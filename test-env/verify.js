// ============================================================
//  VERIFY — teste de integração REAL contra o emulador.
//  Rodado por:  firebase emulators:exec "node ../test-env/verify.js"
//  (o emulators:exec já define FIRESTORE_EMULATOR_HOST etc.)
//  Faz o seed e depois confere os dados direto no Firestore do emulador.
// ============================================================
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';

const path = require('path');
const { execSync } = require('child_process');

console.log('▶ Semeando o emulador...');
execSync('node ' + path.join(__dirname, 'seed.js'), { stdio: 'inherit' });

const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'pizzain-40973' });
const db = admin.firestore();

const cnt = async (c) => (await db.collection(c).get()).size;

(async () => {
  let pass = 0, fail = 0; const fails = [];
  const ck = (n, got, exp) => {
    const ok = typeof exp === 'function' ? exp(got) : got === exp;
    if (ok) { pass++; console.log('  ✓ ' + n + ' (' + JSON.stringify(got) + ')'); }
    else { fail++; fails.push(n); console.log('  ✗ ' + n + ' → ' + JSON.stringify(got) + ' esperado ' + JSON.stringify(exp)); }
  };

  console.log('\n=== Conferindo dados no Firestore do emulador ===');
  ck('cardápio (7)', await cnt('cardapio'), 7);
  ck('cupons (2)', await cnt('cupons'), 2);
  ck('promoções (1)', await cnt('promocoes'), 1);
  ck('estoque (5)', await cnt('estoque_insumos'), 5);
  ck('mesas (6)', await cnt('mesas'), 6);
  ck('entregadores (2)', await cnt('entregadores'), 2);
  ck('financeiro (4)', await cnt('financeiro_lancamentos'), 4);
  ck('pedidos (>40)', await cnt('pedidos'), v => v > 40);

  const cfg = (await db.collection('app_config').doc('geral').get()).data();
  ck('app_config nome', cfg && cfg.nomeApp, 'Pizza In');
  const caixa = (await db.collection('caixa_sessoes').where('status', '==', 'ABERTO').get()).size;
  ck('caixa aberto', caixa, v => v >= 1);
  const ativos = (await db.collection('pedidos').where('status', 'in', ['PENDENTE_PREPARO', 'EM_PREPARO', 'PRONTO_PARA_ENTREGA', 'SAIU_PARA_ENTREGA']).get()).size;
  ck('pedidos ativos (KDS/entrega)', ativos, v => v >= 1);

  console.log('\n============================================');
  console.log('RESULTADO: ' + pass + ' passaram, ' + fail + ' falharam');
  if (fail) { console.log('FALHAS: ' + fails.join('; ')); process.exit(1); }
  console.log('✅ Integração com o emulador OK. Tudo pronto para a demo.');
  process.exit(0);
})().catch(e => { console.error('ERRO na verificação:', e); process.exit(1); });
