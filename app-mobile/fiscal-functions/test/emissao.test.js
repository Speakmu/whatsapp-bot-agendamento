// Emissão de NFC-e de ponta a ponta (monta, assina, "envia"), com certificado
// de teste e SEFAZ falsa. Cobre os caminhos que já geraram nota duplicada ou
// contingência rejeitada em produção.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { SignedXml } = require('xml-crypto');
const { emitirNfceAvulsa, transmitirNfceContingencia, gerarQrCodeOffline } = require('../dist/nfce');
const {
  certDeTeste, pedidoDeTeste, sefazFalsa, restaurarSefaz, semComunicacao, protocolo,
  digestDe, qrCodeDe, QR_ONLINE, QR_OFFLINE,
} = require('./apoio');

test.afterEach(restaurarSefaz);

function assinaturaValida(xml, certPem) {
  const assinatura = xml.match(/<Signature\b[\s\S]*?<\/Signature>/)[0];
  const sig = new SignedXml({ publicCert: certPem });
  sig.loadSignature(assinatura);
  return sig.checkSignature(xml);
}

function registroFalso(xmlsAnteriores = []) {
  const guardados = [];
  return {
    guardados,
    guardar: async (xml) => { guardados.push(xml); },
    candidatos: async () => [...xmlsAnteriores, ...guardados],
  };
}

// ------------------------------------------------------------ emissão normal

test('emissão normal autorizada: chave tpEmis=1 e QR Code no formato online', async () => {
  const cert = certDeTeste();
  const chamadas = sefazFalsa({ authorize: (xml) => protocolo((xml.match(/Id="NFe(\d{44})"/))[1], digestDe(xml)) });
  const res = await emitirNfceAvulsa(pedidoDeTeste(), cert);

  assert.equal(res.status, 'AUTORIZADA');
  assert.equal(res.chave.length, 44);
  assert.equal(res.chave[34], '1');
  assert.match(qrCodeDe(res.xml), QR_ONLINE);
  assert.ok(res.xmlProc.includes('<protNFe'));
  assert.ok(res.danfeBase64.length > 1000);
  assert.equal(res.transitorio, undefined);
  assert.equal(chamadas.authorize.length, 1);
  assert.equal(assinaturaValida(res.xml, cert.pem), true);
});

test('o XML é guardado ANTES de ser transmitido', async () => {
  const registro = registroFalso();
  let guardadosNaHoraDoEnvio = -1;
  sefazFalsa({ authorize: (xml) => { guardadosNaHoraDoEnvio = registro.guardados.length; return protocolo('x'.repeat(44), digestDe(xml)); } });
  const res = await emitirNfceAvulsa(pedidoDeTeste(), certDeTeste(), registro);
  assert.equal(guardadosNaHoraDoEnvio, 1);
  assert.equal(registro.guardados[0], res.xml);
});

test('falha ao guardar o XML não impede a emissão', async () => {
  sefazFalsa({ authorize: (xml) => protocolo('x'.repeat(44), digestDe(xml)) });
  const registro = { guardar: async () => { throw new Error('firestore fora'); }, candidatos: async () => [] };
  const res = await emitirNfceAvulsa(pedidoDeTeste(), certDeTeste(), registro);
  assert.equal(res.status, 'AUTORIZADA');
});

test('rejeição de verdade (ex.: 539) continua sendo rejeição', async () => {
  sefazFalsa({ authorize: { cStat: '539', xMotivo: 'Rejeição: Duplicidade de NF-e com diferença na Chave de Acesso' } });
  const res = await emitirNfceAvulsa(pedidoDeTeste(), certDeTeste());
  assert.equal(res.status, 'REJEITADA');
  assert.equal(res.cStat, '539');
  assert.equal(res.transitorio, undefined);
});

test('homologação: descrição do item sai com o aviso obrigatório inteiro', async () => {
  sefazFalsa({ authorize: (xml) => protocolo('x'.repeat(44), digestDe(xml)) });
  const res = await emitirNfceAvulsa(pedidoDeTeste(), certDeTeste());
  // cortado em 60 caracteres a SEFAZ rejeita com 373
  assert.ok(res.xml.includes('<xProd>NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL</xProd>'));
});

