// ============================================================
//  Grava o resultado de uma emissão na nota (notas_fiscais/{id}).
//
//  Antes só o NAVEGADOR do caixa gravava o resultado, depois de receber a resposta do
//  servidor. Se ele perdia a resposta (aba congelada, rede instável, página recarregada),
//  a SEFAZ já tinha autorizado mas a nota ficava "Processando" até a rotina automática
//  (a cada 20 min) reenviar e conciliar — em 20/10 duas notas levaram 5 e 9 minutos, bem
//  na hora de imprimir o cupom. Agora o próprio servidor grava, antes de responder.
//  É idempotente com a gravação do navegador (mesmos campos).
// ============================================================
import * as admin from 'firebase-admin';
import { AvulsaRequest, AvulsaResult } from './nfce';
import { podeGravarResultado } from './regras-fiscais';

function db(): admin.firestore.Firestore {
  if (!admin.apps.length) admin.initializeApp();
  return admin.firestore();
}

export async function gravarResultado(ref: admin.firestore.DocumentReference, data: AvulsaResult, payload: AvulsaRequest): Promise<void> {
  const emContingencia = data.status === 'CONTINGENCIA';
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const atual = (snap.data() as any).status;
    if (!podeGravarResultado(atual, data.status)) {
      console.warn(`[resultado] nota ${ref.id} já está ${atual} — resultado ${data.status} de envio concorrente descartado.`);
      return;
    }
    if (data.transitorio) {
      tx.update(ref, {
        status: 'ERRO_REDE', cStat: data.cStat || null,
        motivo: `SEFAZ sem veredito (${data.cStat || '-'}: ${data.motivo || 'sem resposta'}) — reenviando a mesma nota automaticamente.`,
        payload_pendente: JSON.parse(JSON.stringify(payload)),
      });
      return;
    }
    tx.update(ref, {
      status: data.status,
      chave: data.chave || null,
      protocolo: data.protocolo || null,
      cStat: data.cStat || null,
      motivo: data.motivo || null,
      danfeBase64: data.danfeBase64 || null,
      xml: data.xml || null,
      xmlProc: data.xmlProc || null,
      formaEmissao: emContingencia ? 'CONTINGENCIA' : 'NORMAL',
      contingencia: !!data.contingencia,
      xmlAssinado: emContingencia ? (data.xml || null) : null,
      payload_pendente: admin.firestore.FieldValue.delete(),
      // Os XMLs de cada envio só servem pra reconhecer uma autorização perdida.
      ...(data.status === 'AUTORIZADA' ? { xml_enviado: admin.firestore.FieldValue.delete() } : {}),
    });
  });
}

// Chamado pela rota de emissão: nunca derruba a resposta ao navegador (que continua
// podendo gravar o resultado por conta própria).
export async function gravarResultadoDaNota(notaId: string | undefined, data: AvulsaResult, payload: AvulsaRequest): Promise<void> {
  if (!notaId) return;
  try {
    await gravarResultado(db().collection('notas_fiscais').doc(String(notaId)), data, payload);
  } catch (err: any) {
    console.error(`[resultado] nao consegui gravar a nota ${notaId} (o navegador ainda pode gravar):`, err?.message || err);
  }
}
