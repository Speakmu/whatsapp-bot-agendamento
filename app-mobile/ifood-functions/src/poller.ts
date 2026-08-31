// ============================================================
//  Polling agendado dos eventos de pedido do iFood — funciona sem
//  homologação do app (diferente da entrega via webhook, que só o iFood
//  libera depois de homologar). Reaproveita o mesmo processamento do
//  webhook (eventProcessor.ts), então o pedido cai igual no Firestore.
// ============================================================
import * as admin from 'firebase-admin';
import { obterConfigIfood } from './ifoodConfig';
import { pollEvents } from './ifoodClient';
import { processarEventos } from './eventProcessor';

export async function executarPolling(): Promise<void> {
  if (!admin.apps.length) admin.initializeApp();
  const db = admin.firestore();

  const config = await obterConfigIfood();
  if (!config) return; // integração ainda não configurada, nada a fazer

  const eventos = await pollEvents();
  if (!Array.isArray(eventos) || !eventos.length) return;

  await processarEventos(db, eventos);
}
