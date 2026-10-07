// ============================================================
//  Sincronização das notas recebidas (Distribuição DFe) feita NO SERVIDOR.
//
//  Antes: só rodava quando alguém clicava em "Sincronizar SEFAZ", trazia no
//  máximo 50 documentos por clique e o painel gravava o resultado. Ficou parada
//  de 13/08 a 07/10 (106 documentos atrás) e notas de compra novas não chegavam.
//
//  Regras da SEFAZ que este módulo respeita (senão ela responde 656 "Consumo
//  Indevido" e bloqueia o CNPJ por 1 hora):
//    - nunca repetir a consulta com o MESMO ultNSU (sempre avançar);
//    - 137 (nenhum documento) ou ter alcançado o maxNSU: esperar 1 hora;
//    - 656: esperar 1 hora.
//  O "próximo horário permitido" fica gravado (dfeProximaConsultaApos) e vale
//  para o agendador e para o botão. Uma trava impede duas consultas simultâneas
//  (botão + agendador), que repetiriam o mesmo ultNSU.
// ============================================================
import * as admin from 'firebase-admin';
import * as fs from 'fs';
import { CertInput, sincronizarDfe } from './nfce';
import { carregarCertificado } from './cert-store';

function db(): admin.firestore.Firestore {
  if (!admin.apps.length) admin.initializeApp();
  return admin.firestore();
}

export const ESPERA_SEFAZ_MS = 61 * 60 * 1000;      // 1h pedida pela SEFAZ + 1min de folga
const MAX_PAGINAS = 12;                              // 50 documentos por página
const PAUSA_ENTRE_PAGINAS_MS = 1500;
const TRAVA_MS = 5 * 60 * 1000;

