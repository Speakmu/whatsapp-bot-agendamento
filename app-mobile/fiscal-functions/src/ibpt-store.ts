// ============================================================
//  Consulta e cache de alíquotas do IBPT ("De Olho no Imposto"),
//  usado para a linha de "Valor aproximado dos tributos" exigida
//  pela Lei 12.741/2012 (Lei da Transparência).
//
//  API oficial: https://apidoni.ibpt.org.br/api/v1/produtos
//  Requer um token gratuito, gerado cadastrando a empresa (CNPJ) em
//  https://deolhonoimposto.ibpt.org.br — token informado em Config fiscal.
//
//  Como a consulta por item a cada venda seria lenta e sujeita a falhas
//  da API do IBPT, o resultado por NCM é cacheado no Firestore e só é
//  atualizado quando expira (30 dias) ou vence a vigência informada pelo
//  próprio IBPT. Falha na API nunca bloqueia a emissão: usa o último
//  valor em cache (mesmo vencido) ou 0.
//  Doc: ibpt_cache/{uf}_{ncm}_{ex} { nacional, estadual, importado, municipal, vigenciaFim, atualizado_em }
// ============================================================
import * as admin from 'firebase-admin';

const CACHE_DIAS = 30;
const IBPT_URL = 'https://apidoni.ibpt.org.br/api/v1/produtos';

let iniciado = false;
function db(): admin.firestore.Firestore {
  if (!iniciado) {
    if (!admin.apps.length) {
      const credPath = process.env.FIREBASE_ADMIN_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS;
      if (credPath) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const cred = require(credPath);
        admin.initializeApp({ credential: admin.credential.cert(cred) });
      } else {
        admin.initializeApp();
      }
    }
    iniciado = true;
  }
  return admin.firestore();
}

export interface AliquotaIBPT {
  nacional: number;
  estadual: number;
  importado: number;
  municipal: number;
}

function docId(uf: string, ncm: string, ex: string): string {
  return `${uf}_${ncm}_${ex || '0'}`;
}

function todasZeradas(d: any): boolean {
  return !(Number(d?.nacional) || Number(d?.estadual) || Number(d?.importado) || Number(d?.municipal));
}

function cacheValido(d: any): boolean {
  if (!d || !d.atualizado_em?.toDate) return false;
  // Nunca confia num resultado com as 4 aliquotas zeradas — isso normalmente indica
  // uma falha antiga da consulta que foi gravada em cache por engano; força nova tentativa.
  if (todasZeradas(d)) return false;
  const idadeDias = (Date.now() - d.atualizado_em.toDate().getTime()) / 86400000;
  if (idadeDias > CACHE_DIAS) return false;
  if (d.vigenciaFim) {
    const fim = new Date(d.vigenciaFim);
    if (!isNaN(fim.getTime()) && fim.getTime() < Date.now()) return false;
  }
  return true;
}

function num(v: any): number {
  const n = parseFloat(String(v ?? '0').replace(',', '.'));
  return isNaN(n) ? 0 : n;
}

async function consultarApi(ncm: string, uf: string, cnpj: string, token: string, ex: string): Promise<AliquotaIBPT & { vigenciaFim?: string }> {
  const params = new URLSearchParams({
    token, cnpj: cnpj.replace(/\D/g, ''), codigo: ncm, uf, ex: ex || '0',
    descricao: 'produto', unidadeMedida: 'UN', valor: '0', gtin: 'SEMGTIN',
  });
  const url = `${IBPT_URL}?${params.toString()}`;
  console.log(`[IBPT] consultando NCM ${ncm} UF ${uf}: ${url.replace(token, '***')}`);
  const inicio = Date.now();
  let resp: Response;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(25000) });
  } catch (err: any) {
    console.error(`[IBPT] fetch falhou após ${Date.now() - inicio}ms: ${err?.name || ''} ${err?.message || err}`);
    throw err;
  }
  console.log(`[IBPT] respondeu HTTP ${resp.status} em ${Date.now() - inicio}ms`);
  const bodyText = await resp.text();
  if (!resp.ok) {
    console.error(`[IBPT] resposta HTTP ${resp.status}: ${bodyText.slice(0, 500)}`);
    throw new Error(`IBPT respondeu ${resp.status}`);
  }
  console.log(`[IBPT] resposta bruta: ${bodyText.slice(0, 500)}`);
  const data: any = JSON.parse(bodyText);
  return {
    nacional: num(data.Nacional), estadual: num(data.Estadual),
    importado: num(data.Importado), municipal: num(data.Municipal),
    vigenciaFim: data.VigenciaFim || undefined,
  };
}

// Pré-aquece o cache para uma lista de NCMs (ex: todo o cardápio), em segundo
// plano, com um pequeno intervalo entre chamadas para não sobrecarregar a API
// do IBPT. Não lança erro — cada item é best-effort (já logado em obterAliquotaIBPT).
export async function prewarmAliquotas(
  itens: { ncm: string; uf: string; cnpj: string; token: string; ex?: string }[],
): Promise<void> {
  const vistos = new Set<string>();
  for (const it of itens) {
    if (!it.ncm) continue;
    const chave = docId(it.uf, it.ncm, it.ex || '0');
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    await obterAliquotaIBPT(it.ncm, it.uf, it.cnpj, it.token, it.ex);
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`[IBPT] pré-aquecimento concluído: ${vistos.size} NCM(s) distintos processados.`);
}

// Retorna a alíquota (%) para o NCM informado, usando cache do Firestore.
// Nunca lança: em caso de falha da API, devolve o cache vencido (se houver) ou zeros.
export async function obterAliquotaIBPT(ncm: string, uf: string, cnpj: string, token: string, ex = '0'): Promise<AliquotaIBPT> {
  const ref = db().collection('ibpt_cache').doc(docId(uf, ncm, ex));
  let cache: any = null;
  try {
    const snap = await ref.get();
    if (snap.exists) cache = snap.data();
  } catch { /* Firestore indisponível — tenta API mesmo assim */ }

  if (cacheValido(cache)) {
    return { nacional: cache.nacional, estadual: cache.estadual, importado: cache.importado, municipal: cache.municipal };
  }

  try {
    const fresco = await consultarApi(ncm, uf, cnpj, token, ex);
    // Só grava em cache se não vier tudo zerado (evita perpetuar uma resposta ruim por 30 dias).
    if (!todasZeradas(fresco)) {
      try {
        await ref.set({ ...fresco, atualizado_em: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      } catch { /* cache é best-effort */ }
    }
    return fresco;
  } catch (err: any) {
    console.error(`[IBPT] falha na consulta (NCM ${ncm}, UF ${uf}): ${err?.message || err}`);
    if (cache) return { nacional: cache.nacional, estadual: cache.estadual, importado: cache.importado, municipal: cache.municipal };
    return { nacional: 0, estadual: 0, importado: 0, municipal: 0 };
  }
}
