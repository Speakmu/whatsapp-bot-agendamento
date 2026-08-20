// ============================================================
//  Retry agendado de pendências fiscais (backstop server-side).
//  O retry existente no navegador (dashboard/public/fiscal-client.js) só
//  roda enquanto alguém está com uma aba do dashboard aberta — se a venda foi
//  concluída offline e ninguém reabrir a tela quando a conexão voltar, a nota
//  nunca sai do estado pendente. Esta function roda periodicamente (ver
//  functions-entry.ts) e cobre os mesmos três casos, sem depender de navegador:
//
//   1. Pedidos concluídos que nunca chegaram a criar a nota, porque a
//      transação que reserva o número sequencial não funciona offline
//      (marcados em pedidos.nfce_pendente = true).
//   2. Notas que começaram a emitir mas caíram por falta de rede
//      (notas_fiscais.status = 'ERRO_REDE', com o payload já salvo).
//   3. Notas emitidas em contingência (tpEmis=9, offline na hora da venda)
//      esperando transmissão à SEFAZ (notas_fiscais.status = 'CONTINGENCIA').
// ============================================================
import * as admin from 'firebase-admin';
import * as fs from 'fs';
import {
  emitirNfceAvulsa, AvulsaRequest, AvulsaResult,
  transmitirNfceContingencia, CertInput,
} from './nfce';
import { carregarCertificado } from './cert-store';

function db(): admin.firestore.Firestore {
  if (!admin.apps.length) admin.initializeApp();
  return admin.firestore();
}

const CERT_PATH = process.env.CERT_PATH || '';
const CERT_PASSWORD = process.env.CERT_PASSWORD || '';

// Mesma lógica de obterCert() do server.ts (prioriza o certificado enviado
// pelo painel no Firestore; cai para arquivo local + senha do ambiente).
async function obterCert(): Promise<CertInput | null> {
  try {
    const c = await carregarCertificado();
    if (c && c.buffer) return { buffer: c.buffer, password: c.senha || CERT_PASSWORD };
  } catch { /* Firestore indisponível → tenta arquivo local */ }
  if (CERT_PATH && fs.existsSync(CERT_PATH)) return { pfxPath: CERT_PATH, password: CERT_PASSWORD };
  return null;
}

const TPAG: Record<string, string> = {
  dinheiro: '01', pix: '17', cartão: '03', cartao: '03',
  crédito: '03', credito: '03', débito: '04', debito: '04', entrega: '99',
};
function mapTPag(forma: string): string {
  const f = String(forma || '').toLowerCase();
  for (const k in TPAG) if (f.includes(k)) return TPAG[k];
  return '01';
}

function itensDoPedido(pedido: any, cfg: any) {
  const lista = pedido.itens || [];
  if (Array.isArray(lista) && lista.length) {
    return lista.map((i: any) => ({
      xProd: i.nome_exibicao || i.nome || 'Item',
      ncm: i.ncm || cfg.ncm,
      cfop: i.cfop || cfg.cfop,
      csosn: i.csosn || cfg.cst,
      origem: i.origem || cfg.origem || '0',
      uCom: 'UN',
      qCom: Number(i.quantidade) || 1,
      vUnCom: Number(i.preco) || 0,
    }));
  }
  return [{
    xProd: pedido.item_pedido || 'Consumo', ncm: cfg.ncm, cfop: cfg.cfop,
    csosn: cfg.cst, origem: cfg.origem || '0', uCom: 'UN', qCom: 1,
    vUnCom: Number(pedido.valor_total) || 0,
  }];
}

function urlsPorAmbiente(cfg: any) {
  const prod = cfg.ambiente === 'producao';
  return { qrBaseUrl: prod ? cfg.qrBaseUrlProd : cfg.qrBaseUrlHom, urlChave: prod ? cfg.urlChaveProd : cfg.urlChaveHom };
}

function configCompleta(cfg: any): boolean {
  if (!cfg || !cfg.ativo) return false;
  const { qrBaseUrl } = urlsPorAmbiente(cfg);
  if (!qrBaseUrl) return false;
  return ['url', 'cnpj', 'csc', 'cscId', 'uf', 'cMun', 'xLgr', 'nro', 'xBairro', 'xMun', 'cep']
    .every((k) => !!cfg[k]);
}

async function proximoNumero(): Promise<number> {
  const ref = db().collection('configuracoes').doc('fiscal');
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const atual = (snap.data() && (snap.data() as any).seqNNF) || 0;
    const proximo = atual + 1;
    tx.update(ref, { seqNNF: proximo });
    return proximo;
  });
}

