// ============================================================
//  seed-core.js — lógica de dados de demonstração, reutilizável.
//  Usada tanto pelo emulador (seed.js) quanto pela nuvem (cloud-seed.js).
//  popular(admin) cria todos os dados; limpar(admin) remove a demo.
// ============================================================
const COLECOES_DEMO = ['pedidos', 'cardapio', 'cupons', 'promocoes', 'estoque_insumos',
  'estoque_movimentos', 'caixa_sessoes', 'caixa_movimentos', 'mesas', 'comandas',
  'entregadores', 'financeiro_lancamentos', 'notas_fiscais', 'app_config', 'usuarios_app', 'configuracoes'];

const CARDAPIO = [
  { nome: 'pizza calabresa', nome_exibicao: 'Pizza de Calabresa', categoria: 'Pizzas', preco: 45.9, disponivel: true, ingredientes: 'Calabresa, cebola, mussarela', pontos_fidelidade: 45 },
  { nome: 'pizza frango catupiry', nome_exibicao: 'Pizza de Frango c/ Catupiry', categoria: 'Pizzas', preco: 45.9, disponivel: true, ingredientes: 'Frango, catupiry, mussarela', pontos_fidelidade: 45 },
  { nome: 'pizza margherita', nome_exibicao: 'Pizza Margherita', categoria: 'Pizzas', preco: 42.0, disponivel: true, ingredientes: 'Mussarela, tomate, manjericão', pontos_fidelidade: 42 },
  { nome: 'esfiha carne', nome_exibicao: 'Esfiha de Carne', categoria: 'Esfihas', preco: 6.0, disponivel: true, ingredientes: 'Carne temperada', pontos_fidelidade: 6 },
  { nome: 'esfiha escarola', nome_exibicao: 'Esfiha de Escarola', categoria: 'Esfihas', preco: 6.5, disponivel: true, ingredientes: 'Escarola', pontos_fidelidade: 6 },
  { nome: 'coca cola 2l', nome_exibicao: 'Coca-Cola 2L', categoria: 'Bebidas', preco: 9.0, disponivel: true, ingredientes: 'Refrigerante', pontos_fidelidade: 0 },
  { nome: 'guarana lata', nome_exibicao: 'Guaraná Lata', categoria: 'Bebidas', preco: 5.0, disponivel: true, ingredientes: 'Refrigerante', pontos_fidelidade: 0 },
];
const CANAIS = ['WHATSAPP', 'APP', 'BALCAO', 'MESA'];
const PAGS = ['PIX', 'Cartão', 'Dinheiro'];
const CLIENTES = ['Murilo Augusto', 'Ana Paula', 'Beto Silva', 'Carla Dias', 'João Pedro', 'Mariana Costa'];
const rnd = (a) => a[Math.floor(Math.random() * a.length)];

async function limpar(admin) {
  const db = admin.firestore();
  for (const c of COLECOES_DEMO) {
    const snap = await db.collection(c).get();
    let batch = db.batch(), n = 0;
    for (const d of snap.docs) { batch.delete(d.ref); if (++n % 400 === 0) { await batch.commit(); batch = db.batch(); } }
    if (n % 400 !== 0) await batch.commit();
  }
}

function pedidoAleatorio(admin, data, status) {
  const TS = (d) => admin.firestore.Timestamp.fromDate(d);
  const n = 1 + Math.floor(Math.random() * 3);
  const itens = []; let total = 0;
  for (let i = 0; i < n; i++) { const p = rnd(CARDAPIO); const q = 1 + Math.floor(Math.random() * 2); itens.push({ nome: p.nome_exibicao, nome_exibicao: p.nome_exibicao, preco: p.preco, quantidade: q }); total += p.preco * q; }
  const origem = rnd(CANAIS);
  return {
    origem, nome_cliente: origem === 'MESA' ? `Mesa ${1 + Math.floor(Math.random() * 8)}` : rnd(CLIENTES),
    telefone_cliente: '4799' + Math.floor(1000000 + Math.random() * 8999999),
    endereco: origem === 'BALCAO' ? 'Retirada no Balcão' : 'Rua Exemplo, ' + (10 + Math.floor(Math.random() * 990)),
    itens, valor_total: Math.round(total * 100) / 100, forma_pagamento: rnd(PAGS), status, hora_pedido: TS(data),
  };
}

