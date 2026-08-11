/**
 * SEFAZ webservice endpoints by UF.
 * Sources:
 *   - SVRS (Sefaz Virtual RS) for UFs that delegate
 *   - SVAN (Sefaz Virtual AN) for some UFs
 *   - Own infrastructure per state
 *
 * Reference: Portal NF-e – Manual de Orientação ao Contribuinte v7.00
 */

export interface SefazUfEndpoints {
  /** NFeAutorizacao4 */
  autorizacao: string;
  /** NFeRetAutorizacao4 */
  retAutorizacao: string;
  /** NFeStatusServico4 */
  statusServico: string;
  /** NFeConsultaProtocolo4 (NF-e model 55) */
  consultaProtocolo: string;
  /** NfceConsultaProtocolo4 (NFC-e model 65) */
  consultaProtocoloNfce: string;
  /** RecepcaoEvento4 (cancelamento, CCES, etc.) */
  recepcaoEvento: string;
  /** NFeInutilizacao4 */
  inutilizacao: string;
}

// Hosts específicos de NFC-e (modelo 65) — diferentes dos hosts de NF-e (modelo 55).
// Usar o host errado gera rejeição "Modelo de NF-e diferente de 55" na SEFAZ.
const SVRS_HOM = 'https://nfce-homologacao.svrs.rs.gov.br/ws';
const SVRS_PRD = 'https://nfce.svrs.rs.gov.br/ws';

function svrs(env: 'HOM' | 'PRD'): SefazUfEndpoints {
  const base = env === 'PRD' ? SVRS_PRD : SVRS_HOM;
  return {
    autorizacao: `${base}/NfeAutorizacao/NFeAutorizacao4.asmx`,
    retAutorizacao: `${base}/NfeRetAutorizacao/NFeRetAutorizacao4.asmx`,
    statusServico: `${base}/NfeStatusServico/NfeStatusServico4.asmx`,
    consultaProtocolo: `${base}/NfeConsulta2/NfeConsulta2.asmx`,
    consultaProtocoloNfce: `${base}/NfceConsulta/NfceConsulta4.asmx`,
    recepcaoEvento: `${base}/NfeRecepcaoEvento4/NfeRecepcaoEvento4.asmx`,
    inutilizacao: `${base}/NfeInutilizacao/NFeInutilizacao4.asmx`,
  };
}

/**
 * Returns SEFAZ endpoints for the given UF and environment.
 * Falls back to SVRS (Sefaz Virtual RS) if the UF does not have own infra.
 */
export function getSefazEndpoints(
  uf: string,
  environment: 'HOMOLOGACAO' | 'PRODUCAO',
): SefazUfEndpoints {
  const env = environment === 'PRODUCAO' ? 'PRD' : 'HOM';

  const MG_HOM = 'https://hnfce.fazenda.mg.gov.br/nfce/services';
  const MG_PRD = 'https://nfce.fazenda.mg.gov.br/nfce/services';

  const SP_HOM = 'https://homologacao.nfce.fazenda.sp.gov.br/ws';
  const SP_PRD = 'https://nfce.fazenda.sp.gov.br/ws';

  const AM_HOM = 'https://homnfce.sefaz.am.gov.br/nfce-services/services';
  const AM_PRD = 'https://nfce.sefaz.am.gov.br/nfce-services/services';

  // GO não tem host separado para NFC-e — usa o mesmo webservice de NF-e.
  const GO_HOM = 'https://homolog.sefaz.go.gov.br/nfe/services';
  const GO_PRD = 'https://nfe.sefaz.go.gov.br/nfe/services';

  const MT_HOM = 'https://homologacao.sefaz.mt.gov.br/nfcews/services';
  const MT_PRD = 'https://nfce.sefaz.mt.gov.br/nfcews/services';

  const MS_HOM = 'https://hom.nfce.sefaz.ms.gov.br/ws';
  const MS_PRD = 'https://nfce.sefaz.ms.gov.br/ws';

  const PR_HOM = 'https://homologacao.nfce.sefa.pr.gov.br/nfce';
  const PR_PRD = 'https://nfce.sefa.pr.gov.br/nfce';

  // BA e CE não têm webservice de autorização de NFC-e próprio — delegam para a
  // SVRS (Sefaz Virtual RS), por isso não têm case próprio no switch abaixo.

  function endpoints(
    base: string,
    suffix = '',
  ): SefazUfEndpoints {
    return {
      autorizacao: `${base}/NFeAutorizacao4${suffix}`,
      retAutorizacao: `${base}/NFeRetAutorizacao4${suffix}`,
      statusServico: `${base}/NFeStatusServico4${suffix}`,
      consultaProtocolo: `${base}/NFeConsultaProtocolo4${suffix}`,
      consultaProtocoloNfce: `${base}/NfceConsultaProtocolo4${suffix}`,
      recepcaoEvento: `${base}/NFeRecepcaoEvento4${suffix}`,
      inutilizacao: `${base}/NFeInutilizacao4${suffix}`,
    };
  }

  switch (uf.toUpperCase()) {
    case 'MG':
      return endpoints(env === 'PRD' ? MG_PRD : MG_HOM);
    case 'SP':
      return endpoints(env === 'PRD' ? SP_PRD : SP_HOM, '.asmx');
    case 'AM':
      return endpoints(env === 'PRD' ? AM_PRD : AM_HOM);
    case 'GO':
      return endpoints(env === 'PRD' ? GO_PRD : GO_HOM);
    case 'MT':
      return endpoints(env === 'PRD' ? MT_PRD : MT_HOM);
    case 'MS':
      return endpoints(env === 'PRD' ? MS_PRD : MS_HOM);
    case 'PR':
      return endpoints(env === 'PRD' ? PR_PRD : PR_HOM);
    // UFs que delegam a autorização de NFC-e para a SVRS (Sefaz Virtual RS):
    // AC, AL, AP, BA, CE, DF, ES, PB, PI, RJ, RN, RO, RR, SC, SE, TO
    default:
      return svrs(env);
  }
}

/** IBGE code for Brazilian states (needed in NF-e XML) */
export const UF_IBGE: Record<string, string> = {
  AC: '12', AL: '27', AP: '16', AM: '13', BA: '29', CE: '23',
  DF: '53', ES: '32', GO: '52', MA: '21', MT: '51', MS: '50',
  MG: '31', PA: '15', PB: '25', PR: '41', PE: '26', PI: '22',
  RJ: '33', RN: '24', RS: '43', RO: '11', RR: '14', SC: '42',
  SP: '35', SE: '28', TO: '17',
};

/** Código do ambiente: 1=Produção, 2=Homologação */
export function tpAmb(environment: 'HOMOLOGACAO' | 'PRODUCAO'): '1' | '2' {
  return environment === 'PRODUCAO' ? '1' : '2';
}

/**
 * NFeDistribuicaoDFe é um webservice nacional (Ambiente Nacional - AN):
 * o endpoint é o mesmo para todas as UFs, não depende da infraestrutura estadual.
 */
export function getDistribuicaoDFeEndpoint(environment: 'HOMOLOGACAO' | 'PRODUCAO'): string {
  return environment === 'PRODUCAO'
    ? 'https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx'
    : 'https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx';
}
