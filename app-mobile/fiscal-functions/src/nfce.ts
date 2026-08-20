// ============================================================
//  Wrapper NFC-e "avulsa" — usa o motor SEFAZ copiado do
//  Construline (engine/) SEM depender do banco/Prisma dele.
//  Recebe um payload autocontido (emitente + itens + pagamento)
//  e devolve chave, status, protocolo, XML e DANFE (PDF base64).
// ============================================================
import 'reflect-metadata';
import * as crypto from 'crypto';
import { NfeXmlBuilder, NfeXmlInput, NfeXmlItem } from './engine/nfe-xml.builder';
import { NfeXmlSigner } from './engine/nfe-xml.signer';
import { SefazTransport } from './engine/sefaz-transport.service';
import { getDistribuicaoDFeEndpoint, getSefazEndpoints } from './engine/sefaz-endpoints';
import { DanfeNfceService } from './engine/danfe-nfce.service';
import { obterAliquotaIBPT } from './ibpt-store';

const builder = new NfeXmlBuilder();
const signer = new NfeXmlSigner();
const transport = new SefazTransport();
const danfe = new DanfeNfceService();

// Certificado: pode vir de um arquivo (CERT_PATH) OU de um buffer (base64 do Firestore).
export type CertInput = { pfxPath?: string; buffer?: Buffer; password: string };
function carregarCred(cert: CertInput) {
  return cert.buffer
    ? signer.loadCertificateFromBuffer(cert.buffer, cert.password)
    : signer.loadCertificateFromFile(cert.pfxPath as string, cert.password);
}
// Valida um .pfx (lança se o arquivo/senha estiverem incorretos).
export function validarCertificado(buffer: Buffer, password: string): void {
  signer.loadCertificateFromBuffer(buffer, password);
}

// Validade do certificado configurado — usado pelo /fiscal/health pra flagar
// certificado vencido/perto de vencer sem precisar tentar emitir uma nota.
export function obterValidadeCertificado(cert: CertInput): { notBefore: Date; notAfter: Date } {
  return carregarCred(cert).validity;
}

// IBGE — código da UF (2 dígitos)
const UF_CODIGO: Record<string, string> = {
  RO: '11', AC: '12', AM: '13', RR: '14', PA: '15', AP: '16', TO: '17',
  MA: '21', PI: '22', CE: '23', RN: '24', PB: '25', PE: '26', AL: '27', SE: '28', BA: '29',
  MG: '31', ES: '32', RJ: '33', SP: '35',
  PR: '41', SC: '42', RS: '43',
  MS: '50', MT: '51', GO: '52', DF: '53',
};

export interface AvulsaItem {
  cProd?: string;
  xProd: string;
  ncm: string;
  cfop: string;
  csosn?: string;   // Simples Nacional
  cst?: string;     // Regime Normal
  origem?: string;  // '0' nacional (padrão)
  uCom?: string;    // unidade (UN padrão)
  qCom: number;
  vUnCom: number;
  vDesc?: number;
}

