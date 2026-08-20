import { Injectable } from '@nestjs/common';
import { create } from 'xmlbuilder2';
import * as crypto from 'crypto';


export interface NfeXmlInput {
  // Identification
  cUF: string;           // UF code (IBGE)
  cNF: string;           // random 8-digit code
  natOp: string;         // nature of operation
  mod: '55' | '65';      // model
  serie: number;
  nNF: number;           // NF number
  dhEmi: string;         // ISO datetime BRT e.g. "2026-05-07T14:55:22-03:00"
  dhSaiEnt?: string;     // output/entry datetime
  tpNF: '0' | '1';       // 0=entrada, 1=saída
  idDest: '1' | '2' | '3'; // 1=internal, 2=interstate, 3=exterior
  cMunFG: string;        // IBGE municipality code of emitter
  tpImp: '1' | '2' | '4'; // 1=portrait DANFE
  tpEmis: '1' | '9';     // 1=normal emission, 9=contingência offline (NFC-e)
  dhCont?: string;       // data/hora de entrada em contingência (ISO BRT) — obrigatório se tpEmis=9
  xJust?: string;        // justificativa da contingência (15..256) — obrigatório se tpEmis=9
  cDV?: string;          // check digit (calculated after)
  tpAmb: '1' | '2';      // 1=prod, 2=hom
  finNFe: '1' | '2' | '3' | '4'; // 1=normal
  indFinal: '0' | '1';   // 0=not final consumer, 1=final consumer
  indPres: '0'|'1'|'2'|'3'|'4'|'9'; // physical presence
  // Obrigatório (NT 2020.006) quando indPres = 2, 3, 4 ou 9. 0=sem intermediador
  // (canal próprio, ex: app do próprio emitente), 1=venda via marketplace de terceiro.
  indIntermed?: '0' | '1';
  procEmi: '0';          // 0=software

  // Reference to original NF-e (required for devolution — finNFe=4)
  refNFe?: string;       // 44-digit access key of the original NF-e

  // Emitter
  emitter: {
    cnpj: string;
    xNome: string;
    xFant?: string;
    xLgr: string;
    nro: string;
    xCpl?: string;
    xBairro: string;
    cMun: string;
    xMun: string;
    uf: string;
    cep: string;
    cPais: '1058';
    xPais: 'Brasil';
    fone?: string;
    ie: string;
    crt: '1' | '2' | '3'; // 1=Simples Nacional, 3=Regime Normal
  };

  // Recipient (optional for NFC-e anonymous consumer)
  recipient?: {
    cnpj?: string;
    cpf?: string;
    xNome: string;
    xLgr?: string;
    nro?: string;
    xCpl?: string;
    xBairro?: string;
    cMun?: string;
    xMun?: string;
    uf?: string;
    cep?: string;
    cPais?: string;
    xPais?: string;
    fone?: string;
    email?: string;
    indIEDest?: '1' | '2' | '9'; // 1=contribuinte ICMS, 2=isento, 9=nao contribuinte
    ie?: string;
  };

  // Items
  items: NfeXmlItem[];

  // Totals
  totals: {
    vBC: number;
    vICMS: number;
    vICMSDeson: number;
    vFCP: number;
    vBCST: number;
    vST: number;
    vFCPST: number;
    vFCPSTRet: number;
    vProd: number;
    vFrete: number;
    vSeg: number;
    vDesc: number;
    vII: number;
    vIPI: number;
    vIPIDevol: number;
    vPIS: number;
    vCOFINS: number;
    vOutro: number;
    vNF: number;
    vTotTrib: number;
  };

  // Payment (required for modelo 65; for 55 can be "sem pagamento")
  payment?: {
    indPag?: '0' | '1';
    tPag: string; // '01'=dinheiro, '03'=cartão crédito, '04'=débito, '15'=boleto, '90'=sem pagamento
    xPag?: string;
    vPag: number;
    vTroco?: number;
    card?: {
      tpIntegra: '1' | '2'; // 1=integrado, 2=não integrado
      tBand: string;         // 01=Visa, 02=Master, 99=outras
      CNPJ?: string;
      cAut?: string;
    };
  };

  // Additional info
  infAdic?: string;

  // NFC-e supplemental information
  supplemental?: {
    qrCode: string;
    urlChave?: string;
  };
}

