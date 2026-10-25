// Conta dividida: leitura única dos pagamentos (servidor e painel dão a MESMA resposta) e como os
// pagamentos viram <detPag> na NFC-e (soma - troco = total, senão falha antes da SEFAZ).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const srv = require('../dist/pagamentos-nota');

// O arquivo do painel (navegador) é carregado do repositório e roda aqui do jeito que roda lá.
function carregarPainel() {
  const codigo = fs.readFileSync(path.join(__dirname, '../../../dashboard/public/pagamentos-pedido.js'), 'utf8');
  const janela = {};
  new Function('window', codigo)(janela);
  return janela.PagamentosPedido;
}
const painel = carregarPainel();

const casos = [
  { nome: 'pedido antigo: um pagamento com forma_pagamento e valor_total', p: { forma_pagamento: 'Cartão', valor_total: 46 },
    pagamentos: [{ forma: 'Cartão', valor: 46, recebido: null }], dinheiro: false, saldo: 0, quitada: true },
  { nome: 'pedido antigo em dinheiro', p: { forma_pagamento: 'Dinheiro', valor_total: 20 },
    pagamentos: [{ forma: 'Dinheiro', valor: 20, recebido: null }], dinheiro: true, saldo: 0, quitada: true },
  { nome: '"Dinheiro na entrega" conta como dinheiro (mesmo criterio de sempre)', p: { forma_pagamento: 'DINHEIRO NA ENTREGA', valor_total: 30 },
    pagamentos: [{ forma: 'DINHEIRO NA ENTREGA', valor: 30, recebido: null }], dinheiro: true, saldo: 0, quitada: true },
  { nome: 'conta dividida quitada: dinheiro + cartão', p: { valor_total: 46.2, forma_pagamento: 'Dividido', conta_dividida: true, pagamentos: [{ forma: 'Dinheiro', valor: 20, recebido: 50 }, { forma: 'Cartão', valor: 26.2 }] },
    pagamentos: [{ forma: 'Dinheiro', valor: 20, recebido: 50 }, { forma: 'Cartão', valor: 26.2, recebido: null }], dinheiro: false, saldo: 0, quitada: true },
  { nome: 'conta dividida só em dinheiro', p: { valor_total: 30, conta_dividida: true, pagamentos: [{ forma: 'Dinheiro', valor: 10 }, { forma: 'Dinheiro', valor: 20 }] },
    pagamentos: [{ forma: 'Dinheiro', valor: 10, recebido: null }, { forma: 'Dinheiro', valor: 20, recebido: null }], dinheiro: true, saldo: 0, quitada: true },
  { nome: 'conta parcial: falta pagar', p: { valor_total: 46.2, conta_dividida: true, conta_aberta: true, pagamentos: [{ forma: 'Cartão', valor: 20 }] },
    pagamentos: [{ forma: 'Cartão', valor: 20, recebido: null }], dinheiro: false, saldo: 26.2, quitada: false },
  { nome: 'conta dividida SEM pagamento ainda: não inventa pagamento a partir do forma_pagamento', p: { valor_total: 40, forma_pagamento: 'Cartão', conta_dividida: true, conta_aberta: true, pagamentos: [] },
    pagamentos: [], dinheiro: false, saldo: 40, quitada: false },
  { nome: 'centavos: 3 partes de uma conta de 10,00', p: { valor_total: 10, conta_dividida: true, pagamentos: [{ forma: 'PIX', valor: 3.33 }, { forma: 'PIX', valor: 3.33 }, { forma: 'PIX', valor: 3.34 }] },
    pagamentos: [{ forma: 'PIX', valor: 3.33, recebido: null }, { forma: 'PIX', valor: 3.33, recebido: null }, { forma: 'PIX', valor: 3.34, recebido: null }], dinheiro: false, saldo: 0, quitada: true },
  { nome: 'pagamento de valor zero/inválido é ignorado', p: { valor_total: 10, conta_dividida: true, pagamentos: [{ forma: 'PIX', valor: 0 }, { forma: 'PIX', valor: 'abc' }, { forma: 'PIX', valor: 10 }] },
    pagamentos: [{ forma: 'PIX', valor: 10, recebido: null }], dinheiro: false, saldo: 0, quitada: true },
  { nome: 'pedido sem forma e sem valor', p: {}, pagamentos: [], dinheiro: false, saldo: 0, quitada: false },
  { nome: 'pedido nulo', p: null, pagamentos: [], dinheiro: false, saldo: 0, quitada: false },
];

