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
import { CertInput, consultarNfcePorChave, chaveNormalCalculada, danfeDeNotaAutorizada, xmlsParaContabilidade } from './nfce';
import { nfeProcDe } from './xml-proc';
import { xmlAutorizado, xmlsDaNota, precisaCompletarXml } from './regras-fiscais';

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
        // Só junta o protocolo com o XML que a SEFAZ de fato autorizou (digest
        // igual ao do protocolo). O XML gravado na nota pode ser de outra
        // tentativa — o da contingência, por exemplo, que tem outra chave.
        const xmlCerto = xmlAutorizado(xmlsDaNota(n), r.rawResponse);
        const xmlProc = xmlCerto ? nfeProcDe(xmlCerto, r.rawResponse) : undefined;
        const danfeBase64 = xmlCerto ? await danfeDeNotaAutorizada(xmlCerto, chave, r.nProt, r.dhRecbto) : undefined;
        await doc.ref.update({
          status: 'AUTORIZADA', chave, protocolo: r.nProt, cStat: '100',
          motivo: 'Autorizado o uso da NF-e (conciliada com a SEFAZ antes de nova emissão)'
            + (xmlCerto ? '' : ' — XML autorizado não está guardado.'),
          formaEmissao: 'NORMAL', contingencia: false, xmlAssinado: null,
          ...(xmlCerto ? { xml: xmlCerto } : {}),
          ...(xmlProc ? { xmlProc } : {}),
          ...(danfeBase64 ? { danfeBase64 } : {}),
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
  const snap = await db().collection('notas_fiscais').where('criado_em', '>=', desde).select('status', 'pedido_id', 'nNF').get();
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

// Completa, no ciclo automatico, o XML de distribuicao (nfeProc) e o evento de
// cancelamento que ficaram sem gravar: nota autorizada por uma tela desatualizada,
// cancelamento feito pelo painel (guarda so o evento sem protocolo), conciliacao
// sem XML. So junta o protocolo com o XML cujo digest bate (ver xmlsParaContabilidade);
// se nenhum bate, marca xml_proc_indisponivel e nao tenta de novo. Limita a
// quantidade por ciclo para nao estourar o tempo da function.
export async function completarXmlsFaltantes(cert: CertInput, dias = 7, max = 40): Promise<number> {
  const cfgSnap = await db().collection('configuracoes').doc('fiscal').get();
  const cfg = (cfgSnap.exists ? cfgSnap.data() : {}) as any;
  if (!cfg.uf) return 0;
  const desde = admin.firestore.Timestamp.fromMillis(Date.now() - dias * 86400000);
  // select(): sem o DANFE (PDF em base64), que e o campo mais pesado da nota.
  const snap = await db().collection('notas_fiscais').where('criado_em', '>=', desde)
    .select('status', 'tipo', 'chave', 'ambiente', 'xml', 'xmlAssinado', 'xml_enviado', 'xmlProc', 'xml_proc_indisponivel', 'cancelamento').get();
  let feitas = 0;
  for (const doc of snap.docs) {
    if (feitas >= max) break;
    const n = doc.data();
    if (!precisaCompletarXml(n)) continue;
    feitas++;
    try {
      const xmls = xmlsDaNota(n);
      const r = await xmlsParaContabilidade({ ambiente: n.ambiente || cfg.ambiente || 'homologacao', uf: cfg.uf, chave: n.chave, xmls }, cert);
      const upd: Record<string, any> = {};
      if (!n.xmlProc && xmls.length) {
        if (r.xmlProc) upd.xmlProc = r.xmlProc; else upd.xml_proc_indisponivel = true;
      }
      if (n.status === 'CANCELADA' && !(n.cancelamento && n.cancelamento.xmlProcEvento) && r.eventosCancelamento[0]) {
        upd['cancelamento.xmlProcEvento'] = r.eventosCancelamento[0];
      }
      if (Object.keys(upd).length) {
        await doc.ref.update(upd);
        console.log(`[xml] nota ${doc.id} (${n.chave}): ${Object.keys(upd).join(', ')}`);
      }
    } catch (err: any) {
      console.warn(`[xml] nota ${doc.id}: ${err?.message || err}`);
    }
  }
  return feitas;
}
