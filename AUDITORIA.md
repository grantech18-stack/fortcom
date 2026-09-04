# Auditoria de Código — FORTCOM (Controle de Obras)

**Data:** 03/09/2026 · **Alvo:** `index.html` (3.862 linhas, 362 KB) + `sw.js` + `README.md`
**Escopo:** segurança, integridade de dados, PWA/offline, bugs funcionais, performance, higiene de código.
**Metodologia:** leitura completa do código-fonte, verificação de sintaxe (`new Function` em todos os blocos `<script>` — OK), rastreio de fluxo de dados (entrada → render → localStorage → backup → Firestore).

**Status (03/09/2026):** correções rápidas **M1, M2, M3, L1, L3 e M8 aplicadas** + **lado do app do A1 pronto** (login de nuvem com Firebase Auth — falta publicar as rules no console). Tudo validado com suíte de testes automatizados (jsdom, 59 verificações: zero erros de JS na primeira abertura e no reload, dados preservados após reload, exclusão de semana persiste, import de backup legado sem crash, valores BR aceitos, fluxo de login de nuvem completo). Restam os itens Alto (A2–A4, A1 pendente só do console) e os demais Médio/Baixo (M4–M7, L2, L4–L10).

## Resumo executivo

O sistema funciona e está bem estruturado para o que é (app offline-first em arquivo único), mas tem **4 problemas de alto impacto**: a sincronização em nuvem não tem segurança real além das regras do Firestore (impossíveis de verificar aqui, e o app roda sem autenticação), o PIN é decorativo e não tem rota de recuperação (esqueceu o PIN = apagar o app), a sincronização multi-aparelho pode perder dados silenciosamente, e há XSS armazenado por falta de escape em todo o render. Há ainda **bugs concretos** (excluir semana não funciona; importar backup antigo quebra o app; valores com vírgula são truncados) e **lixo herdado** (scripts de Cloudflare que 404 fora do host original, dados de exemplo, código morto).

| Severidade | Qtd |
|---|---|
| Alto | 4 |
| Médio | 8 |
| Baixo | 10 |

---

## ALTO

### A1 — A "nuvem" pode ser lida e escrita por qualquer pessoa (regras Firestore + sem auth) — **CONFIRMADO**
`index.html` ~L3747–3804
Toda a empresa vive em **um único documento** (`empresas/fortcom/dados/principal`) num projeto cuja `projectId`/`apiKey` estão no fonte da página: `fortcom-c8f39`. O payload inclui valores financeiros, nomes e **chaves PIX de funcionários**, CNPJ e endereço. O app não usa Firebase Auth — a única proteção é o PIN no cliente (ver A2), que **não existe na nuvem**.

**Confirmado em 03/09/2026** — as regras reais do projeto são:
```
match /empresas/fortcom/dados/{doc} { allow read, write: if true; }
```
Ou seja: **qualquer pessoa na internet** que conheça o endereço do documento (que está no código do app, público) pode **ler tudo** (inclusive chaves PIX) e **sobrescrever/apagar** os dados — indistinguível de um "outro aparelho sincronizando". Única boa notícia: o escopo das regras se limita a esse caminho (não há wildcard global). ⚠️ O `{doc}` também permite criar documentos arbitrários dentro de `dados/`.
**Risco:** vazamento/corrupção total dos dados.
**Status (03/09/2026):** lado do **app pronto** — login de nuvem via Firebase Auth (e-mail/senha) dentro da tela de PIN: cada aparelho autentica uma vez (persistência local), overlay "Nuvem FORTCOM" com opção de uso só-offline, chip com estado "Nuvem: toque para entrar", script `firebase-auth-compat` incluído no precache do service worker (`fortcom-v7`). **Pendências (console, ~2 min):** (1) Authentication → habilitar E-mail/senha e criar o usuário do dono; (2) publicar as rules travadas: `allow read, write: if request.auth != null && request.auth.token.email == '<e-mail do dono>';`. ⚠️ Publicar app novo + rules novas juntos — versões antigas perdem a sync (dados locais intactos) até serem atualizadas.
**Recomendação:** (2) sair do "documento único" para um doc por obra, limitando o dano de uma escrita maliciosa (fica para a etapa A3/M5).