for (const c of casos) {
  test(`leitura única (servidor e painel iguais): ${c.nome}`, () => {
    assert.deepEqual(srv.pagamentosDoPedido(c.p), c.pagamentos, 'servidor: pagamentos');
    assert.deepEqual(painel.doPedido(c.p), c.pagamentos, 'painel: pagamentos');
    assert.equal(srv.somenteDinheiro(c.p), c.dinheiro, 'servidor: só dinheiro');
    assert.equal(painel.somenteDinheiro(c.p), c.dinheiro, 'painel: só dinheiro');
    assert.equal(srv.saldoDoPedido(c.p), c.saldo, 'servidor: saldo');
    assert.equal(painel.saldo(c.p), c.saldo, 'painel: saldo');
    assert.equal(srv.quitada(c.p), c.quitada, 'servidor: quitada');
    assert.equal(painel.quitada(c.p), c.quitada, 'painel: quitada');
  });
}

test('painel: resumo da forma de pagamento para listas e relatórios', () => {
  assert.equal(painel.resumo({ forma_pagamento: 'Cartão', valor_total: 5 }), 'Cartão');
  assert.equal(painel.resumo({ conta_dividida: true, valor_total: 5, pagamentos: [{ forma: 'Dinheiro', valor: 2 }, { forma: 'Cartão', valor: 3 }, { forma: 'Dinheiro', valor: 0.01 }] }), 'Dinheiro + Cartão');
  assert.equal(painel.resumo({}), '');
});

// ---------------------------------------------------------------- pagamentos -> <detPag>

test('tPag: cada forma vira o código certo da NF-e', () => {
  const m = { 'Dinheiro': '01', 'PIX': '17', 'Cartão': '03', 'Crédito': '03', 'Débito': '04', 'Pagar na entrega': '99', 'qualquer coisa': '01' };
  for (const [forma, tPag] of Object.entries(m)) assert.equal(srv.tPagDaForma(forma), tPag, forma);
});

test('dinheiro + cartão: troco só no dinheiro, e soma(vPag) - vTroco = total', () => {
  const r = srv.detPagParaNota([{ forma: 'Dinheiro', valor: 20, recebido: 50 }, { forma: 'Cartão', valor: 26.2, recebido: null }], 46.2);
  assert.deepEqual(r.detPag.map((d) => [d.tPag, d.vPag]), [['01', 50], ['03', 26.2]]);
  assert.equal(r.vTroco, 30);
});

test('dinheiro sem troco informado usa o próprio valor', () => {
  const r = srv.detPagParaNota([{ forma: 'Dinheiro', valor: 10, recebido: null }, { forma: 'PIX', valor: 5, recebido: null }], 15);
  assert.deepEqual(r.detPag.map((d) => d.vPag), [10, 5]);
  assert.equal(r.vTroco, 0);
});

test('"recebido" em cartão/PIX é ignorado (não existe troco fora do dinheiro)', () => {
  const r = srv.detPagParaNota([{ forma: 'Cartão', valor: 10, recebido: 100 }], 10);
  assert.deepEqual(r.detPag.map((d) => d.vPag), [10]);
  assert.equal(r.vTroco, 0);
});

test('vários trocos se somam; pagamentos "na entrega" levam xPag', () => {
  const r = srv.detPagParaNota([{ forma: 'Dinheiro', valor: 10, recebido: 20 }, { forma: 'Dinheiro', valor: 10, recebido: 15 }, { forma: 'Pagar na entrega', valor: 5, recebido: null }], 25);
  assert.equal(r.vTroco, 15);
  assert.equal(r.detPag[2].xPag, 'Pagamento na entrega');
});

test('conta não quitada ou valor divergente: falha ANTES de gastar uma transmissão', () => {
  assert.throws(() => srv.detPagParaNota([{ forma: 'Cartão', valor: 20, recebido: null }], 46.2), /nao fecham o total/);
  assert.throws(() => srv.detPagParaNota([{ forma: 'Cartão', valor: 50, recebido: null }], 46.2), /nao fecham o total/);
  assert.throws(() => srv.detPagParaNota([], 10), /Nenhum pagamento/);
});

test('arredondamento: 3 partes de 3,33/3,33/3,34 fecham 10,00 sem diferença de centavo', () => {
  const r = srv.detPagParaNota([{ forma: 'PIX', valor: 3.33, recebido: null }, { forma: 'PIX', valor: 3.33, recebido: null }, { forma: 'PIX', valor: 3.34, recebido: null }], 10);
  assert.equal(r.detPag.length, 3);
});
