# FORTCOM — Controle de Obras

Sistema de gestão de obras da **Fortcom Engenharia e Reformas**.

Controle semanal de mão de obra, orçamento por etapas, diário de obra,
materiais e despesas, galeria de fotos e relatório gerencial em PDF.

## Acessar

O sistema roda direto no navegador, sem instalação.

## Instalar no celular

1. Abra o link no Chrome (Android) ou Safari (iPhone)
2. **Android:** menu ⋮ → *Instalar aplicativo*
3. **iPhone:** botão compartilhar → *Adicionar à Tela de Início*

Depois disso funciona como app, inclusive offline no canteiro.

## Primeira vez

O sistema abre vazio. Para carregar seus dados:
**Importar planilha** na barra lateral → selecione seu arquivo de backup `.json`

## Nuvem (sincronização entre aparelhos)

Opcional. O sistema funciona 100% offline; a nuvem só sincroniza entre aparelhos.
A configuração do Firebase (login e *security rules*) está em
**[FIREBASE.md](FIREBASE.md)** — as regras ficam versionadas em
[`firestore.rules`](firestore.rules) e precisam ser **publicadas no console**.

## Backup

- **Backup agora** — baixa um `.json` com tudo (inclusive o código de resgate do PIN)
- **Lembrete de backup** — uma vez por dia o app avisa que o backup de hoje está
  pendente (o selo *hoje pendente* aparece ao lado de "Backup agora"); o
  download só acontece com o seu toque, porque o celular bloqueia downloads
  automáticos
- **Restaurar cópia** — volta uma das cópias internas dos últimos 7 dias

Guarde os backups no Google Drive.

## PIN de acesso

O app abre com um PIN. Na primeira vez vale o PIN de fábrica (o de sempre) e a
tela avisa para trocar: **Ferramentas → Trocar PIN de acesso**. Ao trocar, o app
mostra um **código de resgate** (8 letras/números) — anote. Se esquecer o PIN,
toque em **Esqueci o PIN** e use o código, ou confirme a senha da nuvem. Cinco
erros seguidos bloqueiam a tela por um tempo crescente.

## Verificação automatizada

```bash
cd testes && npm install && npm test
```

Carrega o `index.html` real num DOM simulado e executa os fluxos do app
(PIN, sync entre aparelhos, import de backup, valores em formato BR, XSS,
compressão de fotos, CSV…). Detalhes em [AUDITORIA.md](AUDITORIA.md).