test('produção: nome do produto vai como cadastrado (até 120 caracteres)', async () => {
  sefazFalsa({ authorize: (xml) => protocolo('x'.repeat(44), digestDe(xml)) });
  const nome = 'Combo Festa 100 salgadinhos sortidos com refrigerante 2 litros e molho da casa';
  const req = pedidoDeTeste({ ambiente: 'producao' });
  req.items[0].xProd = nome;
  const res = await emitirNfceAvulsa(req, certDeTeste());
  assert.ok(res.xml.includes('<tpAmb>1</tpAmb>'));
  assert.ok(res.xml.includes(`<xProd>${nome}</xProd>`));
});

// ------------------------------------------------------------ contingência

test('SEFAZ fora do ar: gera contingência com QR Code offline válido no schema', async () => {
  const cert = certDeTeste();
  sefazFalsa({ authorize: semComunicacao, consultaProtocolo: semComunicacao });
  const req = pedidoDeTeste();
  const res = await emitirNfceAvulsa(req, cert);

  assert.equal(res.status, 'CONTINGENCIA');
  assert.equal(res.contingencia, true);
  assert.equal(res.chave[34], '9', 'chave de contingência tem tpEmis=9');
  assert.ok(res.xml.includes('<tpEmis>9</tpEmis>'));
  assert.ok(res.xml.includes('<dhCont>') && res.xml.includes('<xJust>'));

  const qr = qrCodeDe(res.xml);
  // O defeito que rejeitou todas as contingências (215): QR Code online numa chave tpEmis=9.
  assert.doesNotMatch(qr, QR_ONLINE);
  assert.match(qr, QR_OFFLINE);

  const [chave, versao, tpAmb, dia, vNF, digVal, cIdToken, hash] = qr.split('?p=')[1].split('|');
  assert.equal(chave, res.chave);
  assert.equal(versao, '2');
  assert.equal(tpAmb, '2');
  assert.equal(dia, (res.xml.match(/<dhEmi>\d{4}-\d{2}-(\d{2})/))[1]);
  assert.equal(vNF, '25.50');
  assert.equal(vNF, (res.xml.match(/<vNF>([^<]+)<\/vNF>/))[1]);
  assert.equal(digVal, Buffer.from(digestDe(res.xml), 'utf8').toString('hex'));
  assert.equal(cIdToken, '1', 'identificador do CSC sem zeros à esquerda');
  const esperado = crypto.createHash('sha1').update(`${chave}|2|2|${dia}|${vNF}|${digVal}|1${req.csc}`).digest('hex').toUpperCase();
  assert.equal(hash, esperado);
});

test('trocar o QR Code depois de assinar não invalida a assinatura', async () => {
  const cert = certDeTeste();
  sefazFalsa({ authorize: semComunicacao, consultaProtocolo: semComunicacao });
  const res = await emitirNfceAvulsa(pedidoDeTeste(), cert);
  assert.equal(assinaturaValida(res.xml, cert.pem), true);
  // ordem exigida pela SEFAZ: infNFe, infNFeSupl, Signature
  assert.ok(res.xml.indexOf('</infNFe>') < res.xml.indexOf('<infNFeSupl>'));
  assert.ok(res.xml.indexOf('</infNFeSupl>') < res.xml.indexOf('<Signature'));
});

test('contingência gera cupom (DANFE) mesmo sem protocolo', async () => {
  sefazFalsa({ authorize: semComunicacao, consultaProtocolo: semComunicacao });
  const res = await emitirNfceAvulsa(pedidoDeTeste(), certDeTeste());
  assert.ok(res.danfeBase64 && res.danfeBase64.length > 1000);
  assert.equal(Buffer.from(res.danfeBase64, 'base64').subarray(0, 4).toString(), '%PDF');
});

test('contingência forçada não chama a SEFAZ', async () => {
  const chamadas = sefazFalsa({});
  const res = await emitirNfceAvulsa(pedidoDeTeste({ contingencia: { forcar: true } }), certDeTeste());
  assert.equal(res.status, 'CONTINGENCIA');
  assert.equal(chamadas.authorize.length, 0);
  assert.match(qrCodeDe(res.xml), QR_OFFLINE);
});

