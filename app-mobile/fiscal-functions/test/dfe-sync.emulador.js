// Sincronizacao DFe no servidor (dfe-sync): consulta a SEFAZ simulada e grava no Firestore.
// Precisa do emulador do Firestore (nao entra no `npm test`):
//   firebase emulators:start --only firestore --project demo-teste --config <firebase.json com o emulador na 8080>
//   npm run build && FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node test/dfe-sync.emulador.js
// Cobre: paginas sem repetir ultNSU, espera de 1h (137/maxNSU/656), trava contra consultas
// simultaneas, erro de rede, loop de ultNSU parado, limite de paginas e resumo x nota completa.
const admin = require('firebase-admin');
const { sincronizarDfeServidor } = require('../dist/dfe-sync');

let falhas = 0;
const ok = (c, t) => { console.log((c ? 'PASS ' : 'FAIL ') + t); if (!c) falhas++; };
const cert = { buffer: Buffer.from('x'), password: 'x' };
const doc = (nsu, extra = {}) => ({ nsu: String(nsu).padStart(15, '0'), schema: 'procNFe', chave: 'K' + nsu, emitente: 'FORNECEDOR ' + nsu, cnpjEmitente: '00000000000' + String(nsu % 100).padStart(3, '0'), valor: 10, resumo: false, itens: [], dhEmi: '2026-10-06', ...extra });
const pausa = async () => { };

async function reset(cfg) {
  const db = admin.firestore();
  const cfgRef = db.collection('configuracoes').doc('fiscal');
  await cfgRef.set(cfg);
  await db.collection('dfe_travas').doc('sincronizacao').delete();
  for (const col of ['dfe_documentos', 'fornecedores']) { const s = await db.collection(col).get(); await Promise.all(s.docs.map(d => d.ref.delete())); }
}
const lerCfg = async () => (await admin.firestore().collection('configuracoes').doc('fiscal').get()).data();
const base = { ativo: true, cnpj: '03689716000217', uf: 'MG', ambiente: 'producao', dfeUltNSU: '000000000000000', dfeMaxNSU: '000000000000000' };

