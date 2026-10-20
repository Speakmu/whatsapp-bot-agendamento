// Gravação do resultado da emissão feita PELO SERVIDOR (resultado-nota.ts). Precisa do emulador do Firestore
// (não entra no `npm test`):  npm run build && FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node test/resultado-nota.emulador.js
const admin = require('firebase-admin');
const { gravarResultado, gravarResultadoDaNota } = require('../dist/resultado-nota');
let falhas = 0;
const ok = (c, t) => { console.log((c ? 'PASS ' : 'FAIL ') + t); if (!c) falhas++; };

(async () => {
  admin.initializeApp({ projectId: 'salgadinhos-lileamar' });
  const db = admin.firestore();
  const nova = async (id, extra = {}) => { await db.collection('notas_fiscais').doc(id).set({ pedido_id: 'p', nNF: 1, status: 'PROCESSANDO', payload_pendente: { x: 1 }, xml_enviado: { a: { xml: '<NFe/>' } }, ...extra }); return db.collection('notas_fiscais').doc(id); };
  const ler = async (ref) => (await ref.get()).data();
  const payload = { ambiente: 'producao', items: [] };
  const autorizada = { status: 'AUTORIZADA', chave: 'K'.repeat(44), protocolo: '131262649839283', cStat: '100', motivo: 'Autorizado o uso da NF-e', danfeBase64: 'UERG', xml: '<NFe/>', xmlProc: '<nfeProc/>' };

  // 1) autorizacao gravada pelo servidor, sem depender do navegador
  let ref = await nova('n1');
  await gravarResultadoDaNota('n1', autorizada, payload);
  let d = await ler(ref);
  ok(d.status === 'AUTORIZADA' && d.protocolo === '131262649839283' && d.cStat === '100', 'servidor grava AUTORIZADA com protocolo e cStat');
  ok(d.danfeBase64 === 'UERG' && d.xmlProc === '<nfeProc/>' && d.xml === '<NFe/>', 'grava o cupom (DANFE), o XML e o XML com protocolo — o que a impressao precisa');
  ok(d.payload_pendente === undefined && d.xml_enviado === undefined, 'limpa payload_pendente e os XMLs de reenvio');
  ok(d.formaEmissao === 'NORMAL' && d.contingencia === false, 'forma de emissao NORMAL');

  // 2) resultado atrasado/concorrente nao rebaixa nota ja autorizada
  await gravarResultadoDaNota('n1', { status: 'REJEITADA', cStat: '204', motivo: 'Duplicidade' }, payload);
  d = await ler(ref);
  ok(d.status === 'AUTORIZADA' && d.cStat === '100', 'REJEITADA tardia nao rebaixa nota AUTORIZADA');

  // 3) nota cancelada nao volta a autorizada
  ref = await nova('n2', { status: 'CANCELADA' });
  await gravarResultadoDaNota('n2', autorizada, payload);
  ok((await ler(ref)).status === 'CANCELADA', 'nota CANCELADA nao e sobrescrita por resultado tardio');

  // 4) resposta sem veredito: volta para a fila de reenvio da MESMA nota
  ref = await nova('n3');
  await gravarResultadoDaNota('n3', { status: 'REJEITADA', cStat: '105', motivo: 'Lote em processamento', transitorio: true }, payload);
  d = await ler(ref);
  ok(d.status === 'ERRO_REDE' && d.payload_pendente && d.payload_pendente.ambiente === 'producao', 'sem veredito (transitorio): ERRO_REDE com o payload para reenviar a mesma nota');

  // 5) rejeicao real e contingencia
  ref = await nova('n4');
  await gravarResultadoDaNota('n4', { status: 'REJEITADA', cStat: '539', motivo: 'Duplicidade de NF-e com diferenca na chave', xml: '<NFe/>' }, payload);
  d = await ler(ref);
  ok(d.status === 'REJEITADA' && d.cStat === '539' && d.danfeBase64 === null, 'rejeicao de verdade: REJEITADA com cStat e motivo');
  ref = await nova('n5');
  await gravarResultadoDaNota('n5', { status: 'CONTINGENCIA', chave: 'C'.repeat(44), xml: '<NFe tpEmis9/>', contingencia: true, danfeBase64: 'UERG' }, payload);
  d = await ler(ref);
  ok(d.status === 'CONTINGENCIA' && d.formaEmissao === 'CONTINGENCIA' && d.xmlAssinado === '<NFe tpEmis9/>', 'contingencia: guarda o XML assinado para transmitir depois');

  // 6) casos de borda que nao podem derrubar a emissao
  await gravarResultadoDaNota(undefined, autorizada, payload);
  await gravarResultadoDaNota('nota-que-nao-existe', autorizada, payload);
  ok(!(await db.collection('notas_fiscais').doc('nota-que-nao-existe').get()).exists, 'sem notaId / nota inexistente: nao faz nada e nao cria documento');

  // 7) idempotente com a gravacao do navegador (mesmos campos, gravada duas vezes)
  ref = await nova('n6');
  await gravarResultado(ref, autorizada, payload); await gravarResultado(ref, autorizada, payload);
  d = await ler(ref);
  ok(d.status === 'AUTORIZADA' && d.protocolo === '131262649839283', 'gravar duas vezes o mesmo resultado nao muda nada');

  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error('ERRO NO TESTE', e); process.exit(1); });