export interface AvulsaRequest {
  ambiente: 'homologacao' | 'producao';
  serie: number;
  nNF: number;
  seed?: string;            // para cNF estável entre retentativas (idempotência)
  emitter: {
    cnpj: string; ie: string; xNome: string; xFant?: string;
    xLgr: string; nro: string; xCpl?: string; xBairro: string;
    cMun: string;            // IBGE 7 dígitos do município do emitente
    xMun: string; uf: string; cep: string; fone?: string;
    crt: '1' | '3';          // 1=Simples Nacional, 3=Regime Normal
  };
  csc: string;
  cscId: string;
  qrBaseUrl: string;         // portal QR Code da UF (homolog/prod)
  urlChave?: string;         // portal de consulta por chave
  recipient?: { cpf?: string; cnpj?: string; xNome?: string };
  // Indicador de presença do comprador (padrão '1' = presencial/balcão). Pra
  // vendas por app/delivery, usar '4' (NFC-e com entrega a domicílio) — ver
  // Nota Técnica 2020.006. Quando indPres exige, indIntermed é obrigatório
  // ('0' = canal próprio/sem intermediador, o padrão; '1' = marketplace de terceiro).
  indPres?: '0' | '1' | '2' | '3' | '4' | '9';
  indIntermed?: '0' | '1';
  payment: { tPag: string; vPag?: number; vTroco?: number };
  items: AvulsaItem[];
  infAdic?: string;
  // Alíquota aproximada (%) da carga tributária total, para a linha exigida pela
  // Lei 12.741/2010 ("Lei da Transparência"). Usada como fallback quando o token
  // do IBPT (abaixo) não está configurado.
  aliquotaAproxTributos?: number;
  // Token do IBPT ("De Olho no Imposto") para consultar a alíquota real por NCM
  // de cada item. Quando informado, tem prioridade sobre aliquotaAproxTributos.
  ibptToken?: string;
  // Contingência offline (NFC-e tpEmis=9):
  //  - permitir: cai em contingência se a SEFAZ estiver inacessível (padrão true)
  //  - forcar: emite direto em contingência, sem tentar a SEFAZ
  //  - xJust: justificativa (15..256 caracteres)
  contingencia?: { permitir?: boolean; forcar?: boolean; xJust?: string };
}

export interface AvulsaResult {
  status: 'AUTORIZADA' | 'REJEITADA' | 'CONTINGENCIA' | 'ERRO';
  chave?: string;
  protocolo?: string;
  cStat?: string;
  motivo?: string;
  xml?: string;
  danfeBase64?: string;
  contingencia?: boolean;   // true quando emitida offline (tpEmis=9), pendente de transmissão
}

async function gerarDanfeBase64(
  signedXml: string,
  fallback?: { accessKey?: string; protocol?: string; receivedAt?: string },
): Promise<string | undefined> {
  try {
    const pdf = await danfe.generate(signedXml, fallback);
    return (pdf?.pdf ?? pdf)?.toString?.('base64');
  } catch { return undefined; }
}

function round2(v: number): number { return Math.round((Number(v) || 0) * 100) / 100; }

