import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import * as https from 'https';
import * as zlib from 'zlib';
import { SefazUfEndpoints } from './sefaz-endpoints';

export interface SefazTransmitResult {
  /** Raw SOAP response XML */
  rawResponse: string;
  /** cStat: 100=autorizado, 101=cancelado, 103=lote recebido, 104=lote processado, 110=denegada, 204=duplicata, etc. */
  cStat: string;
  xMotivo: string;
  /** NF-e access key (44 digits) — present when authorized */
  chNFe?: string;
  /** Authorization protocol */
  nProt?: string;
  /** Authorization datetime */
  dhRecbto?: string;
  /** Receipt number when lote is received asynchronously (cStat=103) */
  nRec?: string;
  /** IBPT tribute value info (not always present) */
  xmlAutorizado?: string;
  /** Error details for rejection */
  errors?: Array<{ cStat: string; xMotivo: string; chNFe?: string }>;
}

export interface SefazStatusResult {
  cStat: string;
  xMotivo: string;
  /** Ambiente: 1=produção, 2=homologação */
  tpAmb: string;
  cUF: string;
}

export interface SefazCancelResult {
  cStat: string;
  xMotivo: string;
  nProt?: string;
  dhRecbto?: string;
}

export interface SefazConsultaResult {
  cStat: string;
  xMotivo: string;
  nProt?: string;
  dhRecbto?: string;
  chNFe?: string;
}

export interface SefazInutilizacaoResult {
  cStat: string;
  xMotivo: string;
  nProt?: string;
  dhRecbto?: string;
}

export interface SefazDistribuicaoDocumento {
  /** NSU (Número Sequencial Único) do documento dentro do lote */
  nsu: string;
  /** Schema do documento retornado, ex: "procNFe_v4.00.xsd" (XML completo) ou "resNFe_v1.01.xsd" (apenas resumo) */
  schema: string;
  /** XML descompactado (gunzip + base64) do <docZip> */
  xml: string;
}

export interface SefazDistribuicaoResult {
  cStat: string;
  xMotivo: string;
  ultNSU?: string;
  maxNSU?: string;
  documentos: SefazDistribuicaoDocumento[];
}

@Injectable()
export class SefazTransport {
  private readonly logger = new Logger(SefazTransport.name);

  /**
   * Builds an axios instance with the client certificate for mutual TLS (mTLS).
   * SEFAZ requires the sender's certificate for authentication.
   */
  private buildHttpClient(
    certPem: string,
    keyPem: string,
    timeoutMs = 30_000,
  ): AxiosInstance {
    const httpsAgent = new https.Agent({
      cert: certPem,
      key: keyPem,
      rejectUnauthorized: true,
    } as any);

    return axios.create({
      httpsAgent,
      timeout: timeoutMs,
      headers: {
        Accept: 'application/soap+xml, text/xml;q=0.9, */*;q=0.8',
      },
    });
  }

  private soap12Headers(action: string): Record<string, string> {
    return {
      'Content-Type': `application/soap+xml; charset=utf-8; action="${action}"`,
      SOAPAction: action,
    };
  }

  // ── NF-e Authorization (NFeAutorizacao4) ─────────────────────────────────

  /**
   * Sends a NF-e lot to SEFAZ for authorization (synchronous lot of 1 note).
   */
  async authorize(
    signedXml: string,
    endpoints: SefazUfEndpoints,
    certPem: string,
    keyPem: string,
    tpAmb: '1' | '2',
    cUF: string,
    idLote: string,
  ): Promise<SefazTransmitResult> {
    const soapBody = this.buildAutorizacaoEnvelope(signedXml, idLote, tpAmb, cUF);
    const soapAction = 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4/nfeAutorizacaoLote';

    const client = this.buildHttpClient(certPem, keyPem);

    this.logger.debug(`Transmitindo para SEFAZ: ${endpoints.autorizacao}`);

    let response;
    try {
      response = await client.post(endpoints.autorizacao, soapBody, {
        headers: this.soap12Headers(soapAction),
      });
    } catch (err: any) {
      throw new Error(this.describeHttpError(err));
    }

    return this.parseAutorizacaoResponse(response.data as string);
  }

