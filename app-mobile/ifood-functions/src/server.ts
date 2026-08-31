// ============================================================
//  Servidor do webhook de pedidos do iFood.
//  Endpoints:
//    GET  /ifood/health   -> verifica se a integração está configurada
//    POST /ifood/webhook  -> recebe eventos de pedido do iFood (só funciona
//                            de verdade depois da homologação do app — até
//                            lá, quem entrega os pedidos é o polling
//                            agendado, ver poller.ts)
//  Autenticação: assinatura HMAC-SHA256 do corpo bruto (header
//  X-Ifood-Signature), validada contra o clientSecret do webhook.
// ============================================================
import express from 'express';
import * as crypto from 'crypto';
import * as admin from 'firebase-admin';
import { obterConfigIfood } from './ifoodConfig';
import { processarEventos } from './eventProcessor';

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const PORT = parseInt(process.env.PORT || '4100', 10);

const app = express();
app.use(express.json({ limit: '2mb' }));

// CORS: só o endpoint /ifood/health é chamado pelo navegador (botão "Testar
// conexão" do dashboard); /ifood/webhook é server-to-server (iFood -> aqui),
// não passa por CORS, mas não custa liberar geral igual o fiscal-functions faz.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/ifood/health', async (_req, res) => {
  const config = await obterConfigIfood();
  res.json({ ok: true, configurado: !!config });
});

function comparar(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// A doc do iFood não deixa claro se a assinatura vem em hex ou base64 — aceita
// os dois formatos (confirmado hex em teste real, mas mantém base64 como
// fallback). Loga em caso de divergência pra facilitar diagnóstico futuro.
function validarAssinatura(req: express.Request, signatureSecret: string): boolean {
  const assinatura = String(req.headers['x-ifood-signature'] || '');
  const rawBody: Buffer | undefined = (req as any).rawBody;
  if (!assinatura || !rawBody) {
    console.warn(`[ifood] assinatura ausente. header presente: ${!!assinatura}, rawBody presente: ${!!rawBody}`);
    return false;
  }
  const esperadoHex = crypto.createHmac('sha256', signatureSecret).update(rawBody).digest('hex');
  const esperadoBase64 = crypto.createHmac('sha256', signatureSecret).update(rawBody).digest('base64');

  if (comparar(assinatura, esperadoHex) || comparar(assinatura, esperadoBase64)) return true;

  console.warn(`[ifood] assinatura não bateu. recebida="${assinatura}" esperadaHex="${esperadoHex}" esperadaBase64="${esperadoBase64}"`);
  return false;
}

app.post('/ifood/webhook', async (req, res) => {
  const config = await obterConfigIfood();
  if (!config) {
    console.error('[ifood] webhook recebido sem integração configurada.');
    return res.status(503).json({ error: 'Integração iFood não configurada.' });
  }

  if (!validarAssinatura(req, config.signatureSecret)) {
    return res.status(401).json({ error: 'Assinatura inválida.' });
  }

  const eventos: any[] = Array.isArray(req.body) ? req.body : [req.body];
  await processarEventos(db, eventos);

  res.status(200).json({ ok: true });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`ifood-functions ouvindo na porta ${PORT}`));
}

export { app };
