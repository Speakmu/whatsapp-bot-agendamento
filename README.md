# Gestor CHEF — Sistema Unificado

Monorepo com os três componentes do sistema de atendimento e pedidos da pizzaria.
Todos compartilham o **mesmo projeto Firebase** (`pizzain-40973`) e a coleção `pedidos` do Firestore.

```
Pizzaria_chatgpt_bot/
├── backend-bot/      → Bot de atendimento (Flask + WhatsApp + OpenAI)
├── app-mobile/       → App do cliente (Expo / React Native)
├── dashboard/        → Painel de pedidos (Firebase Hosting, site estático)
└── _legado_raiz_expo/→ Sobras antigas de Expo que estavam na raiz (descartável)
```

## Arquitetura

```
        ┌────────────────────┐
        │   App Mobile (RN)  │── grava pedido ─┐
        └────────────────────┘                 │
        ┌────────────────────┐                 ▼
        │  Bot WhatsApp      │── grava pedido ─►  Firestore
        │  (Flask/OpenAI)    │◄─ lê cardápio ──   projeto: pizzain-40973
        └────────────────────┘                 ▲   coleções: pedidos,
        ┌────────────────────┐                 │   cardapio, usuarios_app,
        │  Dashboard (web)   │◄ lê/atualiza ───┘   historico_conversas
        └────────────────────┘
```

- **Coleção central:** `pedidos` — os três módulos leem/gravam nela.
- **Pagamento:** o app mobile chama uma Cloud Function (`processarPagamentoDireto`) que integra com o Mercado Pago.

---

## 1. backend-bot/ — Bot de atendimento

Backend em **Python/Flask** que atende clientes no WhatsApp (API da Meta), usa **OpenAI**
para conversação, lê o `cardapio` no Firestore, registra `pedidos`, processa comprovantes
de PIX (upload no Firebase Storage) e gerencia pontos de fidelidade.

**Rodar localmente:**
```bash
cd backend-bot
python -m venv venv
# Windows: venv\Scripts\activate   |   Linux/Mac: source venv/bin/activate
pip install -r requirements.txt
flask run            # ou: gunicorn app:app   (produção, ver Procfile)
```

**Configuração (.env):** `OPENAI_API_KEY`, `VERIFY_TOKEN`, `ACCESS_TOKEN`, `PHONE_NUMBER_ID`,
`FIREBASE_CREDENCIAL_PATH`, `FIREBASE_COLECAO_PEDIDOS`, `FIREBASE_STORAGE_BUCKET`.
A credencial do Firebase Admin (`pizzain-40973-firebase-adminsdk-*.json`) precisa estar nesta pasta.

**Deploy:** `Procfile` configurado para gunicorn (Render/Heroku).

---

## 2. app-mobile/ — App do cliente (OFICIAL)

App **Expo / React Native** (TypeScript) onde o cliente monta o carrinho e finaliza o pedido.
Usa Firebase (Auth, Firestore, Messaging). Inclui Cloud Functions em `functions/`.
Integrado ao **GestorChef**: lê `app_config` (marca/banner), valida `cupons` e usa as
regras de **fidelidade** configuradas no dashboard.

> ⚠️ Esta é a versão **oficial** do app. A pasta antiga `meu-app-mobile` (fora do
> monorepo) foi descontinuada — não edite mais lá.

**Rodar:**
```bash
cd app-mobile
npm install
npx expo start
```

**Cloud Functions (pagamento):**
```bash
cd app-mobile/functions
npm install
# Configure o token do Mercado Pago como secret (uma vez):
firebase functions:secrets:set MERCADOPAGO_ACCESS_TOKEN
firebase deploy --only functions
```
> O token do Mercado Pago é lido via `defineSecret("MERCADOPAGO_ACCESS_TOKEN")` —
> não fica mais no código. Use o token de produção (`APP_USR-...`) ao cobrar de verdade.

---

## 3. dashboard/ — GestorChef (sistema de gestão, estilo GrandChef)

Site estático (HTML/CSS/JS) servido pelo **Firebase Hosting**. O **GestorChef** evoluiu de
um painel de pedidos para um sistema completo de gestão para restaurantes, com módulos de:
Pedidos, Cozinha (KDS), Mesas & Comandas, Entregas, Caixa/PDV, Financeiro (DRE), BI/Vendas,
Notas Fiscais (NFC-e), Relatórios, Estoque, **Ficha Técnica & Custos**, Cardápio,
Marketing & App e Configurações.

