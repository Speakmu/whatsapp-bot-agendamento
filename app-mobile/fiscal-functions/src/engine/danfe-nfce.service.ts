/**
 * DanfeNfceService — Geração do DANFE NFC-e (modelo 65) em PDF
 * Layout simplificado conforme manual oficial, com QR code em destaque.
 * Extrai dados diretamente do XML autorizado da NFC-e (nfeProc ou NFe).
 */

import { Injectable, Logger } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { XMLParser } from 'fast-xml-parser';
import QRCode from 'qrcode';

const CUPOM_WIDTH = 226.77; // 80mm em pontos
const MARGIN = 8;
const CONTENT_W = CUPOM_WIDTH - MARGIN * 2;
const FONT_BOLD = 'Helvetica-Bold';
const FONT_NORMAL = 'Helvetica';

export interface DanfeNfceResult {
  pdf: Buffer;
  filename: string;
}

export interface DanfeNfceFallbackData {
  accessKey?: string;
  protocol?: string;
  receivedAt?: string;
  logoDataUrl?: string;
}

function parseNfceXml(xmlContent: string): any {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseAttributeValue: false,
    parseTagValue: true,
    trimValues: true,
  });
  const root = parser.parse(xmlContent);
  const nfeProc = root['nfeProc'] ?? root;
  const nfe = nfeProc['NFe'] ?? nfeProc;
  const infNFe = nfe['infNFe'];
  const prot = nfeProc['protNFe']?.['infProt'];
  const infNFeSupl = nfe['infNFeSupl'] ?? nfeProc['infNFeSupl'];
  return { infNFe, prot, infNFeSupl };
}

function str(v: any): string {
  return v == null ? '' : String(v);
}

const TPAG_LABEL: Record<string, string> = {
  '01': 'Dinheiro', '02': 'Cheque', '03': 'Cartão de Crédito', '04': 'Cartão de Débito',
  '05': 'Crédito Loja', '10': 'Vale Alimentação', '11': 'Vale Refeição', '12': 'Vale Presente',
  '13': 'Vale Combustível', '15': 'Boleto', '16': 'Depósito Bancário', '17': 'PIX',
  '18': 'Transferência/Carteira Digital', '19': 'Fidelidade/Cashback', '90': 'Sem pagamento', '99': 'Outros',
};
function tPagLabel(codigo: string): string {
  return TPAG_LABEL[codigo] || codigo;
}

function decodeLogoDataUrl(logoDataUrl?: string): Buffer | null {
  const raw = str(logoDataUrl).trim();
  if (!raw) return null;
  const match = raw.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/);
  if (!match) return null;
  try {
    return Buffer.from(match[1], 'base64');
  } catch {
    return null;
  }
}

@Injectable()
export class DanfeNfceService {
  private readonly logger = new Logger(DanfeNfceService.name);

