// ============================================================
//  Ponto de entrada do serviço fiscal como Cloud Function (Firebase).
//  Empacota o mesmo app Express (server.ts) sem mudar a lógica de negócio —
//  só troca "app.listen(PORT)" (Render) por uma function HTTPS (onRequest).
// ============================================================
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret } from 'firebase-functions/params';
import { app } from './server';
import { retentarPendenciasFiscais } from './retry-scheduler';

// Mesmo nome de variável que server.ts já lê via process.env — o Functions
// injeta o valor do secret na env var de mesmo nome em tempo de execução.
// Configure com: firebase functions:secrets:set API_KEY
//
// CERT_ENC_KEY e CERT_PASSWORD são genuinamente opcionais no código (caem em
// fallback), então NÃO entram aqui: declarar um secret na function obriga o
// Firebase a exigir um valor cadastrado antes de deployar, mesmo que o app
// trate a ausência dele normalmente.
const API_KEY = defineSecret('API_KEY');

export const fiscalApi = onRequest(
  {
    secrets: [API_KEY],
    timeoutSeconds: 120, // SEFAZ/IBPT podem levar até ~30s; margem de sobra
    memory: '512MiB',
    // CORS já é tratado dentro do próprio app Express (mesma lógica de sempre) —
    // não usar a opção "cors" daqui pra não duplicar/conflitar cabeçalhos.
  },
  app,
);

// Backstop server-side do retry fiscal: pedidos concluídos offline que nunca
// chegaram a emitir (nfce_pendente), notas que caíram por falta de rede
// (ERRO_REDE) e notas em contingência aguardando transmissão à SEFAZ. O retry
// que já existe no navegador (dashboard/public/fiscal-client.js) só roda
// enquanto alguém está com uma aba do dashboard aberta; este roda sozinho.
// A senha do certificado é decifrada com CERT_ENC_KEY (ou API_KEY como
// fallback) — precisa do mesmo secret que o fiscalApi pra decifrar o mesmo
// valor gravado no Firestore.
export const fiscalRetryScheduler = onSchedule(
  {
    schedule: 'every 20 minutes',
    timeZone: 'America/Sao_Paulo',
    secrets: [API_KEY],
    timeoutSeconds: 300,
    memory: '512MiB',
  },
  async () => {
    await retentarPendenciasFiscais();
  },
);