📖 **Manual de uso completo:** veja [`dashboard/MANUAL.md`](dashboard/MANUAL.md).

**Rodar/Deploy:**
```bash
cd dashboard
firebase serve                          # teste local
firebase deploy --only hosting          # publica o painel
firebase deploy --only firestore:rules  # publica as regras (firestore.rules)
```

### 3.1 Gestão de custos de cozinha (Ficha Técnica & CMV)

Módulo de custos integrado ao estoque e às vendas, no estilo dos ERPs de restaurante.

**Ficha técnica** (`ficha-tecnica.html`) — para cada produto do cardápio, você lista os
insumos e as quantidades consumidas. O sistema calcula em tempo real:
- **Custo do prato** = Σ (quantidade × custo do insumo);
- **Margem** = preço − custo, e **Food cost (CMV%)** = custo ÷ preço (verde ≤35%, amarelo ≤45%, vermelho acima);
- **Sugestão de preço** a partir de um food cost alvo (`preço = custo ÷ alvo%`).
- **Conversão de unidades:** informe em g/ml mesmo que o insumo seja comprado em kg/L —
  a conversão é automática (80 g de mussarela comprada por kg → 0,08 kg).

**Baixa automática de estoque** (`baixa-estoque.js`) — ao **concluir** um pedido, o sistema
consome os insumos das fichas dos produtos vendidos e registra a saída no estoque.
É **idempotente** (marca `estoque_baixado` no pedido via transação), então funciona em
todos os pontos de conclusão sem baixar duas vezes: **Painel, KDS, Entregas, Caixa e Mesas**.
Cobre os quatro canais de venda (App, Balcão, Mesa e WhatsApp).

**Análise do período** (na mesma tela) — a partir das vendas concluídas em um intervalo:
Receita, **CMV**, Margem bruta, Food cost médio e, informando o custo fixo mensal, o
**ponto de equilíbrio** (`custo fixo ÷ margem de contribuição`). Inclui a **curva ABC**
de produtos (A = primeiros 80% do faturamento, B = próximos 15%, C = cauda).

**Estoque** (`estoque.html`) — além do controle de insumos, traz **compras sugeridas**
(insumos no/abaixo do mínimo, com quantidade para recompor até 2× o mínimo e consumo
estimado dos últimos 30 dias) e **alertas de estoque baixo** também no **Início**.

**Coleção nova:** `fichas_tecnicas/{cardapioId}` → `{ produto_nome, itens:[{ insumo_id,
nome, unidade, quantidade, entrada_qtd, entrada_unidade }], atualizado_em }`
(regra de acesso: somente autenticado — publique com `firebase deploy --only firestore:rules`).

> **Formato de item do pedido:** para a baixa reconhecer o produto, cada item do pedido
> deve trazer o `id` do cardápio (ou o `nome` batendo com a ficha) e a `quantidade`.
> App, Caixa e Mesas já gravam nesse formato; o **bot** (`backend-bot/app.py`) foi ajustado
> para incluir `id`, `quantidade` e `preco_unitario` — **reinicie o serviço do bot** após
> atualizar. Pedidos antigos (sem `id`/`quantidade`) são ignorados na baixa, sem erro.

---

## 4. fiscal-service/ — Microserviço de NFC-e

Serviço Node independente que emite **NFC-e** reaproveitando o motor SEFAZ (montagem de
XML, assinatura A1, transmissão e DANFE). **Não depende do Construline** (apenas copiou o
motor). Configuração e setup em [`fiscal-service/README.md`](fiscal-service/README.md).

---

## Observações importantes

- `node_modules/`, `venv/`, `.expo/` e saídas de build foram **excluídos** desta cópia
  (são reinstaláveis com `npm install` / `pip install`).
- As pastas originais (`meu-app-mobile`, `Painel_pedidos`) foram **mantidas intactas**.
- ⚠️ **Segredos:** o `.env` e o JSON do Firebase Admin ainda contêm chaves sensíveis e
  estão protegidos pelo `.gitignore` — confira antes de publicar em repositório público.
  O token do Mercado Pago **já foi removido** do código e agora é lido via secret
  (`MERCADOPAGO_ACCESS_TOKEN`), conforme a seção do app mobile.
