// ============================================================
//  SIMULADOR AO VIVO — cria pedidos novos e avança status
//  automaticamente, para a demo (KDS/Entregas/BI se mexendo).
//  Rode com os emuladores ligados e o seed já feito:  npm run sim
//  Pare com Ctrl+C.
// ============================================================
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';

const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'pizzain-40973' });
const db = admin.firestore();
const TS = (d) => admin.firestore.Timestamp.fromDate(d);
const rnd = (a) => a[Math.floor(Math.random() * a.length)];

const INTERVALO_MS = 8000; // novo evento a cada 8s

const CARDAPIO = [
  { n: 'Pizza de Calabresa', p: 45.9 }, { n: 'Pizza de Frango c/ Catupiry', p: 45.9 },
  { n: 'Pizza Margherita', p: 42 }, { n: 'Esfiha de Carne', p: 6 }, { n: 'Coca-Cola 2L', p: 9 },
];
const CANAIS = ['WHATSAPP', 'APP', 'BALCAO', 'MESA'];
const PAGS = ['PIX', 'Cartão', 'Dinheiro'];
const CLIENTES = ['Murilo', 'Ana', 'Beto', 'Carla', 'João', 'Mariana'];
const PROXIMO = {
  'PENDENTE_PREPARO': 'EM_PREPARO',
  'EM_PREPARO': 'PRONTO_PARA_ENTREGA',
  'PRONTO_PARA_ENTREGA': 'SAIU_PARA_ENTREGA',
  'SAIU_PARA_ENTREGA': 'CONCLUIDO',
};

function novoPedido() {
  const n = 1 + Math.floor(Math.random() * 3);
  let itens = [], total = 0;
  for (let i = 0; i < n; i++) { const x = rnd(CARDAPIO); const q = 1 + Math.floor(Math.random() * 2); itens.push({ nome: x.n, nome_exibicao: x.n, preco: x.p, quantidade: q }); total += x.p * q; }
  const origem = rnd(CANAIS);
  return {
    origem, nome_cliente: origem === 'MESA' ? `Mesa ${1 + Math.floor(Math.random() * 8)}` : rnd(CLIENTES),
    telefone_cliente: '4799' + Math.floor(1000000 + Math.random() * 8999999),
    endereco: origem === 'BALCAO' ? 'Retirada no Balcão' : 'Rua Demo, ' + (10 + Math.floor(Math.random() * 990)),
    itens, valor_total: Math.round(total * 100) / 100, forma_pagamento: rnd(PAGS),
    status: 'PENDENTE_PREPARO', hora_pedido: TS(new Date()),
  };
}

async function avancarUmAtivo() {
  const snap = await db.collection('pedidos')
    .where('status', 'in', ['PENDENTE_PREPARO', 'EM_PREPARO', 'PRONTO_PARA_ENTREGA', 'SAIU_PARA_ENTREGA'])
    .limit(20).get();
  if (snap.empty) return false;
  const docs = snap.docs;
  const alvo = docs[Math.floor(Math.random() * docs.length)];
  const atual = alvo.data().status;
  const prox = PROXIMO[atual];
  if (prox) { await alvo.ref.update({ status: prox }); console.log(`  ↪ pedido ${alvo.id.slice(0, 5)}: ${atual} → ${prox}`); }
  return true;
}

let i = 0;
async function tick() {
  try {
    // alterna: às vezes cria pedido novo, às vezes avança um existente
    if (i % 2 === 0) {
      const ref = await db.collection('pedidos').add(novoPedido());
      console.log(`  + novo pedido ${ref.id.slice(0, 5)} (PENDENTE_PREPARO)`);
    } else {
      await avancarUmAtivo();
    }
  } catch (e) { console.error('  erro:', e.message); }
  i++;
}

console.log('🎬 Simulador ao vivo iniciado (Ctrl+C para parar). Um evento a cada ' + (INTERVALO_MS / 1000) + 's.');
tick();
setInterval(tick, INTERVALO_MS);