export interface NfeXmlItem {
  nItem: number;
  cProd: string;
  cEAN?: "1234567890128";
  xProd: string;
  ncm: string;
  cest?: string;
  cfop: string;
  uCom: string;
  qCom: number;
  vUnCom: number;
  vProd: number;
  cEANTrib?: "1234567890128";
  uTrib?: string;
  qTrib?: number;
  vUnTrib?: number;
  vDesc?: number;
  vFrete?: number;
  indTot: '0' | '1';
  // ICMS (Simples Nacional uses CSOSN; others use CST)
  icms: NfeIcmsSimples | NfeIcmsNormal;
  // PIS
  pis: NfePis;
  // COFINS
  cofins: NfeCofins;
  // Valor aproximado dos tributos deste item (Lei 12.741/2012). A SOMA de todos os
  // itens precisa bater exatamente com o total.vTotTrib, senão a SEFAZ rejeita.
  vTotTrib?: number;
  // Additional item info
  infAdProd?: string;
}

// ---- ICMS variants ----
export interface NfeIcmsSimples {
  type: 'simples';
  orig: string;         // 0=Nacional, 1=Estrangeira, etc.
  csosn: string;        // CSOSN code: 102, 500, etc.
  // CSOSN 900 (with calc):
  modBC?: string;
  vBC?: number;
  pRedBC?: number;
  pICMS?: number;
  vICMS?: number;
  modBCST?: string;
  pMVAST?: number;
  pRedBCST?: number;
  vBCST?: number;
  pICMSST?: number;
  vICMSST?: number;
  vBCFCPST?: number;
  pFCPST?: number;
  vFCPST?: number;
}

export interface NfeIcmsNormal {
  type: 'normal';
  orig: string;
  cst: string;          // CST: 00, 10, 20, 30, 40, 41, 50, 51, 60, 70, 90
  modBC?: string;
  vBC?: number;
  pRedBC?: number;
  pICMS?: number;
  vICMS?: number;
}

// ---- PIS ----
export interface NfePis {
  cst: string;         // '07'=isento, '01'=tributável, '99'=outras
  vBC?: number;
  pPIS?: number;
  vPIS: number;
}

// ---- COFINS ----
export interface NfeCofins {
  cst: string;
  vBC?: number;
  pCOFINS?: number;
  vCOFINS: number;
}