function brtIso(d: Date): string {
  // ISO com offset -03:00 para uma data qualquer
  const off = -3 * 60;
  const local = new Date(d.getTime() + (off - -d.getTimezoneOffset()) * 60000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}` +
    `T${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}-03:00`;
}
function nowBRT(): string { return brtIso(new Date()); }

function gerarQrCode(chave44: string, tpAmb: '1' | '2', cscId: string, csc: string, qrBaseUrl: string): string {
  // cIdToken vai SEM zeros à esquerda (ex: "1", não "000001") — comparado com uma
  // NFC-e real autorizada em MG, o zero-padding quebra o pattern do schema e causa
  // rejeição "Falha no Schema XML do lote de NFe".
  const cIdToken = String(parseInt(cscId, 10) || 0);
  const dadosBase = `${chave44}|2|${tpAmb}|${cIdToken}`;
  const hash = crypto.createHash('sha1').update(dadosBase + csc).digest('hex').toUpperCase();
  const sep = qrBaseUrl.includes('?') ? '&' : '?';
  // Pipe literal (sem URL-encoding) é o formato aceito pela SEFAZ — confirmado
  // comparando com uma NFC-e real autorizada.
  return `${qrBaseUrl}${sep}p=${dadosBase}|${hash}`;
}

// Avisos obrigatórios em ambiente de homologação (confirmados comparando com uma
// NFC-e real gerada pelo Construline): descrição do(s) item(ns) e nome do
// destinatário precisam avisar que a nota não tem valor fiscal.
const AVISO_HOMOLOGACAO_ITEM = 'NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';
const AVISO_HOMOLOGACAO_DEST = 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';

// Monta o NfeXmlInput (ide/emit/dest/itens/totais) a partir do payload avulso.
// Compartilhado entre a emissão real e a prévia de layout (que não assina nem transmite).
async function montarInputNFe(req: AvulsaRequest): Promise<{ input: NfeXmlInput; cUF: string; uf: string; tpAmb: '1' | '2' }> {
  const tpAmb: '1' | '2' = req.ambiente === 'producao' ? '1' : '2';
  const uf = req.emitter.uf.toUpperCase();
  const cUF = UF_CODIGO[uf];
  if (!cUF) throw new Error(`UF inválida: ${uf}`);

  // Itens + totais
  let vProd = 0, vDescTotal = 0;
  const pctFallback = Number(req.aliquotaAproxTributos) || 0;
  const items: NfeXmlItem[] = await Promise.all(req.items.map(async (it, idx) => {
    const qCom = Number(it.qCom) || 0;
    const vUn = Number(it.vUnCom) || 0;
    const vItem = round2(qCom * vUn);
    const vDesc = round2(it.vDesc || 0);
    vProd += vItem; vDescTotal += vDesc;
    const orig = it.origem || '0';
    const icms = req.emitter.crt === '1'
      ? { type: 'simples' as const, orig, csosn: it.csosn || '102' }
      : { type: 'normal' as const, orig, cst: it.cst || '40' };
    // Tributos aproximados (Lei 12.741/2012): usa a tabela IBPT por NCM quando
    // houver token configurado; senão cai na alíquota fixa (fallback manual).
    // O valor é calculado e arredondado POR ITEM — a SEFAZ exige que o total
    // (vTotTrib do documento) seja exatamente a soma dos valores por item.
    let pct = pctFallback;
    if (req.ibptToken && it.ncm) {
      try {
        const aliq = await obterAliquotaIBPT(it.ncm, uf, req.emitter.cnpj, req.ibptToken);
        pct = orig === '0' ? aliq.nacional + aliq.estadual + aliq.municipal : aliq.importado + aliq.estadual + aliq.municipal;
        console.log(`[IBPT] item "${it.xProd}" NCM ${it.ncm}: aliquota ${pct}% (${JSON.stringify(aliq)})`);
      } catch (err: any) {
        // nunca bloqueia a emissão por falha na consulta de tributos — só registra
        console.error(`[IBPT] falha ao consultar NCM ${it.ncm}: ${err?.message || err}`);
      }
    }
    const vTotTribItem = round2(vItem * pct / 100);
    return {
      nItem: idx + 1,
      cProd: it.cProd || String(idx + 1),
      // Regra da SEFAZ: em homologação, a descrição dos itens precisa avisar que a
      // nota não tem valor fiscal, senão a nota é rejeitada (obrigatório no 1º item;
      // aplicamos em todos por segurança/consistência).
      xProd: tpAmb === '2' ? AVISO_HOMOLOGACAO_ITEM : it.xProd,
      ncm: it.ncm,
      cfop: it.cfop,
      uCom: it.uCom || 'UN',
      qCom,
      vUnCom: vUn,
      vProd: vItem,
      uTrib: it.uCom || 'UN',
      qTrib: qCom,
      vUnTrib: vUn,
      vDesc: vDesc || undefined,
      indTot: '1',
      icms,
      pis: { cst: '49', vPIS: 0 },
      cofins: { cst: '49', vCOFINS: 0 },
      vTotTrib: vTotTribItem || undefined,
    };
  }));

  vProd = round2(vProd); vDescTotal = round2(vDescTotal);
  const vNF = round2(vProd - vDescTotal);
  // Total = soma exata dos valores já arredondados por item (não recalcula do zero),
  // para nunca divergir da regra de negócio "total = somatório dos itens".
  const vTotTrib = round2(items.reduce((sum, it) => sum + (it.vTotTrib || 0), 0));

  const input: NfeXmlInput = {
    cUF,
    cNF: builder.generateCNF(req.seed || `${req.emitter.cnpj}-${req.serie}-${req.nNF}-${Date.now()}`),
    natOp: 'VENDA',
    mod: '65',
    serie: req.serie,
    nNF: req.nNF,
    dhEmi: nowBRT(),
    tpNF: '1',
    idDest: '1',
    cMunFG: req.emitter.cMun,
    tpImp: '4', // DANFE NFC-e
    tpEmis: '1',
    tpAmb,
    finNFe: '1',
    indFinal: '1',
    indPres: req.indPres || '1',
    indIntermed: req.indIntermed || '0',
    procEmi: '0',
    emitter: {
      cnpj: req.emitter.cnpj.replace(/\D/g, ''),
      xNome: req.emitter.xNome,
      xFant: req.emitter.xFant,
      xLgr: req.emitter.xLgr, nro: req.emitter.nro, xCpl: req.emitter.xCpl,
      xBairro: req.emitter.xBairro, cMun: req.emitter.cMun, xMun: req.emitter.xMun,
      uf, cep: req.emitter.cep.replace(/\D/g, ''),
      cPais: '1058', xPais: 'Brasil', fone: req.emitter.fone,
      ie: req.emitter.ie.replace(/\D/g, ''),
      crt: req.emitter.crt,
    },
    recipient: req.recipient && (req.recipient.cpf || req.recipient.cnpj) ? {
      cpf: req.recipient.cpf ? req.recipient.cpf.replace(/\D/g, '') : undefined,
      cnpj: req.recipient.cnpj ? req.recipient.cnpj.replace(/\D/g, '') : undefined,
      // Regra da SEFAZ: em homologação, o nome do destinatário também precisa
      // trazer o aviso de nota sem valor fiscal.
      xNome: tpAmb === '2' ? AVISO_HOMOLOGACAO_DEST : (req.recipient.xNome || 'CONSUMIDOR'),
      indIEDest: '9',
    } : undefined,
    items,
    totals: {
      vBC: 0, vICMS: 0, vICMSDeson: 0, vFCP: 0, vBCST: 0, vST: 0, vFCPST: 0, vFCPSTRet: 0,
      vProd, vFrete: 0, vSeg: 0, vDesc: vDescTotal, vII: 0, vIPI: 0, vIPIDevol: 0,
      vPIS: 0, vCOFINS: 0, vOutro: 0, vNF, vTotTrib,
    },
    payment: {
      tPag: req.payment.tPag || '01',
      vPag: round2(req.payment.vPag != null ? req.payment.vPag : vNF),
      vTroco: req.payment.vTroco ? round2(req.payment.vTroco) : undefined,
    },
    infAdic: tpAmb === '2' ? AVISO_HOMOLOGACAO_DEST : req.infAdic,
  };

  return { input, cUF, uf, tpAmb };
}

// Gera um PDF de prévia do DANFE NFC-e a partir da configuração/itens informados,
// sem assinar nem transmitir à SEFAZ (não exige certificado). Útil para conferir o
// layout do cupom (cabeçalho, itens, QR Code, avisos) antes de emitir de verdade.
export async function gerarPreviaDanfe(req: AvulsaRequest): Promise<Buffer> {
  const { input, tpAmb } = await montarInputNFe(req);
  const c43 = builder.buildChave(input);
  const c44 = c43 + builder.calcDV(c43);
  input.supplemental = {
    qrCode: gerarQrCode(c44, tpAmb, req.cscId, req.csc, req.qrBaseUrl),
    urlChave: req.urlChave,
  };
  const unsignedXml = builder.build(input);
  const { pdf } = await danfe.generate(unsignedXml, {
    accessKey: c44,
    protocol: 'PRÉVIA - SEM VALOR FISCAL',
    receivedAt: nowBRT(),
  });
  return pdf;
}

export async function emitirNfceAvulsa(req: AvulsaRequest, cert: CertInput): Promise<AvulsaResult> {
  const { input, cUF, uf, tpAmb } = await montarInputNFe(req);
  const cred = carregarCred(cert);
  const endpoints = getSefazEndpoints(uf, tpAmb === '1' ? 'PRODUCAO' : 'HOMOLOGACAO');

  // Monta chave + QR + assina para um dado tpEmis (1=normal, 9=contingência offline)
  function montarAssinar(tpEmis: '1' | '9', cont?: { dhCont: string; xJust: string }): { chave44: string; signedXml: string } {
    input.tpEmis = tpEmis;
    if (tpEmis === '9' && cont) { input.dhCont = cont.dhCont; input.xJust = cont.xJust; }
    else { delete input.dhCont; delete input.xJust; }
    const c43 = builder.buildChave(input);
    const c44 = c43 + builder.calcDV(c43);
    input.supplemental = {
      qrCode: gerarQrCode(c44, tpAmb, req.cscId, req.csc, req.qrBaseUrl),
      urlChave: req.urlChave,
    };
    const unsigned = builder.build(input);
    const { signedXml } = signer.sign(unsigned, cred);
    return { chave44: c44, signedXml };
  }

  const permitirCont = req.contingencia?.permitir !== false;   // padrão: permite
  const forcarCont = req.contingencia?.forcar === true;
  const justCont = (() => {
    const j = (req.contingencia?.xJust || '').trim();
    return j.length >= 15 ? j.slice(0, 255) : 'Sem comunicacao com a SEFAZ para autorizacao da NFC-e';
  })();

  // 1) Emissão normal (a menos que a contingência seja forçada)
  if (!forcarCont) {
    const { chave44, signedXml } = montarAssinar('1');
    try {
      let result = await transport.authorize(
        signedXml, endpoints, cred.certificatePem, cred.privateKeyPem, tpAmb, cUF, '1',
      );

      // cStat 103/105 = lote recebido/em processamento — comum em picos de carga
      // da SEFAZ mesmo em modo síncrono (indSinc=1). Não é rejeição: sem consultar
      // de novo, uma nota que seria autorizada em poucos segundos ficaria marcada
      // erroneamente como REJEITADA.
      if ((result.cStat === '103' || result.cStat === '105') && result.nRec) {
        for (let tentativa = 1; tentativa <= 2; tentativa++) {
          await new Promise(resolve => setTimeout(resolve, 1500));
          try {
            result = await transport.retAutorizacao(
              result.nRec, endpoints, cred.certificatePem, cred.privateKeyPem, tpAmb, cUF, 8000,
            );
          } catch {
            break; // sem resposta na consulta rápida — mantém o último resultado conhecido
          }
          if (result.cStat !== '103' && result.cStat !== '105') break;
        }
      }

      const autorizada = result.cStat === '100';
      return {
        status: autorizada ? 'AUTORIZADA' : 'REJEITADA',
        chave: chave44,
        protocolo: result.nProt,
        cStat: result.cStat ?? undefined,
        motivo: result.xMotivo ?? undefined,
        xml: signedXml,
        danfeBase64: autorizada
          ? await gerarDanfeBase64(signedXml, { accessKey: chave44, protocol: result.nProt, receivedAt: result.dhRecbto })
          : undefined,
      };
    } catch (err: any) {
      // Falha de comunicação com a SEFAZ → cai para contingência (se permitida)
      if (!permitirCont) throw err;
    }
  }

  // 2) Contingência offline (tpEmis=9): assina, gera DANFE e deixa pendente de transmissão
  const dhCont = nowBRT();
  const { chave44, signedXml } = montarAssinar('9', { dhCont, xJust: justCont });
  return {
    status: 'CONTINGENCIA',
    chave: chave44,
    xml: signedXml,
    danfeBase64: await gerarDanfeBase64(signedXml, { accessKey: chave44 }),
    motivo: 'Emitida em contingência offline (pendente de transmissão à SEFAZ em até 24h).',
    contingencia: true,
  };
}

// ============================================================
//  TRANSMISSÃO de NFC-e emitida em contingência (envio posterior)
//  Recebe o XML já assinado (tpEmis=9) e autoriza na SEFAZ.
// ============================================================
export interface TransmitirRequest {
  ambiente: 'homologacao' | 'producao';
  uf: string;
  xmlAssinado: string;   // XML da NFC-e já assinado, gerado na contingência
}

export async function transmitirNfceContingencia(
  req: TransmitirRequest, cert: CertInput,
): Promise<AvulsaResult> {
  if (!req.xmlAssinado) throw new Error('XML assinado ausente.');
  const tpAmb: '1' | '2' = req.ambiente === 'producao' ? '1' : '2';
  const uf = req.uf.toUpperCase();
  const cUF = UF_CODIGO[uf];
  if (!cUF) throw new Error(`UF inválida: ${uf}`);

  const cred = carregarCred(cert);
  const endpoints = getSefazEndpoints(uf, tpAmb === '1' ? 'PRODUCAO' : 'HOMOLOGACAO');

  let result = await transport.authorize(
    req.xmlAssinado, endpoints, cred.certificatePem, cred.privateKeyPem, tpAmb, cUF, '1',
  );

  // Mesmo tratamento de cStat 103/105 (lote recebido/em processamento) da
  // emissão normal — sem isso, uma contingência que a SEFAZ só está demorando
  // pra processar seria marcada como REJEITADA por engano.
  if ((result.cStat === '103' || result.cStat === '105') && result.nRec) {
    for (let tentativa = 1; tentativa <= 2; tentativa++) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      try {
        result = await transport.retAutorizacao(
          result.nRec, endpoints, cred.certificatePem, cred.privateKeyPem, tpAmb, cUF, 8000,
        );
      } catch {
        break;
      }
      if (result.cStat !== '103' && result.cStat !== '105') break;
    }
  }

  const autorizada = result.cStat === '100';
  return {
    status: autorizada ? 'AUTORIZADA' : 'REJEITADA',
    protocolo: result.nProt,
    cStat: result.cStat ?? undefined,
    motivo: result.xMotivo ?? undefined,
    xml: req.xmlAssinado,
    danfeBase64: autorizada
      ? await gerarDanfeBase64(req.xmlAssinado, { protocol: result.nProt, receivedAt: result.dhRecbto })
      : undefined,
  };
}

// ============================================================
//  CANCELAMENTO (evento 110111 — RecepcaoEvento4)
// ============================================================
export interface CancelRequest {
  ambiente: 'homologacao' | 'producao';
  uf: string;
  cnpjEmitente: string;
  chave: string;         // chave de 44 dígitos da NFC-e autorizada
  protocolo: string;     // nProt da autorização
  justificativa: string; // 15 a 255 caracteres
}
export interface CancelResult {
  status: 'CANCELADA' | 'REJEITADA' | 'ERRO';
  cStat?: string; motivo?: string; protocolo?: string; dhRecbto?: string; xmlEvento?: string;
}

export async function cancelarNfce(req: CancelRequest, cert: CertInput): Promise<CancelResult> {
  const just = (req.justificativa || '').trim();
  if (just.length < 15 || just.length > 255) throw new Error('Justificativa deve ter entre 15 e 255 caracteres.');
  const chave = (req.chave || '').replace(/\D/g, '');
  if (chave.length !== 44) throw new Error('Chave da NFC-e inválida (esperado 44 dígitos).');

  const tpAmb: '1' | '2' = req.ambiente === 'producao' ? '1' : '2';
  const uf = req.uf.toUpperCase();
  const cUF = UF_CODIGO[uf];
  if (!cUF) throw new Error(`UF inválida: ${uf}`);

  const cred = carregarCred(cert);
  const endpoints = getSefazEndpoints(uf, tpAmb === '1' ? 'PRODUCAO' : 'HOMOLOGACAO');

  // dhEvento: agora + 30s (evita rejeição por relógio adiantado da SEFAZ)
  const dhEvento = brtIso(new Date(Date.now() + 30000));
  const eventoXml = transport.buildEventoXml(
    chave, '110111', '1', dhEvento, just, req.protocolo, req.cnpjEmitente.replace(/\D/g, ''), cUF, tpAmb,
  );
  const signedEvento = signer.signEvento(eventoXml, cred);
  const r = await transport.cancel(signedEvento, endpoints, cred.certificatePem, cred.privateKeyPem, tpAmb, cUF);

  // 135 = evento registrado e vinculado à NF-e; 155 = cancelamento homologado fora de prazo
  const ok = r.cStat === '135' || r.cStat === '155';
  return {
    status: ok ? 'CANCELADA' : 'REJEITADA',
    cStat: r.cStat, motivo: r.xMotivo, protocolo: r.nProt, dhRecbto: r.dhRecbto, xmlEvento: signedEvento,
  };
}

// ============================================================
//  INUTILIZAÇÃO DE NUMERAÇÃO (NFeInutilizacao4)
// ============================================================
export interface InutRequest {
  ambiente: 'homologacao' | 'producao';
  uf: string;
  cnpjEmitente: string;
  serie: number;
  nNFIni: number;
  nNFFin: number;
  modelo?: 'NFE' | 'NFCE';  // padrão NFCE (65)
  justificativa: string;    // 15 a 255 caracteres
}
export interface InutResult {
  status: 'INUTILIZADA' | 'REJEITADA' | 'ERRO';
  cStat?: string; motivo?: string; protocolo?: string; dhRecbto?: string; xml?: string;
}

export async function inutilizarNumeracao(req: InutRequest, cert: CertInput): Promise<InutResult> {
  const just = (req.justificativa || '').trim();
  if (just.length < 15 || just.length > 255) throw new Error('Justificativa deve ter entre 15 e 255 caracteres.');
  if (!(req.nNFFin >= req.nNFIni)) throw new Error('Faixa inválida: nNFFin deve ser >= nNFIni.');

  const tpAmb: '1' | '2' = req.ambiente === 'producao' ? '1' : '2';
  const uf = req.uf.toUpperCase();
  const cUF = UF_CODIGO[uf];
  if (!cUF) throw new Error(`UF inválida: ${uf}`);

  const cred = carregarCred(cert);
  const endpoints = getSefazEndpoints(uf, tpAmb === '1' ? 'PRODUCAO' : 'HOMOLOGACAO');

  const ano = brtIso(new Date()).slice(2, 4);
  const cnpj = req.cnpjEmitente.replace(/\D/g, '');
  const mod = req.modelo === 'NFE' ? '55' : '65';

  const inutXml = transport.buildInutNFeXml(cUF, ano, cnpj, mod, req.serie, req.nNFIni, req.nNFFin, just, tpAmb);
  const signedInut = signer.signInutilizacao(inutXml, cred);
  const r = await transport.inutilizar(signedInut, endpoints, cred.certificatePem, cred.privateKeyPem, tpAmb, cUF);

  const ok = r.cStat === '102'; // 102 = inutilização de número homologado
  return {
    status: ok ? 'INUTILIZADA' : 'REJEITADA',
    cStat: r.cStat, motivo: r.xMotivo, protocolo: r.nProt, dhRecbto: r.dhRecbto, xml: signedInut,
  };
}

// ============================================================
//  DISTRIBUICAO DFe (notas recebidas / XMLs por ultimo NSU)
// ============================================================
export interface DfeSyncRequest {
  ambiente: 'homologacao' | 'producao';
  uf: string;
  cnpj: string;
  ultNSU?: string;
}

export interface DfeItem {
  cProd?: string;
  xProd?: string;
  ncm?: string;
  cfop?: string;
  uCom?: string;
  qCom?: number;
  vUnCom?: number;
  vProd?: number;
}

export interface DfeDocumento {
  nsu: string;
  schema: string;
  xml: string;
  chave?: string;
  emitente?: string;
  cnpjEmitente?: string;
  foneEmitente?: string;
  destinatario?: string;
  cnpjDestinatario?: string;
  valor?: number;
  dhEmi?: string;
  resumo?: boolean;
  itens?: DfeItem[];
}

export interface DfeSyncResult {
  status: 'OK' | 'SEM_DOCUMENTOS' | 'REJEITADA';
  cStat?: string;
  motivo?: string;
  ultNSU?: string;
  maxNSU?: string;
  documentos: DfeDocumento[];
}

function xmlTag(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`));
  return match ? match[1] : undefined;
}

