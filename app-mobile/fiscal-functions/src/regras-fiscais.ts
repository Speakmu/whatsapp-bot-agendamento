// ============================================================
//  Regras de decisão do fluxo fiscal, sem banco nem rede — o que decide se
//  uma nota pode ser reaberta, descartada ou sobrescrita. Ficam isoladas aqui
//  porque um erro nelas vira NFC-e duplicada, e assim dá pra testar cada uma
//  (test/regras-fiscais.test.js).
// ============================================================

// Respostas da SEFAZ que NÃO são um veredito sobre a nota: lote ainda em
// processamento (103/105) ou serviço paralisado (108/109). Tratar isso como
// rejeição libera número novo pra uma venda cuja nota ainda pode ser
// autorizada — duas NFC-e pra mesma venda.
const CSTAT_SEM_VEREDITO = new Set(['103', '105', '108', '109']);
export function cStatTransitorio(cStat?: string | null): boolean {
  return CSTAT_SEM_VEREDITO.has(String(cStat || ''));
}

// Serviço de autorização fora do ar (com resposta da própria SEFAZ): mesmo
// caso de "sem comunicação" pra efeito de contingência.
export function servicoParalisado(cStat?: string | null): boolean {
  return cStat === '108' || cStat === '109';
}

function millis(v: any): number {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.toDate === 'function') return v.toDate().getTime();
  return v instanceof Date ? v.getTime() : 0;
}

// Há quanto tempo a nota está em PROCESSANDO. Conta a partir da ÚLTIMA vez
// que entrou nesse status (processando_desde), não da criação: uma nota antiga
// que acabou de ser reenviada tem criado_em de minutos/horas atrás, e medir por
// ele fazia o agendador tratá-la como travada com o envio ainda em andamento.
export function msEmProcessamento(nota: any, agora: number): number | null {
  const desde = Math.max(millis(nota?.criado_em), millis(nota?.processando_desde));
  return desde ? agora - desde : null;
}

// Um resultado tardio (de uma tentativa concorrente que perdeu a corrida) não
// pode rebaixar uma nota que já está AUTORIZADA/CANCELADA.
export function podeGravarResultado(statusAtual: string | undefined, novoStatus: string): boolean {
  if (statusAtual === 'CANCELADA' || statusAtual === 'INUTILIZADA') return false;
  if (statusAtual === 'AUTORIZADA') return novoStatus === 'AUTORIZADA';
  return true;
}

// DigestValue (base64) do <NFe> assinado e o digVal do protocolo devolvido
// pela SEFAZ: iguais = aquele XML é exatamente o que foi autorizado.
export function digestDoXml(xml?: string | null): string | null {
  const m = xml && xml.match(/<DigestValue>([^<]+)<\/DigestValue>/);
  return m ? m[1].trim() : null;
}
export function digValDoProtocolo(soap?: string | null): string | null {
  const m = soap && soap.match(/<digVal>([^<]+)<\/digVal>/);
  return m ? m[1].trim() : null;
}

// Entre os XMLs guardados de uma nota, devolve o que a SEFAZ autorizou. Cada
// reenvio assina um XML novo (a hora de emissão muda), e a contingência gera
// outro com outra chave — juntar o protocolo com o XML errado produz um
// arquivo que a contabilidade/SPED recusa. Sem digVal na resposta não há como
// comparar: fica o primeiro candidato (comportamento antigo).
export function xmlAutorizado(candidatos: Array<string | null | undefined>, soap?: string | null): string | undefined {
  const xmls = candidatos.filter((x): x is string => !!x);
  const digVal = digValDoProtocolo(soap);
  if (!digVal) return xmls[0];
  return xmls.find((x) => digestDoXml(x) === digVal);
}

// XMLs que uma nota já teve: o gravado, o da contingência e os de cada envio.
export function xmlsDaNota(nota: any): string[] {
  const enviados = Object.values(nota?.xml_enviado || {})
    .map((e: any) => (e && typeof e === 'object' ? e.xml : e))
    .filter((x) => typeof x === 'string');
  return [nota?.xml, nota?.xmlAssinado, ...enviados].filter((x) => typeof x === 'string' && x);
}

// Nota AUTORIZADA/CANCELADA a que ainda falta o XML de distribuição (nfeProc) ou,
// se cancelada, o evento de cancelamento com protocolo. Alimenta o passo do ciclo
// automatico que completa o que um navegador desatualizado, uma conciliacao ou um
// cancelamento deixaram de gravar. xml_proc_indisponivel marca a nota cujo XML
// autorizado nao esta guardado (nenhum digest bate): nao adianta tentar de novo.
export function precisaCompletarXml(nota: any): boolean {
  if (!nota || nota.tipo === 'INUTILIZACAO' || !nota.chave) return false;
  if (nota.status !== 'AUTORIZADA' && nota.status !== 'CANCELADA') return false;
  const faltaProc = !nota.xmlProc && !nota.xml_proc_indisponivel && xmlsDaNota(nota).length > 0;
  const faltaEvento = nota.status === 'CANCELADA' && !(nota.cancelamento && nota.cancelamento.xmlProcEvento);
  return faltaProc || faltaEvento;
}