// Status que indicam uma nota já ativa (em andamento ou concluída) para o
// pedido — igual à checagem do emitir() em fiscal-client.js, pra não pedir
// outro número nem duplicar a nota fiscal da venda.
const STATUS_NOTA_ATIVA = ['PROCESSANDO', 'ERRO_REDE', 'CONTINGENCIA', 'AUTORIZADA'];

// Mesma trava transacional do fiscal-client.js (client), no MESMO campo do
// MESMO documento pedidos/{pedidoId} — Firestore garante consistência entre
// SDK admin (aqui) e SDK client (dashboard), então um clique manual de
// "Retry" e este cron se excluem mutuamente de verdade, mesmo rodando em
// processos diferentes. Sem isso, os dois podiam checar "nenhuma nota ativa"
// quase ao mesmo tempo e cada um emitir a sua — já causou duas NFC-e
// AUTORIZADA de verdade pra um único pedido em produção.
const TRAVA_EMISSAO_TIMEOUT_MS = 5 * 60 * 1000;
async function adquirirTravaEmissao(pedidoId: string): Promise<void> {
  const pedidoRef = db().collection('pedidos').doc(pedidoId);
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(pedidoRef);
    const d = snap.exists ? (snap.data() as any) : {};
    const travaEm = d?.nfce_emitindo_em?.toMillis ? d.nfce_emitindo_em.toMillis() : 0;
    if (travaEm && (Date.now() - travaEm) < TRAVA_EMISSAO_TIMEOUT_MS) {
      throw new Error('NFCE_JA_EM_ANDAMENTO');
    }
    tx.update(pedidoRef, { nfce_emitindo_em: admin.firestore.FieldValue.serverTimestamp() });
  });
}
async function liberarTravaEmissao(pedidoId: string): Promise<void> {
  await db().collection('pedidos').doc(pedidoId)
    .set({ nfce_emitindo_em: admin.firestore.FieldValue.delete() }, { merge: true })
    .catch(() => {});
}

async function gravarResultado(ref: admin.firestore.DocumentReference, data: AvulsaResult): Promise<void> {
  const emContingencia = data.status === 'CONTINGENCIA';
  await ref.update({
    status: data.status,
    chave: data.chave || null,
    protocolo: data.protocolo || null,
    cStat: data.cStat || null,
    motivo: data.motivo || null,
    danfeBase64: data.danfeBase64 || null,
    xml: data.xml || null,
    formaEmissao: emContingencia ? 'CONTINGENCIA' : 'NORMAL',
    contingencia: !!data.contingencia,
    xmlAssinado: emContingencia ? (data.xml || null) : null,
    payload_pendente: admin.firestore.FieldValue.delete(),
  });
}

async function emitirParaPedido(pedidoId: string, pedido: any, cfg: any, cert: CertInput): Promise<void> {
  try {
    await adquirirTravaEmissao(pedidoId);
  } catch {
    return; // outro processo (dashboard ou este mesmo cron) já está emitindo pra este pedido
  }
  try {
    await emitirParaPedidoComTravaAdquirida(pedidoId, pedido, cfg, cert);
  } finally {
    await liberarTravaEmissao(pedidoId);
  }
}

async function emitirParaPedidoComTravaAdquirida(pedidoId: string, pedido: any, cfg: any, cert: CertInput): Promise<void> {
  const existentes = await db().collection('notas_fiscais').where('pedido_id', '==', pedidoId).get();
  if (existentes.docs.some((d) => STATUS_NOTA_ATIVA.includes(d.data().status))) return;

  const nNF = await proximoNumero();
  const payload: AvulsaRequest = {
    ambiente: cfg.ambiente || 'homologacao',
    serie: cfg.serie || 1,
    nNF,
    seed: `pedido-${pedidoId}`,
    emitter: {
      cnpj: cfg.cnpj, ie: cfg.ie || 'ISENTO', xNome: cfg.razao || cfg.fantasia || 'Emitente',
      xFant: cfg.fantasia, xLgr: cfg.xLgr, nro: cfg.nro, xCpl: cfg.xCpl,
      xBairro: cfg.xBairro, cMun: cfg.cMun, xMun: cfg.xMun, uf: cfg.uf,
      cep: cfg.cep, fone: cfg.fone, crt: cfg.regime === 'normal' ? '3' : '1',
    },
    csc: cfg.csc, cscId: cfg.cscId,
    ...urlsPorAmbiente(cfg),
    aliquotaAproxTributos: Number(cfg.aliquotaAproxTributos) || 0,
    ibptToken: cfg.ibptToken || undefined,
    indPres: pedido.origem === 'APP' ? '4' : '1',
    indIntermed: pedido.origem === 'APP' ? '0' : undefined,
    payment: { tPag: mapTPag(pedido.forma_pagamento), vPag: Number(pedido.valor_total) || 0 },
    items: itensDoPedido(pedido, cfg),
    recipient: pedido.cpf_cliente ? { cpf: pedido.cpf_cliente, xNome: pedido.nome_cliente } : undefined,
  };

  const ref = await db().collection('notas_fiscais').add({
    pedido_id: pedidoId,
    nNF, serie: payload.serie,
    status: 'PROCESSANDO',
    valor: payload.payment.vPag,
    cliente: pedido.nome_cliente || null,
    ambiente: payload.ambiente,
    criado_em: admin.firestore.FieldValue.serverTimestamp(),
  });

  try {
    const resultado = await emitirNfceAvulsa(payload, cert);
    await gravarResultado(ref, resultado);
  } catch (err: any) {
    // Rejeição/erro da SEFAZ (não falta de rede, já que estamos no servidor) —
    // fica em ERRO, igual ao fluxo interativo, esperando um "Retry" manual.
    await ref.update({ status: 'ERRO', motivo: err?.message || String(err) });
  }
}

