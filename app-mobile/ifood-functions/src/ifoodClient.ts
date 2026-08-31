// ============================================================
//  Cliente HTTP da Merchant/Order API do iFood.
//  Doc oficial: https://developer.ifood.com.br
//  Fluxo: OAuth client_credentials -> GET pedido -> confirmar -> ack do evento.
// ============================================================
import axios from 'axios';
import { obterConfigIfood } from './ifoodConfig';

const BASE_URL = 'https://merchant-api.ifood.com.br';

let tokenCache: { token: string; expiraEm: number } | null = null;

async function obterToken(): Promise<string> {
  if (tokenCache && tokenCache.expiraEm > Date.now()) return tokenCache.token;

  const config = await obterConfigIfood();
  if (!config) throw new Error('Integração iFood não configurada (merchantId/clientId/segredos ausentes).');

  const params = new URLSearchParams({
    grantType: 'client_credentials',
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  });
  const resp = await axios.post(`${BASE_URL}/authentication/v1.0/oauth/token`, params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const accessToken = resp.data?.accessToken;
  const expiresIn = Number(resp.data?.expiresIn || 3000);
  if (!accessToken) throw new Error('iFood não retornou accessToken na autenticação.');

  // margem de 60s antes do vencimento real, pra não usar token expirado
  tokenCache = { token: accessToken, expiraEm: Date.now() + (expiresIn - 60) * 1000 };
  return accessToken;
}

async function authHeaders() {
  const token = await obterToken();
  return { Authorization: `Bearer ${token}` };
}

export async function getOrder(orderId: string): Promise<any> {
  const resp = await axios.get(`${BASE_URL}/order/v1.0/orders/${orderId}`, {
    headers: await authHeaders(),
  });
  return resp.data;
}

export async function confirmOrder(orderId: string): Promise<void> {
  await axios.post(`${BASE_URL}/order/v1.0/orders/${orderId}/confirm`, {}, {
    headers: await authHeaders(),
  });
}

// Diagnóstico: busca eventos pendentes via polling, sem depender do webhook.
export async function pollEvents(): Promise<any> {
  const resp = await axios.get(`${BASE_URL}/events/v1.0/events:polling`, {
    headers: await authHeaders(),
  });
  return resp.data;
}

export async function acknowledgeEvents(eventIds: string[]): Promise<void> {
  if (!eventIds.length) return;
  await axios.post(
    `${BASE_URL}/events/v1.0/events/acknowledgment`,
    eventIds.map((id) => ({ id })),
    { headers: await authHeaders() },
  );
}
