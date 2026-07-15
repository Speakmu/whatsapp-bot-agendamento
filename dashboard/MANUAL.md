# 🍕 GestorChef — Manual do Sistema

Manual de uso e operação do **GestorChef**, o sistema de gestão da pizzaria. É um conjunto
de telas web (Firebase Hosting) integradas ao mesmo banco em tempo real (Firestore,
projeto `pizzain-40973`), e conversa com o bot de WhatsApp, o app do cliente e o
serviço fiscal de NFC-e.

---

## Sumário

1. [Visão geral](#1-visão-geral)
2. [Como acessar](#2-como-acessar)
3. [Navegação](#3-navegação)
4. [Operação](#4-operação)
   - [Pedidos](#41-pedidos) · [Cozinha (KDS)](#42-cozinha-kds) · [Mesas](#43-mesas--comandas) · [Entregas](#44-entregas) · [Caixa / PDV](#45-caixa--pdv)
5. [Gestão](#5-gestão)
   - [Financeiro](#51-financeiro) · [Notas Fiscais](#52-notas-fiscais) · [Relatórios](#53-relatórios) · [Estoque](#54-estoque)
6. [Cadastros — Cardápio](#6-cadastros--cardápio)
7. [Sistema — Marketing, App e Configurações](#7-sistema--marketing-app-e-configurações)
8. [Fluxo de status do pedido](#8-fluxo-de-status-do-pedido)
9. [Emissão fiscal (NFC-e) — passo a passo](#9-emissão-fiscal-nfc-e)
10. [Deploy e manutenção](#10-deploy-e-manutenção)
11. [Regras de segurança do Firestore](#11-regras-de-segurança-do-firestore)
12. [Solução de problemas](#12-solução-de-problemas)
13. [App do cliente](#13-app-do-cliente)

---

## 1. Visão geral

O **GestorChef** cobre toda a operação de uma pizzaria/delivery:

| Área | Módulos |
|------|---------|
| **Operação** | Pedidos, Cozinha (KDS), Mesas & Comandas, Entregas, Caixa/PDV |
| **Gestão** | Financeiro (DRE), Notas Fiscais (NFC-e), Relatórios, Estoque |
| **Cadastros** | Cardápio |
| **Sistema** | Configurações (geral + fiscal) |

Todos os pedidos — vindos do **bot WhatsApp**, do **app do cliente**, do **balcão (PDV)**
ou de **mesas** — caem na mesma coleção `pedidos` e circulam pelos mesmos status.

---

## 2. Como acessar

1. Abra o endereço do painel (Firebase Hosting).
2. Faça login com e-mail e senha (usuários criados no Firebase Authentication).
3. Após o login você cai na **tela inicial (Início)** com o resumo do dia.

> Apenas pessoas com login conseguem acessar os módulos administrativos. O app do
> cliente e o bot não usam esse login.

---

## 3. Navegação

A navegação fica na **barra lateral** (esquerda), agrupada em **Operação**, **Gestão**,
**Cadastros** e **Sistema**. No celular, toque no botão **☰** para abrir o menu.

A **tela Início** mostra os indicadores do dia (vendas, pedidos ativos, mesas ocupadas,
itens com estoque baixo) e atalhos para os módulos.

---

## 4. Operação

### 4.1 Pedidos
Lista, em tempo real, os pedidos ativos (aguardando, em preparo, prontos, em entrega).
Cada cartão mostra cliente, itens, endereço e pagamento, com botões para **avançar o
status** ou **cancelar**. Ao marcar como "Pronto", o cliente é avisado pelo bot.

### 4.2 Cozinha (KDS)
Tela cheia para a cozinha, em 3 colunas: **Na fila → Em preparo → Pronto**. Cada ficha
tem um **cronômetro** que fica amarelo após 10 min e vermelho após 20 min. A cozinha
avança com um toque ("Iniciar preparo", "Marcar pronto", "Despachar"). Toca um som a
cada novo pedido (pode silenciar no botão 🔔).

### 4.3 Mesas & Comandas
Mapa de mesas (verde = livre, laranja = ocupada). Toque numa mesa para abrir a comanda,
adicione itens do cardápio, controle quantidades e veja o total ao vivo. Permite
**dividir a conta** por número de pessoas e **fechar a conta** (gera a venda) ou
**cancelar a comanda**.

### 4.4 Entregas
Pedidos prontos para entrega aparecem em **Aguardando despacho**: escolha o entregador
e clique **Despachar** (status vira "Saiu para entrega"). Em **Em rota**, marque
**Entregue** ao concluir. Cada pedido tem um link **🗺️ Rota** (Google Maps). Há um
cadastro simples de **entregadores** (nome, telefone, veículo, ativar/desativar).

### 4.5 Caixa / PDV
Duas abas:
- **Frente de Caixa**: monte a venda tocando nos itens do cardápio, escolha a forma de
  pagamento e finalize. Opção de "enviar para a cozinha". Cada venda vira um pedido
  (`origem: BALCAO`).
- **Operação de Caixa**: **abertura** (com fundo de troco), **sangria/suprimento** e
  **fechamento** (confere o dinheiro contado x esperado e mostra sobra/falta). O caixa
  precisa estar **aberto** para registrar vendas.

---

## 5. Gestão

### 5.1 Financeiro
Filtre por período e veja **Receita, Despesa, Resultado e Margem**, com **DRE** (receita
de vendas + outras receitas − despesas por categoria) e gráficos. Lance **despesas e
receitas** manuais (contas a pagar/receber) e exporte tudo em **CSV**.

### 5.2 Notas Fiscais
Lista as **vendas concluídas** para **emitir NFC-e** (botão por pedido) e as **notas
emitidas** com status, chave e **download do DANFE**. Veja a seção 9 para configurar.

### 5.3 Relatórios
Dentro de **Pedidos → Relatórios**: histórico filtrável por data, ticket médio,
faturamento, ranking de produtos e exportação em CSV/Excel.

### 5.4 Estoque
Cadastro de **insumos** (unidade, estoque mínimo, custo). Registre **entradas, saídas e
ajustes**; o sistema mantém o saldo e alerta os itens **abaixo do mínimo**. Mostra o
**valor total em estoque**.

---

## 6. Cadastros — Cardápio
Em **Pedidos → Gerenciar Cardápio**: cadastre itens (nome, categoria, preço,
ingredientes, imagem, pontos de fidelidade) e ative/desative a disponibilidade. O
cardápio é lido pelo bot, pelo app e pelo PDV.

---

## 7. Sistema — Marketing, App e Configurações

### Marketing & App
Tela que controla o **app do cliente** e as ações de marketing. Tudo é salvo em
coleções de **leitura pública** (`app_config`, `cupons`, `promocoes`) para o app ler
sem login. Abas:

- **🎨 Aparência do app**: nome, emoji/logo e **cor primária** da marca (com
  pré-visualização). A cor é aplicada no app (botões, banner).
- **📢 Promoções / Banner**: liga/desliga a **faixa promocional** do topo do app
  (texto + cor) e mantém uma **lista de promoções**.
- **🎟️ Cupons**: cria cupons (código, **% ou R$ fixo**, valor mínimo, validade),
  ativa/desativa e exclui. O cliente aplica o código no carrinho do app.
- **⭐ Fidelidade**: regras de **acúmulo** (pontos por R$) e **resgate** (valor por
  ponto e mínimo para resgatar). Essas regras valem no app (ganho e desconto por pontos).

### Estabelecimento
Nome, telefone e endereço usados nas telas/documentos.

### Emissão Fiscal (NFC-e)
- **Ativar emissão fiscal** (liga/desliga).
- **Modo de emissão**: **Manual** (botão), **Automático** (emite ao concluir a venda) ou
  **Ambos**. É aqui que se define se a NFC-e sai sozinha no Caixa/Mesas.
- **Serviço fiscal**: URL + token (com botão **Testar conexão**).
- **Emitente**: razão social, CNPJ, IE, UF, regime, ambiente, série, **CSC + ID do
  token**, endereço completo e **código IBGE do município**.
- **Classificação fiscal padrão**: NCM, CFOP, CSOSN/CST e origem (aplicados quando o
  produto não tiver classificação própria).
- **URLs da NFC-e** (QR Code e consulta por chave) — específicas da sua UF/ambiente.

---

## 8. Fluxo de status do pedido

```
AGUARDANDO_PIX ─┐
PENDENTE_PREPARO ├─► EM_PREPARO ─► PRONTO_PARA_ENTREGA ─► SAIU_PARA_ENTREGA ─► CONCLUIDO
PENDENTE_VALIDACAO ┘                                   └─(retirada/balcão)─► CONCLUIDO
                          (qualquer ponto) ─► CANCELADO
```

- **Pedidos/KDS** avançam até "Pronto".
- **Entregas** cuida de "Saiu para entrega" → "Entregue (Concluído)".
- **Caixa/Mesa** geram vendas já **Concluídas** (ou enviam à cozinha).

---

## 9. Emissão fiscal (NFC-e)

> ⚠️ Emitir nota fiscal exige configuração legal: **certificado digital A1**, CSC da
> SEFAZ e classificação fiscal correta. Comece sempre em **Homologação**.

**Pré-requisitos (uma vez):**
1. Suba o **serviço fiscal** (`fiscal-service/`) com o certificado A1 da pizzaria.
   Veja `fiscal-service/README.md`.
2. Em **Configurações → Fiscal**: ative, informe URL + token do serviço, CNPJ/IE/UF,
   **CSC + ID do token**, endereço + **IBGE do município**, e as **URLs da sua UF**
   (em homologação). Clique **Testar conexão**.
3. Confirme com sua contabilidade a **classificação fiscal** (NCM/CFOP/CSOSN).

**No dia a dia:**
- **Modo Manual**: vá em **Notas Fiscais** e clique **Emitir NFC-e** no pedido.
- **Modo Automático/Ambos**: a NFC-e sai sozinha ao concluir a venda no **Caixa** ou ao
  **fechar a conta** na Mesa.
- O **DANFE** (PDF) fica disponível para download na tela **Notas Fiscais**.

**Importante:** o certificado A1 fica **somente no serviço fiscal** (nunca no painel).

---

## 10. Deploy e manutenção

**Dashboard (este painel):**
```bash
cd dashboard
firebase serve              # teste local
firebase deploy --only hosting
```

**Regras do Firestore:**
```bash
cd dashboard
firebase deploy --only firestore:rules   # usa firestore.rules
```

**Serviço fiscal (NFC-e):** veja `fiscal-service/README.md` (Node + certificado A1).

**Bot e app:** o backend do bot está em `backend-bot/` e o app em `app-mobile/`
(consulte o README na raiz do projeto).

> Após alterar CSS/JS, se o navegador mostrar a versão antiga, use **Ctrl+F5**
> (os arquivos já têm versionamento `?v=` para forçar atualização).

---

## 11. Regras de segurança do Firestore

Coleções **públicas** — leitura/escrita pelo cliente sem login (pedido/cardápio) e
leitura pelo app (marca/cupons/promoções): `pedidos`, `cardapio`, `usuarios_app`,
`app_config`, `cupons`, `promocoes`.

Coleções **administrativas** (exigem login): `caixa_sessoes`, `caixa_movimentos`,
`financeiro_lancamentos`, `estoque_insumos`, `estoque_movimentos`, `entregadores`,
`mesas`, `comandas`, `configuracoes`, `notas_fiscais`.

O arquivo `dashboard/firestore.rules` já contém todas, e o `firebase.json` já declara o
target `firestore`. Publique sempre que adicionar um módulo novo:
```bash
cd dashboard && firebase deploy --only firestore:rules
```

---

## 12. Solução de problemas

| Problema | Causa provável | Solução |
|----------|----------------|---------|
| "Missing or insufficient permissions" | Regra do Firestore faltando | Publique `firestore.rules` (seção 11) |
| Tela com visual antigo | Cache do navegador | Ctrl+F5 |
| Financeiro pede índice | Consulta por data sem índice | Clique no link do erro no console para criar |
| "Testar conexão" falha | Serviço fiscal fora do ar / URL ou CORS errados | Verifique a URL e se o serviço está rodando |
| NFC-e rejeitada (cStat ≠ 100) | Dados fiscais incorretos | Veja o motivo na tela Notas Fiscais e ajuste a configuração/classificação |
| NFC-e não sai sozinha | Modo em "Manual" ou emissão desativada | Configurações → Fiscal: ative e escolha "Automático/Ambos" |
| Cupom não aplica no app | Cupom inativo/expirado ou regras não publicadas | Marketing & App → Cupons; publique `firestore.rules` |
| App não mostra a marca/banner | `app_config` vazio ou regras não publicadas | Preencha Marketing & App → Aparência e publique as regras |

---

## 13. App do cliente

App **Expo / React Native** (pasta oficial: `app-mobile/`) integrado ao GestorChef:

- **Marca e banner**: lê `app_config` em tempo real e aplica a **cor primária** e a
  **faixa promocional** definidas em Marketing & App.
- **Cupons**: no carrinho, o cliente digita o código; o app valida em `cupons`
  (ativo + validade + valor mínimo) e aplica o desconto no total.
- **Fidelidade**:
  - *Acúmulo*: ao pagar, ganha pontos pela regra `total × pontos por R$`.
  - *Resgate*: se tiver pontos ≥ mínimo, pode usar os pontos como desconto
    (valor por ponto), com débito automático dos pontos usados.

> A pasta antiga `meu-app-mobile` foi **descontinuada** — edite apenas `app-mobile/`.
> Para rodar: `cd app-mobile && npm install && npx expo start`.