async function reemitirNotaComErroDeRede(
  doc: admin.firestore.QueryDocumentSnapshot, cert: CertInput,
): Promise<void> {
  const ref = doc.ref;
  const payload = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const d = snap.data();
    if (!d || d.status !== 'ERRO_REDE' || !d.payload_pendente) return null;
    tx.update(ref, { status: 'PROCESSANDO' });
    return d.payload_pendente as AvulsaRequest;
  });
  if (!payload) return;
  try {
    const resultado = await emitirNfceAvulsa(payload, cert);
    await gravarResultado(ref, resultado);
  } catch (err: any) {
    await ref.update({ status: 'ERRO_REDE', motivo: err?.message || String(err), payload_pendente: payload });
  }
}

async function transmitirNotaEmContingencia(
  doc: admin.firestore.QueryDocumentSnapshot, cfg: any, cert: CertInput,
): Promise<void> {
  const ref = doc.ref;
  const nota = doc.data();
  if (!nota.xmlAssinado) return;
  try {
    const resultado = await transmitirNfceContingencia(
      { ambiente: nota.ambiente || cfg.ambiente || 'homologacao', uf: cfg.uf, xmlAssinado: nota.xmlAssinado },
      cert,
    );
    if (resultado.status === 'AUTORIZADA') {
      await ref.update({
        status: 'AUTORIZADA',
        protocolo: resultado.protocolo || null,
        cStat: resultado.cStat || null,
        motivo: null,
        contingencia: false,
        xmlAssinado: null,
        danfeBase64: resultado.danfeBase64 || nota.danfeBase64 || null,
        transmitida_em: admin.firestore.FieldValue.serverTimestamp(),
      });
    } else if (resultado.cStat) {
      // SEFAZ processou e rejeitou de vez — reenviar o MESMO XML já assinado de
      // novo (próximo ciclo do cron) nunca vai funcionar, o problema está no
      // conteúdo dele. Libera o pedido pra uma emissão nova do zero em vez de
      // deixar a nota presa em CONTINGENCIA pra sempre.
      await ref.update({ status: 'ERRO', cStat: resultado.cStat, motivo: resultado.motivo || null, contingencia: false });
      if (nota.pedido_id) {
        await db().collection('pedidos').doc(nota.pedido_id).set({ nfce_pendente: true }, { merge: true }).catch(() => {});
      }
    } else {
      // Falha de comunicação (sem cStat) — mantém em CONTINGENCIA, vale tentar de novo.
      await ref.update({ motivo: resultado.motivo || null });
    }
  } catch (err: any) {
    await ref.update({ motivo: err?.message || String(err) });
  }
}

// Recupera notas travadas em PROCESSANDO: o registro é criado na hora (rápido,
// só Firestore) e a transmissão à SEFAZ roda em segundo plano — se essa parte
// nunca terminar de escrever um resultado (aba fechada no meio, notebook
// dormiu, rede caiu de novo bem naquele instante), a nota fica presa nesse
// status pra sempre, porque nada mais a monitora (nfce_pendente já foi limpo
// quando o registro foi criado).
//
// Só reabre uma nova tentativa quando NÃO existe campo "chave" no registro —
// a chave é montada localmente ANTES de transmitir, então a ausência dela é
// garantia de que aquela tentativa nunca chegou a assinar/enviar o XML (não
// tem como ter duplicado nada na SEFAZ). Se já existe chave, a tentativa pode
// ter sido concluída do lado da SEFAZ mesmo sem conseguirmos confirmar aqui —
// nesse caso só loga um aviso pra revisão manual, nunca reemite sozinha (evita
// arriscar uma NFC-e duplicada em produção).
const LIMITE_PROCESSANDO_TRAVADA_MS = 3 * 60 * 1000; // 3 minutos

