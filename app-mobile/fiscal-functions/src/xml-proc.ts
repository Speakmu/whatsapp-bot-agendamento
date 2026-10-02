// ============================================================
//  XML de distribuição da NFC-e (nfeProc = NFe assinada + protNFe da SEFAZ).
//  É o que a contabilidade/SPED espera: o <NFe> sozinho NÃO prova a autorização.
// ============================================================
const NS = 'http://www.portalfiscal.inf.br/nfe';

function comNamespace(el: string): string {
  // Trechos extraídos de dentro do envelope SOAP herdam o xmlns do pai; ao
  // isolá-los é preciso declarar o namespace no próprio elemento.
  return /^<[A-Za-z]+[^>]*\sxmlns=/.test(el) ? el : el.replace(/^<([A-Za-z]+)/, `<$1 xmlns="${NS}"`);
}

export function extrairProtNFe(soap?: string): string | null {
  const m = soap && soap.match(/<protNFe[\s>][\s\S]*?<\/protNFe>/);
  return m ? comNamespace(m[0]) : null;
}

export function extrairEventosCancelamento(soap?: string): string[] {
  if (!soap) return [];
  const todos = soap.match(/<procEventoNFe[\s>][\s\S]*?<\/procEventoNFe>/g) || [];
  return todos.filter((e) => /<tpEvento>110111<\/tpEvento>/.test(e)).map(comNamespace);
}

export function montarNfeProc(nfeXml?: string | null, protNFe?: string | null): string | undefined {
  if (!nfeXml || !protNFe) return undefined;
  const nfe = nfeXml.replace(/^\s*<\?xml[^>]*\?>\s*/, '');
  if (!/^<NFe[\s>]/.test(nfe)) return undefined;
  return `<?xml version="1.0" encoding="UTF-8"?><nfeProc versao="4.00" xmlns="${NS}">${nfe}${protNFe}</nfeProc>`;
}

export function nfeProcDe(nfeXml?: string | null, soap?: string): string | undefined {
  return montarNfeProc(nfeXml, extrairProtNFe(soap));
}
