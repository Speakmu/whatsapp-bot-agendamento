// ============================================================
//  Classificação fiscal POR ITEM, vinda do cadastro do cardápio.
//
//  O pedido guarda cada item só com id/nome/preço/quantidade — quase nunca com
//  NCM/CFOP/CSOSN. Quem monta a nota (painel e agendador) usava
//  "valor do item || padrão da Config fiscal", então TODA nota saía com o padrão
//  (CFOP 5102 / CSOSN 102 / NCM 19059090), inclusive refrigerante, que no
//  cardápio é 5405 / 500 / 22021000. A fonte da verdade é o cardápio: aqui cada
//  item é ligado ao produto (pelo id, ou pelo nome) e recebe a classificação dele.
//  Valor que não está no cadastro (ou está em formato inválido) mantém o padrão.
// ============================================================
import * as admin from 'firebase-admin';
import { CertInput, AvulsaRequest, AvulsaResult, emitirNfceAvulsa } from './nfce';
import { RegistroXml } from './xml-enviado';

export interface ProdutoCardapio {
  id: string;
  nome?: string;
  nome_exibicao?: string;
  apelidos?: string[];
  ncm?: string;
  cfop?: string;
  csosn?: string;
  cst?: string;
  origem?: string;
}

export interface ResultadoClassificacao { aplicados: number; semProduto: string[]; incompletos: string[]; }

export function normalizarNomeProduto(s: unknown): string {
  return String(s ?? '').trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

const soDigitos = (v: unknown) => String(v ?? '').replace(/\D/g, '');

// Só aceita o que tem formato de código fiscal; lixo no cadastro não pode virar XML inválido.
function ncmValido(v: unknown): string | null { const d = soDigitos(v); return /^\d{8}$/.test(d) ? d : null; }
function cfopValido(v: unknown): string | null { const d = soDigitos(v); return /^\d{4}$/.test(d) ? d : null; }
function csosnValido(v: unknown): string | null { const d = soDigitos(v); return /^\d{2,3}$/.test(d) ? d : null; }
function origemValida(v: unknown): string | null { const t = String(v ?? '').trim(); return /^[0-8]$/.test(t) ? t : null; }

// Liga os itens aos produtos e aplica a classificação. Função pura (testável sem banco).
export function aplicarClassificacao(items: any[], produtos: ProdutoCardapio[]): ResultadoClassificacao {
  const porId = new Map<string, ProdutoCardapio>();
  const porNome = new Map<string, ProdutoCardapio>();
  produtos.forEach((p) => {
    porId.set(String(p.id), p);
    [p.nome_exibicao, p.nome, ...(p.apelidos || [])].forEach((n) => {
      const k = normalizarNomeProduto(n);
      if (k && !porNome.has(k)) porNome.set(k, p);
    });
  });

  let aplicados = 0;
  const semProduto: string[] = [];
  const incompletos: string[] = [];
  items.forEach((it) => {
    const prod = (it.produtoId && porId.get(String(it.produtoId))) || porNome.get(normalizarNomeProduto(it.xProd));
    if (!prod) { semProduto.push(String(it.xProd || '?')); return; }
    const ncm = ncmValido(prod.ncm), cfop = cfopValido(prod.cfop), csosn = csosnValido(prod.csosn || prod.cst), origem = origemValida(prod.origem);
    // CFOP e CSOSN andam JUNTOS (ex.: 5405 + 500): aplicar so um deles produziria uma combinacao
    // incoerente (CSOSN 500 com CFOP 5102) que a SEFAZ pode recusar. Cadastro com so um dos dois
    // mantem o padrao nos dois e vai para a lista de incompletos.
    const par = !!(cfop && csosn);
    if (!par && (cfop || csosn)) incompletos.push(String(prod.nome_exibicao || prod.nome || prod.id));
    if (ncm) it.ncm = ncm;
    if (par) { it.cfop = cfop!; it.csosn = csosn!; }
    if (origem) it.origem = origem;
    if (ncm || par || origem) aplicados++;
  });
  return { aplicados, semProduto, incompletos };
}

// ---- leitura do cardápio (cache curto: uma emissão não deve custar 116 leituras) ----
let cache: { em: number; produtos: ProdutoCardapio[] } | null = null;
const CACHE_MS = 60 * 1000;

async function carregarCardapio(): Promise<ProdutoCardapio[]> {
  if (cache && Date.now() - cache.em < CACHE_MS) return cache.produtos;
  if (!admin.apps.length) admin.initializeApp();
  const snap = await admin.firestore().collection('cardapio').get();
  const produtos = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as ProdutoCardapio[];
  cache = { em: Date.now(), produtos };
  return produtos;
}

// Aplica no payload da emissão. Se o cardápio não puder ser lido, segue com o padrão
// (e registra no log) — emitir com o padrão é melhor que travar a venda.
export async function aplicarClassificacaoDoCardapio(items: any[], produtos?: ProdutoCardapio[]): Promise<ResultadoClassificacao> {
  try {
    const r = aplicarClassificacao(items, produtos || await carregarCardapio());
    if (r.incompletos.length) console.warn(`[classificacao] cadastro com CFOP ou CSOSN faltando (ficam com o padrao nos dois): ${[...new Set(r.incompletos)].join(' | ')}`);
    if (r.semProduto.length) console.warn(`[classificacao] itens sem produto no cardapio (ficam com o padrao fiscal): ${r.semProduto.join(' | ')}`);
    return r;
  } catch (err: any) {
    console.error('[classificacao] nao consegui ler o cardapio — emitindo com o padrao fiscal:', err?.message || err);
    return { aplicados: 0, semProduto: items.map((i) => String(i.xProd || '?')), incompletos: [] };
  }
}

// Ponto único de emissão para servidor e agendador: classifica e emite.
export async function emitirNfceComClassificacao(
  payload: AvulsaRequest, cert: CertInput, registro?: RegistroXml,
): Promise<AvulsaResult> {
  await aplicarClassificacaoDoCardapio(payload.items);
  return emitirNfceAvulsa(payload, cert, registro);
}