  /**
   * Queries the status of a previously sent lot (NFeRetAutorizacao4).
   * Used when the response from authorize() is cStat=103 (lot received but not yet processed).
   */
  async retAutorizacao(
    nRec: string,
    endpoints: SefazUfEndpoints,
    certPem: string,
    keyPem: string,
    tpAmb: '1' | '2',
    cUF: string,
    timeoutMs = 30_000,
  ): Promise<SefazTransmitResult> {
    const soapBody = this.buildRetAutorizacaoEnvelope(nRec, tpAmb, cUF);
    const soapAction = 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeRetAutorizacao4/nfeRetAutorizacaoLote';
    const client = this.buildHttpClient(certPem, keyPem, timeoutMs);

    let response;
    try {
      response = await client.post(endpoints.retAutorizacao, soapBody, {
        headers: this.soap12Headers(soapAction),
      });
    } catch (err: any) {
      throw new Error(this.describeHttpError(err));
    }

    return this.parseAutorizacaoResponse(response.data as string);
  }

  // ── Cancellation (RecepcaoEvento4) ────────────────────────────────────────

  /**
   * Sends a cancellation event to SEFAZ.
   * justification must be between 15 and 255 characters.
   */
  async cancel(
    signedEventoXml: string,
    endpoints: SefazUfEndpoints,
    certPem: string,
    keyPem: string,
    tpAmb: '1' | '2',
    cUF: string,
  ): Promise<SefazCancelResult> {
    const soapBody = this.buildRecepcaoEventoEnvelope(signedEventoXml, tpAmb, cUF);
    const soapAction = 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4/nfeRecepcaoEvento';
    const client = this.buildHttpClient(certPem, keyPem);

    const response = await client.post(endpoints.recepcaoEvento, soapBody, {
      headers: this.soap12Headers(soapAction),
    });

    this.logger.debug(`[CANCEL RAW SOAP RESPONSE]:\n${(response.data as string).slice(0, 3000)}`);

    return this.parseCancelResponse(response.data as string);
  }

  // ── Inutilização de numeração (NFeInutilizacao4) ──────────────────────────

  /**
   * Sends an inutilização (number-range voiding) request to SEFAZ.
   * justification (xJust) must be between 15 and 255 characters.
   */
  async inutilizar(
    signedInutNFeXml: string,
    endpoints: SefazUfEndpoints,
    certPem: string,
    keyPem: string,
    tpAmb: '1' | '2',
    cUF: string,
  ): Promise<SefazInutilizacaoResult> {
    const soapBody = this.buildInutilizacaoEnvelope(signedInutNFeXml, tpAmb, cUF);
    const soapAction = 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeInutilizacao4/nfeInutilizacaoNF';
    const client = this.buildHttpClient(certPem, keyPem);

    let response;
    try {
      response = await client.post(endpoints.inutilizacao, soapBody, {
        headers: this.soap12Headers(soapAction),
      });
    } catch (err: any) {
      throw new Error(this.describeHttpError(err));
    }

    this.logger.debug(`[INUTILIZACAO RAW SOAP RESPONSE]:\n${(response.data as string).slice(0, 3000)}`);

    return this.parseInutilizacaoResponse(response.data as string);
  }

  // ── Consulta Protocolo (NFeConsultaProtocolo4) ─────────────────────────────

  async consultaProtocolo(
    chNFe: string,
    endpoints: SefazUfEndpoints,
    certPem: string,
    keyPem: string,
    tpAmb: '1' | '2',
    cUF: string,
  ): Promise<SefazConsultaResult> {
    const soapBody = this.buildConsultaProtocoloEnvelope(chNFe, tpAmb, cUF);
    const soapAction = 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4/nfeConsultaNF';
    const client = this.buildHttpClient(certPem, keyPem);

    const response = await client.post(endpoints.consultaProtocolo, soapBody, {
      headers: this.soap12Headers(soapAction),
    });

    return this.parseConsultaResponse(response.data as string);
  }