### A2 — PIN hardcoded sem recuperação: esqueceu, perdeu tudo
`index.html` L3748 (`var PIN = '2604'`)
O PIN é fixo no código (qualquer um lê no fonte) e a tela não tem alternativa: sem o PIN o app não abre. Se o dono esquecer o PIN, o único caminho é limpar os dados do site — o que **apaga também o localStorage** (os dados locais da obra). Num app de gestão, esse é o cenário de perda total mais provável.
**Recomendação:** permitir troca do PIN dentro do app (guardado hasheado, não em claro), e uma rota de resgate (pergunta secreta, código impresso no backup, ou redefinir após carregar um backup). Também: 4 tentativas → aviso; hoje não há limite.

### A3 — Sincronização "quem escreve por último ganha": perda silenciosa de dados
`index.html` ~L3795–3825 (`enviar`/`aplicar`)
O modelo é: qualquer mudança no aparelho A sobe o **estado inteiro**; o aparelho B aplica cegamente (`obras = o.obras`) e apaga tudo o que tinha local. Cenário comum: A edita a semana 5, B edita a semana 6, B salva depois → **as edições da semana 5 somem sem aviso**. Piora: `saveNow` é chamado no `beforeunload`, mas o `ref.set()` é assíncrono e a página morre antes — a última edição do dia pode não subir.
**Recomendação:** versionar o estado (`updatedAt` + `rev` por obra/semana); ao aplicar, comparar com o local e, em conflito, notificar o usuário (chip/overlay) em vez de sobrescrever; no `pagehide`/`beforeunload` usar `navigator.sendBeacon` ou o `await` do `set()` quando possível.

### A4 — XSS armazenado (dados do usuário viram HTML)
Exemplos: L1857–1861 (`renderSidebarObras` e `renderObraSelector`: `${o.nome}` em `innerHTML` e em `onclick="switchObra('${o.id}')"`), L2050–2070 (`renderWeekTable`: `title="${f.pix}"` e `navigator.clipboard.writeText('${f.pix}')` — uma aspas na chave PIX quebra o JS e vira injeção), `renderExtras`/`renderDiario`/`renderDespesas` (descrições, atividades, fornecedores entram crus), `openFoto` (`f.nome`, `f.obraNome`), e o PDF de `gerarRelatorioPDF()` (mesma história na janela de impressão).
Sozinho é risco baixo (quem digita é o dono); **combinado com A1 é crítico**: quem conseguir gravar no documento do Firestore entrega um script que roda no aparelho do dono, com acesso a tudo (localStorage, backups, dados digitados depois).
**Recomendação:** criar `esc(s)` (substituir `&<>"'`) e usar em **todo** `innerHTML`/atributo que contenha dado; nunca interpolar em `onclick` (usar `addEventListener` ou `data-id`); também corrige o `exportCSV` (campos com `"`/quebra de linha quebram o CSV hoje).

---

## MÉDIO

### M1 — Bug: excluir semana não funciona (a semana volta)
`index.html` L2324 (`removeWeek`)
`weeks=weeks.filter(w=>w.id!==id)` apenas **reatribui a variável local**. O `render()` seguinte chama `syncCurrentObra()`, que faz de volta `weeks = obra.semanas` (o array original, ainda com a semana excluída). Resultado: o usuário confirma "Excluir esta semana e todos os lançamentos?", a semana some por um frame e **volta**, e continua no backup.
**Correção:** `obra.semanas = obra.semanas.filter(...); syncCurrentObra();`
✅ **Corrigido em 03/09/2026** — `removeWeek` agora filtra `getObra().semanas`, chama `syncCurrentObra()` e `save()` explícito (padrão dos demais mutators). Teste: exclusão persiste após reload.

### M2 — Bug: importar backup antigo (v2/v3) quebra o app
`importFile` (L2808 em diante) e `load()` não garantem os campos mínimos das semanas importadas (`status`, `funcionarios`, `custosExtras`, `valorRecebido`). L1873: `w.status.charAt(0).toUpperCase()` lança `TypeError` quando `status` é `undefined` → o `render` inteiro cai. Um backup feito pela versão antiga (formato `{obra, weeks}` ou array puro) traz o app para baixo ao abrir.
**Correção:** sanitizar toda semana importada com o mesmo "migra campos faltantes" que `load()` já faz para o localStorage.
✅ **Corrigido em 03/09/2026** — helper `sanitizarSemanas(o)` (status, funcionarios, custosExtras, valorRecebido, numero, inicio, fim, dias, diária) chamado em `load()`, nos 3 ramos do `importFile` e em `restaurarBackupInterno`. Os ramos de backup legado (`Array` / `{obra, weeks}`) também passam a definir `currentWeekId` válido (semana de hoje ou a 1ª) — antes ficava pendurado num id de obra que não existe mais. Teste: import de `{obra, weeks}` sem `status`/`dias` abre sem erro.