  async generate(xmlContent: string, fallback?: DanfeNfceFallbackData): Promise<DanfeNfceResult> {
    const { infNFe, prot, infNFeSupl } = parseNfceXml(xmlContent);
    if (!infNFe) throw new Error('XML inválido: elemento <infNFe> não encontrado');
    const ide = infNFe['ide'] ?? {};
    const emit = infNFe['emit'] ?? {};
    const detRaw = infNFe['det'];
    const dets: any[] = Array.isArray(detRaw) ? detRaw : detRaw ? [detRaw] : [];
    const total = infNFe['total']?.['ICMSTot'] ?? {};
    const pagRaw = infNFe['pag'];
    const pags: any[] = (() => {
      const detPag = pagRaw?.['detPag'];
      if (!detPag) return [];
      return Array.isArray(detPag) ? detPag : [detPag];
    })();
    const infAdic = infNFe['infAdic'] ?? {};
    const infCpl = str(infAdic['infCpl']);
    const dest = infNFe['dest'] ?? null;
    const tpAmb = str(ide['tpAmb'] ?? '1');
    const chaveId: string = str(infNFe['@_Id'] ?? '').replace(/^NFe/, '');
    const chave44 = chaveId || str(prot?.['chNFe'] ?? fallback?.accessKey ?? '');
    const protocolo = str(prot?.['nProt'] ?? fallback?.protocol ?? '');
    const dhRecbto = str(prot?.['dhRecbto'] ?? fallback?.receivedAt ?? '');
    const logoBuffer = decodeLogoDataUrl(fallback?.logoDataUrl);
    // QR code
    let qrCodeUrl = str(infNFeSupl?.qrCode ?? '');
    if (!qrCodeUrl && infNFeSupl && typeof infNFeSupl === 'object') {
      // Pode estar como { qrCode: { '#text': 'url' } }
      qrCodeUrl = str(infNFeSupl.qrCode?.['#text'] ?? '');
    }
    // PDF estilo cupom fiscal (bobina 80mm)
    // Estimar altura: header ~110pt + itens ~18pt cada + pagamentos ~14pt cada + rodapé ~100pt
    const estimatedH = 120 + dets.length * 18 + pags.length * 14 + 120 + (tpAmb === '2' ? 24 : 0) + (dest ? 14 : 0);
    const doc = new PDFDocument({
      size: [CUPOM_WIDTH, Math.max(estimatedH, 300)],
      margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
      bufferPages: true,
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    let y = MARGIN;

    // Cabeçalho
    doc.font(FONT_BOLD).fontSize(9).text(str(emit['xNome'] ?? ''), MARGIN, y, { width: CONTENT_W, align: 'center' });
    y += doc.currentLineHeight() + 2;
    doc.font(FONT_NORMAL).fontSize(6.5).text(`CNPJ: ${str(emit['CNPJ'] ?? '')}`, MARGIN, y, { width: CONTENT_W, align: 'center' });
    y += doc.currentLineHeight() + 1;
    doc.font(FONT_NORMAL).fontSize(6.5).text(`Endereço: ${str(emit['enderEmit']?.['xLgr'] ?? '')}, ${str(emit['enderEmit']?.['nro'] ?? '')}`, MARGIN, y, { width: CONTENT_W, align: 'center' });
    y += doc.currentLineHeight() + 2;
    y += 2;
    doc.font(FONT_BOLD).fontSize(8).text('DANFE NFC-e', MARGIN, y, { width: CONTENT_W, align: 'center' });
    y += doc.currentLineHeight() + 1;
    doc.font(FONT_NORMAL).fontSize(6).text('Documento Auxiliar da Nota Fiscal de Consumidor Eletrônica', MARGIN, y, { width: CONTENT_W, align: 'center' });
    y += doc.currentLineHeight() + 2;
    // Aviso obrigatório de ambiente de homologação (tpAmb=2) — nota sem valor fiscal
    if (tpAmb === '2') {
      const bannerH = 14;
      doc.rect(MARGIN, y, CONTENT_W, bannerH).fill('#000000');
      doc.fillColor('#ffffff').font(FONT_BOLD).fontSize(6.5)
        .text('EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO - SEM VALOR FISCAL', MARGIN, y + 3, { width: CONTENT_W, align: 'center' });
      doc.fillColor('#000000');
      y += bannerH + 4;
    }
    // Número e Série
    doc.font(FONT_BOLD).fontSize(7).text(`Número: ${str(ide['nNF'] ?? '')}   Série: ${str(ide['serie'] ?? '')}`, MARGIN, y, { width: CONTENT_W, align: 'center' });
    y += doc.currentLineHeight() + 2;
    // Chave de acesso
    doc.font(FONT_BOLD).fontSize(7).text('Chave de Acesso:', MARGIN, y, { width: CONTENT_W });
    y += doc.currentLineHeight();
    doc.font(FONT_NORMAL).fontSize(7).text(chave44.replace(/(\d{4})(?=\d)/g, '$1 '), MARGIN, y, { width: CONTENT_W, align: 'center' });
    y += doc.currentLineHeight() + 2;
    // Protocolo e data
    doc.font(FONT_NORMAL).fontSize(6).text(`Protocolo: ${protocolo}`, MARGIN, y, { width: CONTENT_W });
    y += doc.currentLineHeight();
    doc.font(FONT_NORMAL).fontSize(6).text(`Data/Hora Autorização: ${dhRecbto}`, MARGIN, y, { width: CONTENT_W });
    y += doc.currentLineHeight() + 2;
    // Itens
    doc.font(FONT_BOLD).fontSize(7).text('ITENS', MARGIN, y, { width: CONTENT_W, align: 'center' });
    y += doc.currentLineHeight() + 1;
    let itemNum = 0;
    for (const det of dets) {
      itemNum++;
      const prod = det['prod'] ?? {};
      doc.font(FONT_BOLD).fontSize(6.5).text(`${itemNum}. [${str(prod['cProd'] ?? '')}] ${str(prod['xProd'] ?? '')}`, MARGIN, y, { width: CONTENT_W });
      y += doc.currentLineHeight() + 1;
      doc.font(FONT_NORMAL).fontSize(6.5).text(`Qtd: ${str(prod['qCom'] ?? '')} x Vl.Unit: R$ ${str(prod['vUnCom'] ?? '')} = R$ ${str(prod['vProd'] ?? '')}`, MARGIN, y, { width: CONTENT_W });
      y += doc.currentLineHeight() + 2;
    }
    // Totais
    doc.font(FONT_BOLD).fontSize(7).text('TOTAL:', MARGIN, y, { width: CONTENT_W * 0.5 });
    doc.font(FONT_BOLD).fontSize(7).text(`R$ ${str(total['vNF'] ?? '')}`, MARGIN + CONTENT_W * 0.5, y, { width: CONTENT_W * 0.5, align: 'right' });
    y += doc.currentLineHeight() + 2;
    doc.font(FONT_NORMAL).fontSize(6.5).text(`Descontos: R$ ${str(total['vDesc'] ?? '0')}`, MARGIN, y, { width: CONTENT_W * 0.5 });
    doc.font(FONT_NORMAL).fontSize(6.5).text(`Frete: R$ ${str(total['vFrete'] ?? '0')}`, MARGIN + CONTENT_W * 0.5, y, { width: CONTENT_W * 0.5, align: 'right' });
    y += doc.currentLineHeight() + 2;
    // Valor aproximado dos tributos (Lei 12.741/2012 — Lei da Transparência)
    const vTotTrib = Number(total['vTotTrib']);
    if (vTotTrib > 0) {
      doc.font(FONT_NORMAL).fontSize(6).text(`Valor aprox. dos tributos: R$ ${vTotTrib.toFixed(2)} (Lei 12.741/2012)`, MARGIN, y, { width: CONTENT_W });
      y += doc.currentLineHeight() + 2;
    }
    // Pagamentos
    if (pags.length > 0) {
      doc.font(FONT_BOLD).fontSize(6.5).text('Pagamentos:', MARGIN, y, { width: CONTENT_W });
      y += doc.currentLineHeight();
      pags.forEach((p: any) => {
        doc.font(FONT_NORMAL).fontSize(6.5).text(`Forma: ${tPagLabel(str(p['tPag'] ?? ''))} - Valor: R$ ${str(p['vPag'] ?? '')}`, MARGIN, y, { width: CONTENT_W });
        y += doc.currentLineHeight();
      });
    }
    y += 2;
    // Consumidor
    if (dest) {
      const cpf = str(dest['CPF']);
      const cnpj = str(dest['CNPJ']);
      const doc_ = cpf ? `CPF: ${cpf}` : (cnpj ? `CNPJ: ${cnpj}` : '');
      doc.font(FONT_NORMAL).fontSize(6).text(`Consumidor: ${doc_}${doc_ ? ' - ' : ''}${str(dest['xNome'] ?? '')}`, MARGIN, y, { width: CONTENT_W });
      y += doc.currentLineHeight() + 2;
    }
    // Informações adicionais
    if (infCpl) {
      doc.font(FONT_NORMAL).fontSize(6).text(`Inf. Adicionais: ${infCpl}`, MARGIN, y, { width: CONTENT_W });
      y += doc.currentLineHeight() + 2;
    }
    // QR Code centralizado
    if (qrCodeUrl) {
      try {
        const qrPng = await QRCode.toBuffer(qrCodeUrl, { width: 80, margin: 1 });
        const qrX = MARGIN + (CONTENT_W - 80) / 2;
        doc.image(qrPng, qrX, y, { fit: [80, 80] });
        y += 80 + 2;
        doc.font(FONT_NORMAL).fontSize(6).text('Consulte a NFC-e pela chave de acesso ou pelo QR Code acima.', MARGIN, y, { width: CONTENT_W, align: 'center' });
        y += doc.currentLineHeight() + 2;
      } catch (err) {
        this.logger.warn('Falha ao gerar QR Code DANFE NFC-e: ' + String(err));
      }
    }
    // Rodapé
    doc.font(FONT_NORMAL).fontSize(5.5).fillColor('#888888')
      .text('NFC-e gerada eletronicamente. Consulte a autenticidade em www.nfce.fazenda.gov.br/portal', MARGIN, y, { width: CONTENT_W, align: 'center' });
    doc.end();
    const pdf = await new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });
    const nNF = str(ide['nNF'] ?? 'NFCe');
    const serie = str(ide['serie'] ?? '1');
    const filename = `DANFE_NFC-e_${nNF.padStart(9, '0')}_serie_${serie}.pdf`;
    return { pdf, filename };
  }
}