(async () => {
  admin.initializeApp({ projectId: 'salgadinhos-lileamar' });

  // 1) varias paginas ate alcancar o maxNSU, sempre avancando o ultNSU
  await reset(base);
  const pedidos = [];
  const paginas = { '0': { ult: 2, max: 5, docs: [doc(1), doc(2, { resumo: true, itens: undefined })] }, '2': { ult: 4, max: 5, docs: [doc(3), doc(4)] }, '4': { ult: 5, max: 5, docs: [doc(5)] } };
  const consultar1 = async (req) => {
    pedidos.push(req.ultNSU);
    const p = paginas[String(Number(req.ultNSU))];
    return { status: 'OK', cStat: '138', motivo: 'ok', ultNSU: String(p.ult).padStart(15, '0'), maxNSU: String(p.max).padStart(15, '0'), documentos: p.docs };
  };
  let r = await sincronizarDfeServidor(cert, { consultar: consultar1, pausa });
  ok(r.status === 'OK' && r.novos === 5 && r.paginas === 3, `3 paginas, 5 notas: ${r.status} novos=${r.novos} paginas=${r.paginas}`);
  ok(JSON.stringify(pedidos.map(Number)) === '[0,2,4]', 'cada consulta usa um ultNSU novo (nunca repete): ' + pedidos.join(','));
  let cfg = await lerCfg();
  ok(cfg.dfeUltNSU === '000000000000005' && cfg.dfeMaxNSU === '000000000000005', 'ultNSU/maxNSU gravados em 5');
  ok((await admin.firestore().collection('dfe_documentos').get()).size === 5, '5 notas gravadas em dfe_documentos');
  ok((await admin.firestore().collection('fornecedores').get()).size === 5, 'fornecedores cadastrados');
  ok(!(await admin.firestore().collection('dfe_travas').doc('sincronizacao').get()).exists, 'trava liberada');
  const liberaEm = cfg.dfeProximaConsultaApos.toMillis() - Date.now();
  ok(liberaEm > 59 * 60000 && liberaEm < 63 * 60000, `proxima consulta em ~61 min (${Math.round(liberaEm / 60000)} min)`);

  // 2) tentar de novo logo em seguida NAO consulta a SEFAZ
  let chamadas = 0;
  const consultar2 = async () => { chamadas++; throw new Error('nao devia chamar'); };
  r = await sincronizarDfeServidor(cert, { consultar: consultar2, pausa });
  ok(r.status === 'AGUARDANDO' && chamadas === 0 && !!r.proximaConsultaApos, 'logo depois: AGUARDANDO e zero consultas a SEFAZ');

  // 3) 137 (nada novo): grava a espera
  await reset(base);
  r = await sincronizarDfeServidor(cert, { consultar: (async () => ({ status: 'SEM_DOCUMENTOS', cStat: '137', motivo: 'Nenhum documento', ultNSU: '000000000000000', maxNSU: '000000000000000', documentos: [] })), pausa });
  cfg = await lerCfg();
  ok(r.status === 'OK' && r.novos === 0 && !!cfg.dfeProximaConsultaApos, '137: ok, nenhuma nota, espera gravada');

  // 4) 656 (consumo indevido): espera 1h e NAO insiste
  await reset(base); chamadas = 0;
  r = await sincronizarDfeServidor(cert, { consultar: (async () => { chamadas++; return { status: 'REJEITADA', cStat: '656', motivo: 'Consumo Indevido', ultNSU: '0', maxNSU: '0', documentos: [] }; }), pausa });
  cfg = await lerCfg();
  ok(r.status === 'AGUARDANDO' && chamadas === 1 && r.cStat === '656', '656: AGUARDANDO, uma unica consulta');
  ok(cfg.dfeProximaConsultaApos.toMillis() - Date.now() > 59 * 60000, '656: bloqueia novas consultas por ~1h');
  ok(cfg.dfeUltimoStatus && cfg.dfeUltimoStatus.cStat === '656', 'estado do ultimo resultado gravado para o painel mostrar');

  // 5) duas chamadas ao mesmo tempo (botao + agendador): so uma consulta
  await reset(base); const ult = [];
  const lenta = async (req) => { ult.push(req.ultNSU); await new Promise(res => setTimeout(res, 400)); return { status: 'OK', cStat: '138', motivo: 'ok', ultNSU: '000000000000001', maxNSU: '000000000000001', documentos: [doc(1)] }; };
  const [a, b] = await Promise.all([sincronizarDfeServidor(cert, { consultar: lenta, pausa }), sincronizarDfeServidor(cert, { consultar: lenta, pausa })]);
  const st = [a.status, b.status].sort().join(',');
  ok(st === 'EM_ANDAMENTO,OK' && ult.length === 1, `simultaneas: ${st}, consultas=${ult.length} (nunca repete o ultNSU)`);

  // 6) erro de rede: nao bloqueia (tenta no proximo ciclo) e nao perde o que ja baixou
  await reset(base); let n = 0;
  r = await sincronizarDfeServidor(cert, { consultar: (async (req) => { n++; if (n === 1) return { status: 'OK', cStat: '138', motivo: 'ok', ultNSU: '000000000000002', maxNSU: '000000000000009', documentos: [doc(1), doc(2)] }; throw new Error('timeout'); }), pausa });
  cfg = await lerCfg();
  ok(r.status === 'ERRO' && r.novos === 2 && cfg.dfeUltNSU === '000000000000002' && !cfg.dfeProximaConsultaApos, 'erro de rede na 2a pagina: guarda a 1a, sem bloqueio de 1h');

  // 7) ultNSU que nao avanca nao vira loop infinito
  await reset(base); n = 0;
  r = await sincronizarDfeServidor(cert, { consultar: (async () => { n++; return { status: 'OK', cStat: '138', motivo: 'ok', ultNSU: '000000000000000', maxNSU: '000000000000050', documentos: [] }; }), pausa });
  ok(n === 1, `ultNSU parado: para na 1a consulta (${n})`);

  // 8) limite de paginas por rodada; continua na proxima
  await reset(base); n = 0;
  r = await sincronizarDfeServidor(cert, { consultar: (async (req) => { n++; const u = Number(req.ultNSU) + 1; return { status: 'OK', cStat: '138', motivo: 'ok', ultNSU: String(u).padStart(15, '0'), maxNSU: '000000000009999', documentos: [doc(u)] }; }), pausa });
  cfg = await lerCfg();
  ok(n === 12 && r.status === 'OK' && !cfg.dfeProximaConsultaApos, `limite de 12 paginas por rodada (${n}) e sem espera: continua na proxima rodada`);

  // 8b) trava esquecida (processo que caiu): recente bloqueia, vencida e retomada
  await reset(base); const travaRef = admin.firestore().collection('dfe_travas').doc('sincronizacao');
  await travaRef.set({ em: admin.firestore.Timestamp.now() });
  r = await sincronizarDfeServidor(cert, { consultar: (async () => { throw new Error('nao devia chamar'); }), pausa });
  ok(r.status === 'EM_ANDAMENTO', 'trava recente de outra execucao: EM_ANDAMENTO');
  await travaRef.set({ em: admin.firestore.Timestamp.fromMillis(Date.now() - 10 * 60000) });
  r = await sincronizarDfeServidor(cert, { consultar: (async () => ({ status: 'SEM_DOCUMENTOS', cStat: '137', motivo: 'x', ultNSU: '0', maxNSU: '0', documentos: [] })), pausa });
  ok(r.status === 'OK', 'trava vencida (10 min): retomada e sincroniza');

  // 8c) resumo que chega depois NAO rebaixa nota completa/lancada; nota nova em resumo entra normal
  await reset(base);
  await admin.firestore().collection('dfe_documentos').doc('K77').set({ nsu: 'MANUAL-1', chave: 'K77', resumo: false, itens: [{ xProd: 'A', qCom: 1 }], entrada_confirmada: true });
  r = await sincronizarDfeServidor(cert, { consultar: (async () => ({ status: 'OK', cStat: '138', motivo: 'ok', ultNSU: '000000000000002', maxNSU: '000000000000002',
    documentos: [doc(77, { resumo: true, schema: 'resNFe', itens: undefined }), doc(78, { resumo: true, schema: 'resNFe', itens: undefined })] })), pausa });
  const k77 = (await admin.firestore().collection('dfe_documentos').doc('K77').get()).data();
  const k78 = (await admin.firestore().collection('dfe_documentos').doc('K78').get()).data();
  ok(k77.resumo === false && k77.entrada_confirmada === true && k77.itens.length === 1 && k77.schema === undefined, 'resumo nao rebaixa a nota completa ja lancada');
  ok(k78 && k78.resumo === true, 'resumo de nota desconhecida entra normalmente');

  // 9) config incompleta
  await reset({ ativo: true });
  r = await sincronizarDfeServidor(cert, { consultar: (async () => { throw new Error('nao devia chamar'); }), pausa });
  ok(r.status === 'CONFIG', 'sem CNPJ/UF: CONFIG, nao consulta');


  // 10) recuperacao por NSU (lacuna entre o ponteiro do sistema e o da SEFAZ)
  await reset(base);
  const porNsu = (docs) => async (req) => docs[Number(req.nsu)] ? ({ status: 'OK', cStat: '138', motivo: 'ok', ultNSU: req.nsu, maxNSU: req.nsu, documentos: [docs[Number(req.nsu)]] }) : ({ status: 'SEM_DOCUMENTOS', cStat: '137', motivo: 'nada', documentos: [] });
  const rec = require('../dist/dfe-sync').recuperarNsusServidor;
  let rr = await rec(cert, ['1561', '1578', '1561'], { consultarNSU: porNsu({ 1561: doc(1561), 1578: doc(1578) }), pausa });
  ok(rr.status === 'OK' && rr.recuperadas.length === 2 && rr.novos === 2, `recupera por NSU (sem repetir): ${rr.recuperadas.join(',')}`);
  ok((await admin.firestore().collection('dfe_documentos').get()).size === 2, 'notas recuperadas gravadas em dfe_documentos');
  cfg = await lerCfg();
  ok(cfg.dfeProximaConsultaApos.toMillis() - Date.now() > 59 * 60000, 'segura as consultas em lote por ~1h depois de recuperar');
  chamadas = 0;
  rr = await rec(cert, ['1599'], { consultarNSU: async () => { chamadas++; return {}; }, pausa });
  ok(rr.status === 'AGUARDANDO' && chamadas === 0, 'respeita a espera gravada (zero consultas)');
  await reset(base); let ordem = [];
  rr = await rec(cert, ['1', '2', '3'], { consultarNSU: async (req) => { ordem.push(req.nsu); if (req.nsu.endsWith('2')) return { status: 'REJEITADA', cStat: '656', motivo: 'Consumo Indevido', documentos: [] }; return { status: 'OK', cStat: '138', motivo: 'ok', documentos: [doc(Number(req.nsu))] }; }, pausa });
  ok(rr.status === 'AGUARDANDO' && ordem.length === 2 && rr.recuperadas.length === 1, `656 no meio: para (${ordem.length} consultas) e guarda o que ja veio`);
  await reset(base);
  rr = await rec(cert, ['7'], { consultarNSU: porNsu({}), pausa });
  ok(rr.status === 'OK' && rr.naoEncontradas.length === 1 && rr.novos === 0, 'NSU inexistente (137): vai para naoEncontradas');

  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error('ERRO NO TESTE', e); process.exit(1); });