@Injectable()
export class NfeXmlBuilder {
  /**
   * Builds the unsigned NF-e XML string.
   * The caller must then:
   *   1. Calculate cDV (key check digit)
   *   2. Sign with NfeXmlSigner
   */
  build(input: NfeXmlInput): string {
    const chave = this.buildChave(input);
    const cDV = this.calcDV(chave);

    const root = create({ version: '1.0', encoding: 'UTF-8' });

    // For authorization (enviNFe), SEFAZ expects NFe as the document root.
    const nfe = root.ele('NFe', {
      xmlns: 'http://www.portalfiscal.inf.br/nfe',
    });

    const infNFe = nfe.ele('infNFe', {
      Id: `NFe${chave}${cDV}`,
      versao: '4.00',
    });

    // ── ide ──────────────────────────────────────────────
    const ide = infNFe.ele('ide');
    ide.ele('cUF').txt(input.cUF);
    ide.ele('cNF').txt(input.cNF);
    ide.ele('natOp').txt(input.natOp);
    ide.ele('mod').txt(input.mod);
    ide.ele('serie').txt(String(input.serie));
    ide.ele('nNF').txt(String(input.nNF));
    ide.ele('dhEmi').txt(input.dhEmi);
    if (input.dhSaiEnt) ide.ele('dhSaiEnt').txt(input.dhSaiEnt);
    ide.ele('tpNF').txt(input.tpNF);
    ide.ele('idDest').txt(input.idDest);
    ide.ele('cMunFG').txt(input.cMunFG);
    ide.ele('tpImp').txt(input.tpImp);
    ide.ele('tpEmis').txt(input.tpEmis);
    ide.ele('cDV').txt(cDV);
    ide.ele('tpAmb').txt(input.tpAmb);
    ide.ele('finNFe').txt(input.finNFe);
    ide.ele('indFinal').txt(input.indFinal);
    ide.ele('indPres').txt(input.indPres);
    // Obrigatório (NT 2020.006) quando indPres = 2, 3, 4 ou 9 — declara se a venda
    // passou por um marketplace/intermediador (1) ou foi direto pelo próprio
    // canal do emitente, ex: app próprio (0).
    if (['2', '3', '4', '9'].includes(input.indPres)) {
      ide.ele('indIntermed').txt(input.indIntermed ?? '0');
    }
    ide.ele('procEmi').txt(input.procEmi);
    ide.ele('verProc').txt('1.0.0');

    // Contingência offline (tpEmis=9): dhCont + xJust, após verProc e antes de NFref
    if (input.tpEmis === '9' && input.dhCont && input.xJust) {
      ide.ele('dhCont').txt(input.dhCont);
      ide.ele('xJust').txt(input.xJust);
    }

    // NFref — obrigatório para finNFe=4 (devolução)
    if (input.refNFe) {
      ide.ele('NFref').ele('refNFe').txt(input.refNFe);
    }

    // ── emit ─────────────────────────────────────────────
    const emit = infNFe.ele('emit');
    emit.ele('CNPJ').txt(input.emitter.cnpj.replace(/\D/g, ''));
    emit.ele('xNome').txt(this.sanitizeNfeText(input.emitter.xNome));
    if (input.emitter.xFant) emit.ele('xFant').txt(this.sanitizeNfeText(input.emitter.xFant));

    const enderEmit = emit.ele('enderEmit');
    enderEmit.ele('xLgr').txt(this.sanitizeNfeText(input.emitter.xLgr));
    enderEmit.ele('nro').txt(input.emitter.nro);
    if (input.emitter.xCpl) enderEmit.ele('xCpl').txt(this.sanitizeNfeText(input.emitter.xCpl));
    enderEmit.ele('xBairro').txt(this.sanitizeNfeText(input.emitter.xBairro));
    enderEmit.ele('cMun').txt(input.emitter.cMun);
    enderEmit.ele('xMun').txt(this.sanitizeNfeText(input.emitter.xMun));
    enderEmit.ele('UF').txt(input.emitter.uf);
    enderEmit.ele('CEP').txt(input.emitter.cep.replace(/\D/g, ''));
    enderEmit.ele('cPais').txt('1058');
    enderEmit.ele('xPais').txt('Brasil');
    if (input.emitter.fone) enderEmit.ele('fone').txt(input.emitter.fone.replace(/\D/g, ''));

    emit.ele('IE').txt(input.emitter.ie.replace(/\D/g, ''));
    emit.ele('CRT').txt(input.emitter.crt);

    // ── dest (omitido para NFC-e com consumidor não identificado) ────────────
    if (input.recipient) {
      const r = input.recipient;
      const dest = infNFe.ele('dest');
      if (r.cnpj) {
        dest.ele('CNPJ').txt(r.cnpj.replace(/\D/g, ''));
      } else if (r.cpf) {
        dest.ele('CPF').txt(r.cpf.replace(/\D/g, ''));
      }
      dest.ele('xNome').txt(this.sanitizeNfeText(r.xNome));

      const hasRecipientAddress =
        Boolean(r.xLgr) &&
        Boolean(r.xBairro) &&
        Boolean(r.cMun) &&
        Boolean(r.xMun) &&
        Boolean(r.uf) &&
        Boolean(r.cep);

      if (hasRecipientAddress) {
        const enderDest = dest.ele('enderDest');
        enderDest.ele('xLgr').txt(this.sanitizeNfeText(r.xLgr!));
        enderDest.ele('nro').txt(r.nro ?? 'S/N');
        if (r.xCpl) enderDest.ele('xCpl').txt(this.sanitizeNfeText(r.xCpl));
        enderDest.ele('xBairro').txt(this.sanitizeNfeText(r.xBairro!));
        enderDest.ele('cMun').txt(r.cMun!);
        enderDest.ele('xMun').txt(this.sanitizeNfeText(r.xMun!));
        enderDest.ele('UF').txt(r.uf!);
        enderDest.ele('CEP').txt(r.cep!.replace(/\D/g, ''));
        enderDest.ele('cPais').txt(r.cPais ?? '1058');
        enderDest.ele('xPais').txt(r.xPais ?? 'Brasil');
        if (r.fone) enderDest.ele('fone').txt(r.fone.replace(/\D/g, ''));
      }

      dest.ele('indIEDest').txt(r.indIEDest ?? '9');
      if (r.ie) dest.ele('IE').txt(r.ie.replace(/\D/g, ''));
      if (r.email) dest.ele('email').txt(r.email);
    }

    // ── det (items) ───────────────────────────────────────
    for (const item of input.items) {
      const det = infNFe.ele('det', { nItem: String(item.nItem) });
      const prod = det.ele('prod');
      prod.ele('cProd').txt(item.cProd);
      prod.ele('cEAN').txt(item.cEAN ?? 'SEM GTIN');
      prod.ele('xProd').txt(this.sanitizeNfeText(item.xProd));
      prod.ele('NCM').txt(item.ncm.replace(/\D/g, ''));
      if (item.cest) prod.ele('CEST').txt(item.cest.replace(/\D/g, ''));
      prod.ele('CFOP').txt(item.cfop);
      prod.ele('uCom').txt(item.uCom);
      prod.ele('qCom').txt(this.fmt4(item.qCom));
      prod.ele('vUnCom').txt(this.fmt10(item.vUnCom));
      prod.ele('vProd').txt(this.fmt2(item.vProd));
      prod.ele('cEANTrib').txt(item.cEANTrib ?? 'SEM GTIN');
      prod.ele('uTrib').txt(item.uTrib ?? item.uCom);
      prod.ele('qTrib').txt(this.fmt4(item.qTrib ?? item.qCom));
      prod.ele('vUnTrib').txt(this.fmt10(item.vUnTrib ?? item.vUnCom));
      if (item.vFrete) prod.ele('vFrete').txt(this.fmt2(item.vFrete));
      if (item.vDesc) prod.ele('vDesc').txt(this.fmt2(item.vDesc));
      prod.ele('indTot').txt(item.indTot);

      // Schema requires all tax groups inside a single <imposto> per item.
      const imposto = det.ele('imposto');

      // vTotTrib vem antes do ICMS — a soma de todos os itens precisa bater
      // exatamente com total.vTotTrib, senão a SEFAZ rejeita.
      if (item.vTotTrib) imposto.ele('vTotTrib').txt(this.fmt2(item.vTotTrib));

      // ICMS
      const icmsTag = imposto.ele('ICMS');
      this.buildIcms(icmsTag, item.icms);

      // PIS
      const pisTag = imposto.ele('PIS');
      this.buildPis(pisTag, item.pis);

      // COFINS
      const cofinsTag = imposto.ele('COFINS');
      this.buildCofins(cofinsTag, item.cofins);

      if (item.infAdProd) det.ele('infAdProd').txt(item.infAdProd);
    }

    // ── total ─────────────────────────────────────────────
    const total = infNFe.ele('total');
    const icmsTot = total.ele('ICMSTot');
    const t = input.totals;
    icmsTot.ele('vBC').txt(this.fmt2(t.vBC));
    icmsTot.ele('vICMS').txt(this.fmt2(t.vICMS));
    icmsTot.ele('vICMSDeson').txt(this.fmt2(t.vICMSDeson));
    icmsTot.ele('vFCP').txt(this.fmt2(t.vFCP));
    icmsTot.ele('vBCST').txt(this.fmt2(t.vBCST));
    icmsTot.ele('vST').txt(this.fmt2(t.vST));
    icmsTot.ele('vFCPST').txt(this.fmt2(t.vFCPST));
    icmsTot.ele('vFCPSTRet').txt(this.fmt2(t.vFCPSTRet));
    icmsTot.ele('vProd').txt(this.fmt2(t.vProd));
    icmsTot.ele('vFrete').txt(this.fmt2(t.vFrete));
    icmsTot.ele('vSeg').txt(this.fmt2(t.vSeg));
    icmsTot.ele('vDesc').txt(this.fmt2(t.vDesc));
    icmsTot.ele('vII').txt(this.fmt2(t.vII));
    icmsTot.ele('vIPI').txt(this.fmt2(t.vIPI));
    icmsTot.ele('vIPIDevol').txt(this.fmt2(t.vIPIDevol));
    icmsTot.ele('vPIS').txt(this.fmt2(t.vPIS));
    icmsTot.ele('vCOFINS').txt(this.fmt2(t.vCOFINS));
    icmsTot.ele('vOutro').txt(this.fmt2(t.vOutro));
    icmsTot.ele('vNF').txt(this.fmt2(t.vNF));
    icmsTot.ele('vTotTrib').txt(this.fmt2(t.vTotTrib));

    // ── transp ────────────────────────────────────────────
    const transp = infNFe.ele('transp');
    transp.ele('modFrete').txt('9'); // 9=sem frete

    // ── cobr / pag ────────────────────────────────────────
   // ── cobr / pag ────────────────────────────────────────
    const pag = infNFe.ele('pag');
    if (input.payment) {
      const detPag = pag.ele('detPag');
      detPag.ele('tPag').txt(input.payment.tPag);
      if (input.payment.tPag === '99' && input.payment.xPag) {
        detPag.ele('xPag').txt(input.payment.xPag.slice(0, 60));
      }
      detPag.ele('vPag').txt(this.fmt2(input.payment.vPag));

      // xPag deve ser informado apenas para tPag='99' (Outros).
      // card: obrigatório para tPag='03' (crédito), '04' (débito), '17' (PIX) e
      // '20' — sem isso a SEFAZ rejeita com "391: Não informados os dados do
      // cartão de crédito/débito nas Formas de Pagamento da Nota Fiscal".
      if (['03', '04', '17', '20'].includes(input.payment.tPag)) {
        const card = input.payment.card ?? { tpIntegra: '2' as const, tBand: '99' };
        const cardEle = detPag.ele('card');
        cardEle.ele('tpIntegra').txt(card.tpIntegra);
        if (card.CNPJ) cardEle.ele('CNPJ').txt(card.CNPJ.replace(/\D/g, ''));
        cardEle.ele('tBand').txt(card.tBand);
        if (card.cAut) cardEle.ele('cAut').txt(card.cAut);
      }

      // vTroco no nível <pag>, não dentro de <detPag> (schema NF-e 4.00)
      if (input.payment.vTroco) pag.ele('vTroco').txt(this.fmt2(input.payment.vTroco));
    } else {
      const detPag = pag.ele('detPag');
      detPag.ele('tPag').txt('90'); // sem pagamento
      detPag.ele('vPag').txt('0.00');
    }

    // ── infAdic ───────────────────────────────────────────
    if (input.infAdic) {
      infNFe.ele('infAdic').ele('infCpl').txt(this.sanitizeNfeText(input.infAdic, 5000));
    }

    if (input.supplemental?.qrCode) {
      const infNFeSupl = nfe.ele('infNFeSupl');
      infNFeSupl.ele('qrCode').txt(input.supplemental.qrCode.trim());
      if (input.supplemental.urlChave) {
        infNFeSupl.ele('urlChave').txt(input.supplemental.urlChave.trim());
      }
    }

    const xml = root.end({ prettyPrint: false });
    this.validateSingleImpostoPerItem(xml, input.items.length);
    return xml;
  }