async function recuperarNotasProcessandoTravadas(cfg: any, cert: CertInput): Promise<void> {
  const travadas = await db().collection('notas_fiscais').where('status', '==', 'PROCESSANDO').get();
  const agora = Date.now();
  for (const doc of travadas.docs) {
    const d = doc.data();
    const criadoEm = d.criado_em && typeof d.criado_em.toDate === 'function' ? d.criado_em.toDate().getTime() : null;
    if (!criadoEm || (agora - criadoEm) < LIMITE_PROCESSANDO_TRAVADA_MS) continue; // ainda pode estar em andamento de verdade

    console.log(`[retry fiscal] nota ${doc.id} (pedido ${d.pedido_id}) travada em PROCESSANDO há ${Math.round((agora - criadoEm) / 60000)}min.`);
    if (d.chave) {
      console.warn(`[retry fiscal] nota ${doc.id} travada em PROCESSANDO há mais de 3min mas já tem chave (${d.chave}) — não mexo automaticamente, requer verificação manual na SEFAZ.`);
      continue;
    }
    if (!d.pedido_id) continue;

    try {
      // Tira o registro velho do caminho (não fica mais em STATUS_NOTA_ATIVA)
      // antes de abrir uma tentativa nova pro mesmo pedido.
      await doc.ref.update({
        status: 'ERRO',
        motivo: 'Emissão anterior travou sem gerar chave (processo interrompido antes de transmitir) — nova tentativa aberta automaticamente.',
      });
      const pedidoSnap = await db().collection('pedidos').doc(d.pedido_id).get();
      if (!pedidoSnap.exists) continue;
      await emitirParaPedido(d.pedido_id, pedidoSnap.data(), cfg, cert);
    } catch (err: any) {
      console.error(`[retry fiscal] falha ao recuperar nota travada ${doc.id} (pedido ${d.pedido_id}):`, err?.message || err);
    }
  }
}

// Ponto de entrada chamado pelo scheduler (functions-entry.ts).
export async function retentarPendenciasFiscais(): Promise<void> {
  const cfgSnap = await db().collection('configuracoes').doc('fiscal').get();
  const cfg = cfgSnap.exists ? cfgSnap.data()! : {};
  if (!configCompleta(cfg)) {
    console.log('[retry fiscal] configuração fiscal incompleta ou desativada — nada a fazer.');
    return;
  }

  const cert = await obterCert();
  if (!cert || !cert.password) {
    console.log('[retry fiscal] certificado A1 indisponível — abortando este ciclo.');
    return;
  }

  if (['automatico', 'ambos'].includes(cfg.modo)) {
    const pendentes = await db().collection('pedidos').where('nfce_pendente', '==', true).get();
    if (pendentes.size) console.log(`[retry fiscal] ${pendentes.size} pedido(s) com nfce_pendente.`);
    for (const doc of pendentes.docs) {
      try {
        await emitirParaPedido(doc.id, doc.data(), cfg, cert);
        await doc.ref.update({ nfce_pendente: admin.firestore.FieldValue.delete() });
      } catch (err: any) {
        console.error(`[retry fiscal] pedido ${doc.id} (nfce_pendente):`, err?.message || err);
      }
    }

    await recuperarNotasProcessandoTravadas(cfg, cert);
  }

  const erroRede = await db().collection('notas_fiscais').where('status', '==', 'ERRO_REDE').get();
  if (erroRede.size) console.log(`[retry fiscal] ${erroRede.size} nota(s) em ERRO_REDE.`);
  for (const doc of erroRede.docs) {
    await reemitirNotaComErroDeRede(doc, cert)
      .catch((err) => console.error(`[retry fiscal] nota ${doc.id} (ERRO_REDE):`, err?.message || err));
  }

  const contingencia = await db().collection('notas_fiscais').where('status', '==', 'CONTINGENCIA').get();
  if (contingencia.size) console.log(`[retry fiscal] ${contingencia.size} nota(s) em CONTINGENCIA.`);
  for (const doc of contingencia.docs) {
    await transmitirNotaEmContingencia(doc, cfg, cert)
      .catch((err) => console.error(`[retry fiscal] nota ${doc.id} (CONTINGENCIA):`, err?.message || err));
  }

  console.log('[retry fiscal] ciclo concluído.');
}
