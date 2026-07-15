# 📲 Testar o app fora da rede (APK instalável)

O app já aponta para o **Firebase na nuvem** (projeto `pizzain-40973`) — então, depois de
gerar o APK, ele funciona em **qualquer rede/celular**, sem depender do seu PC.
Use o **Expo Go NÃO funciona** aqui (o app usa `@react-native-firebase`, que exige build próprio).

> Antes: rode `npm run cloud:seed` na pasta `test-env` (popula cardápio, marca, cupons,
> fidelidade na nuvem). Assim o app já abre com dados de demonstração.

## Opção A — APK pronto para enviar (recomendado p/ cliente)

Gera um arquivo `.apk` que o cliente instala no Android e usa de qualquer lugar.

```bash
cd app-mobile
npm install                      # se ainda não instalou
npm install -g eas-cli           # 1ª vez
eas login                        # sua conta Expo (cria grátis em expo.dev)
eas init                         # 1ª vez: cria o projeto EAS e grava o projectId no app.json
eas build -p android --profile preview
```
Ao terminar (~10–15 min, roda nos servidores da Expo), o EAS te dá um **link do .apk**.
Baixe no celular (qualquer rede), instale e teste. Para mandar ao cliente, é só compartilhar o link.

**Login de teste no app:** aba *Você* → CPF **000.000.000-00** (cliente demo já tem pontos),
ou cadastre um novo na hora.

## Opção B — Teste rápido via túnel (se você já tem um *dev build* instalado)

Se o celular de teste já tem o **development build** deste app instalado:
```bash
cd app-mobile
npx expo start --tunnel
```
Gera um QR com URL pública (via túnel) que o celular abre **mesmo em outra rede**.
> O Expo Go não serve; precisa ser o *dev client* deste app. Por isso, para o cliente,
> a **Opção A (APK)** é a indicada.

## iOS
Para iPhone é parecido, mas exige conta Apple Developer (ou TestFlight):
`eas build -p ios --profile preview`. Para a maioria dos testes, comece pelo Android (APK).

## Observações
- O app lê marca, banner, cupons e fidelidade do Firebase na nuvem (config em **Marketing & App**
  do painel). Mude lá e reabra o app para ver refletir.
- Os pedidos feitos no app caem na nuvem com `origem: "APP"` e aparecem no painel
  (`https://pizzain-40973.web.app`) em tempo real.
