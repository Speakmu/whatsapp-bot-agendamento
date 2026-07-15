# Manual de Implantação — Sistema Completo (GestorChef + App + Bot)

Runbook de implantação de um cliente novo, do zero até o go-live. Componentes:

| Componente | Pasta | Tecnologia | Onde roda |
|------------|-------|------------|-----------|
| **GestorChef** (painel de gestão) | `dashboard/` | HTML/CSS/JS + Firebase | Firebase Hosting |
| **App de vendas** (cliente final) | `app-mobile/` | Expo / React Native | APK (EAS) / lojas |
| **Bot de atendimento** | `backend-bot/` | Python / Flask | Render / VPS (gunicorn) |
| **Serviço fiscal** (opcional) | `fiscal-service/` | Node / TypeScript | Cloud Run / VPS |

> Base comum: todos falam com o **mesmo projeto Firebase** e a coleção `pedidos` do Firestore.
> A ordem recomendada é: **Firebase → Dashboard → Cadastros → Bot → App → Fiscal → Treinamento**.

---

## 0. Pré-requisitos (contas e ferramentas)

**Contas a criar/ter (por cliente ou reaproveitadas):**
- **Firebase / Google Cloud** — projeto do cliente (Firestore + Auth + Hosting).
- **Meta / WhatsApp Cloud API** — número, `ACCESS_TOKEN`, `PHONE_NUMBER_ID`, `VERIFY_TOKEN` (para o bot).
- **OpenAI** — `OPENAI_API_KEY` (conversa do bot).
- **Mercado Pago** — token de produção `APP_USR-...` (pagamento no app).
- **Expo (EAS)** — conta para gerar o APK do app.
- **Certificado A1 + CSC** — só se o cliente contratar o fiscal (ver `fiscal-service/HOMOLOGACAO_DEPLOY.md`).

**Ferramentas na sua máquina:**
- Node 20+, `npm i -g firebase-tools eas-cli expo`
- Python 3.11+ (para o bot)
- `firebase login` e `eas login` feitos.

---

## 1. Firebase (base de tudo)