  // ── private helpers ───────────────────────────────────────────────────────

  /**
   * Corrige mojibake comum (UTF-8 lido como latin1, ex: "COLÃ‰GIO") e normaliza
   * para ASCII puro — nomes de cliente/produto digitados com encoding quebrado
   * já geraram XML rejeitado por validadores externos no motor original
   * (Construline). Portado de sefaz-direct.service.ts (sanitizeNfeText).
   */
  private sanitizeNfeText(value: unknown, maxLen = 60): string {
    let text = String(value ?? '').trim();
    if (!text) return '';

    if (/[\u00c3\u00c2]/.test(text)) {
      const repaired = Buffer.from(text, 'latin1').toString('utf8');
      if (repaired && repaired.replace(/\s/g, '').length >= text.replace(/\s/g, '').length / 2) {
        text = repaired;
      }
    }

    text = text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .normalize('NFC')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/[^\x20-\x7E]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return text.slice(0, maxLen);
  }

  /**
   * Guarda defensiva: o schema da NF-e exige exatamente um bloco <imposto> por
   * item — o builder acima já é estruturalmente imune (um único `det.ele('imposto')`
   * por item), mas o Construline (motor original) já teve um caso real de XML
   * malformado com <imposto> duplicado que só foi percebido depois da rejeição
   * pela SEFAZ. Falha cedo aqui em vez de gastar uma transmissão.
   */
  private validateSingleImpostoPerItem(xml: string, itemCount: number): void {
    const detMatches = xml.match(/<det\b[^>]*>[\s\S]*?<\/det>/g) ?? [];
    if (detMatches.length !== itemCount) {
      throw new Error(`XML fiscal inválido: esperado ${itemCount} bloco(s) <det>, encontrado ${detMatches.length}.`);
    }
    detMatches.forEach((det, idx) => {
      const impostoCount = (det.match(/<imposto>/g) ?? []).length;
      if (impostoCount !== 1) {
        throw new Error(`XML fiscal inválido no item ${idx + 1}: esperado 1 bloco <imposto>, encontrado ${impostoCount}.`);
      }
    });
  }