function xmlFirstElement(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`));
  return match ? match[0] : undefined;
}

function xmlAllElements(xml: string, tag: string): string[] {
  const matches = xml.match(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'g'));
  return matches || [];
}

function numTag(xml: string, tag: string): number | undefined {
  const v = xmlTag(xml, tag);
  return v == null ? undefined : Number(v) || undefined;
}

// Extrai os itens (<det><prod>...) de uma nota de compra, para dar entrada no
// estoque sem precisar reabrir o XML na tela.
function parseItensXml(xml: string): DfeItem[] {
  return xmlAllElements(xml, 'det').map((det) => {
    const prod = xmlFirstElement(det, 'prod') || det;
    return {
      cProd: xmlTag(prod, 'cProd'),
      xProd: xmlTag(prod, 'xProd'),
      ncm: xmlTag(prod, 'NCM'),
      cfop: xmlTag(prod, 'CFOP'),
      uCom: xmlTag(prod, 'uCom'),
      qCom: numTag(prod, 'qCom'),
      vUnCom: numTag(prod, 'vUnCom'),
      vProd: numTag(prod, 'vProd'),
    };
  });
}

function resumirDfe(doc: { nsu: string; schema: string; xml: string }): DfeDocumento {
  const emit = xmlFirstElement(doc.xml, 'emit') || '';
  const dest = xmlFirstElement(doc.xml, 'dest') || '';
  const resumo = /^res/i.test(doc.schema);
  // <chNFe> só existe dentro de <protNFe> (documentos com protocolo). Um XML de
  // NF-e "avulso" (só <NFe>, sem protNFe) traz a chave no atributo Id do <infNFe>.
  const chaveViaId = doc.xml.match(/<infNFe[^>]*\bId="NFe(\d{44})"/)?.[1];
  return {
    nsu: doc.nsu,
    schema: doc.schema,
    xml: doc.xml,
    chave: xmlTag(doc.xml, 'chNFe') || chaveViaId,
    emitente: xmlTag(emit, 'xNome'),
    cnpjEmitente: xmlTag(emit, 'CNPJ') || xmlTag(doc.xml, 'CNPJ'),
    foneEmitente: xmlTag(emit, 'fone'),
    destinatario: xmlTag(dest, 'xNome'),
    cnpjDestinatario: xmlTag(dest, 'CNPJ'),
    valor: Number(xmlTag(doc.xml, 'vNF') || xmlTag(doc.xml, 'vNFe') || 0) || undefined,
    dhEmi: xmlTag(doc.xml, 'dhEmi') || xmlTag(doc.xml, 'dEmi'),
    resumo,
    // documentos "resumo" (schema resNFe/resEvento) não trazem <det> — só o
    // schema completo (procNFe/nfeProc) tem os itens.
    itens: resumo ? undefined : parseItensXml(doc.xml),
  };
}

// Processa um XML de NF-e enviado manualmente (upload ou colado), fora da
// distribuição automática da SEFAZ — mesmo formato de saída de sincronizarDfe,
// pra cair no mesmo fluxo de "dar entrada no estoque" no dashboard.
export function processarXmlAvulso(xml: string): DfeDocumento {
  if (!xmlFirstElement(xml, 'infNFe')) {
    throw new Error('XML inválido: não parece ser uma NF-e (elemento <infNFe> não encontrado).');
  }
  return resumirDfe({ nsu: `MANUAL-${Date.now()}`, schema: 'procNFe', xml });
}

export async function sincronizarDfe(req: DfeSyncRequest, cert: CertInput): Promise<DfeSyncResult> {
  const tpAmb: '1' | '2' = req.ambiente === 'producao' ? '1' : '2';
  const uf = req.uf.toUpperCase();
  const cUF = UF_CODIGO[uf];
  if (!cUF) throw new Error(`UF invalida: ${uf}`);
  const cnpj = (req.cnpj || '').replace(/\D/g, '');
  if (cnpj.length !== 14) throw new Error('CNPJ invalido para distribuicao DFe.');

  const cred = carregarCred(cert);
  const endpoint = getDistribuicaoDFeEndpoint(tpAmb === '1' ? 'PRODUCAO' : 'HOMOLOGACAO');
  const r = await transport.consultaDistribuicaoPorUltNSU(
    cnpj,
    cUF,
    req.ultNSU || '0',
    endpoint,
    cred.certificatePem,
    cred.privateKeyPem,
    tpAmb,
  );

  const documentos = r.documentos.map(resumirDfe);
  const ok = r.cStat === '138' || r.cStat === '137';
  return {
    status: r.cStat === '137' ? 'SEM_DOCUMENTOS' : (ok ? 'OK' : 'REJEITADA'),
    cStat: r.cStat,
    motivo: r.xMotivo,
    ultNSU: r.ultNSU,
    maxNSU: r.maxNSU,
    documentos,
  };
}