test('QR Code offline: URL base com "?" usa "&" e valor sempre com 2 casas', () => {
  const qr = gerarQrCodeOffline('3'.repeat(34) + '9' + '1'.repeat(9), '1', '000002', 'CSC', 'https://exemplo.gov.br/qr?x=1', {
    dhEmi: '2026-10-07T08:00:00-03:00', vNF: 30, digestValue: 'abcdefghijklmnopqrstuvwxyz0=',
  });
  assert.ok(qr.startsWith('https://exemplo.gov.br/qr?x=1&p='));
  const p = qr.split('&p=')[1].split('|');
  assert.equal(p[3], '07');
  assert.equal(p[4], '30.00');
  assert.equal(p[5].length, 56);
  assert.equal(p[6], '2');
});

test('serviço paralisado (108) cai em contingência em vez de rejeitar', async () => {
  sefazFalsa({ authorize: { cStat: '108', xMotivo: 'Serviço Paralisado Momentaneamente' } });
  const res = await emitirNfceAvulsa(pedidoDeTeste(), certDeTeste());
  assert.equal(res.status, 'CONTINGENCIA');
  assert.equal(res.chave[34], '9');
});

test('serviço paralisado com contingência proibida: sem veredito, não rejeição', async () => {
  sefazFalsa({ authorize: { cStat: '109', xMotivo: 'Serviço Paralisado sem Previsão' } });
  const res = await emitirNfceAvulsa(pedidoDeTeste({ contingencia: { permitir: false } }), certDeTeste());
  assert.equal(res.status, 'REJEITADA');
  assert.equal(res.transitorio, true);
});

// ------------------------------------------------------------ resposta perdida

test('resposta perdida mas nota autorizada: NÃO gera contingência (evita duplicar)', async () => {
  let chaveEnviada;
  const chamadas = sefazFalsa({
    authorize: (xml) => { chaveEnviada = (xml.match(/Id="NFe(\d{44})"/))[1]; chamadas.xml = xml; throw new Error('socket hang up'); },
    consultaProtocolo: (chave) => protocolo(chave, digestDe(chamadas.xml)),
  });
  const res = await emitirNfceAvulsa(pedidoDeTeste(), certDeTeste());
  assert.equal(res.status, 'AUTORIZADA');
  assert.equal(res.chave, chaveEnviada);
  assert.equal(res.chave[34], '1');
  assert.equal(chamadas.consultaProtocolo[0][0], chaveEnviada);
  assert.ok(res.xmlProc.includes('<protNFe'));
  assert.equal(res.contingencia, undefined);
});

test('lote ainda em processamento (105): sem veredito, não rejeição', async () => {
  sefazFalsa({
    authorize: { cStat: '103', xMotivo: 'Lote recebido com sucesso', nRec: '123' },
    retAutorizacao: { cStat: '105', xMotivo: 'Lote em processamento' },
  });
  const res = await emitirNfceAvulsa(pedidoDeTeste(), certDeTeste());
  assert.equal(res.status, 'REJEITADA');
  assert.equal(res.cStat, '105');
  assert.equal(res.transitorio, true, 'quem chama deve reenviar a MESMA nota, não abrir número novo');
});

test('lote processado depois da espera: autoriza normalmente', async () => {
  sefazFalsa({
    authorize: { cStat: '103', xMotivo: 'Lote recebido com sucesso', nRec: '123' },
    retAutorizacao: { cStat: '100', xMotivo: 'Autorizado o uso da NF-e', nProt: '131', rawResponse: '<protNFe><infProt><nProt>131</nProt></infProt></protNFe>' },
  });
  const res = await emitirNfceAvulsa(pedidoDeTeste(), certDeTeste());
  assert.equal(res.status, 'AUTORIZADA');
  assert.equal(res.protocolo, '131');
});

// ------------------------------------------------------------ duplicidade (204)