  // ── Distribuição DFe (download do XML autorizado pela chave) ──────────────

  /**
   * Consulta o webservice nacional NFeDistribuicaoDFe e baixa o XML completo
   * (procNFe) de uma NF-e/NFC-e autorizada a partir da chave de acesso.
   * Útil para recuperar documentos cujo XML assinado não ficou salvo
   * localmente (ex.: resposta de autorização perdida em uma retransmissão).
   */
  async consultaDistribuicaoPorChave(
    chNFe: string,
    cnpj: string,
    cUFAutor: string,
    endpointUrl: string,
    certPem: string,
    keyPem: string,
    tpAmb: '1' | '2',
  ): Promise<SefazDistribuicaoResult> {
    const soapBody = this.buildDistDFeChaveEnvelope(chNFe, cnpj, cUFAutor, tpAmb);
    const soapAction = 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse';
    const client = this.buildHttpClient(certPem, keyPem);

    let response;
    try {
      response = await client.post(endpointUrl, soapBody, {
        headers: this.soap12Headers(soapAction),
      });
    } catch (err: any) {
      throw new Error(this.describeHttpError(err));
    }

    return this.parseDistDFeResponse(response.data as string);
  }

  /**
   * Distribuicao DFe por ultimo NSU: varre documentos de interesse do CNPJ
   * a partir do ultNSU informado. Reaproveitado do modulo fiscal Construline.
   */
  async consultaDistribuicaoPorUltNSU(
    cnpj: string,
    cUFAutor: string,
    ultNSU: string,
    endpointUrl: string,
    certPem: string,
    keyPem: string,
    tpAmb: '1' | '2',
  ): Promise<SefazDistribuicaoResult> {
    const soapBody = this.buildDistDFeUltNsuEnvelope(cnpj, cUFAutor, ultNSU, tpAmb);
    const soapAction = 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse';
    const client = this.buildHttpClient(certPem, keyPem);

    let response;
    try {
      response = await client.post(endpointUrl, soapBody, {
        headers: this.soap12Headers(soapAction),
      });
    } catch (err: any) {
      throw new Error(this.describeHttpError(err));
    }

    return this.parseDistDFeResponse(response.data as string);
  }

  private buildDistDFeUltNsuEnvelope(
    cnpj: string,
    cUFAutor: string,
    ultNSU: string,
    tpAmb: string,
  ): string {
    const nsu = String(ultNSU ?? '0').replace(/\D/g, '').padStart(15, '0');
    return (
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">` +
      `<soap:Header/>` +
      `<soap:Body>` +
      `<nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe">` +
      `<nfeDadosMsg>` +
      `<distDFeInt versao="1.01" xmlns="http://www.portalfiscal.inf.br/nfe">` +
      `<tpAmb>${tpAmb}</tpAmb>` +
      `<cUFAutor>${cUFAutor}</cUFAutor>` +
      `<CNPJ>${cnpj}</CNPJ>` +
      `<distNSU><ultNSU>${nsu}</ultNSU></distNSU>` +
      `</distDFeInt>` +
      `</nfeDadosMsg>` +
      `</nfeDistDFeInteresse>` +
      `</soap:Body>` +
      `</soap:Envelope>`
    );
  }

  private buildDistDFeChaveEnvelope(chNFe: string, cnpj: string, cUFAutor: string, tpAmb: string): string {
    return (
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">` +
      `<soap:Header/>` +
      `<soap:Body>` +
      `<nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe">` +
      `<nfeDadosMsg>` +
      `<distDFeInt versao="1.01" xmlns="http://www.portalfiscal.inf.br/nfe">` +
      `<tpAmb>${tpAmb}</tpAmb>` +
      `<cUFAutor>${cUFAutor}</cUFAutor>` +
      `<CNPJ>${cnpj}</CNPJ>` +
      `<consChNFe><chNFe>${chNFe}</chNFe></consChNFe>` +
      `</distDFeInt>` +
      `</nfeDadosMsg>` +
      `</nfeDistDFeInteresse>` +
      `</soap:Body>` +
      `</soap:Envelope>`
    );
  }

