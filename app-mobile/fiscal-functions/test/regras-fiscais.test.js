const test = require('node:test');
const assert = require('node:assert/strict');
const r = require('../dist/regras-fiscais');

const ts = (ms) => ({ toMillis: () => ms });
const xmlCom = (digest) => `<NFe><infNFe Id="NFe1"></infNFe><Signature><DigestValue>${digest}</DigestValue></Signature></NFe>`;
const protCom = (digVal) => `<protNFe><infProt><digVal>${digVal}</digVal></infProt></protNFe>`;

test('lote em processamento e serviço paralisado não são rejeição', () => {
  for (const c of ['103', '105', '108', '109']) assert.equal(r.cStatTransitorio(c), true, c);
  // rejeições de verdade e autorização
  for (const c of ['100', '204', '215', '539', '704', undefined, null, '']) assert.equal(r.cStatTransitorio(c), false, String(c));
});

test('só 108/109 mandam pra contingência', () => {
  assert.equal(r.servicoParalisado('108'), true);
  assert.equal(r.servicoParalisado('109'), true);
  assert.equal(r.servicoParalisado('103'), false);
  assert.equal(r.servicoParalisado('215'), false);
});

test('tempo em PROCESSANDO conta do último reenvio, não da criação', () => {
  const agora = 10 * 60 * 60 * 1000;
  const criadaHa2h = agora - 2 * 60 * 60 * 1000;
  // nota antiga, sem reenvio registrado: travada há 2h
  assert.equal(r.msEmProcessamento({ criado_em: ts(criadaHa2h) }, agora), 2 * 60 * 60 * 1000);
  // a mesma nota, reenviada há 20s: NÃO está travada (era aqui que o agendador
  // abria número novo com o envio em andamento)
  const reenviada = { criado_em: ts(criadaHa2h), processando_desde: ts(agora - 20000) };
  assert.equal(r.msEmProcessamento(reenviada, agora), 20000);
  assert.ok(r.msEmProcessamento(reenviada, agora) < 3 * 60 * 1000);
  // sem data nenhuma: não dá pra afirmar que travou
  assert.equal(r.msEmProcessamento({}, agora), null);
});

test('resultado atrasado não rebaixa nota autorizada ou cancelada', () => {
  assert.equal(r.podeGravarResultado('AUTORIZADA', 'CONTINGENCIA'), false);
  assert.equal(r.podeGravarResultado('AUTORIZADA', 'REJEITADA'), false);
  assert.equal(r.podeGravarResultado('AUTORIZADA', 'ERRO'), false);
  assert.equal(r.podeGravarResultado('AUTORIZADA', 'AUTORIZADA'), true);
  assert.equal(r.podeGravarResultado('CANCELADA', 'AUTORIZADA'), false);
  assert.equal(r.podeGravarResultado('PROCESSANDO', 'CONTINGENCIA'), true);
  assert.equal(r.podeGravarResultado('PROCESSANDO', 'AUTORIZADA'), true);
  assert.equal(r.podeGravarResultado('ERRO_REDE', 'REJEITADA'), true);
  assert.equal(r.podeGravarResultado(undefined, 'AUTORIZADA'), true);
});

test('escolhe o XML cujo digest é o do protocolo', () => {
  const a = xmlCom('AAAAAAAAAAAAAAAAAAAAAAAAAAA=');
  const b = xmlCom('BBBBBBBBBBBBBBBBBBBBBBBBBBB=');
  assert.equal(r.xmlAutorizado([a, b], protCom('BBBBBBBBBBBBBBBBBBBBBBBBBBB=')), b);
  assert.equal(r.xmlAutorizado([a, b], protCom('AAAAAAAAAAAAAAAAAAAAAAAAAAA=')), a);
});

test('nunca devolve um XML que não bate com o protocolo', () => {
  const a = xmlCom('AAAAAAAAAAAAAAAAAAAAAAAAAAA=');
  assert.equal(r.xmlAutorizado([a], protCom('ZZZZZZZZZZZZZZZZZZZZZZZZZZZ=')), undefined);
  assert.equal(r.xmlAutorizado([], protCom('ZZZZZZZZZZZZZZZZZZZZZZZZZZZ=')), undefined);
  assert.equal(r.xmlAutorizado([null, undefined], protCom('ZZZZZZZZZZZZZZZZZZZZZZZZZZZ=')), undefined);
});

test('sem digVal na resposta mantém o comportamento antigo (primeiro XML)', () => {
  const a = xmlCom('AAAAAAAAAAAAAAAAAAAAAAAAAAA=');
  assert.equal(r.xmlAutorizado([null, a], '<retorno>sem protocolo</retorno>'), a);
});

test('reúne todos os XMLs que a nota já teve', () => {
  const nota = {
    xml: '<NFe>gravado</NFe>', xmlAssinado: '<NFe>contingencia</NFe>',
    xml_enviado: { abc: { xml: '<NFe>envio1</NFe>', em: 1 }, def: { xml: '<NFe>envio2</NFe>', em: 2 } },
  };
  assert.deepEqual(r.xmlsDaNota(nota).sort(), ['<NFe>contingencia</NFe>', '<NFe>envio1</NFe>', '<NFe>envio2</NFe>', '<NFe>gravado</NFe>']);
  assert.deepEqual(r.xmlsDaNota({}), []);
  assert.deepEqual(r.xmlsDaNota(null), []);
});
