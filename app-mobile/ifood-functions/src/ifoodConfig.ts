// ============================================================
//  Configuração da integração iFood (credenciais + merchantId).
//  merchantId/clientId ficam em configuracoes/ifood (editável no dashboard).
//  clientSecret/signatureSecret ficam em integracao_secrets/ifood — coleção
//  bloqueada pras regras do Firestore (allow read, write: if false), só o
//  Admin SDK (esta function e o configurarIfood do dashboard) acessa.
//  Cacheado em memória de módulo por um TTL curto: Gen2 reaproveita a
//  instância entre invocações, então evita reler o Firestore a cada evento,
//  mas ainda pega mudanças de configuração em minutos, não só no cold start.
// ============================================================
import * as admin from 'firebase-admin';

export interface IfoodConfig {
  merchantId: string;
  clientId: string;
  clientSecret: string;
  signatureSecret: string;
}

let iniciado = false;
function db(): admin.firestore.Firestore {
  if (!iniciado) {
    if (!admin.apps.length) admin.initializeApp();
    iniciado = true;
  }
  return admin.firestore();
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { config: IfoodConfig | null; expiraEm: number } | null = null;

export async function obterConfigIfood(forcar = false): Promise<IfoodConfig | null> {
  if (!forcar && cache && cache.expiraEm > Date.now()) return cache.config;

  const configSnap = await db().collection('configuracoes').doc('ifood').get();
  const configData = configSnap.exists ? (configSnap.data() as any) : null;

  // Integração desativada no dashboard: nem chega a ler os segredos nem a
  // chamar a API do iFood — o poller (a cada 1 min) só faz essa leitura e sai.
  if (configData?.ativo === false) {
    cache = { config: null, expiraEm: Date.now() + CACHE_TTL_MS };
    return null;
  }

  const secretSnap = await db().collection('integracao_secrets').doc('ifood').get();
  const secretData = secretSnap.exists ? (secretSnap.data() as any) : null;

  const merchantId = String(configData?.merchantId || '').trim();
  const clientId = String(configData?.clientId || '').trim();
  const clientSecret = String(secretData?.clientSecret || '').trim();
  const signatureSecret = String(secretData?.signatureSecret || '').trim();

  const config = (merchantId && clientId && clientSecret && signatureSecret)
    ? { merchantId, clientId, clientSecret, signatureSecret }
    : null;

  cache = { config, expiraEm: Date.now() + CACHE_TTL_MS };
  return config;
}
