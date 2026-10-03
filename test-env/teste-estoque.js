// ============================================================
//  Teste de ponta a ponta do ESTOQUE, no emulador do Firebase:
//    nota de entrada -> estoque, produto novo cadastrado pela nota,
//    baixa na venda, reprocessamento de vendas sem baixa e liberação
//    do produto novo no Cardápio.
//  Abre as telas de verdade (fiscal.html, painel.html) num navegador.
//
//  Rodar:  npm run test:estoque     (dentro de test-env)
//  NUNCA fala com a produção: só roda com o emulador ligado.
// ============================================================
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.error('Este teste só roda dentro do emulador (npm run test:estoque).');
  process.exit(1);
}
const admin = require('firebase-admin');
const { chromium } = require('playwright-core');

const PROJETO = process.env.GCLOUD_PROJECT;
// 127.0.0.1 (não "localhost"): o navegador tenta IPv6 primeiro e o emulador só escuta em IPv4.
const BASE = 'http://127.0.0.1:5000';
admin.initializeApp({ projectId: PROJETO });
const db = admin.firestore();
const agora = () => admin.firestore.FieldValue.serverTimestamp();
const ha = (min) => admin.firestore.Timestamp.fromMillis(Date.now() - min * 60000);

let falhas = 0;
function ok(nome, cond, extra) {
  if (!cond) falhas++;
  console.log(`${cond ? 'OK   ' : 'FALHA'} ${nome}${extra !== undefined ? ' -> ' + extra : ''}`);
}
const doc = async (col, id) => (await db.collection(col).doc(id).get()).data();
const saldo = async (id) => (await doc('estoque_insumos', id)).quantidade_atual;
async function esperar(cond, ms = 15000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) { if (await cond()) return true; await new Promise(r => setTimeout(r, 250)); }
  return false;
}

const CHAVE1 = '3126090000000000000055001000000001100000001' + '5';
const CHAVE2 = '3126090000000000000055001000000002100000002' + '3';
const itemNota = (xProd, qCom, vUnCom, ncm) => ({ cProd: '1', xProd, ncm, cfop: '5405', uCom: 'UN', qCom, vUnCom, vProd: qCom * vUnCom });

async function semear() {
  await admin.auth().createUser({ email: 'contabilidade@teste.com', password: 'teste123' });
  const b = db.batch();
  const produto = (id, exib, extra) => b.set(db.collection('cardapio').doc(id), {
    nome: exib.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''), nome_exibicao: exib,
    categoria: 'Bebidas', preco: 6, ingredientes: 'x', disponivel: true, ...extra,
  });
  produto('coca', 'Coca Lata', { insumo_vinculado_id: 'ins-coca' });
  // pausado SOZINHO pela baixa automática (estoque zerou)
  produto('pao', 'Pão de Queijo', { categoria: 'Salgados assados', insumo_vinculado_id: 'ins-pao', disponivel: false, desativado_motivo: 'Estoque de insumo esgotado', desativado_automaticamente_em: agora() });
  // pausado À MÃO pelo dono: a nota não pode reativar
  produto('suco', 'Suco de Uva', { insumo_vinculado_id: 'ins-suco', disponivel: false });
  const insumo = (id, nome, qtd) => b.set(db.collection('estoque_insumos').doc(id), { nome, categoria: 'Produto revenda', unidade: 'UN', quantidade_atual: qtd, estoque_minimo: 0, custo_unitario: 3 });
  insumo('ins-coca', 'coca lata', 5); insumo('ins-pao', 'pao de queijo', 0); insumo('ins-suco', 'suco de uva', 0);
  const ficha = (pid, nome, ins) => b.set(db.collection('fichas_tecnicas').doc(pid), { produto_nome: nome, itens: [{ insumo_id: ins, quantidade: 1 }] });
  ficha('coca', 'coca lata', 'ins-coca'); ficha('pao', 'pao de queijo', 'ins-pao'); ficha('suco', 'suco de uva', 'ins-suco');
  b.set(db.collection('dfe_documentos').doc('nota1'), {
    nsu: 'MANUAL-1', chave: CHAVE1, emitente: 'Distribuidora Teste', valor: 100, dhEmi: '2026-10-01T10:00:00-03:00', schema: 'procNFe', resumo: false,
    itens: [itemNota('COCA COLA LATA 350ML', 12, 3, '22021000'), itemNota('PAO DE QUEIJO CONG', 20, 1.5, '19012000'), itemNota('SUCO UVA INTEGRAL', 6, 4, '20096100'), itemNota('AGUA MINERAL 500ML', 24, 1.2, '22011000')],
  });
  b.set(db.collection('dfe_documentos').doc('nota2'), {
    nsu: 'MANUAL-2', chave: CHAVE2, emitente: 'Distribuidora Teste', valor: 30, dhEmi: '2026-10-02T10:00:00-03:00', schema: 'procNFe', resumo: false,
    itens: [itemNota('AGUA MIN 500', 10, 1.3, '22011000')],
  });
  b.set(db.collection('configuracoes').doc('fiscal'), { ativo: false });
  await b.commit();
}

