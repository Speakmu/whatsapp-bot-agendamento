# Como publicar update do app (EAS Update)

Depois de mexer no código do app (`app-mobile/app`, `app-mobile/services`, etc.)
e já ter commitado/enviado pro git, publique o update OTA rodando dentro de
`app-mobile/`:

```bash
eas update --branch preview --message "descrição curta da mudança"
```

## Por que `preview` e não `production`

Todos os builds do app que já foram gerados até hoje usam o canal `preview`
(perfil `preview` do `eas.json`). **Não existe nenhum build no canal
`production`** — publicar um update em `--branch production` não quebra nada,
mas não chega em lugar nenhum, porque nenhum app instalado escuta esse canal.

Confira com `eas channel:list` se isso mudar no futuro (por exemplo, quando
sair o primeiro build de produção de verdade pra loja).

## Depois de publicar

O app só busca update novo quando abre — se você acabou de publicar, feche o
app **por completo** (não só minimizar) e abra de novo. Se ainda não aparecer,
confira se o `runtimeVersion` do update bate com o do build instalado
(`eas update:list` / `eas build:list`).
