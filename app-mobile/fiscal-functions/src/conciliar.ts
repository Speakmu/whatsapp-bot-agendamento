// ============================================================
//  Conciliação com a SEFAZ antes de pedir um NÚMERO NOVO para um pedido.
//
//  Por que existe: uma tentativa de emissão pode ser AUTORIZADA pela SEFAZ e a
//  resposta nunca chegar aqui (timeout, queda, função encerrada). O registro
//  fica em ERRO/REJEITADA sem chave/protocolo e, se emitirmos de novo com outro
//  número, a venda passa a ter DUAS NFC-e válidas (aconteceu em set/2026: 11
//  vendas duplicadas). Toda emissão que reserva número novo precisa passar por
//  aqui primeiro. Se não for possível consultar a SEFAZ, LANÇA erro — melhor
//  não emitir agora (a venda segue pendente e é tentada de novo) do que duplicar.
// ============================================================
import * as admin from 'firebase-admin';
import { CertInput, consultarNfcePorChave, chaveNormalCalculada } from './nfce';
import { nfeProcDe } from './xml-proc';

function db(): admin.firestore.Firestore {
  if (!admin.apps.length) admin.initializeApp();
  return admin.firestore();
}

// Só notas "mortas": as ativas (PROCESSANDO/ERRO_REDE/CONTINGENCIA) já bloqueiam
// uma nova emissão, e mexer nelas competiria com a emissão em andamento.
const STATUS_A_CONCILIAR = ['ERRO', 'REJEITADA'];

export async function conciliarNotasDoPedido(
  pedidoId: string, cert: CertInput,
): Promise<{ autorizada: boolean; nNF?: number; id?: string }> {
  const notas = await db().collection('notas_fiscais').where('pedido_id', '==', pedidoId).get();
  if (notas.docs.some((d) => d.data().status === 'AUTORIZADA')) {
    const d = notas.docs.find((x) => x.data().status === 'AUTORIZADA')!;
    return { autorizada: true, nNF: d.data().nNF, id: d.id };
  }

  const cfgSnap = await db().collection('configuracoes').doc('fiscal').get();
  const cfg = (cfgSnap.exists ? cfgSnap.data() : {}) as any;
  if (!cfg.uf || !cfg.cnpj) throw new Error('Configuração fiscal incompleta (uf/cnpj) — não dá pra conciliar.');

  for (const doc of notas.docs) {
    const n = doc.data();
    if (!STATUS_A_CONCILIAR.includes(n.status) || !n.nNF || n.tipo === 'INUTILIZACAO') continue;
    const criado = n.criado_em && typeof n.criado_em.toDate === 'function' ? n.criado_em.toDate() : new Date();

    // Chave gravada (se a tentativa chegou a registrar) + a recalculada da emissão
    // normal (tpEmis=1) — a contingência (tpEmis=9) reaproveita o mesmo nNF, e a
    // emissão normal anterior à queda pode ter sido a autorizada.
    const chaves = new Set<string>();
    if (n.chave) chaves.add(String(n.chave));
    chaves.add(chaveNormalCalculada({
      uf: cfg.uf, cnpj: cfg.cnpj, serie: Number(n.serie) || 1, nNF: Number(n.nNF),
      seed: `pedido-${pedidoId}`, quando: criado,
    }));

    for (const chave of chaves) {
      const r = await consultarNfcePorChave({ ambiente: n.ambiente || cfg.ambiente || 'homologacao', uf: cfg.uf, chave }, cert);
      if (r.cStat === '100' && r.nProt) {
        await doc.ref.update({
          status: 'AUTORIZADA', chave, protocolo: r.nProt, cStat: '100',
          motivo: 'Autorizado o uso da NF-e (conciliada com a SEFAZ antes de nova emissão)',
          formaEmissao: 'NORMAL', contingencia: false,
          ...(nfeProcDe(n.xml || n.xmlAssinado, r.rawResponse) ? { xmlProc: nfeProcDe(n.xml || n.xmlAssinado, r.rawResponse) } : {}),
          payload_pendente: admin.firestore.FieldValue.delete(),
        });
        console.log(`[conciliar] pedido ${pedidoId}: nota ${n.nNF} já estava AUTORIZADA na SEFAZ (${chave}) — não emite outra.`);
        return { autorizada: true, nNF: n.nNF, id: doc.id };
      }
    }
  }
  return { autorizada: false };
}

// Vigia: mais de uma NFC-e AUTORIZADA para o mesmo pedido (duplicidade). Grava um
// alerta em fiscal_alertas/{pedido_id} e loga — nunca altera as notas.
export async function auditarDuplicidades(dias = 3): Promise<void> {
  const desde = admin.firestore.Timestamp.fromMillis(Date.now() - dias * 86400000);
  const snap = await db().collection('notas_fiscais').where('criado_em', '>=', desde).get();
  const porPedido: Record<string, number[]> = {};
  snap.docs.forEach((d) => {
    const n = d.data();
    if (n.status === 'AUTORIZADA' && n.pedido_id) (porPedido[n.pedido_id] = porPedido[n.pedido_id] || []).push(n.nNF);
  });
  for (const [pedidoId, nums] of Object.entries(porPedido)) {
    if (nums.length < 2) continue;
    console.error(`[ALERTA fiscal] pedido ${pedidoId} tem ${nums.length} NFC-e AUTORIZADAS: ${nums.join(', ')}`);
    await db().collection('fiscal_alertas').doc(pedidoId).set({
      tipo: 'DUPLICIDADE', pedido_id: pedidoId, notas: nums, atualizado_em: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }
}