(async () => {
  await semear();
  let browser;
  for (const channel of ['chrome', 'msedge']) { try { browser = await chromium.launch({ channel, headless: true }); break; } catch (e) { /* tenta o próximo */ } }
  if (!browser) throw new Error('Chrome/Edge não encontrado para rodar o teste.');
  // Sem service worker: ele serviria o shell.js do cache (ignorando o bloqueio
  // abaixo) e cada tela voltaria a ser redirecionada pra moldura.
  const contexto = await browser.newContext({ viewport: { width: 1400, height: 1000 }, serviceWorkers: 'block' });
  const page = await contexto.newPage();
  const erros = []; const dialogos = [];
  page.on('pageerror', e => erros.push(String(e)));
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) console.log('   [console ' + m.type() + '] ' + m.text().slice(0, 400)); });
  page.on('dialog', d => { dialogos.push(d.message()); d.accept(); });
  // A moldura (shell.js) redireciona tudo pra admin.html; aqui cada tela é aberta sozinha.
  await page.route('**/shell.js*', r => r.fulfill({ contentType: 'application/javascript', body: '' }));

  // Espera a tela carregar com o usuário logado e o módulo de estoque disponível.
  async function telaPronta() {
    try {
      await page.waitForFunction(() => window.GestorChefEstoque && window.firebase && firebase.auth().currentUser, null, { timeout: 20000 });
    } catch (e) {
      const estado = await page.evaluate(() => ({ url: location.href, estoque: !!window.GestorChefEstoque, usuario: !!(window.firebase && firebase.auth().currentUser) })).catch(() => ({}));
      throw new Error('tela não ficou pronta: ' + JSON.stringify(estado) + ' | erros: ' + erros.join(' | '));
    }
  }

  await page.goto(`${BASE}/login.html`);
  await page.fill('#email-input', 'contabilidade@teste.com');
  await page.fill('#password-input', 'teste123');
  await page.click('#login-button');
  // O login redireciona duas vezes (onAuthStateChanged + then): espera assentar.
  await page.waitForURL('**/admin.html*', { waitUntil: 'commit' }).catch(() => {});
  await page.waitForLoadState('load').catch(() => {});
  await page.waitForFunction(() => window.firebase && firebase.auth().currentUser, null, { timeout: 15000 });

  // ================= 1) Entrada da nota =================
  console.log('\n--- 1) Nota de entrada repõe o estoque');
  await page.goto(`${BASE}/fiscal.html`);
  await page.click('[data-tab="dfe"]');
  await page.waitForSelector('[data-dfe-toggle="nota1"]');
  await page.click('[data-dfe-toggle="nota1"]');
  await page.waitForSelector('[data-item-produto="3"]');
  ok('sugere sozinho o produto pelo nome da nota (Coca)', await page.locator('[data-item-produto="0"]').inputValue() === 'coca');
  await page.selectOption('[data-item-produto="0"]', 'coca');
  await page.selectOption('[data-item-produto="1"]', 'pao');
  await page.selectOption('[data-item-produto="2"]', 'suco');
  await page.selectOption('[data-item-produto="3"]', '__novo__');
  ok('campos do produto novo aparecem', await page.locator('[data-item-prod-novo="3"]').isVisible());
  ok('campos do produto novo ficam ocultos nos outros itens', !(await page.locator('[data-item-prod-novo="0"]').isVisible()));
  await page.fill('[data-item-prod-nome="3"]', 'Água Mineral 500ml');

  // sem categoria: recusa e não grava nada
  await page.click('[data-dfe-confirmar="nota1"]');
  await page.waitForFunction(() => document.getElementById('dfe-entrada-msg-nota1')?.textContent.includes('categoria'));
  ok('produto novo sem categoria é recusado', (await doc('dfe_documentos', 'nota1')).entrada_confirmada !== true);
  ok('recusa não mexe no estoque', await saldo('ins-coca') === 5);
  ok('formulário continua preenchido depois da recusa', await page.locator('[data-item-prod-nome="3"]').inputValue() === 'Água Mineral 500ml');

  await page.selectOption('[data-item-prod-categoria="3"]', 'Bebidas');
  await page.click('[data-dfe-confirmar="nota1"]');
  const confirmou = await esperar(async () => (await doc('dfe_documentos', 'nota1')).entrada_confirmada === true);
  ok('entrada confirmada', confirmou, confirmou ? undefined : 'mensagem na tela: ' + await page.evaluate(() => document.getElementById('dfe-entrada-msg-nota1')?.textContent) + ' | erros: ' + erros.join(' | ') + ' | avisos: ' + dialogos.join(' | '));
  if (!confirmou) { console.log('   linha da nota: ' + (await page.locator('#dfe-lista').innerText()).slice(0, 500).split('\n').join(' / ')); await browser.close(); process.exit(1); }

  ok('produto existente: saldo 5 + 12 = 17', await saldo('ins-coca') === 17, await saldo('ins-coca'));
  ok('produto zerado: saldo 0 + 20 = 20', await saldo('ins-pao') === 20, await saldo('ins-pao'));
  const movs = (await db.collection('estoque_movimentos').get()).docs.map(d => d.data());
  const entradas = movs.filter(m => m.tipo === 'ENTRADA' && String(m.motivo).includes(CHAVE1));
  ok('um movimento de ENTRADA por item da nota', entradas.length === 4, entradas.length);
  ok('movimento registra quem lançou', entradas.every(m => m.operador === 'contabilidade@teste.com'));
  ok('movimento guarda o saldo resultante', entradas.find(m => m.insumo_id === 'ins-coca').saldo_resultante === 17);

  const pao = await doc('cardapio', 'pao');
  ok('produto pausado por estoque zerado volta a ficar disponível', pao.disponivel === true && !pao.desativado_motivo);
  ok('produto pausado à mão continua pausado', (await doc('cardapio', 'suco')).disponivel === false);

  // ================= 2) Produto novo =================
  console.log('\n--- 2) Produto novo cadastrado pela nota');
  const novoSnap = await db.collection('cardapio').where('nome_exibicao', '==', 'Água Mineral 500ml').get();
  ok('produto novo foi criado no cardápio (uma vez)', novoSnap.size === 1, novoSnap.size);
  const novoId = novoSnap.docs[0].id; const novo = novoSnap.docs[0].data();
  ok('nasce sem preço de venda', novo.preco === 0);
  ok('nasce indisponível no caixa/mesas/totem (disponivel=false)', novo.disponivel === false);
  ok('nasce indisponível no app e no bot (disponivel_online=false)', novo.disponivel_online === false);
  ok('marcado como cadastro pendente', novo.cadastro_pendente === true);
  ok('guarda NCM e custo da nota', novo.ncm === '22011000' && novo.custo_unitario === 1.2, `${novo.ncm} / ${novo.custo_unitario}`);
  ok('guarda de qual nota veio e quem cadastrou', novo.criado_pela_nota === CHAVE1 && novo.criado_por === 'contabilidade@teste.com');
  ok('já nasce ligado ao estoque', !!novo.insumo_vinculado_id && await saldo(novo.insumo_vinculado_id) === 24);
  const fichaNova = await doc('fichas_tecnicas', novoId);
  ok('ficha técnica 1:1 criada (venda vai dar baixa)', !!fichaNova && fichaNova.itens[0].insumo_id === novo.insumo_vinculado_id);
  // o que cada canal enxerga
  const visiveis = (await db.collection('cardapio').where('disponivel', '==', true).get()).docs.map(d => d.id);
  ok('consulta do app/bot/totem (disponivel==true) não traz o produto novo', !visiveis.includes(novoId));

  // 2ª nota: o item agora é reconhecido pelo apelido? e cadastrar de novo é recusado
  await page.click('[data-dfe-toggle="nota2"]');
  await page.waitForSelector('[data-item-produto="0"]');
  await page.selectOption('[data-item-produto="0"]', '__novo__');
  await page.fill('[data-item-prod-nome="0"]', 'agua mineral 500ML');
  await page.selectOption('[data-item-prod-categoria="0"]', 'Bebidas');
  await page.click('[data-dfe-confirmar="nota2"]');
  await page.waitForFunction(() => document.getElementById('dfe-entrada-msg-nota2')?.textContent.includes('Ja existe'));
  ok('não deixa cadastrar o mesmo produto duas vezes', (await db.collection('cardapio').get()).size === 4);
  await page.selectOption('[data-item-produto="0"]', novoId);
  await page.click('[data-dfe-confirmar="nota2"]');
  ok('segunda nota confirmada no produto já cadastrado', await esperar(async () => (await doc('dfe_documentos', 'nota2')).entrada_confirmada === true));
  ok('nova entrada soma no mesmo estoque: 24 + 10 = 34', await saldo(novo.insumo_vinculado_id) === 34, await saldo(novo.insumo_vinculado_id));
  ok('aprende o nome que veio na nota como apelido do produto', ((await doc('cardapio', novoId)).apelidos || []).includes('AGUA MIN 500'));
  ok('produto pendente NÃO é liberado por receber estoque', (await doc('cardapio', novoId)).disponivel === false);

  // ================= 3) Baixa na venda =================
  console.log('\n--- 3) Venda dá baixa no estoque');
  await page.goto(`${BASE}/kds.html`);
  await telaPronta();
  const baixar = (id) => page.evaluate((pid) => window.GestorChefEstoque.baixarDoPedido(firebase.firestore(), pid), id);
  const pedido = (id, itens, extra = {}) => db.collection('pedidos').doc(id).set({ origem: 'BALCAO', status: 'CONCLUIDO', valor_total: 10, forma_pagamento: 'PIX', hora_pedido: ha(120), itens, ...extra });

  await pedido('v1', [{ id: 'coca', nome: 'Coca Lata', nome_exibicao: 'Coca Lata', preco: 6, quantidade: 2 }]);
  let r = await baixar('v1');
  ok('venda com código do produto: 17 - 2 = 15', r.ok && await saldo('ins-coca') === 15, JSON.stringify(r));
  r = await baixar('v1');
  ok('mesma venda nunca baixa duas vezes', !r.ok && await saldo('ins-coca') === 15, r.motivo);

  await pedido('v2', [{ nome: 'Pão de Queijo', nome_exibicao: 'Pão de Queijo', preco: 5, quantidade: 3 }]);
  r = await baixar('v2');
  ok('venda só com o nome, com acento: 20 - 3 = 17', r.ok && await saldo('ins-pao') === 17, JSON.stringify(r));

  await pedido('v3', [{ nome: 'Coxinha', quantidade: 1 }]);
  r = await baixar('v3');
  ok('produto sem controle de estoque: marca como processado e não mexe em nada', !r.ok && (await doc('pedidos', 'v3')).estoque_baixado === true);

  // venda que ainda não chegou ao servidor quando a baixa roda (o caso do balcão)
  const atrasada = baixar('v4');
  setTimeout(() => pedido('v4', [{ id: 'coca', nome: 'Coca Lata', quantidade: 1 }]), 2500);
  r = await atrasada;
  ok('venda ainda não sincronizada: espera e baixa (15 - 1 = 14)', r.ok && await saldo('ins-coca') === 14, JSON.stringify(r));

  // esgotar: pausa sozinho
  await pedido('v5', [{ id: 'coca', nome: 'Coca Lata', quantidade: 14 }]);
  r = await baixar('v5');
  const coca = await doc('cardapio', 'coca');
  ok('estoque zerou: produto é pausado sozinho', r.ok && await saldo('ins-coca') === 0 && coca.disponivel === false && !!coca.desativado_motivo);

  // ================= 4) Reprocessamento =================
  console.log('\n--- 4) Vendas que ficaram sem baixa são reprocessadas');
  await pedido('p-recente', [{ id: 'pao', nome: 'Pão de Queijo', quantidade: 4 }], { hora_pedido: ha(30) });
  await pedido('p-agora', [{ id: 'pao', nome: 'Pão de Queijo', quantidade: 1 }], { hora_pedido: ha(0) });
  await pedido('p-antigo', [{ id: 'pao', nome: 'Pão de Queijo', quantidade: 5 }], { hora_pedido: ha(8 * 60) });
  await pedido('p-preparo', [{ id: 'pao', nome: 'Pão de Queijo', quantidade: 2 }], { hora_pedido: ha(30), status: 'EM_PREPARO' });
  const varrer = () => page.evaluate(() => window.GestorChefEstoque.reprocessarPendentes(firebase.firestore()));
  let v = await varrer();
  ok('reprocessa a venda recente sem baixa (17 - 4 = 13)', v.processados === 1 && await saldo('ins-pao') === 13, `${v.processados} / saldo ${await saldo('ins-pao')}`);
  ok('não mexe em venda de segundos atrás (a baixa normal ainda vai rodar)', (await doc('pedidos', 'p-agora')).estoque_baixado !== true);
  ok('não mexe em venda antiga, fora da janela de 6h', (await doc('pedidos', 'p-antigo')).estoque_baixado !== true);
  ok('não mexe em pedido que ainda não foi concluído', (await doc('pedidos', 'p-preparo')).estoque_baixado !== true);
  v = await varrer();
  ok('rodar de novo não baixa duas vezes', v.processados === 0 && await saldo('ins-pao') === 13);
  const saidas = (await db.collection('estoque_movimentos').where('tipo', '==', 'SAIDA').get()).docs.map(d => d.data());
  ok('cada baixa gera movimento de SAÍDA com o pedido', saidas.filter(m => m.pedido_id === 'p-recente').length === 1);

  // ================= 5) Cardápio =================
  console.log('\n--- 5) Liberar o produto novo no Cardápio');
  await page.goto(`${BASE}/painel.html#cardapio`);
  await page.waitForFunction((id) => !!document.querySelector(`button[onclick="prepararEdicao('${id}')"]`), novoId);
  const card = page.locator('.menu-item-card', { hasText: 'Água Mineral 500ml' });
  ok('card mostra "Cadastro pendente"', (await card.innerText()).includes('Cadastro pendente'));
  ok('card mostra "Sem preço"', (await card.innerText()).includes('Sem preço'));
  await page.selectOption('#filtro-status-menu', 'pendente');
  ok('filtro "Cadastro pendente" mostra só ele', await page.locator('.menu-item-card').count() === 1);
  await page.selectOption('#filtro-status-menu', '');

  dialogos.length = 0;
  await card.locator('button', { hasText: 'Ativar (geral)' }).click();
  await esperar(async () => dialogos.length > 0, 4000);
  ok('ativar sem preço é bloqueado com aviso', dialogos.some(m => m.includes('preço de venda')) && (await doc('cardapio', novoId)).disponivel === false, dialogos.join(' | '));
  dialogos.length = 0;
  await card.locator('button', { hasText: 'Repor no App/Bot' }).click();
  await esperar(async () => dialogos.length > 0, 4000);
  ok('liberar no app/bot sem preço é bloqueado', dialogos.length === 1 && (await doc('cardapio', novoId)).disponivel_online === false);

  // completar o cadastro
  await page.evaluate((id) => window.prepararEdicao(id), novoId);
  // a descrição é obrigatória no formulário do Cardápio (o navegador nem envia sem ela)
  await page.click('#product-form button[type="submit"]');
  ok('formulário exige a descrição antes de salvar', await page.evaluate(() => !document.getElementById('product-form').checkValidity()));
  await page.fill('#product-ingredientes', 'Água mineral sem gás 500ml');
  await page.check('#product-disponivel');
  await page.fill('#product-preco', '0');
  await page.click('#product-form button[type="submit"]');
  await page.waitForFunction(() => document.getElementById('product-message')?.textContent.includes('preço de venda'));
  ok('salvar como disponível com preço zero é recusado', (await doc('cardapio', novoId)).disponivel === false);
  await page.fill('#product-preco', '4.50');
  await page.click('#product-form button[type="submit"]');
  ok('cadastro completado', await esperar(async () => (await doc('cardapio', novoId)).preco === 4.5));
  const liberado = await doc('cardapio', novoId);
  ok('com preço: deixa de ser pendente e fica disponível em tudo', liberado.cadastro_pendente === false && liberado.disponivel === true && liberado.disponivel_online === true,
    JSON.stringify({ p: liberado.cadastro_pendente, d: liberado.disponivel, o: liberado.disponivel_online }));
  ok('completar o cadastro não perde o vínculo com o estoque', liberado.insumo_vinculado_id === novo.insumo_vinculado_id && liberado.ncm === '22011000');

  // vender o produto novo
  await page.goto(`${BASE}/kds.html`);
  await telaPronta();
  await pedido('v6', [{ id: novoId, nome: 'Água Mineral 500ml', quantidade: 4 }]);
  r = await baixar('v6');
  ok('venda do produto novo dá baixa: 34 - 4 = 30', r.ok && await saldo(novo.insumo_vinculado_id) === 30, JSON.stringify(r));

  ok('nenhum erro de JavaScript nas telas', erros.length === 0, erros.join(' | '));
  await browser.close();
  console.log(`\n${falhas ? falhas + ' FALHA(S)' : 'TODOS OS TESTES PASSARAM'}`);
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error('ERRO DO TESTE:', e); process.exit(1); });
