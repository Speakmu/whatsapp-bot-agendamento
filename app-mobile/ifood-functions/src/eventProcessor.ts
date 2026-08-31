// ============================================================
//  Processamento de eventos de pedido do iFood — compartilhado entre o
//  webhook (POST /ifood/webhook, usado depois da homologação) e o polling
//  agendado (funciona sem homologação, é o que valida a integração agora).
// ============================================================
import * as admin from 'firebase-admin';
import { getOrder, confirmOrder, acknowledgeEvents } from './ifoodClient';
import { carregarIndiceCardapio, mapearPedido } from './pedidoMapper';

const CODIGOS_PEDIDO_NOVO = new Set(['PLC', 'PLACED']);

// Evento novo (PLC = pedido colocado): busca o pedido completo, grava em
// `pedidos` (idempotente via doc id determinístico) e confirma no iFood.
async function processarPedidoNovo(db: admin.firestore.Firestore, orderId: string) {
  const ref = db.collection('pedidos').doc(`ifood_${orderId}`);
  const jaExiste = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return true;

    const orderPayload = await getOrder(orderId);
    const indiceCardapio = await carregarIndiceCardapio(db);
    const pedido = mapearPedido(orderPayload, indiceCardapio);
    tx.set(ref, pedido);
    return false;
  });

  if (!jaExiste) await confirmOrder(orderId);
}

// Eventos de status subsequentes (CONFIRMED, CANCELLED, CONCLUDED...): só
// atualiza o status do pedido já gravado, sem recriar.
async function processarAtualizacaoStatus(db: admin.firestore.Firestore, orderId: string, status: string) {
  const ref = db.collection('pedidos').doc(`ifood_${orderId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    console.warn(`[ifood] evento de status "${status}" pro pedido ${orderId}, mas o doc ainda não existe (corrida com o PLC?).`);
    return;
  }
  await ref.update({ status_ifood: status });
}

export async function processarEventos(db: admin.firestore.Firestore, eventos: any[]): Promise<void> {
  const eventIds: string[] = [];

  for (const evento of eventos) {
    const orderId = String(evento.orderId || evento.id || '');
    const code = String(evento.code || '').toUpperCase();
    if (evento.id) eventIds.push(String(evento.id));
    if (!orderId) continue;

    try {
      if (CODIGOS_PEDIDO_NOVO.has(code)) await processarPedidoNovo(db, orderId);
      else await processarAtualizacaoStatus(db, orderId, code);
    } catch (err) {
      console.error(`[ifood] falha processando evento ${code} do pedido ${orderId}:`, (err as Error).message);
    }
  }

  if (eventIds.length) {
    try {
      await acknowledgeEvents(eventIds);
    } catch (err) {
      console.error('[ifood] falha ao confirmar (ack) eventos:', (err as Error).message);
    }
  }
}