  private parseDistDFeResponse(soapXml: string): SefazDistribuicaoResult {
    const retDistXml = this.extractElement(soapXml, 'retDistDFeInt') ?? soapXml;
    const cStat = this.extractTag(retDistXml, 'cStat') ?? '999';
    const xMotivo = this.extractTag(retDistXml, 'xMotivo') ?? 'Erro desconhecido';
    const ultNSU = this.extractTag(retDistXml, 'ultNSU') ?? undefined;
    const maxNSU = this.extractTag(retDistXml, 'maxNSU') ?? undefined;

    const documentos: SefazDistribuicaoDocumento[] = [];
    const docZipRegex = /<docZip\s+([^>]*)>([\s\S]*?)<\/docZip>/g;
    let match: RegExpExecArray | null;
    while ((match = docZipRegex.exec(retDistXml)) !== null) {
      const attrs = match[1];
      const base64Content = match[2].trim();
      const nsu = (attrs.match(/NSU="(\d+)"/) ?? [])[1] ?? '';
      const schema = (attrs.match(/schema="([^"]+)"/) ?? [])[1] ?? '';

      try {
        const xml = zlib.gunzipSync(Buffer.from(base64Content, 'base64')).toString('utf-8');
        documentos.push({ nsu, schema, xml });
      } catch (err: any) {
        this.logger.warn(`Falha ao descompactar docZip (NSU=${nsu}, schema=${schema}): ${err?.message ?? err}`);
      }
    }

    return { cStat, xMotivo, ultNSU, maxNSU, documentos };
  }

  // ── Status Serviço ────────────────────────────────────────────────────────

  async statusServico(
    endpoints: SefazUfEndpoints,
    certPem: string,
    keyPem: string,
    tpAmb: '1' | '2',
    cUF: string,
  ): Promise<SefazStatusResult> {
    const soapBody = this.buildStatusServicoEnvelope(tpAmb, cUF);
    const soapAction = 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4/nfeStatusServicoNF';
    const client = this.buildHttpClient(certPem, keyPem);

    const response = await client.post(endpoints.statusServico, soapBody, {
      headers: this.soap12Headers(soapAction),
    });

    return this.parseStatusResponse(response.data as string);
  }

  // ── SOAP envelope builders ─────────────────────────────────────────────────

  private buildAutorizacaoEnvelope(
    signedXml: string,
    idLote: string,
    tpAmb: string,
    cUF: string,
  ): string {
    const nfeXml = this.normalizeXmlFragment(signedXml);
    return (
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:nfe="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">` +
      `<soap:Header><nfe:nfeCabecMsg><nfe:cUF>${cUF}</nfe:cUF><nfe:versaoDados>4.00</nfe:versaoDados></nfe:nfeCabecMsg></soap:Header>` +
      `<soap:Body>` +
      `<nfe:nfeDadosMsg>` +
      `<enviNFe versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">` +
      `<idLote>${idLote}</idLote>` +
      `<indSinc>1</indSinc>` +
      nfeXml +
      `</enviNFe>` +
      `</nfe:nfeDadosMsg>` +
      `</soap:Body>` +
      `</soap:Envelope>`
    );
  }

  private buildRetAutorizacaoEnvelope(
    nRec: string,
    tpAmb: string,
    cUF: string,
  ): string {
    return (
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:nfe="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRetAutorizacao4">` +
      `<soap:Header><nfe:nfeCabecMsg><nfe:cUF>${cUF}</nfe:cUF><nfe:versaoDados>4.00</nfe:versaoDados></nfe:nfeCabecMsg></soap:Header>` +
      `<soap:Body>` +
      `<nfe:nfeDadosMsg>` +
      `<consReciNFe versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">` +
      `<tpAmb>${tpAmb}</tpAmb>` +
      `<nRec>${nRec}</nRec>` +
      `</consReciNFe>` +
      `</nfe:nfeDadosMsg>` +
      `</soap:Body>` +
      `</soap:Envelope>`
    );
  }