### M3 — Bug: valores com vírgula (formato BR) são truncados em 3 campos
L2246 (`fDiaria`), L2307 (`wRecebido`), L2383 (`editPagamento` → `parseFloat(novo)`): `parseFloat("150,50")` = **150**; `parseFloat("1,50")` = **1**. Outros campos do app (`addCustoExtra`, `editCustoExtra`) convertem `,` → `.`. Comportamento inconsistente no financeiro = dinheiro errado no pagamento.
**Correção:** uma função `parseVal(s)` (`String(s).replace(/\./g,'').replace(',','.')` com cuidado para `1.234,56`) usada em **todos** os inputs de valor.
✅ **Corrigido em 03/09/2026** — `parseVal(v)` adicionada e aplicada nos 13 pontos de entrada de valor (custos extra, diárias/extras/adiantamento, valor recebido, pagamento, valor da obra, etapa, despesa). Aceita `150,50`, `1.234,56`, `R$ 99,9` e número puro. O contador animado do KPI (que já fazia a conversão certa) ficou intacto. Teste: custo extra digitado como `1.234,56` grava 1234.56; diárias/extras via `saveFuncionario` com valor BR gravam corretamente.

### M4 — Backup automático por download não funciona no celular (e grava a toa)
`checarBackupAuto()` roda a cada `saveNow()` — que há um `setInterval` de **30 s** mesmo sem mudança alguma (`index.html` ~L1780). O download programático (`baixarBackup(true)`) fora de gesto do usuário é bloqueado pelo Chrome mobile: o "backup diário" que o README promete provavelmente **nunca chega a baixar no canteiro**. E a gravação a cada 30 s força `JSON.stringify` + `localStorage.setItem` permanentes (bateria/flash em aparelho velho).
**Recomendação:** salvar só quando houve mudança (`pacote() !== ultimo`); para o backup diário, avisar no app ("há backup pendente de hoje — tocar para baixar") em vez de download automático.

### M5 — Limite de 1 MB do doc Firestore + erro enganoso
O payload sincroniza **tudo** (obras, etapas, diário, despesas). Quando o estado passar de 1 MB, `ref.set()` falha com erro 400 e o chip mostra "Aguardando internet" — o usuário acha que é rede, quando é tamanho. Sem alerta prévio, a sincronização simplesmente **para de funcionar um dia**.
**Recomendação:** monitorar `pacote().length` e alertar acima de ~800 KB; dividir em múltiplos docs (um por obra) resolve junto com A1.

### M6 — Fotos em localStorage sem compressão (cota ~5 MB)
`handleFotos()` grava a foto crua em base64 (~2–4 MB cada). Duas ou três fotos lotam a cota; a partir daí **todos os saves falham** (o app só mostra o toast "memória cheia"). O app inteiro pode ficar gravando nada.
**Recomendação:** comprimir via `<canvas>` (máx. ~1280 px, JPEG q≈0.7) antes de salvar; mostrar uso da cota e alertar perto do limite; a galeria já era o maior custo — com compressão cabe muito mais.

### M7 — Service Worker: cache sem limite e versão fixa
`sw.js`: o handler de fetch faz `c.put` de **qualquer GET** (inclusive cross-origin: gstatic, fontes, beacon) sem LRU nem limite de entradas → PWA instalado por meses pode estourar a cota de cache do navegador. `CACHE='fortcom-v6'` nunca muda: entradas de versões antigas de SDK acumulam.
**Recomendação:** limitar o cache à origem + allowlist (gstatic do firebase), impor teto (ex.: 60 entradas ou 30 MB com LRU), e bumpar `fortcom-vN` a cada deploy.

### M8 — Resíduos de Cloudflare no HTML (telemetria de terceiros + 404s)
`index.html` L3859–3860: um `beacon.min.js` do Cloudflare Insights **com o token do site onde este HTML foi salvo** (análise/envio de métricas para a conta de terceiros) e um script de challenge que injeta iframe oculto e carrega `/cdn-cgi/challenge-platform/...` **da origem atual** — no GitHub Pages isso 404 silenciosamente. Os dois não fazem nada útil aqui.
**Recomendação:** excluir as duas tags.
✅ **Corrigido em 03/09/2026** — beacon do Cloudflare Insights (com token de terceiros) e script de challenge removidos; o `</body></html>` final foi mantido.