test('204 de um envio anterior: adota o protocolo e devolve o XML que foi autorizado', async () => {
  const cert = certDeTeste();
  // 1º envio: autorizado, mas a resposta nunca chegou (só o registro ficou com o XML)
  const registro = registroFalso();
  sefazFalsa({ authorize: semComunicacao, consultaProtocolo: semComunicacao });
  await emitirNfceAvulsa(pedidoDeTeste({ contingencia: { permitir: false } }), cert, registro).catch(() => {});
  const xmlDoPrimeiroEnvio = registro.guardados[0];
  assert.ok(xmlDoPrimeiroEnvio);

  // 2º envio (reenvio da mesma nota): um XML diferente, mesma chave
  await new Promise((ok) => setTimeout(ok, 1100)); // hora de emissão muda → outro digest
  sefazFalsa({
    authorize: { cStat: '204', xMotivo: 'Rejeição: Duplicidade de NF-e' },
    consultaProtocolo: (chave) => protocolo(chave, digestDe(xmlDoPrimeiroEnvio)),
  });
  const res = await emitirNfceAvulsa(pedidoDeTeste(), cert, registro);

  assert.equal(res.status, 'AUTORIZADA');
  assert.equal(registro.guardados.length, 2);
  assert.notEqual(digestDe(registro.guardados[1]), digestDe(xmlDoPrimeiroEnvio), 'o reenvio assinou outro XML');
  assert.equal(res.xml, xmlDoPrimeiroEnvio, 'o XML devolvido é o que a SEFAZ autorizou, não o do reenvio');
  assert.ok(res.xmlProc.includes(digestDe(xmlDoPrimeiroEnvio)));
  assert.ok(!res.motivo.includes('não está guardado'));
});

test('204 sem o XML original guardado: autoriza, mas não inventa arquivo pra contabilidade', async () => {
  sefazFalsa({
    authorize: { cStat: '204', xMotivo: 'Rejeição: Duplicidade de NF-e' },
    consultaProtocolo: (chave) => protocolo(chave, 'OUTRODIGESTQUENAOTEMOSAQUI0='),
  });
  const res = await emitirNfceAvulsa(pedidoDeTeste(), certDeTeste(), registroFalso());
  assert.equal(res.status, 'AUTORIZADA');
  assert.equal(res.xml, undefined);
  assert.equal(res.xmlProc, undefined);
  assert.ok(res.motivo.includes('XML autorizado não está guardado'));
  assert.ok(res.danfeBase64, 'ainda assim sai um cupom');
});

test('204 e a consulta falha: sem veredito, não rejeição', async () => {
  sefazFalsa({ authorize: { cStat: '204', xMotivo: 'Rejeição: Duplicidade de NF-e' }, consultaProtocolo: semComunicacao });
  const res = await emitirNfceAvulsa(pedidoDeTeste(), certDeTeste());
  assert.equal(res.status, 'REJEITADA');
  assert.equal(res.transitorio, true);
});

test('204 e a consulta diz que a nota existente não está autorizada: rejeição definitiva', async () => {
  sefazFalsa({ authorize: { cStat: '204', xMotivo: 'Rejeição: Duplicidade de NF-e' }, consultaProtocolo: { cStat: '101', xMotivo: 'Cancelamento homologado' } });
  const res = await emitirNfceAvulsa(pedidoDeTeste(), certDeTeste());
  assert.equal(res.status, 'REJEITADA');
  assert.equal(res.transitorio, undefined);
});

// ------------------------------------------------------------ transmissão da contingência

async function notaEmContingencia() {
  sefazFalsa({ authorize: semComunicacao, consultaProtocolo: semComunicacao });
  const res = await emitirNfceAvulsa(pedidoDeTeste(), certDeTeste());
  restaurarSefaz();
  return res;
}
const reqTransmitir = (xml) => ({ ambiente: 'homologacao', uf: 'MG', xmlAssinado: xml });

test('transmissão da contingência: envia o mesmo XML assinado e autoriza', async () => {
  const cont = await notaEmContingencia();
  const chamadas = sefazFalsa({ authorize: (xml) => protocolo(cont.chave, digestDe(xml)) });
  const res = await transmitirNfceContingencia(reqTransmitir(cont.xml), certDeTeste());
  assert.equal(res.status, 'AUTORIZADA');
  assert.equal(chamadas.authorize[0][0], cont.xml, 'transmite exatamente o XML impresso pro cliente');
  assert.ok(res.xmlProc.includes('<protNFe'));
  assert.equal(res.transitorio, undefined);
});

