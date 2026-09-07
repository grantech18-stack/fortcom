# Firebase — projeto `fortcom-c8f39`

O app é offline-first: **ele funciona sem nada disso**. A nuvem serve só para
sincronizar entre aparelhos. Os dados do dia a dia ficam no `localStorage` do
celular (`obra_control_v4`), e o backup `.json` é o que garante a recuperação.

## O que o app usa

| Recurso | Onde está no código | Para quê |
|---|---|---|
| Firebase Auth (e-mail/senha) | `index.html` — `firebase.auth().signInWithEmailAndPassword` na tela "Nuvem FORTCOM" | cada aparelho autentica uma vez; a sessão fica persistida |
| Firestore, documento único | `index.html` — `DOCPATH = ['empresas','fortcom','dados','principal']` | guarda `{ payload, dev, aba, updatedAt, rev, conflitos }`; o `payload` é o estado inteiro (obras) em JSON, `rev` cresce a cada gravação e `conflitos` lista as últimas edições concorrentes resolvidas |
| SDK (compat 10.12.2) | `index.html` + `sw.js` (precache) | app / firestore / auth |

Fotos **não** vão para a nuvem (ficam só no aparelho) — é o que mantém o
documento dentro do limite de 1 MB. O app mede o tamanho do `payload` a cada
envio: avisa acima de ~800 KB e, acima de 1 MB, para de sincronizar com o chip
em vermelho ("Nuvem: dados acima de 1 MB") em vez de fingir que é falta de
internet — os dados continuam salvos no aparelho.

## Como a sincronização funciona (desde 04/09/2026)

Não é mais "quem grava por último ganha". Cada aparelho guarda a **base** (o
último estado que confirmou em comum com a nuvem) e:

- **ao receber** um snapshot, faz um *merge de 3 vias* (base × local × nuvem)
  por obra, semana, funcionário, etapa, diário, despesa e campo. Só o que mudou
  **dos dois lados no mesmo campo** é conflito: fica a versão do aparelho que
  está olhando, e o valor descartado vai para a lista `conflitos` (no
  documento e no `localStorage`), com aviso nos dois aparelhos — o chip da
  nuvem fica vermelho com "⚠ N conflitos — toque para ver";
- **ao gravar**, usa uma transação: lê o documento atual e, se a nuvem mudou
  desde a base, mescla **antes** de escrever e sobe `rev + 1`. Sem internet a
  transação falha e a gravação fica pendente até o evento `online`;
- um aparelho novo (só com a obra de exemplo vazia) simplesmente adota a nuvem.

Exclusões seguem a regra natural: item apagado de um lado e **não mexido** do
outro some dos dois; apagado de um lado e **editado** do outro volta (com
registro de conflito), porque perder edição é pior que ver um item a mais.

## Configuração no console — 2 passos, ~2 min

### 1. Authentication → Sign-in method

Habilite **E-mail/senha** e crie o usuário do dono em *Authentication → Users →
Add user*:

| | |
|---|---|
| **E-mail (login da nuvem)** | `gran.tech18@gmail.com` — o dono da conta Firebase |
| **Não confundir com** | `fernandogpi92@gmail.com` (`EMPRESA.email`), que é o contato da empresa e vai no cabeçalho do relatório/PDF |

O campo de e-mail da tela "Nuvem FORTCOM" já abre preenchido com
`gran.tech18@gmail.com` (`index.html` → `EMAIL_PADRAO`). Se um dia trocar a
conta no Firebase, troque **os dois lugares**: o `EMAIL_PADRAO` no `index.html`
e a lista dentro de `dono()` em `firestore.rules`.

### 2. Firestore Database → Rules

Publique o conteúdo de **[`firestore.rules`](firestore.rules)** (está versionado
neste repositório). Ele substitui a regra atual do projeto:

```
match /empresas/fortcom/dados/{doc} { allow read, write: if true; }
```

Essa regra é o item **A1** da [AUDITORIA.md](AUDITORIA.md): qualquer pessoa na
internet que conheça o endereço do documento — e ele está no código público do
app — consegue **ler** nomes, valores e **chaves PIX** dos funcionários, e
também **sobrescrever ou apagar** tudo, sem deixar rastro (parece "outro
aparelho sincronizando").

Pelo CLI, se preferir:

```bash
firebase login
firebase use fortcom-c8f39
firebase deploy --only firestore:rules
```

## ⚠️ Ordem do deploy

Publique **as regras e a versão nova do app juntas** (o login de nuvem entrou em
04/09/2026). Regras novas com app antigo = aquela instalação perde a
sincronização até ser atualizada. **Os dados locais do celular não são
afetados** — só a sync para.

Antes de mexer: baixe um backup `.json` no próprio app (menu → *Backup agora*)
e guarde no Drive.

## Como conferir se ficou certo

1. Abra o app num aparelho, passe pelo PIN `2604` e entre na nuvem com o
   usuário criado → o chip no canto inferior deve chegar em **"Sincronizado ✓"**.
2. No console, em Firestore, o documento
   `empresas/fortcom/dados/principal` deve ter `updatedAt` recente.
3. Teste o bloqueio: no console, use *Rules → Rules Playground* com
   `get /empresas/fortcom/dados/principal` e **Authentication: desabilitado** →
   a resposta deve ser **negada** (simula um estranho sem login).

## O que ainda não está resolvido na nuvem

- **A3** — a sync é *last-write-wins*: o último aparelho a gravar sobe o estado
  inteiro e apaga o que o outro fez offline, sem aviso. Reproduzido na
  verificação 7.9c de `testes/suite.js`.
- **M5** — o documento tem limite de 1 MB e o app não avisa quando se aproxima;
  quando estourar, o chip vai dizer "Aguardando internet" (erro enganoso).
- A recomendação estrutural (A1/A3/M5 juntos) é sair do documento único para um
  documento **por obra**.
