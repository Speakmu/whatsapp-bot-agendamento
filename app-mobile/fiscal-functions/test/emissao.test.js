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