  private buildConsultaProtocoloEnvelope(chNFe: string, tpAmb: string, cUF: string): string {
    return (
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:nfe="http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4">` +
      `<soap:Header><nfe:nfeCabecMsg><nfe:cUF>${cUF}</nfe:cUF><nfe:versaoDados>4.00</nfe:versaoDados></nfe:nfeCabecMsg></soap:Header>` +
      `<soap:Body>` +
      `<nfe:nfeDadosMsg>` +
      `<consSitNFe versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">` +
      `<tpAmb>${tpAmb}</tpAmb>` +
      `<xServ>CONSULTAR</xServ>` +
      `<chNFe>${chNFe}</chNFe>` +
      `</consSitNFe>` +
      `</nfe:nfeDadosMsg>` +
      `</soap:Body>` +
      `</soap:Envelope>`
    );
  }

  private buildStatusServicoEnvelope(tpAmb: string, cUF: string): string {
    return (
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:nfe="http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4">` +
      `<soap:Header><nfe:nfeCabecMsg><nfe:cUF>${cUF}</nfe:cUF><nfe:versaoDados>4.00</nfe:versaoDados></nfe:nfeCabecMsg></soap:Header>` +
      `<soap:Body>` +
      `<nfe:nfeDadosMsg>` +
      `<consStatServ versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">` +
      `<tpAmb>${tpAmb}</tpAmb>` +
      `<cUF>${cUF}</cUF>` +
      `<xServ>STATUS</xServ>` +
      `</consStatServ>` +
      `</nfe:nfeDadosMsg>` +
      `</soap:Body>` +
      `</soap:Envelope>`
    );
  }

  private buildRecepcaoEventoEnvelope(xmlEvento: string, tpAmb: string, cUF: string): string {
    const eventoXml = this.normalizeXmlFragment(xmlEvento);
    return (
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:nfe="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4">` +
      `<soap:Header><nfe:nfeCabecMsg><nfe:cUF>${cUF}</nfe:cUF><nfe:versaoDados>1.00</nfe:versaoDados></nfe:nfeCabecMsg></soap:Header>` +
      `<soap:Body>` +
      `<nfe:nfeDadosMsg>` +
      `<envEvento versao="1.00" xmlns="http://www.portalfiscal.inf.br/nfe">` +
      `<idLote>${Date.now()}</idLote>` +
      eventoXml +
      `</envEvento>` +
      `</nfe:nfeDadosMsg>` +
      `</soap:Body>` +
      `</soap:Envelope>`
    );
  }

  private buildInutilizacaoEnvelope(signedXml: string, tpAmb: string, cUF: string): string {
    const inutXml = this.normalizeXmlFragment(signedXml);
    return (
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:nfe="http://www.portalfiscal.inf.br/nfe/wsdl/NFeInutilizacao4">` +
      `<soap:Header><nfe:nfeCabecMsg><nfe:cUF>${cUF}</nfe:cUF><nfe:versaoDados>4.00</nfe:versaoDados></nfe:nfeCabecMsg></soap:Header>` +
      `<soap:Body>` +
      `<nfe:nfeDadosMsg>` +
      inutXml +
      `</nfe:nfeDadosMsg>` +
      `</soap:Body>` +
      `</soap:Envelope>`
    );
  }