  private buildIcms(parent: any, icms: NfeIcmsSimples | NfeIcmsNormal): void {
    if (icms.type === 'simples') {
      const s = icms as NfeIcmsSimples;
      // Choose correct ICMS SN group based on CSOSN
      let tagName: string;
      if (['101', '102', '103', '300', '400'].includes(s.csosn)) {
        tagName = 'ICMSSN102';
      } else if (s.csosn === '201') {
        tagName = 'ICMSSN201';
      } else if (['202', '203'].includes(s.csosn)) {
        tagName = 'ICMSSN202';
      } else if (s.csosn === '500') {
        tagName = 'ICMSSN500';
      } else {
        tagName = 'ICMSSN900';
      }
      const el = parent.ele(tagName);
      el.ele('orig').txt(s.orig);
      el.ele('CSOSN').txt(s.csosn);
      if (tagName === 'ICMSSN900' && s.modBC !== undefined) {
        el.ele('modBC').txt(s.modBC);
        el.ele('vBC').txt(this.fmt2(s.vBC ?? 0));
        el.ele('pRedBC').txt(this.fmt2(s.pRedBC ?? 0));
        el.ele('pICMS').txt(this.fmt2(s.pICMS ?? 0));
        el.ele('vICMS').txt(this.fmt2(s.vICMS ?? 0));
      }
      if (s.modBCST !== undefined) {
        el.ele('modBCST').txt(s.modBCST);
        el.ele('pMVAST').txt(this.fmt2(s.pMVAST ?? 0));
        el.ele('pRedBCST').txt(this.fmt2(s.pRedBCST ?? 0));
        el.ele('vBCST').txt(this.fmt2(s.vBCST ?? 0));
        el.ele('pICMSST').txt(this.fmt2(s.pICMSST ?? 0));
        el.ele('vICMSST').txt(this.fmt2(s.vICMSST ?? 0));
        el.ele('vBCFCPST').txt(this.fmt2(s.vBCFCPST ?? 0));
        el.ele('pFCPST').txt(this.fmt2(s.pFCPST ?? 0));
        el.ele('vFCPST').txt(this.fmt2(s.vFCPST ?? 0));
      }
    } else {
      const n = icms as NfeIcmsNormal;
      const cstNum = parseInt(n.cst, 10);
      let tagName: string;
      if (cstNum === 0) tagName = 'ICMS00';
      else if (cstNum === 10) tagName = 'ICMS10';
      else if (cstNum === 20) tagName = 'ICMS20';
      else if (cstNum === 30) tagName = 'ICMS30';
      else if ([40, 41, 50].includes(cstNum)) tagName = 'ICMS40';
      else if (cstNum === 51) tagName = 'ICMS51';
      else if (cstNum === 60) tagName = 'ICMS60';
      else if (cstNum === 70) tagName = 'ICMS70';
      else tagName = 'ICMS90';

      const el = parent.ele(tagName);
      el.ele('orig').txt(n.orig);
      el.ele('CST').txt(n.cst);
      if (n.modBC !== undefined) el.ele('modBC').txt(n.modBC);
      if (n.vBC !== undefined) el.ele('vBC').txt(this.fmt2(n.vBC));
      if (n.pRedBC !== undefined) el.ele('pRedBC').txt(this.fmt2(n.pRedBC));
      if (n.pICMS !== undefined) el.ele('pICMS').txt(this.fmt2(n.pICMS));
      if (n.vICMS !== undefined) el.ele('vICMS').txt(this.fmt2(n.vICMS));
    }
  }

