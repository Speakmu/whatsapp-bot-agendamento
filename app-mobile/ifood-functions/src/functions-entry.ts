// ============================================================
//  Pontos de entrada do serviço iFood como Cloud Functions (Firebase).
//  - ifoodWebhook: recebe eventos via POST (só entrega de verdade depois da
//    homologação do app — ver src/server.ts).
//  - ifoodPoller: busca eventos via polling a cada 1 minuto — funciona sem
//    homologação, é o que efetivamente traz os pedidos pro Firestore hoje.
//  Sem Firebase Secrets aqui: client_id/client_secret vêm do Firestore
//  (configuracoes/ifood + integracao_secrets/ifood), editáveis pelo
//  dashboard (aba Configurações) sem precisar de deploy/CLI por loja — ver
//  src/ifoodConfig.ts.
// ============================================================
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { app } from './server';
import { executarPolling } from './poller';

export const ifoodWebhook = onRequest(
  {
    timeoutSeconds: 60,
    memory: '256MiB',
  },
  app,
);

export const ifoodPoller = onSchedule(
  {
    schedule: 'every 1 minutes',
    timeZone: 'America/Sao_Paulo',
    timeoutSeconds: 60,
    memory: '256MiB',
  },
  async () => {
    await executarPolling();
  },
);