async function popular(admin) {
  const db = admin.firestore();
  const TS = (d) => admin.firestore.Timestamp.fromDate(d);
  const SV = () => admin.firestore.FieldValue.serverTimestamp();

  console.log('Limpando coleções de demo...'); await limpar(admin);

  console.log('Login de demonstração...');
  try { await admin.auth().createUser({ uid: 'demo', email: 'demo@gestorchef.com', password: '123456', displayName: 'Gerente Demo' }); console.log('  • demo@gestorchef.com / 123456'); }
  catch (e) { if (['auth/uid-already-exists', 'auth/email-already-exists'].includes(e.code)) console.log('  • usuário de login já existe'); else throw e; }

  console.log('Cardápio...'); for (const p of CARDAPIO) await db.collection('cardapio').doc().set({ ...p, ultima_atualizacao: SV() });

  console.log('Config / Marketing...');
  await db.collection('app_config').doc('geral').set({ nomeApp: 'Pizza In', emojiLogo: '🍕', corPrimaria: '#ff5200', bannerAtivo: true, bannerTexto: '🔥 Terça da Pizza: 20% OFF com o cupom PIZZA20!', bannerCor: '#ff5200', fidelidadeAtiva: true, pontosPorReal: 1, valorPorPonto: 0.05, minResgate: 100, validadePontosDias: 0 });
  await db.collection('cupons').doc().set({ codigo: 'PIZZA20', tipo: 'percentual', valor: 20, minimo: 40, validade: null, ativo: true });
  await db.collection('cupons').doc().set({ codigo: 'BEMVINDO10', tipo: 'fixo', valor: 10, minimo: 30, validade: null, ativo: true });
  await db.collection('promocoes').doc().set({ titulo: 'Combo Família', descricao: '2 pizzas G + refri 2L', ativo: true });
  await db.collection('configuracoes').doc('sistema').set({ nome: 'Pizza In', telefone: '(47) 99999-0000', endereco: 'Av. Central, 1000 - Centro' });

  console.log('Cliente demo...'); await db.collection('usuarios_app').doc('cliente_demo').set({ nome: 'Murilo Augusto', telefone: '47999990000', cpf: '00000000000', pontos: 350 });

  console.log('Estoque...');
  const insumos = [
    { nome: 'Mussarela', categoria: 'Laticínios', unidade: 'kg', quantidade_atual: 12, estoque_minimo: 5, custo_unitario: 38 },
    { nome: 'Massa de Pizza', categoria: 'Massas', unidade: 'un', quantidade_atual: 40, estoque_minimo: 20, custo_unitario: 2.5 },
    { nome: 'Calabresa', categoria: 'Carnes', unidade: 'kg', quantidade_atual: 3, estoque_minimo: 5, custo_unitario: 28 },
    { nome: 'Coca-Cola 2L', categoria: 'Bebidas', unidade: 'un', quantidade_atual: 6, estoque_minimo: 12, custo_unitario: 6 },
    { nome: 'Caixa de Pizza', categoria: 'Embalagens', unidade: 'un', quantidade_atual: 80, estoque_minimo: 30, custo_unitario: 0.9 },
  ];
  for (const i of insumos) await db.collection('estoque_insumos').doc().set({ ...i, atualizado_em: SV() });

  console.log('Caixa / Mesas / Entregadores...');
  const ref = await db.collection('caixa_sessoes').add({ status: 'ABERTO', operador: 'demo@gestorchef.com', aberto_em: SV(), fechado_em: null, fundo_troco: 200, totais: { Dinheiro: 120, PIX: 340, Cartao: 210 }, total_vendas: 670, qtd_vendas: 9, suprimentos_total: 0, sangrias_total: 50 });
  await db.collection('caixa_movimentos').add({ sessao_id: ref.id, tipo: 'ABERTURA', valor: 200, forma_pagamento: 'Dinheiro', descricao: 'Abertura de caixa', operador: 'demo@gestorchef.com', hora: SV() });
  for (let n = 1; n <= 6; n++) await db.collection('mesas').doc('mesa' + n).set({ numero: n, nome: '', status: n === 3 ? 'OCUPADA' : 'LIVRE', comanda_id: n === 3 ? 'comandaDemo' : null, total_atual: n === 3 ? 91.8 : 0 });
  await db.collection('comandas').doc('comandaDemo').set({ mesa_id: 'mesa3', mesa_numero: 3, status: 'ABERTA', itens: [{ nome: 'Pizza de Calabresa', preco: 45.9, qtd: 2 }], total: 91.8, operador: 'demo@gestorchef.com', aberta_em: SV() });
  await db.collection('entregadores').add({ nome: 'Carlos Moto', telefone: '(47) 98888-1111', veiculo: 'Moto', ativo: true });
  await db.collection('entregadores').add({ nome: 'Rafael Bike', telefone: '(47) 98888-2222', veiculo: 'Bicicleta', ativo: true });

  console.log('Financeiro...');
  const hoje = new Date();
  const lanc = (tipo, categoria, valor, dias) => { const d = new Date(hoje); d.setDate(hoje.getDate() - dias); return db.collection('financeiro_lancamentos').add({ tipo, categoria, descricao: categoria, valor, data: TS(d), pago: true, criado_em: SV() }); };
  await lanc('DESPESA', 'Aluguel', 2500, 5); await lanc('DESPESA', 'Insumos', 1800, 3); await lanc('DESPESA', 'Energia', 600, 8); await lanc('RECEITA', 'Outros', 150, 2);

  console.log('Pedidos (histórico + ativos)...');
  let batch = db.batch(), cont = 0;
  const add = (data) => { batch.set(db.collection('pedidos').doc(), data); if (++cont % 400 === 0) { const b = batch; batch = db.batch(); return b.commit(); } };
  for (let d = 14; d >= 1; d--) {
    const qtdDia = 3 + Math.floor(Math.random() * 6);
    for (let i = 0; i < qtdDia; i++) { const data = new Date(hoje); data.setDate(hoje.getDate() - d); data.setHours(11 + Math.floor(Math.random() * 12), Math.floor(Math.random() * 60), 0, 0); await add(pedidoAleatorio(admin, data, Math.random() < 0.1 ? 'CANCELADO' : 'CONCLUIDO')); }
  }
  const ativos = ['PENDENTE_PREPARO', 'PENDENTE_PREPARO', 'EM_PREPARO', 'PRONTO_PARA_ENTREGA', 'SAIU_PARA_ENTREGA'];
  for (let idx = 0; idx < ativos.length; idx++) { const data = new Date(hoje); data.setMinutes(hoje.getMinutes() - (idx * 7 + 2)); await add(pedidoAleatorio(admin, data, ativos[idx])); }
  await batch.commit();

  console.log('\n✅ Dados de demonstração criados!');
}

module.exports = { popular, limpar };