  private buildPis(parent: any, pis: NfePis): void {
    const cst = parseInt(pis.cst, 10);
    // Grupos do leiaute NFe 4.00: PISAliq (01,02,03,05), PISNT (04,06,07,08,09),
    // PISOutr (todo o restante: 49 a 99). CST 49 é o padrão usado para itens sem
    // apuração detalhada de PIS/COFINS — precisa cair em PISOutr, nunca em PISAliq.
    if ([1, 2, 3, 5].includes(cst)) {
      const el = parent.ele('PISAliq');
      el.ele('CST').txt(pis.cst.padStart(2, '0'));
      el.ele('vBC').txt(this.fmt2(pis.vBC ?? 0));
      el.ele('pPIS').txt(this.fmt4(pis.pPIS ?? 0));
      el.ele('vPIS').txt(this.fmt2(pis.vPIS));
    } else if ([4, 6, 7, 8, 9].includes(cst)) {
      const el = parent.ele('PISNT');
      el.ele('CST').txt(pis.cst.padStart(2, '0'));
    } else {
      const el = parent.ele('PISOutr');
      el.ele('CST').txt(pis.cst.padStart(2, '0'));
      el.ele('vBC').txt(this.fmt2(pis.vBC ?? 0));
      el.ele('pPIS').txt(this.fmt4(pis.pPIS ?? 0));
      el.ele('vPIS').txt(this.fmt2(pis.vPIS));
    }
  }