  /**
   * Builds the unsigned <inutNFe> XML for a number-range voiding request.
   * Id format per SEFAZ schema: ID + cUF(2) + ano(2) + CNPJ(14) + mod(2) + serie(3) + nNFIni(9) + nNFFin(9).
   */
  buildInutNFeXml(
    cUF: string,
    ano: string,
    cnpj: string,
    mod: string,
    serie: number,
    numberStart: number,
    numberEnd: number,
    justification: string,
    tpAmb: '1' | '2',
  ): string {
    const serieStr = String(serie).padStart(3, '0');
    const nNFIni = String(numberStart).padStart(9, '0');
    const nNFFin = String(numberEnd).padStart(9, '0');
    const id = `ID${cUF}${ano}${cnpj}${mod}${serieStr}${nNFIni}${nNFFin}`;
    return (
      `<inutNFe versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">` +
      `<infInut Id="${id}">` +
      `<tpAmb>${tpAmb}</tpAmb>` +
      `<xServ>INUTILIZAR</xServ>` +
      `<cUF>${cUF}</cUF>` +
      `<ano>${ano}</ano>` +
      `<CNPJ>${cnpj}</CNPJ>` +
      `<mod>${mod}</mod>` +
      `<serie>${serie}</serie>` +
      `<nNFIni>${numberStart}</nNFIni>` +
      `<nNFFin>${numberEnd}</nNFFin>` +
      `<xJust>${justification}</xJust>` +
      `</infInut>` +
      `</inutNFe>`
    );
  }

  buildEventoXml(
    chNFe: string,
    tpEvento: string,
    nSeqEvento: string,
    dhEvento: string,
    justification: string,
    nProt: string,
    cnpjEmitente: string,
    cUF: string,
    tpAmb: '1' | '2',
  ): string {
    const id = `ID${tpEvento}${chNFe}${nSeqEvento.padStart(2, '0')}`;
    return (
      `<evento versao="1.00" xmlns="http://www.portalfiscal.inf.br/nfe">` +
      `<infEvento Id="${id}">` +
      `<cOrgao>${cUF}</cOrgao>` +
      `<tpAmb>${tpAmb}</tpAmb>` +
      `<CNPJ>${cnpjEmitente.replace(/\D/g, '')}</CNPJ>` +
      `<chNFe>${chNFe}</chNFe>` +
      `<dhEvento>${dhEvento}</dhEvento>` +
      `<tpEvento>${tpEvento}</tpEvento>` +
      `<nSeqEvento>${nSeqEvento}</nSeqEvento>` +
      `<verEvento>1.00</verEvento>` +
      `<detEvento versao="1.00">` +
      `<descEvento>Cancelamento</descEvento>` +
      `<nProt>${nProt}</nProt>` +
      `<xJust>${justification}</xJust>` +
      `</detEvento>` +
      `</infEvento>` +
      `</evento>`
    );
  }

  // ── Response parsers ───────────────────────────────────────────────────────

  private parseAutorizacaoResponse(soapXml: string): SefazTransmitResult {
    const loteCStat = this.extractTag(soapXml, 'cStat') ?? '999';
    const loteXMotivo = this.extractTag(soapXml, 'xMotivo') ?? 'Erro desconhecido';
    const nRec = this.extractTag(soapXml, 'nRec') ?? undefined;

    // When SEFAZ returns cStat=104 (lote processado), the final result is inside <infProt>.
    const infProtXml = this.extractElement(soapXml, 'infProt');
    const finalCStat = infProtXml ? this.extractTag(infProtXml, 'cStat') : null;
    const finalXMotivo = infProtXml ? this.extractTag(infProtXml, 'xMotivo') : null;
    const chNFe = (infProtXml ? this.extractTag(infProtXml, 'chNFe') : null) ?? undefined;
    const nProt = (infProtXml ? this.extractTag(infProtXml, 'nProt') : null) ?? undefined;
    const dhRecbto = (infProtXml ? this.extractTag(infProtXml, 'dhRecbto') : null) ?? undefined;

    return {
      rawResponse: soapXml,
      cStat: finalCStat ?? loteCStat,
      xMotivo: finalXMotivo ?? loteXMotivo,
      chNFe,
      nProt,
      dhRecbto,
      nRec,
    };
  }

