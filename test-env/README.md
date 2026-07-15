# 🧪 Ambiente de Teste — GestorChef (Firebase Emulator)

Roda todo o sistema **isolado na sua máquina** (Firestore + Auth + Hosting), sem tocar
na produção. Inclui **dados de demonstração** e um **simulador ao vivo** que cria
pedidos e avança status (KDS / Entregas / BI se atualizam na sua frente).

> Como conecta sozinho: as telas têm o `emu.js`, que só aponta para o emulador quando
> o endereço é `localhost`. Em produção, nada muda.

## Pré-requisitos
- Node.js instalado.
- Firebase CLI: `npm install -g firebase-tools` (ou use `npx firebase ...`).
- Java (necessário para o emulador do Firestore). Se faltar, o `firebase` avisa.

## 🌐 Demo NA NUVEM (acessível de qualquer rede) — para apresentar ao cliente

Publica o painel no Firebase Hosting (link `https://pizzain-40973.web.app`, acessível de
qualquer lugar, sem deixar seu PC ligado) e popula os dados de demonstração no Firebase real.

```bash
cd test-env
npm install                 # 1ª vez (firebase-admin + firebase-tools)
firebase login              # 1ª vez (autentica sua conta Google)
npm run cloud:seed          # popula os dados de demo no projeto real
npm run cloud:deploy        # publica o painel + regras
```
Pronto: abra **https://pizzain-40973.web.app** de qualquer rede e entre com
**demo@gestorchef.com / 123456**.

**Simulação ao vivo na nuvem** (KDS/BI atualizando para quem está acessando remoto):
```bash
npm run cloud:sim           # deixe rodando durante a apresentação (Ctrl+C para parar)
```

**Limpar a demo depois** (remove os dados de demonstração do projeto real):
```bash
npm run cloud:clean
```

> O `emu.js` só ativa o emulador em `localhost`; na nuvem o painel usa o Firebase real
> automaticamente. O `cloud:seed/sim/clean` usa a credencial em
> `backend-bot/pizzain-40973-firebase-adminsdk-*.json`.

---

## 🖱️ Demo em 1 clique (mais fácil)

- **Windows:** dê duplo clique em **`iniciar-demo.bat`**
- **Mac/Linux:** `chmod +x iniciar-demo.sh && ./iniciar-demo.sh`

Ele instala o necessário (1ª vez), sobe o emulador **com persistência**, popula os
dados na primeira execução e abre o painel. Login: **demo@gestorchef.com / 123456**.
Os dados ficam salvos em `emulator-data/` entre as execuções (não precisa semear de novo).
Para parar: feche a janela do emulador (Windows) ou `Ctrl+C` (Mac/Linux).

---

## ⚡ Teste automático (1 comando)

Sobe o emulador, semeia e confere tudo — e desliga sozinho ao final:
```bash
cd test-env
npm install            # só na primeira vez (instala firebase-admin + firebase-tools)
npm run test:emu
```
Saída esperada: `✅ Integração com o emulador OK. Tudo pronto para a demo.`
(Precisa de Java instalado — o emulador do Firestore usa.)

## Demo ao vivo (1 comando para subir tudo)
```bash
cd test-env
npm run demo           # sobe Hosting:5000, Firestore:8080, Auth:9099, UI:4000
```
Em outro terminal: `npm run seed` (popular) e, opcional, `npm run sim` (ao vivo).
Depois abra http://localhost:5000 e entre com **demo@gestorchef.com / 123456**.

---

## Passo a passo (manual)

**1) Ligar os emuladores** (na pasta `dashboard`, que tem o `firebase.json`):
```bash
cd dashboard
firebase emulators:start
```
Isso sobe:
- Painel (Hosting): http://localhost:5000
- Emulator UI (ver os dados): http://localhost:4000
- Firestore: 8080 · Auth: 9099

**2) Semear os dados de demonstração** (em OUTRO terminal):
```bash
cd test-env
npm install      # só na primeira vez
npm run seed
```
Cria cardápio, pedidos (14 dias de histórico + ativos), caixa aberto, estoque,
mesas, entregadores, cupons, fidelidade, financeiro e o **login de demo**.

**3) Abrir o painel:** http://localhost:5000 → entre com:
```
e-mail: demo@gestorchef.com
senha:  123456
```

**4) (Opcional) Simulação ao vivo** — em mais um terminal:
```bash
cd test-env
npm run sim
```
A cada 8s entra um pedido novo ou um pedido avança de status. Deixe a tela
**Cozinha (KDS)**, **Entregas** ou **BI / Vendas** aberta para ver mexendo. `Ctrl+C` para parar.

## Dicas para a demo
- **Início**: visão geral (vendas do dia, pedidos ativos, mesas, estoque baixo).
- **BI / Vendas**: gráficos com os 14 dias de histórico.
- **Cozinha (KDS)** + **Simulador**: mostra o fluxo da cozinha em tempo real.
- **Caixa / PDV**: o caixa já está aberto; faça uma venda na frente do cliente.
- **Mesas**: a Mesa 3 já está ocupada com uma comanda.
- **Marketing & App**: troque a cor/nome e mostre o banner/cupom.

## Resetar
Pare os emuladores (Ctrl+C) e suba de novo — o emulador começa zerado. Rode o
`npm run seed` novamente para repopular. (Os dados do emulador não persistem entre
execuções, a não ser que use `--import/--export-on-exit`.)

## App mobile (opcional) no emulador
O app React Native também pode usar o emulador, mas o aparelho/simulador precisa
alcançar o IP da sua máquina (não `localhost`). No `app-mobile/app/index.tsx`, após o
`initializeApp`, adicione (somente em desenvolvimento):
```js
// db.useEmulator('SEU_IP_LOCAL', 8080); auth.useEmulator('http://SEU_IP_LOCAL:9099');
```
Para a demonstração, o mais simples é mostrar o app apontando para o projeto real e o
**painel** rodando no emulador.
