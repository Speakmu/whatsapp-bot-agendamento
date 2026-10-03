// ============================================================
//  Guarda o XML assinado de cada envio ANTES de transmitir à SEFAZ, no próprio
//  documento da nota (notas_fiscais/{id}.xml_enviado).
//
//  Por que existe: a nota pode ser autorizada e a resposta se perder. Quando
//  ela é reconhecida depois (consulta por chave), o XML que temos em mãos é o
//  de OUTRA tentativa — reassinado com outra hora, ou o da contingência — e não
//  bate com o protocolo. Sem o XML original não existe arquivo válido pra
//  contabilidade. Com isto, basta procurar o XML cujo digest é o do protocolo.
// ============================================================
import * as admin from 'firebase-admin';
import * as crypto from 'crypto';
import { digestDoXml, xmlsDaNota } from './regras-fiscais';

function db(): admin.firestore.Firestore {
  if (!admin.apps.length) admin.initializeApp();
  return admin.firestore();
}

// Uma nota reenviada várias vezes não pode crescer sem limite (documento do
// Firestore tem teto de 1 MB): ficam só os envios mais recentes.
const MAX_ENVIOS_GUARDADOS = 4;

export interface RegistroXml {
  guardar(xml: string): Promise<void>;
  candidatos(): Promise<string[]>;
}

export function registroXmlDaNota(notaId: string): RegistroXml {
  const ref = db().collection('notas_fiscais').doc(notaId);
  return {
    async guardar(xml: string) {
      const digest = digestDoXml(xml);
      if (!digest) return;
      const id = crypto.createHash('sha1').update(digest).digest('hex').slice(0, 16);
      await db().runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return;
        const atual: Record<string, any> = { ...((snap.data() as any).xml_enviado || {}) };
        atual[id] = { xml, em: Date.now() };
        const maisNovos = Object.entries(atual)
          .sort((a, b) => (b[1]?.em || 0) - (a[1]?.em || 0))
          .slice(0, MAX_ENVIOS_GUARDADOS);
        tx.update(ref, { xml_enviado: Object.fromEntries(maisNovos) });
      });
    },
    async candidatos() {
      const snap = await ref.get();
      return snap.exists ? xmlsDaNota(snap.data()) : [];
    },
  };
}