  private buildCofins(parent: any, cofins: NfeCofins): void {
    const cst = parseInt(cofins.cst, 10);
    // Mesma lógica de grupos do PIS, espelhada para o COFINS.
    if ([1, 2, 3, 5].includes(cst)) {
      const el = parent.ele('COFINSAliq');
      el.ele('CST').txt(cofins.cst.padStart(2, '0'));
      el.ele('vBC').txt(this.fmt2(cofins.vBC ?? 0));
      el.ele('pCOFINS').txt(this.fmt4(cofins.pCOFINS ?? 0));
      el.ele('vCOFINS').txt(this.fmt2(cofins.vCOFINS));
    } else if ([4, 6, 7, 8, 9].includes(cst)) {
      const el = parent.ele('COFINSNT');
      el.ele('CST').txt(cofins.cst.padStart(2, '0'));
    } else {
      const el = parent.ele('COFINSOutr');
      el.ele('CST').txt(cofins.cst.padStart(2, '0'));
      el.ele('vBC').txt(this.fmt2(cofins.vBC ?? 0));
      el.ele('pCOFINS').txt(this.fmt4(cofins.pCOFINS ?? 0));
      el.ele('vCOFINS').txt(this.fmt2(cofins.vCOFINS));
    }
  }

  /**
   * Builds the 43-digit NF-e access key (without check digit).
   * Format: cUF(2) + AAMM(4) + CNPJ(14) + mod(2) + serie(3) + nNF(9) + tpEmis(1) + cNF(8)
   */
  buildChave(input: NfeXmlInput): string {
    const aamm = input.dhEmi.slice(2, 4) + input.dhEmi.slice(5, 7);
    const cnpj = input.emitter.cnpj.replace(/\D/g, '').padStart(14, '0');
    const mod = input.mod;
    const serie = String(input.serie).padStart(3, '0');
    const nNF = String(input.nNF).padStart(9, '0');
    const tpEmis = input.tpEmis;
    const cNF = input.cNF.padStart(8, '0');
    return `${input.cUF}${aamm}${cnpj}${mod}${serie}${nNF}${tpEmis}${cNF}`;
  }

  /** Modulo-11 check digit for NF-e access key */
  calcDV(chave43: string): string {
    let sum = 0;
    let mult = 2;
    for (let i = chave43.length - 1; i >= 0; i--) {
      sum += parseInt(chave43[i], 10) * mult;
      mult = mult === 9 ? 2 : mult + 1;
    }
    const rem = sum % 11;
    return String(rem < 2 ? 0 : 11 - rem);
  }

  /**
   * Derives a stable 8-digit cNF from a seed (the fiscal document id).
   * cNF is part of the 44-digit chave de acesso; if it changed on every
   * retransmission attempt, the same document number (nNF) would produce a
   * different chave each time, and SEFAZ would reject the retry as
   * "duplicidade de NF-e com diferença na chave de acesso" (rejeição 539).
   * Hashing the document id keeps the chave — and thus the cNF — identical
   * across retries of the same document.
   */
  generateCNF(seed: string): string {
    const hash = crypto.createHash('sha1').update(seed).digest('hex');
    return String((parseInt(hash.slice(0, 8), 16) % 90000000) + 10000000);
  }

  private fmt2(v: number): string {
    return v.toFixed(2);
  }

  private fmt4(v: number): string {
    return v.toFixed(4);
  }

  private fmt10(v: number): string {
    return v.toFixed(10);
  }
}
