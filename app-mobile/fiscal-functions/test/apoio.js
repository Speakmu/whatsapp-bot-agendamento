// Apoio dos testes: certificado de mentira (autoassinado, gerado na hora) e uma
// SEFAZ falsa. Nenhum teste fala com a SEFAZ nem com o Firestore de verdade.
const forge = require('node-forge');
const { SefazTransport } = require('../dist/engine/sefaz-transport.service');

let certCache = null;
function certDeTeste() {
  if (certCache) return certCache;
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400000);
  const attrs = [{ name: 'commonName', value: 'EMPRESA DE TESTE:11222333000181' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], 'senha123', { algorithm: '3des' });
  certCache = {
    buffer: Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary'),
    password: 'senha123',
    pem: forge.pki.certificateToPem(cert),
  };
  return certCache;
}

function pedidoDeTeste(extra = {}) {
  return {
    ambiente: 'homologacao',
    serie: 1,
    nNF: 4321,
    seed: 'pedido-TESTE123',
    emitter: {
      cnpj: '11222333000181', ie: '0012345670089', xNome: 'EMPRESA DE TESTE LTDA', xFant: 'Teste',
      xLgr: 'Rua A', nro: '10', xBairro: 'Centro', cMun: '3106200', xMun: 'Belo Horizonte',
      uf: 'MG', cep: '30000000', crt: '1',
    },
    csc: 'ABCDEF0123456789CSC', cscId: '000001',
    qrBaseUrl: 'https://hnfce.fazenda.mg.gov.br/portalnfce/sistema/qrcode.xhtml',
    urlChave: 'https://hnfce.fazenda.mg.gov.br/portalnfce',
    payment: { tPag: '17', vPag: 25.5 },
    items: [
      { xProd: 'Coxinha', ncm: '19059090', cfop: '5102', csosn: '102', qCom: 3, vUnCom: 5.5 },
      { xProd: 'Refrigerante', ncm: '22021000', cfop: '5102', csosn: '102', qCom: 1, vUnCom: 9 },
    ],
    ...extra,
  };
}

// Troca os métodos de rede do transporte por respostas roteirizadas. Cada
// roteiro é uma função (ou um valor); lançar erro simula queda de comunicação.
const originais = {};
function sefazFalsa(roteiro) {
  const chamadas = { authorize: [], consultaProtocolo: [], retAutorizacao: [] };
  for (const metodo of Object.keys(chamadas)) {
    if (!originais[metodo]) originais[metodo] = SefazTransport.prototype[metodo];
    SefazTransport.prototype[metodo] = async function (...args) {
      chamadas[metodo].push(args);
      const r = roteiro[metodo];
      if (r === undefined) throw new Error(`teste: ${metodo} não era esperado`);
      return typeof r === 'function' ? r(...args) : r;
    };
  }
  return chamadas;
}
function restaurarSefaz() {
  for (const metodo of Object.keys(originais)) SefazTransport.prototype[metodo] = originais[metodo];
}

const semComunicacao = () => { throw new Error('timeout of 30000ms exceeded'); };

// Resposta de consulta/autorização com protocolo, como a SEFAZ devolve.
function protocolo(chave, digVal, nProt = '131260000000001') {
  return {
    cStat: '100', xMotivo: 'Autorizado o uso da NF-e', nProt, dhRecbto: '2026-10-03T10:00:00-03:00',
    rawResponse: `<soap><protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><chNFe>${chave}</chNFe><dhRecbto>2026-10-03T10:00:00-03:00</dhRecbto><nProt>${nProt}</nProt><digVal>${digVal}</digVal><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe></soap>`,
  };
}

const digestDe = (xml) => (xml.match(/<DigestValue>([^<]+)<\/DigestValue>/) || [])[1];
const qrCodeDe = (xml) => (xml.match(/<qrCode>([\s\S]*?)<\/qrCode>/) || [])[1].replace(/&amp;/g, '&');

// Padrão do <qrCode> no schema da NFC-e (leiauteNFe_v4.00): o formato é amarrado
// ao tpEmis da chave (35º dígito). Chave de contingência (9) com QR Code no
// formato online = "215 Falha no schema XML".
const QR_ONLINE = /^https?:\/\/.*\?p=[0-9]{34}[1345678][0-9]{9}\|2\|[12]\|(0|[1-9][0-9]*)\|[A-Fa-f0-9]{40}$/;
const QR_OFFLINE = /^https?:\/\/.*\?p=[0-9]{34}9[0-9]{9}\|2\|[12]\|[0-3][0-9]\|[0-9]{1,13}\.[0-9]{2}\|[A-Fa-f0-9]{56}\|(0|[1-9][0-9]*)\|[A-Fa-f0-9]{40}$/;

module.exports = { certDeTeste, pedidoDeTeste, sefazFalsa, restaurarSefaz, semComunicacao, protocolo, digestDe, qrCodeDe, QR_ONLINE, QR_OFFLINE };
