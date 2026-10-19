// Classificação fiscal por item (NCM/CFOP/CSOSN/origem) vinda do cardápio. Antes toda nota
// saía com o padrão da Config fiscal (CFOP 5102), inclusive refrigerante (que é 5405 / 500).
const test = require('node:test');
const assert = require('node:assert/strict');
const { aplicarClassificacao, normalizarNomeProduto } = require('../dist/classificacao-fiscal');

const produtos = [
  { id: 'ref1', nome: 'coca cola 220ml', nome_exibicao: 'Coca cola 220ml', cfop: '5405', csosn: '500', ncm: '22021000', origem: '0' },
  { id: 'sal1', nome: 'coxinha', nome_exibicao: 'Coxinha', cfop: '5102', csosn: '102', ncm: '19059090', origem: '0', apelidos: ['COXINHA DE FRANGO'] },
  { id: 'semfiscal', nome: 'pastel', nome_exibicao: 'Pastel' },
  { id: 'lixo', nome: 'produto estranho', cfop: 'abc', ncm: '12', csosn: '', origem: '9' },
  { id: 'soCst', nome: 'suco de caixinha', cst: '500', cfop: '5405', ncm: '22029900' },
  { id: 'soCsosn', nome: 'del valle pessego lata', csosn: '500' },
  { id: 'soCfop', nome: 'sukita 1 litro', cfop: '5405', ncm: '22021000' },
];
const padrao = (extra = {}) => ({ xProd: 'x', ncm: '19059090', cfop: '5102', csosn: '102', origem: '0', qCom: 1, vUnCom: 5, ...extra });

test('refrigerante recebe CFOP 5405 / CSOSN 500 / NCM 22021000 do cardápio (pelo id do produto)', () => {
  const it = padrao({ produtoId: 'ref1', xProd: 'qualquer nome' });
  const r = aplicarClassificacao([it], produtos);
  assert.deepEqual([it.cfop, it.csosn, it.ncm, it.origem], ['5405', '500', '22021000', '0']);
  assert.equal(r.aplicados, 1);
  assert.deepEqual(r.semProduto, []);
});

test('salgado continua 5102 / 102', () => {
  const it = padrao({ produtoId: 'sal1', xProd: 'Coxinha' });
  aplicarClassificacao([it], produtos);
  assert.deepEqual([it.cfop, it.csosn, it.ncm], ['5102', '102', '19059090']);
});

test('sem id (nota antiga/payload reenviado): acha o produto pelo nome, ignorando maiúscula, acento e espaço duplo', () => {
  for (const nome of ['Coca cola  220ml', 'COCA COLA 220ML', ' coca-cola 220ml ']) {
    const it = padrao({ xProd: nome });
    aplicarClassificacao([it], produtos);
    assert.equal(it.cfop, '5405', nome);
  }
});

test('acha pelo apelido aprendido (nome que veio da nota de compra)', () => {
  const it = padrao({ xProd: 'Coxinha de frango', cfop: '5405' });
  aplicarClassificacao([it], produtos);
  assert.equal(it.cfop, '5102');
});

test('o id do produto tem prioridade sobre o nome', () => {
  const it = padrao({ produtoId: 'sal1', xProd: 'Coca cola 220ml' });
  aplicarClassificacao([it], produtos);
  assert.equal(it.cfop, '5102');
});

test('produto sem classificação no cadastro mantém o padrão', () => {
  const it = padrao({ produtoId: 'semfiscal' });
  const r = aplicarClassificacao([it], produtos);
  assert.deepEqual([it.cfop, it.csosn, it.ncm], ['5102', '102', '19059090']);
  assert.equal(r.aplicados, 0);
});

test('valor inválido no cadastro é ignorado (não vira XML inválido)', () => {
  const it = padrao({ produtoId: 'lixo' });
  aplicarClassificacao([it], produtos);
  assert.deepEqual([it.cfop, it.ncm, it.csosn, it.origem], ['5102', '19059090', '102', '0']);
});

test('cadastro só com CST: usa como CSOSN', () => {
  const it = padrao({ produtoId: 'soCst' });
  aplicarClassificacao([it], produtos);
  assert.deepEqual([it.cfop, it.csosn, it.ncm], ['5405', '500', '22029900']);
});

test('item sem produto no cardápio fica com o padrão e é listado', () => {
  const it = padrao({ xProd: 'Item que nao existe' });
  const r = aplicarClassificacao([it], produtos);
  assert.equal(it.cfop, '5102');
  assert.deepEqual(r.semProduto, ['Item que nao existe']);
});

test('pedido misto (caso real): cada item sai com a classificação do seu produto', () => {
  const itens = [
    padrao({ produtoId: 'sal1', xProd: 'Coxinha' }),
    padrao({ produtoId: 'ref1', xProd: 'Coca cola  220ml' }),
    padrao({ xProd: 'Pastel', produtoId: 'semfiscal' }),
  ];
  aplicarClassificacao(itens, produtos);
  assert.deepEqual(itens.map((i) => i.cfop), ['5102', '5405', '5102']);
  assert.deepEqual(itens.map((i) => i.csosn), ['102', '500', '102']);
});

test('normalizarNomeProduto', () => {
  assert.equal(normalizarNomeProduto('  Água  Saborizada Maçã 510ML '), 'agua saborizada maca 510ml');
  assert.equal(normalizarNomeProduto(null), '');
});

test('CFOP e CSOSN so valem em par: cadastro com so um dos dois mantem o padrao nos dois', () => {
  const soCsosn = padrao({ produtoId: 'soCsosn' });
  const soCfop = padrao({ produtoId: 'soCfop' });
  const r = aplicarClassificacao([soCsosn, soCfop], produtos);
  // nada de CSOSN 500 com CFOP 5102 (nem CFOP 5405 com CSOSN 102): combinacao que a SEFAZ pode recusar
  assert.deepEqual([soCsosn.cfop, soCsosn.csosn], ['5102', '102']);
  assert.deepEqual([soCfop.cfop, soCfop.csosn], ['5102', '102']);
  assert.equal(soCfop.ncm, '22021000', 'o NCM do cadastro continua valendo mesmo sem o par');
  assert.deepEqual(r.incompletos.sort(), ['del valle pessego lata', 'sukita 1 litro']);
});