export interface ResultadoSyncDfe {
  status: 'OK' | 'AGUARDANDO' | 'EM_ANDAMENTO' | 'ERRO' | 'CONFIG';
  novos: number;
  paginas: number;
  ultNSU?: string;
  maxNSU?: string;
  cStat?: string;
  motivo?: string;
  proximaConsultaApos?: number | null;   // epoch ms
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nsuNum = (v?: string) => Number(String(v || '0').replace(/\D/g, '')) || 0;

function salvarDocumento(batch: admin.firestore.WriteBatch, doc: any, now: admin.firestore.FieldValue, vistos: Set<string>) {
  const id = doc.chave || doc.nsu;
  if (!id) return;
  // JSON: o Firestore recusa campos undefined (resumos não têm itens, etc.).
  const limpo = JSON.parse(JSON.stringify(doc));
  batch.set(db().collection('dfe_documentos').doc(String(id)), { ...limpo, atualizado_em: now, criado_em: now }, { merge: true });
  const cnpjForn = String(doc.cnpjEmitente || '').replace(/\D/g, '');
  if (cnpjForn && !vistos.has(cnpjForn)) {
    vistos.add(cnpjForn);
    batch.set(db().collection('fornecedores').doc(cnpjForn), {
      nome: doc.emitente || cnpjForn, cnpj: cnpjForn, fone: doc.foneEmitente || null, atualizado_em: now,
    }, { merge: true });
  }
}

// Trava contra duas sincronizacoes ao mesmo tempo (botao + agendador): repetiriam o
// mesmo ultNSU e a SEFAZ bloquearia por 1h (656). Usa create() — falha de forma
// atomica se o documento ja existe — em vez de transacao de leitura/escrita, que
// nao garante exclusao mutua entre duas chamadas simultaneas. Trava esquecida
// (processo que caiu) vale por TRAVA_MS e depois e retomada.
function refTrava(): admin.firestore.DocumentReference {
  return db().collection('dfe_travas').doc('sincronizacao');
}
async function adquirirTrava(): Promise<boolean> {
  const ref = refTrava();
  try {
    await ref.create({ em: admin.firestore.Timestamp.now() });
    return true;
  } catch (err: any) {
    const jaExiste = err?.code === 6 || /ALREADY_EXISTS|already exists/i.test(String(err?.message || ''));
    if (!jaExiste) throw err;
  }
  const atual = ((await ref.get()).data() || {}) as any;
  const desde = atual.em && atual.em.toMillis ? atual.em.toMillis() : 0;
  if (desde && Date.now() - desde < TRAVA_MS) return false;
  // Trava vencida: retoma de forma condicional (so um concorrente consegue).
  return db().runTransaction(async (tx) => {
    const d = ((await tx.get(ref)).data() || {}) as any;
    const t = d.em && d.em.toMillis ? d.em.toMillis() : 0;
    if (t && Date.now() - t < TRAVA_MS) return false;
    tx.set(ref, { em: admin.firestore.Timestamp.now() });
    return true;
  });
}

// `deps` existe so para teste (consulta e pausa substituiveis); em producao usa os padroes.
export interface DepsSyncDfe { consultar?: typeof sincronizarDfe; pausa?: (ms: number) => Promise<void>; }

export async function sincronizarDfeServidor(cert: CertInput, deps: DepsSyncDfe = {}): Promise<ResultadoSyncDfe> {
  const consultar = deps.consultar || sincronizarDfe;
  const pausa = deps.pausa || dormir;
  const ref = db().collection('configuracoes').doc('fiscal');
  const cfg = ((await ref.get()).data() || {}) as any;
  if (!cfg.cnpj || !cfg.uf) return { status: 'CONFIG', novos: 0, paginas: 0, motivo: 'CNPJ/UF da empresa ausentes em Config fiscal.' };

  const libera = cfg.dfeProximaConsultaApos && cfg.dfeProximaConsultaApos.toMillis ? cfg.dfeProximaConsultaApos.toMillis() : 0;
  if (libera > Date.now()) {
    return {
      status: 'AGUARDANDO', novos: 0, paginas: 0, ultNSU: cfg.dfeUltNSU, maxNSU: cfg.dfeMaxNSU, proximaConsultaApos: libera,
      motivo: 'A SEFAZ so permite nova consulta depois desse horario.',
    };
  }
  if (!(await adquirirTrava())) {
    return { status: 'EM_ANDAMENTO', novos: 0, paginas: 0, ultNSU: cfg.dfeUltNSU, maxNSU: cfg.dfeMaxNSU, motivo: 'Ja existe uma sincronizacao em andamento.' };
  }

  let ultNSU: string = cfg.dfeUltNSU || '0';
  let maxNSU: string | undefined = cfg.dfeMaxNSU;
  let novos = 0, paginas = 0;
  let resultado: ResultadoSyncDfe = { status: 'OK', novos: 0, paginas: 0 };
  try {
    while (paginas < MAX_PAGINAS) {
      let r;
      try {
        r = await consultar({ ambiente: cfg.ambiente || 'homologacao', uf: cfg.uf, cnpj: cfg.cnpj, ultNSU }, cert);
      } catch (err: any) {
        // Falha de rede/transporte: nao e culpa do consumo, tenta no proximo ciclo.
        resultado = { status: 'ERRO', novos, paginas, ultNSU, maxNSU, motivo: err?.message || String(err) };
        break;
      }
      paginas++;

      if (r.cStat === '138') {
        const batch = db().batch();
        const now = admin.firestore.FieldValue.serverTimestamp();
        const vistos = new Set<string>();
        // Um "resumo" (resNFe) nunca rebaixa uma nota que ja temos completa (importada
        // pelo XML ou lancada no estoque): a SEFAZ costuma mandar o resumo antes, mas
        // numa pagina posterior ele pode reaparecer para uma nota que ja esta completa.
        const refsResumo = r.documentos.filter((d: any) => d.resumo && (d.chave || d.nsu)).map((d: any) => db().collection('dfe_documentos').doc(String(d.chave || d.nsu)));
        const jaCompletos = new Set<string>();
        if (refsResumo.length) {
          (await db().getAll(...refsResumo)).forEach((snap) => { if (snap.exists && (snap.data() as any).resumo === false) jaCompletos.add(snap.id); });
        }
        r.documentos.forEach((d: any) => {
          if (d.resumo && jaCompletos.has(String(d.chave || d.nsu))) return;
          salvarDocumento(batch, d, now, vistos);
        });
        const novoUlt = r.ultNSU || ultNSU;
        batch.set(ref, { dfeUltNSU: novoUlt, dfeMaxNSU: r.maxNSU || maxNSU || novoUlt, dfeSincronizadoEm: now }, { merge: true });
        await batch.commit();                      // progresso salvo a cada pagina
        novos += r.documentos.length;
        const avancou = nsuNum(novoUlt) > nsuNum(ultNSU);
        ultNSU = novoUlt; maxNSU = r.maxNSU || maxNSU;
        if (!avancou || nsuNum(ultNSU) >= nsuNum(maxNSU)) {
          resultado = { status: 'OK', novos, paginas, ultNSU, maxNSU, cStat: '138', proximaConsultaApos: Date.now() + ESPERA_SEFAZ_MS, motivo: 'Em dia com a SEFAZ.' };
          break;
        }
        await pausa(PAUSA_ENTRE_PAGINAS_MS);
        continue;
      }

      if (r.cStat === '137') {                     // nenhum documento novo: SEFAZ pede 1h
        resultado = { status: 'OK', novos, paginas, ultNSU: r.ultNSU || ultNSU, maxNSU: r.maxNSU || maxNSU, cStat: '137', proximaConsultaApos: Date.now() + ESPERA_SEFAZ_MS, motivo: 'Nenhuma nota nova.' };
        break;
      }

      // Qualquer outra resposta (656 consumo indevido, 108/109 fora do ar, ...).
      const espera = r.cStat === '656';
      resultado = {
        status: espera ? 'AGUARDANDO' : 'ERRO', novos, paginas, ultNSU, maxNSU, cStat: r.cStat, motivo: r.motivo,
        proximaConsultaApos: espera ? Date.now() + ESPERA_SEFAZ_MS : null,
      };
      break;
    }
    if (paginas >= MAX_PAGINAS && resultado.status === 'OK' && !resultado.proximaConsultaApos && nsuNum(ultNSU) < nsuNum(maxNSU)) {
      resultado = { status: 'OK', novos, paginas, ultNSU, maxNSU, motivo: 'Ainda ha notas para baixar; continua na proxima rodada.' };
    }
    if (resultado.status === 'OK' && !resultado.paginas) resultado = { ...resultado, novos, paginas, ultNSU, maxNSU };
  } finally {
    await refTrava().delete().catch((e) => console.error('[dfe] nao consegui liberar a trava:', e?.message || e));
    const fim: Record<string, any> = {
      dfeUltimoStatus: {
        status: resultado.status, cStat: resultado.cStat || null, motivo: resultado.motivo || null, novos: resultado.novos,
        em: admin.firestore.Timestamp.now(),
      },
    };
    if (resultado.proximaConsultaApos) fim.dfeProximaConsultaApos = admin.firestore.Timestamp.fromMillis(resultado.proximaConsultaApos);
    await ref.set(fim, { merge: true }).catch((e) => console.error('[dfe] nao consegui gravar o estado:', e?.message || e));
  }
  return resultado;
}

// Entrada do agendador: obtém o certificado do mesmo jeito do retry fiscal.
export async function sincronizarDfeAgendado(): Promise<ResultadoSyncDfe | null> {
  const cfg = ((await db().collection('configuracoes').doc('fiscal').get()).data() || {}) as any;
  if (!cfg.ativo) return null;
  let cert: CertInput | null = null;
  try {
    const c = await carregarCertificado();
    if (c && c.buffer) cert = { buffer: c.buffer, password: c.senha || process.env.CERT_PASSWORD || '' };
  } catch { /* cai no arquivo local */ }
  const caminho = process.env.CERT_PATH || '';
  if (!cert && caminho && fs.existsSync(caminho)) cert = { pfxPath: caminho, password: process.env.CERT_PASSWORD || '' };
  if (!cert || !cert.password) { console.log('[dfe] certificado A1 indisponivel — pulando.'); return null; }
  const r = await sincronizarDfeServidor(cert);
  console.log(`[dfe] ${r.status} | novos=${r.novos} paginas=${r.paginas} ultNSU=${r.ultNSU} maxNSU=${r.maxNSU} ${r.cStat || ''} ${r.motivo || ''}`);
  return r;
}