test('transmissão com lote em processamento: nota fica em contingência (não descarta)', async () => {
  const cont = await notaEmContingencia();
  sefazFalsa({
    authorize: { cStat: '103', xMotivo: 'Lote recebido com sucesso', nRec: '9' },
    retAutorizacao: { cStat: '105', xMotivo: 'Lote em processamento' },
  });
  const res = await transmitirNfceContingencia(reqTransmitir(cont.xml), certDeTeste());
  assert.equal(res.status, 'REJEITADA');
  assert.equal(res.transitorio, true);
});

test('transmissão com serviço paralisado: nota fica em contingência', async () => {
  const cont = await notaEmContingencia();
  sefazFalsa({ authorize: { cStat: '108', xMotivo: 'Serviço Paralisado Momentaneamente' } });
  const res = await transmitirNfceContingencia(reqTransmitir(cont.xml), certDeTeste());
  assert.equal(res.transitorio, true);
});

test('transmissão já recebida antes (204): adota o protocolo em vez de rejeitar', async () => {
  const cont = await notaEmContingencia();
  sefazFalsa({
    authorize: { cStat: '204', xMotivo: 'Rejeição: Duplicidade de NF-e' },
    consultaProtocolo: (chave) => protocolo(chave, digestDe(cont.xml)),
  });
  const res = await transmitirNfceContingencia(reqTransmitir(cont.xml), certDeTeste());
  assert.equal(res.status, 'AUTORIZADA');
});

test('transmissão rejeitada de verdade: rejeição definitiva', async () => {
  const cont = await notaEmContingencia();
  sefazFalsa({ authorize: { cStat: '215', xMotivo: 'Rejeição: Falha no schema XML' } });
  const res = await transmitirNfceContingencia(reqTransmitir(cont.xml), certDeTeste());
  assert.equal(res.status, 'REJEITADA');
  assert.equal(res.transitorio, undefined);
});

// ------------------------------------------------------- endereço do destinatário

// Todo texto de folha do XML precisa respeitar o padrao TString do schema da NF-e: sem
// espaco no comeco nem no fim. (Foi o que rejeitou a nota 99729 com 215.)
function textosComBrancoNasPontas(xml) {
  const ruins = [];
  for (const m of xml.matchAll(/<([A-Za-z]+)(?:\s[^>]*)?>([^<]*)<\/\1>/g)) {
    if (m[2] !== m[2].trim()) ruins.push(`${m[1]}="${m[2]}"`);
  }
  return ruins;
}

const enderecoDoApp = 'Avenida Doutor José de Oliveira Brandão Filho, 333 - Bairro Jardim Mediterranée, Ministério Público ';
const entregaComCpf = (extra = {}) => pedidoDeTeste({
  indPres: '4', indIntermed: '0',
  recipient: {
    cpf: '16148462605', xNome: 'Raquel Silva Ribeiro', xLgr: enderecoDoApp, xBairro: 'Jardim Mediterranée',
    cMun: '3164704', xMun: 'São Sebastião do Paraíso', uf: 'MG', cep: '37950000', ...extra,
  },
});

test('entrega do app (nota 99729): endereco em texto livre vira logradouro + numero, sem espaco no fim', async () => {
  const cert = certDeTeste();
  const chamadas = sefazFalsa({ authorize: (xml) => protocolo((xml.match(/Id="NFe(\d{44})"/))[1], digestDe(xml)) });
  const res = await emitirNfceAvulsa(entregaComCpf(), cert);
  assert.equal(res.status, 'AUTORIZADA');
  const xml = chamadas.authorize[0][0];
  assert.equal(xml.match(/<enderDest><xLgr>([^<]*)<\/xLgr>/)[1], 'Avenida Doutor Jose de Oliveira Brandao Filho');
  assert.equal(xml.match(/<enderDest>[\s\S]*?<nro>([^<]*)<\/nro>/)[1], '333');
  assert.equal(xml.match(/<xBairro>Jardim Mediterranee<\/xBairro>/) !== null, true);
  assert.deepEqual(textosComBrancoNasPontas(xml), []);
});