  private parseCancelResponse(soapXml: string): SefazCancelResult {
    // cStat=128 means "Lote de Evento Processado" (batch accepted).
    // The actual event result is inside <infEvento> in the response.
    const infEventoXml = this.extractElement(soapXml, 'infEvento');
    const cStat = (infEventoXml ? this.extractTag(infEventoXml, 'cStat') : null)
      ?? this.extractTag(soapXml, 'cStat')
      ?? '999';
    const xMotivo = (infEventoXml ? this.extractTag(infEventoXml, 'xMotivo') : null)
      ?? this.extractTag(soapXml, 'xMotivo')
      ?? 'Erro desconhecido';
    const nProt = (infEventoXml ? this.extractTag(infEventoXml, 'nProt') : null)
      ?? this.extractTag(soapXml, 'nProt')
      ?? undefined;
    const dhRecbto = (infEventoXml ? this.extractTag(infEventoXml, 'dhRecbto') : null)
      ?? this.extractTag(soapXml, 'dhRecbto')
      ?? undefined;
    return { cStat, xMotivo, nProt, dhRecbto };
  }

  private parseInutilizacaoResponse(soapXml: string): SefazInutilizacaoResult {
    // cStat=102 means "Inutilização de número homologado".
    // The result is inside <infInut> in <retInutNFe>.
    const infInutXml = this.extractElement(soapXml, 'infInut');
    const cStat = (infInutXml ? this.extractTag(infInutXml, 'cStat') : null)
      ?? this.extractTag(soapXml, 'cStat')
      ?? '999';
    const xMotivo = (infInutXml ? this.extractTag(infInutXml, 'xMotivo') : null)
      ?? this.extractTag(soapXml, 'xMotivo')
      ?? 'Erro desconhecido';
    const nProt = (infInutXml ? this.extractTag(infInutXml, 'nProt') : null)
      ?? this.extractTag(soapXml, 'nProt')
      ?? undefined;
    const dhRecbto = (infInutXml ? this.extractTag(infInutXml, 'dhRecbto') : null)
      ?? this.extractTag(soapXml, 'dhRecbto')
      ?? undefined;
    return { cStat, xMotivo, nProt, dhRecbto };
  }

  private parseConsultaResponse(soapXml: string): SefazConsultaResult {
    const infProtXml = this.extractElement(soapXml, 'infProt');
    const cStat = (infProtXml ? this.extractTag(infProtXml, 'cStat') : null)
      ?? this.extractTag(soapXml, 'cStat')
      ?? '999';
    const xMotivo = (infProtXml ? this.extractTag(infProtXml, 'xMotivo') : null)
      ?? this.extractTag(soapXml, 'xMotivo')
      ?? 'Erro desconhecido';
    const nProt = (infProtXml ? this.extractTag(infProtXml, 'nProt') : null) ?? undefined;
    const dhRecbto = (infProtXml ? this.extractTag(infProtXml, 'dhRecbto') : null) ?? undefined;
    const chNFe = (infProtXml ? this.extractTag(infProtXml, 'chNFe') : null) ?? undefined;
    return { cStat, xMotivo, nProt, dhRecbto, chNFe };
  }

  private parseStatusResponse(soapXml: string): SefazStatusResult {
    return {
      cStat: this.extractTag(soapXml, 'cStat') ?? '999',
      xMotivo: this.extractTag(soapXml, 'xMotivo') ?? 'Erro',
      tpAmb: this.extractTag(soapXml, 'tpAmb') ?? '2',
      cUF: this.extractTag(soapXml, 'cUF') ?? '',
    };
  }

  private extractTag(xml: string, tag: string): string | null {
    const match = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)<\/${tag}>`));
    return match ? match[1] : null;
  }

  private extractElement(xml: string, tag: string): string | null {
    const match = xml.match(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\/${tag}>`));
    return match ? match[0] : null;
  }

  private describeHttpError(err: any): string {
    const status = err?.response?.status;
    const data = err?.response?.data;
    const dataText =
      typeof data === 'string'
        ? data.replace(/\s+/g, ' ').slice(0, 500)
        : JSON.stringify(data ?? {}).slice(0, 500);
    return `HTTP ${status ?? 'N/A'} - ${err?.message ?? 'Erro de comunicacao'} - payload: ${dataText}`;
  }

  private normalizeXmlFragment(xml: string): string {
    if (!xml) return '';
    return xml
      .replace(/^\uFEFF/, '')
      .replace(/<\?xml[^>]*\?>/gi, '')
      .trim();
  }
}
