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

- **Backup agora** — baixa um `.json` com tudo
- **Backup automático** — salva um arquivo por dia
- **Restaurar cópia** — volta uma das cópias dos últimos 7 dias

Guarde os backups no Google Drive.