test('texto cortado em 60 caracteres nao pode terminar em espaco (schema 215)', async () => {
  const cert = certDeTeste();
  const chamadas = sefazFalsa({ authorize: (xml) => protocolo((xml.match(/Id="NFe(\d{44})"/))[1], digestDe(xml)) });
  // o 60o caractere cai logo antes de um espaco: antes do corte "X...X " e depois "X...X "
  const nome59 = 'N'.repeat(59);
  const res = await emitirNfceAvulsa(entregaComCpf({
    xNome: `${nome59} SOBRENOME`, xLgr: `${'R'.repeat(59)} SEM NUMERO`, xBairro: `${'B'.repeat(59)} CENTRO`, xMun: `${'M'.repeat(59)} CIDADE`,
  }), cert);
  assert.equal(res.status, 'AUTORIZADA');
  assert.deepEqual(textosComBrancoNasPontas(chamadas.authorize[0][0]), []);
});

test('numero informado no pedido tem prioridade; sem numero em lugar nenhum vai S/N', async () => {
  const cert = certDeTeste();
  let chamadas = sefazFalsa({ authorize: (xml) => protocolo((xml.match(/Id="NFe(\d{44})"/))[1], digestDe(xml)) });
  await emitirNfceAvulsa(entregaComCpf({ xLgr: 'Rua das Flores', nro: '45' }), cert);
  assert.equal(chamadas.authorize[0][0].match(/<enderDest>[\s\S]*?<nro>([^<]*)<\/nro>/)[1], '45');
  restaurarSefaz();
  chamadas = sefazFalsa({ authorize: (xml) => protocolo((xml.match(/Id="NFe(\d{44})"/))[1], digestDe(xml)) });
  await emitirNfceAvulsa(entregaComCpf({ xLgr: 'Rua das Flores' }), cert);
  assert.equal(chamadas.authorize[0][0].match(/<enderDest>[\s\S]*?<nro>([^<]*)<\/nro>/)[1], 'S/N');
});

// ------------------------------------------- classificação fiscal por item (CFOP 5405)

test('XML da nota sai com o CFOP/CSOSN/NCM de cada produto: refrigerante 5405/500, salgado 5102/102', async () => {
  const { aplicarClassificacao } = require('../dist/classificacao-fiscal');
  const cert = certDeTeste();
  const chamadas = sefazFalsa({ authorize: (xml) => protocolo((xml.match(/Id="NFe(\d{44})"/))[1], digestDe(xml)) });
  const padraoFiscal = { ncm: '19059090', cfop: '5102', csosn: '102', origem: '0' };   // o que o painel manda hoje para TODO item
  const items = [
    { produtoId: 'sal1', xProd: 'Coxinha', qCom: 2, vUnCom: 6, ...padraoFiscal },
    { produtoId: 'ref1', xProd: 'Coca cola 220ml', qCom: 1, vUnCom: 4, ...padraoFiscal },
  ];
  aplicarClassificacao(items, [
    { id: 'sal1', nome: 'coxinha', cfop: '5102', csosn: '102', ncm: '19059090', origem: '0' },
    { id: 'ref1', nome: 'coca cola 220ml', cfop: '5405', csosn: '500', ncm: '22021000', origem: '0' },
  ]);
  const res = await emitirNfceAvulsa(pedidoDeTeste({ items, payment: { tPag: '17', vPag: 16 } }), cert);
  assert.equal(res.status, 'AUTORIZADA');
  const xml = chamadas.authorize[0][0];
  const dets = xml.match(/<det nItem="\d+">[\s\S]*?<\/det>/g);
  assert.equal(dets.length, 2);
  assert.match(dets[0], /<NCM>19059090<\/NCM><CFOP>5102<\/CFOP>/);
  assert.match(dets[0], /<ICMSSN102><orig>0<\/orig><CSOSN>102<\/CSOSN><\/ICMSSN102>/);
  assert.match(dets[1], /<NCM>22021000<\/NCM><CFOP>5405<\/CFOP>/);
  assert.match(dets[1], /<ICMSSN500><orig>0<\/orig><CSOSN>500<\/CSOSN><\/ICMSSN500>/);
  assert.equal([...xml.matchAll(/<CFOP>(\d+)<\/CFOP>/g)].map((m) => m[1]).join(','), '5102,5405');
});

// ---------------------------------------------- conta dividida: vários <detPag> na mesma nota