1. Criar o projeto no [console.firebase.google.com](https://console.firebase.google.com) (ex.: `lileamar-gestor`).
   - *Ou* reaproveitar um projeto único multi-cliente — mas o recomendado é **um projeto por cliente** (isolamento de dados e faturamento).
2. **Firestore Database** → criar (modo produção).
3. **Authentication** → ativar **E-mail/senha**. Criar o usuário admin do cliente
   (ex.: `gestor@lileamar.com`) — é com ele que a equipe loga no painel.
4. **Web App**: em Configurações do projeto → "Seus apps" → adicionar app Web → copiar o objeto
   `firebaseConfig` (apiKey, authDomain, projectId, appId...).
5. **Service Account (Admin SDK)**: Configurações → Contas de serviço → gerar chave privada
   (JSON). Guarde — o **bot** e os scripts usam esse arquivo.

> **Config centralizada (só 2 arquivos por cliente):** o `firebaseConfig` foi centralizado.
> Para um projeto novo, cole o config do cliente em **apenas dois lugares**:
> 1. `dashboard/public/firebase-config.js` → `window.__FIREBASE_CONFIG__ = { ... }` (todo o painel lê daqui);
> 2. `app-mobile/firebaseConfig.ts` → `export const firebaseConfig = { ... }` (o app lê daqui).
>
> A URL da Cloud Function de pagamento no app é derivada automaticamente do `projectId`
> (não precisa mexer). O **bot** usa o JSON do Admin SDK (passo 1.5), não o `firebaseConfig`.

---

## 2. Dashboard GestorChef (Firebase Hosting)

```bash
cd dashboard
firebase use <PROJECT_ID>                 # aponta para o projeto do cliente
firebase deploy --only firestore:rules    # publica as regras (firestore.rules)
firebase deploy --only hosting            # publica o painel
```

- URL do painel: `https://<PROJECT_ID>.web.app` (abre direto no **Início**).
- **Regras**: o deploy de `firestore.rules` é obrigatório — sem ele, módulos que exigem login
  (Financeiro, Estoque, Fichas, Mesas, Notas, Configurações) dão "permissão insuficiente".
- Login do painel: e-mail/senha criados no passo 1.3.

### Verificação
- Acesse a URL, faça login, confira se a sidebar carrega e o Início mostra os KPIs.

---

## 3. Cadastros iniciais no painel

Com o cliente (ou pelos dados que ele enviou):

1. **Configurações** → dados da empresa, horários, taxas de entrega.
2. **Cardápio** (via Pedidos → Cardápio) → itens, categorias, preços, fotos.
   - Campos que o fiscal usa depois: `ncm`, `cfop`, `csosn` (podem ficar no padrão da config).
3. **Marketing & App** → marca (cor, nome do app), banner, cupons, regras de fidelidade
   (pontos por real). Isso alimenta o app automaticamente (`app_config/geral`).
4. **Estoque** → insumos (nome, unidade, custo, mínimo) — base para Fichas e baixa automática.
5. **Ficha Técnica / Custos** → montar as fichas dos produtos (insumo × quantidade) para ativar
   CMV, food cost e baixa automática de estoque na venda.

---

## 4. Bot de atendimento (WhatsApp)

```bash
cd backend-bot
python -m venv venv && source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

**`.env` do bot:**
```env
OPENAI_API_KEY=sk-...
VERIFY_TOKEN=<voce-escolhe-um-token>
ACCESS_TOKEN=<token-da-Meta-WhatsApp>
PHONE_NUMBER_ID=<id-do-numero-na-Meta>
FIREBASE_CREDENCIAL_PATH=./<PROJECT_ID>-firebase-adminsdk-*.json
FIREBASE_COLECAO_PEDIDOS=pedidos
FIREBASE_STORAGE_BUCKET=<PROJECT_ID>.appspot.com
```
- Coloque o **JSON do Admin SDK** (passo 1.5) nesta pasta e aponte `FIREBASE_CREDENCIAL_PATH`.

**Deploy (Render/Heroku ou VPS):**
```bash
gunicorn app:app        # produção (há Procfile)
```
- Suba num host com URL pública HTTPS (Render é simples).
- Na **Meta (WhatsApp Cloud API)** → configurar o **Webhook**:
  - Callback URL: `https://<seu-bot>/webhook`
  - Verify Token: o mesmo `VERIFY_TOKEN` do `.env`
  - Assinar o evento **messages**.

> **Importante:** o bot grava cada item do pedido com `id` do cardápio, `quantidade` e
> `preco_unitario` — necessário para a **baixa automática de estoque**. Após qualquer alteração
> no `app.py`, **reinicie o serviço** (gunicorn) para valer.

### Verificação
- Mande "oi" para o número do WhatsApp; o bot deve responder e conseguir montar um pedido que
  aparece no painel (Pedidos), com `origem: WHATSAPP`.

---

## 5. App de vendas (Expo / EAS)

```bash
cd app-mobile
npm install
```

**Personalização por cliente:**
1. `app.json` → nome do app, `slug`, `android.package` (ex.: `com.seusuporte.<cliente>`), ícone e splash.
2. `google-services.json` → baixar do Firebase (app Android do projeto do cliente) e substituir.
   - O `package_name` do arquivo **precisa bater** com `android.package` do `app.json`.
3. `firebaseConfig` → conferir nos arquivos do app (`services/pedidoService.ts`, `app/index.tsx`).
4. Marca/cores vêm do painel (`app_config`) em tempo de execução — não precisa recompilar para trocar cor/banner.

**Pagamento (Mercado Pago) — Cloud Functions:**
```bash
cd app-mobile/functions
npm install
firebase use <PROJECT_ID>
firebase functions:secrets:set MERCADOPAGO_ACCESS_TOKEN   # cole o APP_USR-... de produção
firebase deploy --only functions
```
> O token do Mercado Pago é lido via `defineSecret` — **não** fica no código.

**Gerar o APK (distribuição direta):**
```bash
eas build -p android --profile preview     # gera APK
```
- O link do APK **expira** (é o link, não o app instalado). Baixe e **guarde o `.apk`**.
- Para publicar na **Play Store**: `eas build -p android --profile production` (gera `.aab`) +
  conta Google Play Developer.

### Verificação
- Instale o APK, confira marca/cardápio, faça um pedido de teste (Pix/cartão) → deve aparecer no
  painel com `origem: APP` e pontuar fidelidade.

---

## 6. Serviço fiscal (opcional — só se contratado)

O fiscal é um **add-on**. Siga o guia dedicado:
**`fiscal-service/HOMOLOGACAO_DEPLOY.md`** (certificado A1, CSC, deploy Cloud Run, homologação e
roteiro emitir → contingência → transmitir → cancelar → inutilizar).

No painel: Configurações → Fiscal → informar URL do serviço, API Key, CSC/idCSC, ambiente.

---

## 7. Treinamento do cliente

Roteiro sugerido (1 a 2 horas):
1. **Início** e navegação (sidebar por grupos).
2. **Pedidos + KDS** — receber, avançar status, concluir (aqui ocorre a baixa de estoque).
3. **Caixa/PDV e Mesas** — venda no balcão e comandas.
4. **Entregas** — despacho e entregadores.
5. **Estoque + Fichas + Compras sugeridas** — reposição e custos.
6. **Financeiro + BI** — DRE, ticket médio, curva ABC, ponto de equilíbrio.
7. **Marketing & App** — cupons, fidelidade, banner.
8. **Notas Fiscais** (se contratado) — emitir/cancelar/contingência.

---

## 8. Checklist de go-live

- [ ] Projeto Firebase criado; Auth (e-mail/senha) e usuário admin do cliente
- [ ] `firebaseConfig` substituído em todos os componentes (se projeto novo)
- [ ] `firestore.rules` publicado + hosting publicado
- [ ] Cardápio, Configurações, marca/cupons/fidelidade cadastrados
- [ ] Estoque e Fichas Técnicas montados (para custos e baixa automática)
- [ ] Bot no ar, webhook da Meta verificado, pedido de teste OK (`origem WHATSAPP`)
- [ ] Functions de pagamento com secret do Mercado Pago; pedido de teste OK (`origem APP`)
- [ ] APK gerado, instalado e testado; `.apk` guardado em local seguro
- [ ] (Se fiscal) homologação aprovada e credenciamento SEFAZ concluído
- [ ] Treinamento realizado
- [ ] Backup do JSON do Admin SDK e das credenciais em cofre (não no Git)

---

## 9. Manutenção e suporte

- **Backups**: o Firestore tem exportação agendada (Cloud) — configure se o volume justificar.
- **Segredos**: `.env`, JSON do Admin SDK e `.pfx` ficam fora do Git (`.gitignore` já cobre).
- **Atualizações do painel**: `firebase deploy --only hosting` publica na hora (a URL reflete a
  última publicação).
- **Atualizações do bot**: novo deploy + **reiniciar gunicorn**.
- **Atualizações do app**: novo `eas build`; mudanças só de marca/cupom/fidelidade **não** exigem
  rebuild (vêm do painel).

> Referências: `README.md` (visão geral do monorepo) · `fiscal-service/README.md` e
> `fiscal-service/HOMOLOGACAO_DEPLOY.md` (fiscal) · `app-mobile/COMO_TESTAR_FORA_DA_REDE.md` (app).
