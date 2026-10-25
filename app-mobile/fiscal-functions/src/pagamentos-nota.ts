// ============================================================
//  Pagamentos de um pedido (conta dividida) e como eles viram <detPag> na NFC-e.
//
//  Modelo no pedido (gravado pelo PDV):
//    pagamentos: [{ forma, valor, recebido? }]   valor = quanto da CONTA este pagamento quitou;
//                                                recebido = quanto o cliente entregou (so dinheiro,
//                                                pode passar do valor: a diferenca e o troco)
//    conta_dividida: true, conta_aberta: true enquanto faltar quitar
//  Pedido antigo (sem `pagamentos`) = um pagamento so, com forma_pagamento e valor_total.
//
//  Esta e a LEITURA UNICA do lado do servidor; o painel tem a espelhada em
//  dashboard/public/pagamentos-pedido.js (os dois sao testados com os mesmos casos).
// ============================================================

export interface PagamentoPedido { forma: string; valor: number; recebido: number | null; }
export interface DetPagNota {
  tPag: string;
  xPag?: string;
  vPag: number;
  card?: { tpIntegra: '1' | '2'; tBand: string };
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const ehDinheiro = (forma: string) => /dinheiro/i.test(forma);

// Forma de pagamento (texto do PDV/app/bot) -> tPag da NF-e.
const TPAG: Array<[string, string]> = [
  ['dinheiro', '01'], ['pix', '17'], ['cartão', '03'], ['cartao', '03'],
  ['crédito', '03'], ['credito', '03'], ['débito', '04'], ['debito', '04'], ['entrega', '99'],
];
export function tPagDaForma(forma: string): string {
  const f = String(forma || '').toLowerCase();
  for (const [k, v] of TPAG) if (f.includes(k)) return v;
  return '01';
}

export function pagamentosDoPedido(p: any): PagamentoPedido[] {
  const lista = Array.isArray(p?.pagamentos) ? p.pagamentos : [];
  const validos: PagamentoPedido[] = lista
    .map((x: any) => ({
      forma: String(x?.forma ?? ''),
      valor: round2(Number(x?.valor) || 0),
      recebido: x?.recebido != null && isFinite(Number(x.recebido)) ? round2(Number(x.recebido)) : null,
    }))
    .filter((x: PagamentoPedido) => x.valor > 0);
  // Conta dividida ainda sem pagamento nao pode "ganhar" um pagamento inventado do forma_pagamento.
  if (validos.length || p?.conta_dividida) return validos;
  const valor = round2(Number(p?.valor_total) || 0);
  const forma = String(p?.forma_pagamento ?? '');
  return (forma || valor) ? [{ forma, valor, recebido: null }] : [];
}

export function somenteDinheiro(p: any): boolean {
  const l = pagamentosDoPedido(p);
  return l.length > 0 && l.every((x) => ehDinheiro(x.forma));
}

export function saldoDoPedido(p: any): number {
  const pago = pagamentosDoPedido(p).reduce((s, x) => s + x.valor, 0);
  return round2(Math.max(0, (Number(p?.valor_total) || 0) - pago));
}

export function quitada(p: any): boolean {
  const total = round2(Number(p?.valor_total) || 0);
  return total > 0 && saldoDoPedido(p) === 0 && pagamentosDoPedido(p).length > 0;
}

// Pagamentos -> <pag> da NFC-e. vPag e o valor ENTREGUE (no dinheiro inclui o troco);
// vTroco = soma dos trocos, e a regra do schema e: soma(vPag) - vTroco = vNF. Se nao
// bater (conta nao quitada, valor divergente), falha ANTES de gastar uma transmissao —
// a SEFAZ rejeitaria (ex.: 866 "ausencia de troco").
export function detPagParaNota(pagamentos: PagamentoPedido[], vNF: number): { detPag: DetPagNota[]; vTroco: number } {
  if (!pagamentos.length) throw new Error('Nenhum pagamento informado para a nota.');
  let vTroco = 0;
  const detPag = pagamentos.map((pg) => {
    const tPag = tPagDaForma(pg.forma);
    const entregue = tPag === '01' && pg.recebido != null && pg.recebido > pg.valor ? pg.recebido : pg.valor;
    if (tPag === '01') vTroco = round2(vTroco + (entregue - pg.valor));
    const item: DetPagNota = { tPag, vPag: round2(entregue) };
    if (tPag === '99') item.xPag = 'Pagamento na entrega';
    return item;
  });
  const soma = round2(detPag.reduce((s, d) => s + d.vPag, 0) - vTroco);
  if (Math.abs(soma - round2(vNF)) > 0.005) {
    throw new Error(`Os pagamentos (R$ ${soma.toFixed(2)}) nao fecham o total da nota (R$ ${round2(vNF).toFixed(2)}).`);
  }
  return { detPag, vTroco };
}