test('conta dividida (dinheiro + cartão): a nota leva um detPag por pagamento, troco no <pag> e soma - troco = total', async () => {
  const cert = certDeTeste();
  const chamadas = sefazFalsa({ authorize: (xml) => protocolo((xml.match(/Id="NFe(\d{44})"/))[1], digestDe(xml)) });
  // itens: 3 x 5,50 + 1 x 9,00 = 25,50  ->  dinheiro 10 (entregou 20) + cartão 15,50
  const res = await emitirNfceAvulsa(pedidoDeTeste({
    payment: { tPag: '01', vPag: 25.5 },                                   // o campo antigo continua indo; `pagamentos` tem prioridade
    pagamentos: [{ forma: 'Dinheiro', valor: 10, recebido: 20 }, { forma: 'Cartão', valor: 15.5 }],
  }), cert);
  assert.equal(res.status, 'AUTORIZADA');
  const xml = chamadas.authorize[0][0];
  const pag = xml.match(/<pag>[\s\S]*?<\/pag>/)[0];
  const dets = pag.match(/<detPag>[\s\S]*?<\/detPag>/g);
  assert.equal(dets.length, 2);
  assert.match(dets[0], /<tPag>01<\/tPag><vPag>20\.00<\/vPag>/);
  assert.doesNotMatch(dets[0], /<card>/, 'dinheiro não leva grupo de cartão');
  assert.match(dets[1], /<tPag>03<\/tPag><vPag>15\.50<\/vPag><card><tpIntegra>2<\/tpIntegra><tBand>99<\/tBand><\/card>/);
  assert.match(pag, /<\/detPag><vTroco>10\.00<\/vTroco><\/pag>$/, 'vTroco fica no nível <pag>, depois dos detPag');
  const somaVPag = [...pag.matchAll(/<vPag>([\d.]+)<\/vPag>/g)].reduce((s, m) => s + Number(m[1]), 0);
  const vNF = Number(xml.match(/<vNF>([\d.]+)<\/vNF>/)[1]);
  assert.equal(Math.round((somaVPag - 10) * 100) / 100, vNF, 'soma(vPag) - vTroco = vNF');
});

test('conta dividida em 3 pagamentos (cartão, PIX, cartão) sem troco', async () => {
  const cert = certDeTeste();
  const chamadas = sefazFalsa({ authorize: (xml) => protocolo((xml.match(/Id="NFe(\d{44})"/))[1], digestDe(xml)) });
  const res = await emitirNfceAvulsa(pedidoDeTeste({
    pagamentos: [{ forma: 'Cartão', valor: 10 }, { forma: 'PIX', valor: 10 }, { forma: 'Cartão', valor: 5.5 }],
  }), cert);
  assert.equal(res.status, 'AUTORIZADA');
  const pag = chamadas.authorize[0][0].match(/<pag>[\s\S]*?<\/pag>/)[0];
  assert.deepEqual([...pag.matchAll(/<tPag>(\d+)<\/tPag>/g)].map((m) => m[1]), ['03', '17', '03']);
  assert.doesNotMatch(pag, /vTroco/);
});

test('conta dividida que NÃO fecha o total não chega à SEFAZ', async () => {
  const cert = certDeTeste();
  const chamadas = sefazFalsa({ authorize: () => { throw new Error('não devia transmitir'); } });
  await assert.rejects(
    emitirNfceAvulsa(pedidoDeTeste({ pagamentos: [{ forma: 'Cartão', valor: 10 }] }), cert),
    /nao fecham o total/);
  assert.equal(chamadas.authorize.length, 0, 'nada foi transmitido');
});

test('pedido SEM pagamentos (todo o fluxo atual) continua com um detPag só, exatamente como antes', async () => {
  const cert = certDeTeste();
  const chamadas = sefazFalsa({ authorize: (xml) => protocolo((xml.match(/Id="NFe(\d{44})"/))[1], digestDe(xml)) });
  await emitirNfceAvulsa(pedidoDeTeste({ payment: { tPag: '17', vPag: 25.5 } }), cert);
  const pag = chamadas.authorize[0][0].match(/<pag>[\s\S]*?<\/pag>/)[0];
  assert.equal((pag.match(/<detPag>/g) || []).length, 1);
  assert.match(pag, /<tPag>17<\/tPag><vPag>25\.50<\/vPag>/);
});
