// ============================================================
//  CLOUD SIM — simulador ao vivo apontando para o Firebase REAL.
//  Cria pedidos e avança status na nuvem (KDS/Entregas/BI ao vivo
//  para quem acessa o link de qualquer rede). Pare com Ctrl+C.
//  Uso:  npm run cloud:sim
// ============================================================
const path = require('path');
const admin = require('firebase-admin');

const CRED = path.join(__dirname, '..', 'backend-bot', 'salgadinhos-lileamar-firebase-adminsdk-fbsvc-76d7889ffc.json');
let serviceAccount;
try { serviceAccount = require(CRED); }
catch (e) { console.error('Credencial não encontrada: ' + CRED); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId: serviceAccount.project_id });

const db = admin.firestore();
const TS = (d) => admin.firestore.Timestamp.fromDate(d);
const rnd = (a) => a[Math.floor(Math.random() * a.length)];
const INTERVALO_MS = 8000;

const CARDAPIO = [{ n: 'Pizza de Calabresa', p: 45.9 }, { n: 'Pizza de Frango c/ Catupiry', p: 45.9 }, { n: 'Pizza Margherita', p: 42 }, { n: 'Esfiha de Carne', p: 6 }, { n: 'Coca-Cola 2L', p: 9 }];
const CANAIS = ['WHATSAPP', 'APP', 'BALCAO', 'MESA'];
const PAGS = ['PIX', 'Cartão', 'Dinheiro'];
const CLIENTES = ['Murilo', 'Ana', 'Beto', 'Carla', 'João', 'Mariana'];
const PROX = { PENDENTE_PREPARO: 'EM_PREPARO', EM_PREPARO: 'PRONTO_PARA_ENTREGA', PRONTO_PARA_ENTREGA: 'SAIU_PARA_ENTREGA', SAIU_PARA_ENTREGA: 'CONCLUIDO' };

function novoPedido() {
  const n = 1 + Math.floor(Math.random() * 3); let itens = [], total = 0;
  for (let i = 0; i < n; i++) { const x = rnd(CARDAPIO); const q = 1 + Math.floor(Math.random() * 2); itens.push({ nome: x.n, nome_exibicao: x.n, preco: x.p, quantidade: q }); total += x.p * q; }
  const origem = rnd(CANAIS);
  return { origem, nome_cliente: origem === 'MESA' ? `Mesa ${1 + Math.floor(Math.random() * 8)}` : rnd(CLIENTES), telefone_cliente: '4799' + Math.floor(1000000 + Math.random() * 8999999), endereco: origem === 'BALCAO' ? 'Retirada no Balcão' : 'Rua Demo, ' + (10 + Math.floor(Math.random() * 990)), itens, valor_total: Math.round(total * 100) / 100, forma_pagamento: rnd(PAGS), status: 'PENDENTE_PREPARO', hora_pedido: TS(new Date()) };
}

async function avancar() {
  const snap = await db.collection('pedidos').where('status', 'in', ['PENDENTE_PREPARO', 'EM_PREPARO', 'PRONTO_PARA_ENTREGA', 'SAIU_PARA_ENTREGA']).limit(20).get();
  if (snap.empty) return;
  const alvo = snap.docs[Math.floor(Math.random() * snap.docs.length)];
  const prox = PROX[alvo.data().status];
  if (prox) { await alvo.ref.update({ status: prox }); console.log(`  ↪ ${alvo.id.slice(0, 5)}: ${alvo.data().status} → ${prox}`); }
}

let i = 0;
async function tick() {
  try { if (i % 2 === 0) { const r = await db.collection('pedidos').add(novoPedido()); console.log('  + novo pedido ' + r.id.slice(0, 5)); } else await avancar(); }
  catch (e) { console.error('  erro:', e.message); }
  i++;
}
console.log('🎬 Simulador NA NUVEM iniciado (' + serviceAccount.project_id + '). Ctrl+C para parar.');
tick(); setInterval(tick, INTERVALO_MS);