---

## BAIXO

| # | Achado | Onde |
|---|---|---|
| L1 | ~~Ano `2026` hardcoded para o nome do mês~~ — o nome do mês vinha de `new Date(2026, …)`; agora o ano vem da própria coluna (`mes`, formato `M/AAAA`). (Cosmético: os nomes de mês pt-BR não dependem do ano e a linha já mostrava o `mes` real.) ✅ **corrigido em 03/09/2026** | L2626 (atual L2671) |
| L2 | Código morto/dados de exemplo: `obrasModelo` com 4 obras fictícias no `seed()`, `OBRA_KEY` (nunca usada), `LOGO_BRANCA` (~10 KB de base64, nunca usada), `backupJSON` original **e** o patch (nenhum botão chama mais — o UI usa `baixarBackup`), `_orig*` | L1578–1583, 1508, 1521, 2657/2805, 2807–2812 |
| L3 | ~~Primeiro acesso abria na **semana 5**~~ (o seed gera a semana atual no índice 0, mas `load()` escolhia `semanas[4]` — sobra da versão antiga). Agora a abertura sem semana salva escolhe a **semana que cobre hoje** (helper `semanaDeHoje`), com fallback para a 1ª. ⚠️ muda o comportamento do 1º acesso (de semana 5 para a semana atual) ✅ **corrigido em 03/09/2026** | L1643 (atual L1669) |
| L4 | `openWeekModal()` quebra se a obra tiver 0 semanas (`weeks[weeks.length-1]` undefined) — possível após importar obra vazia | L2281 |
| L5 | `selectWeek`/`changeWeek` não validam semana existente (ID obsoleto após restaurar backup → crash) | L2102–2108 |
| L6 | PWA: manifest e ícones 100% em `data:` URI — no iPhone o `apple-touch-icon` pode não aparecer e no Android os critérios de instalabilidade podem falhar (sem ícones fetcháveis) | L7–8 |
| L7 | A11y: dezenas de botões só com `title` (✎ ✕ ‹ › ☰ ◐) e sem `aria-label` | body inteiro |
| L8 | `exportCSV`: sem aspas de campo (quebra com `"` ou quebra de linha) e decimal com `.` em Excel BR | L2632 |
| L9 | `gerarRelatorioPDF` usa `document.write` + popup (bloqueador comum); o HTML do relatório também não escapa dados (ver A4) | L3266+ |
| L10 | Arquivo único de 362 KB no repo: diff/merge impossíveis de revisar, cache HTTP ineficiente; considerar `index.html` + `app.js` + `estilo.css` + `manifest.json` + ícones | — |

---

## O que está bem feito (para não mexer)

- **Offline-first de verdade:** rede-primeiro com fallback de cache, Firebase SDK precacheado no `sw.js`, Firestore persistence habilitado.
- **Backup em camadas:** JSON manual, cópia interna de 7 dias **sem fotos** (não estoura cota), RESTAURAR com confirmação.
- **Detecção de loop de eco** na sync (`ultimoEnviado`, flag `pausar`, filtro `dev===DEV`).
- Salvamento com debounce + `beforeunload`/`visibilitychange` + `QuotaExceededError` tratado com mensagem clara.
- Migrações v2→v3→v4 no `load()` (a falta dessa sanitização no import é o M2, não a estratégia).
- Suporte a `prefers-reduced-motion`, tema dark completo, layout mobile decente.
- Fotos excluídas do payload de sync (consciente — é a razão de o doc caber no limite, por enquanto).

## Ordem sugerida de correção

1. **Hoje, fora do código:** revisar as *security rules* do Firestore de `fortcom-c8f39` (A1) e ter um backup `.json` + Drive atualizados.
2. **Rápido e barato:** M1 (excluir semana), M2 (sanitizar import), M3 (`parseVal`), L1 (ano), L3 (semana inicial), M8 (remover Cloudflare) — ✅ **feito em 03/09/2026** (ver status no topo).
3. **Estrutura:** A4 (escape + `esc()` em tudo), A2 (troca de PIN + resgate), M4 (save só em mudança + aviso de backup pendente), M6 (compressão de fotos), M7 (SW com teto).
4. **Projeto:** A3 (versão/conflicto na sync) + M5 (docs por obra) — é o passo que transforma a "nuvem" em sincronização de verdade (junto com A1).
