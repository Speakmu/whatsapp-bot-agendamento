// ============================================================
//  CAIXA / PDV — Frente de caixa + operação de caixa
//  Coleções:
//    pedidos          (reusa a existente; vendas de balcão)
//    caixa_sessoes    { status, aberto_em, fechado_em, operador,
//                       fundo_troco, totais{Dinheiro,PIX,Cartao},
//                       total_vendas, qtd_vendas,
//                       suprimentos_total, sangrias_total,
//                       conferencia, diferenca }
//    caixa_movimentos { sessao_id, tipo, valor, forma_pagamento,
//                       descricao, hora, pedido_id, operador }
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
    const firebaseConfig = window.__FIREBASE_CONFIG__;
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    const db = firebase.firestore();
    const auth = firebase.auth();
    const FieldValue = firebase.firestore.FieldValue;

    // Persistência offline: vendas/movimentos feitos sem internet ficam na
    // fila local (IndexedDB) e sincronizam sozinhos quando a conexão volta.
    // O PDV não pode depender de rede contínua para funcionar.
    db.enablePersistence({ synchronizeTabs: true }).catch(err => {
        if (err.code === 'failed-precondition') {
            console.warn('Persistência offline: já ativa em outra aba deste navegador.');
        } else if (err.code === 'unimplemented') {
            console.warn('Persistência offline: navegador sem suporte (IndexedDB).');
        }
    });

    const COL_PEDIDOS = "pedidos";
    const COL_CARDAPIO = "cardapio";
    const COL_SESSOES = "caixa_sessoes";
    const COL_MOVS = "caixa_movimentos";
    const COL_MESAS = "mesas";
    const COL_COMANDAS = "comandas";

    // forma de pagamento (rótulo) -> chave do mapa de totais
    const CHAVE_PAG = { "Dinheiro": "Dinheiro", "PIX": "PIX", "Cartão": "Cartao" };

    // Estado
    let cardapio = [];
    let carrinho = [];        // {id, nome, preco, qtd}
    let formaPagamento = "Dinheiro";
    let sessaoAtual = null;   // {id, ...dados}
    let usuarioEmail = null;
    let unsubMovs = null;
    let comandasPendentes = [];
    let categoriaAtiva = "";  // "" = todas

    // Emoji de fallback por categoria, pra quando o item não tem imagem
    // cadastrada — não é pra ser "o" ícone certo, só dar uma pista visual
    // rápida no grid touch em vez de um card totalmente em branco.
    const EMOJI_CATEGORIA = {
        pizza: '🍕', pizzas: '🍕', bebida: '🥤', bebidas: '🥤',
        lanche: '🍔', lanches: '🍔', sobremesa: '🍰', sobremesas: '🍰',
        esfiha: '🥙', esfihas: '🥙', combo: '🍽️', combos: '🍽️',
        borda: '🧀', bordas: '🧀', porção: '🍟', porcao: '🍟', porções: '🍟'
    };
    function emojiDoItem(item) {
        const cat = (item.categoria || '').toLowerCase().trim();
        return EMOJI_CATEGORIA[cat] || '🍴';
    }

    const $ = (id) => document.getElementById(id);
    const money = (v) => "R$ " + (Number(v) || 0).toFixed(2).replace('.', ',');
    const escapeHtml = (s) => String(s).replace(/[&<>"]/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    // ---------- Navegação entre abas ----------
    $('tab-pdv').addEventListener('click', () => trocarAba('pdv'));
    $('tab-caixa').addEventListener('click', () => trocarAba('caixa'));
    function trocarAba(qual) {
        $('tab-pdv').classList.toggle('active', qual === 'pdv');
        $('tab-caixa').classList.toggle('active', qual === 'caixa');
        $('view-pdv').classList.toggle('hidden', qual !== 'pdv');
        $('view-caixa').classList.toggle('hidden', qual !== 'caixa');
    }

    // ---------- Autenticação ----------
    auth.onAuthStateChanged((user) => {
        if (!user) { window.location.href = '/login.html'; return; }
        usuarioEmail = user.email || 'operador';
        configurarIndicadorConexao();
        ouvirCardapio();
        ouvirSessaoAberta();
        ouvirComandasPendentes();
        configurarPDV();
        configurarCaixa();
    });

    // ============================================================
    //  INDICADOR DE CONEXÃO / SINCRONIZAÇÃO
    //  O operador precisa saber que está offline (e que não perdeu nada)
    //  em vez de ficar em dúvida e redigitar a venda.
    // ============================================================
    let vendasPendentes = 0;
    function configurarIndicadorConexao() {
        // Anexa dentro de .right (junto com "Caixa: ABERTO"/"Painel") em vez do
        // header direto — no layout mobile o header vira grid de 1 coluna e um
        // filho solto cai numa linha cheia própria, desorganizando o topo.
        const right = document.querySelector('header.top .right');
        if (!right || $('conn-indicador')) return;
        const badge = document.createElement('span');
        badge.id = 'conn-indicador';
        badge.style.cssText = 'font-size:.85rem;padding:5px 10px;border-radius:20px;margin-left:8px;';
        right.appendChild(badge);
        window.addEventListener('online', atualizarIndicadorConexao);
        window.addEventListener('offline', atualizarIndicadorConexao);
        atualizarIndicadorConexao();
    }
    function atualizarIndicadorConexao() {
        const badge = $('conn-indicador');
        if (!badge) return;
        if (navigator.onLine) {
            badge.textContent = vendasPendentes
                ? `🟡 Sincronizando ${vendasPendentes} venda(s)...`
                : '🟢 Online';
            badge.style.background = vendasPendentes ? '#fff6db' : '#e6f9ef';
            badge.style.color = vendasPendentes ? '#8a6d00' : '#1e8e4f';
        } else {
            badge.textContent = '🔴 Offline — vendas continuam sendo registradas';
            badge.style.background = '#fdecea';
            badge.style.color = '#c0392b';
        }
    }

    // ============================================================
    //  CARDÁPIO (PDV)
    // ============================================================
    function ouvirCardapio() {
        db.collection(COL_CARDAPIO).orderBy("categoria").onSnapshot(snap => {
            cardapio = [];
            snap.forEach(doc => cardapio.push({ id: doc.id, ...doc.data() }));
            renderCardapio($('busca-produto').value);
        }, err => console.error("Erro cardápio:", err));
    }

    function renderCategorias() {
        const wrap = $('cat-pills');
        if (!wrap) return;
        const categorias = [...new Set(cardapio.map(i => i.categoria).filter(Boolean))];
        if (!categorias.length) { wrap.innerHTML = ''; return; }
        if (categoriaAtiva && !categorias.includes(categoriaAtiva)) categoriaAtiva = '';
        const pills = ['<button type="button" class="cat-pill' + (categoriaAtiva ? '' : ' active') + '" data-cat="">Todos</button>']
            .concat(categorias.map(c => `<button type="button" class="cat-pill${c === categoriaAtiva ? ' active' : ''}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`));
        wrap.innerHTML = pills.join('');
        wrap.querySelectorAll('[data-cat]').forEach(btn => btn.onclick = () => {
            categoriaAtiva = btn.dataset.cat;
            renderCardapio($('busca-produto').value);
        });
    }

    // Grid de produtos tocável (em vez de dropdown) — pensado pro monitor touch
    // do caixa: nome + preço grandes, foto do cardápio quando cadastrada
    // (item.imagem_url), tocar no card já adiciona 1 unidade ao carrinho.
    function renderCardapio(filtro = "") {
        const grid = $('produtos-grid');
        if (!grid) return;
        renderCategorias();
        const termo = filtro.trim().toLowerCase();
        const itens = cardapio.filter(i => {
            const nome = (i.nome_exibicao || i.nome || "").toLowerCase();
            const categoria = i.categoria || "";
            if (i.disponivel === false) return false;
            if (categoriaAtiva && categoria !== categoriaAtiva) return false;
            return !termo || nome.includes(termo) || categoria.toLowerCase().includes(termo);
        });
        if (!itens.length) {
            grid.innerHTML = '<div class="empty-state">Nenhum item encontrado.</div>';
            return;
        }
        grid.innerHTML = itens.map(i => {
            const nome = i.nome_exibicao || i.nome || "Item";
            const imagem = i.imagem_url
                ? `<img class="produto-img" src="${i.imagem_url}" alt="" loading="lazy">`
                : `<div class="produto-emoji">${emojiDoItem(i)}</div>`;
            return `<button type="button" class="produto-card" data-produto="${i.id}">
                ${imagem}
                <span class="produto-nome">${escapeHtml(nome)}</span>
                <span class="produto-preco">${money(i.preco)}</span>
            </button>`;
        }).join('');
        grid.querySelectorAll('[data-produto]').forEach(btn => btn.onclick = () => addAoCarrinho(btn.dataset.produto));
    }

    // ============================================================
    //  CARRINHO
    // ============================================================
    function addAoCarrinho(id) {
        const item = cardapio.find(i => i.id === id);
        if (!item) return;
        const existente = carrinho.find(c => c.id === id);
        if (existente) existente.qtd += 1;
        else carrinho.push({
            id,
            nome: item.nome_exibicao || item.nome || "Item",
            preco: Number(item.preco) || 0,
            qtd: 1
        });
        renderCarrinho();
        if (window.matchMedia('(max-width: 700px)').matches) {
            $('cart-itens').scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }
    function mudarQtd(id, delta) {
        const c = carrinho.find(x => x.id === id);
        if (!c) return;
        c.qtd += delta;
        if (c.qtd <= 0) carrinho = carrinho.filter(x => x.id !== id);
        renderCarrinho();
    }
    function totalCarrinho() { return carrinho.reduce((s, c) => s + c.preco * c.qtd, 0); }

    function renderCarrinho() {
        const wrap = $('cart-itens');
        $('cart-vazio').style.display = carrinho.length ? 'none' : 'block';
        wrap.innerHTML = carrinho.map(c => `
            <div class="cart-item">
                <div class="ci-info">
                    <div class="ci-nome" title="${escapeHtml(c.nome)}">${escapeHtml(c.nome)}</div>
                    <div class="ci-sub">${money(c.preco)} • subtotal ${money(c.preco * c.qtd)}</div>
                </div>
                <div class="qty">
                    <button data-menos="${c.id}">−</button>
                    <span>${c.qtd}</span>
                    <button data-mais="${c.id}">+</button>
                </div>
            </div>`).join('');
        wrap.querySelectorAll('[data-mais]').forEach(b => b.onclick = () => mudarQtd(b.dataset.mais, +1));
        wrap.querySelectorAll('[data-menos]').forEach(b => b.onclick = () => mudarQtd(b.dataset.menos, -1));
        $('cart-total').textContent = money(totalCarrinho());
        atualizarBotaoFinalizar();
    }

    function configurarPDV() {
        $('busca-produto').addEventListener('input', e => renderCardapio(e.target.value));
        configurarBuscaEComandas();
        $('btn-limpar').addEventListener('click', () => { carrinho = []; renderCarrinho(); });
        $('chk-identificar-cliente').addEventListener('change', e => {
            const marcado = e.target.checked;
            $('campo-cliente').classList.toggle('hidden', !marcado);
            if (marcado) {
                $('cliente-nome').focus();
            } else {
                // Some o campo sem apagar o texto -- se o operador marcar de novo
                // (ex.: clicou sem querer), o nome digitado continua ali.
            }
        });
        $('pag-grid').querySelectorAll('.pag-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                $('pag-grid').querySelectorAll('.pag-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                formaPagamento = btn.dataset.pag;
                renderComandasPendentes();
            });
        });
        $('btn-finalizar').addEventListener('click', finalizarVenda);
    }

    function atualizarBotaoFinalizar() {
        const btn = $('btn-finalizar');
        const podeVender = sessaoAtual && carrinho.length > 0;
        btn.disabled = !podeVender;
        btn.textContent = !sessaoAtual
            ? 'Abra o caixa para vender'
            : (carrinho.length ? `Finalizar venda • ${money(totalCarrinho())}` : 'Finalizar venda');
    }

    function ouvirComandasPendentes() {
        db.collection(COL_PEDIDOS)
            .where("status", "==", "AGUARDANDO_PAGAMENTO")
            .onSnapshot(snap => {
                comandasPendentes = [];
                snap.forEach(doc => {
                    const data = doc.data();
                    // MESA = comanda de mesa fechada pedindo pagamento; TOTEM = pedido
                    // feito no autoatendimento, também esperando pagamento no caixa.
                    if (data.origem === "MESA" || data.origem === "TOTEM") comandasPendentes.push({ id: doc.id, ...data });
                });
                comandasPendentes.sort((a, b) => Number(a.mesa_numero || a.senha || 0) - Number(b.mesa_numero || b.senha || 0));
                renderComandasPendentes();
            }, err => console.error("Erro comandas pendentes:", err));
    }

    // Busca vira ícone (some o input pra sobrar tela pro cardápio) e o
    // ícone de comandas abre a lista num modal — antes ela ficava fixa
    // ocupando espaço no painel "Venda rápida" o tempo todo, mesmo vazia.
    function configurarBuscaEComandas() {
        const btnBusca = $('btn-toggle-busca');
        const inputBusca = $('busca-produto');
        const headProdutos = $('produtos-panel-head');
        if (btnBusca && inputBusca) {
            btnBusca.addEventListener('click', () => {
                const abrindo = inputBusca.classList.contains('hidden');
                inputBusca.classList.toggle('hidden', !abrindo);
                btnBusca.classList.toggle('active', abrindo);
                if (headProdutos) headProdutos.classList.toggle('buscando', abrindo);
                if (abrindo) {
                    inputBusca.focus();
                } else {
                    inputBusca.value = '';
                    renderCardapio('');
                }
            });
        }

        const modal = $('comandas-modal');
        const abrirModal = () => modal && modal.classList.remove('hidden');
        const fecharModal = () => modal && modal.classList.add('hidden');
        const btnComandas = $('btn-comandas');
        if (btnComandas) btnComandas.addEventListener('click', abrirModal);
        const fechar = $('fechar-comandas-modal');
        if (fechar) fechar.addEventListener('click', fecharModal);
        const backdrop = $('comandas-modal-backdrop');
        if (backdrop) backdrop.addEventListener('click', fecharModal);
    }

    function renderComandasPendentes() {
        const lista = $('mesa-pendentes-lista');
        const total = $('mesa-pendentes-total');
        const badge = $('comandas-badge');
        if (!lista) return;
        if (total) {
            total.textContent = `${comandasPendentes.length} ${comandasPendentes.length === 1 ? 'aberta' : 'abertas'}`;
        }
        if (badge) {
            badge.textContent = String(comandasPendentes.length);
            badge.classList.toggle('hidden', !comandasPendentes.length);
        }
        if (!comandasPendentes.length) {
            lista.innerHTML = '<div class="empty-state">Nenhum pedido enviado ao caixa.</div>';
            return;
        }
        lista.innerHTML = comandasPendentes.map(p => {
            const qtd = (p.itens || []).reduce((s, i) => s + (Number(i.quantidade || i.qtd) || 0), 0);
            const itensHtml = (p.itens || []).map(i => {
                const itemQtd = Number(i.quantidade || i.qtd) || 1;
                const nome = i.nome_exibicao || i.nome || 'Item';
                const subtotal = (Number(i.preco) || 0) * itemQtd;
                return `<li><span>${itemQtd}x ${escapeHtml(nome)}</span><strong>${money(subtotal)}</strong></li>`;
            }).join('');
            const disabled = sessaoAtual ? '' : 'disabled';
            const label = sessaoAtual ? 'Receber' : 'Abra o caixa';
            const consumoTotem = p.tipo_consumo === 'LOCAL' ? ' · Comer aqui' : (p.origem === 'TOTEM' ? ' · Levar' : '');
            const rotulo = p.origem === 'TOTEM' ? `Senha ${escapeHtml(p.senha || '-')}${consumoTotem}` : `Mesa ${escapeHtml(p.mesa_numero || '-')}`;
            return `<div class="mesa-pendente">
                <div class="linha-topo">
                    <span class="mesa-num">${rotulo}</span>
                    <span class="valor">${money(p.valor_total)}</span>
                </div>
                <div class="meta">${qtd} item(ns) na comanda</div>
                <details class="mesa-itens">
                    <summary>Ver itens</summary>
                    <ul>${itensHtml || '<li><span>Sem itens listados</span><strong>R$ 0,00</strong></li>'}</ul>
                </details>
                <div class="acoes-mini">
                    <select class="mesa-pagamento" data-pag-mesa="${p.id}" ${disabled}>
                        <option value="Dinheiro">Dinheiro</option>
                        <option value="PIX">PIX</option>
                        <option value="Cartão">Cartão</option>
                    </select>
                    <button data-receber-mesa="${p.id}" ${disabled}>${label}</button>
                </div>
            </div>`;
        }).join('');
        lista.querySelectorAll('[data-receber-mesa]').forEach(btn => {
            btn.addEventListener('click', () => {
                const linha = btn.closest('.mesa-pendente');
                const select = linha ? linha.querySelector('[data-pag-mesa]') : null;
                receberComandaMesa(btn.dataset.receberMesa, select ? select.value : 'Dinheiro');
            });
        });
    }

    async function receberComandaMesa(pedidoId, formaRecebimento = "Dinheiro") {
        if (!sessaoAtual) { alert("Abra o caixa para receber comandas."); return; }
        const pedido = comandasPendentes.find(p => p.id === pedidoId);
        if (!pedido) return;
        const total = Number(pedido.valor_total) || 0;
        const consumoTotem = pedido.tipo_consumo === 'LOCAL' ? ' (Comer aqui)' : (pedido.origem === 'TOTEM' ? ' (Levar)' : '');
        const rotulo = pedido.origem === 'TOTEM' ? `Senha ${pedido.senha}${consumoTotem}` : `Mesa ${pedido.mesa_numero}`;
        if (!confirm(`Receber ${rotulo}?\nTotal: ${money(total)}\nPagamento: ${formaRecebimento}`)) return;

        const chave = CHAVE_PAG[formaRecebimento] || "Dinheiro";
        const pedidoRef = db.collection(COL_PEDIDOS).doc(pedidoId);
        const movRef = db.collection(COL_MOVS).doc();
        const sessaoRef = db.collection(COL_SESSOES).doc(sessaoAtual.id);
        const batch = db.batch();

        // Mesa: a comida já foi servida antes de fechar a comanda, então
        // pagar = concluir. Totem: o cliente paga ANTES de a cozinha começar
        // a preparar (igual totem de fast-food) — pagar manda pra cozinha.
        const statusFinal = pedido.origem === 'TOTEM' ? 'PENDENTE_PREPARO' : 'CONCLUIDO';

        batch.update(pedidoRef, {
            status: statusFinal,
            forma_pagamento: formaRecebimento,
            caixa_sessao_id: sessaoAtual.id,
            pago_em: FieldValue.serverTimestamp()
        });
        batch.set(movRef, {
            sessao_id: sessaoAtual.id,
            tipo: "VENDA",
            valor: total,
            forma_pagamento: formaRecebimento,
            descricao: `Recebimento ${rotulo.toLowerCase()}`,
            pedido_id: pedidoId,
            operador: usuarioEmail,
            hora: FieldValue.serverTimestamp()
        });
        batch.update(sessaoRef, {
            total_vendas: FieldValue.increment(total),
            qtd_vendas: FieldValue.increment(1),
            ["totais." + chave]: FieldValue.increment(total)
        });
        if (pedido.comanda_id) {
            batch.update(db.collection(COL_COMANDAS).doc(pedido.comanda_id), {
                status: "FECHADA",
                forma_pagamento: formaRecebimento,
                caixa_sessao_id: sessaoAtual.id,
                fechada_em: FieldValue.serverTimestamp()
            });
        }
        if (pedido.mesa_id) {
            batch.update(db.collection(COL_MESAS).doc(pedido.mesa_id), {
                status: "LIVRE",
                comanda_id: null,
                pedido_id: null,
                total_atual: 0
            });
        }

        // Não faz "await" no commit: com persistência offline habilitada, a
        // Promise só resolve quando o servidor confirma — offline ela fica
        // pendurada. O efeito é aplicado localmente na hora (cache do
        // Firestore) e a confirmação/erro definitivo do servidor chega depois.
        batch.commit().catch(err => {
            flash(`⚠️ Falha ao sincronizar recebimento da mesa ${pedido.mesa_numero}: ${err.message}`);
        });
        if (window.GestorChefEstoque) {
            window.GestorChefEstoque.baixarDoPedido(db, pedidoId).then(avisarPratosDesativados).catch(() => {});
        }
        flash(`${rotulo} recebida - ${money(total)} (${formaRecebimento})`);
        autoEmitirNFCe(pedidoId, { ...pedido, status: statusFinal, forma_pagamento: formaRecebimento });
    }
    // URLs das Cloud Functions que criam a cobrança na maquininha (Point ou Stone).
    // Mesmo projeto/região das outras functions (WEBHOOK_URL não é acessível aqui,
    // então repetimos o padrão fixo). O provedor ativo vem de configuracoes/pagamentos.
    const CRIAR_COBRANCA_POINT_URL = "https://us-central1-salgadinhos-lileamar.cloudfunctions.net/criarCobrancaPoint";
    const CRIAR_COBRANCA_STONE_URL = "https://us-central1-salgadinhos-lileamar.cloudfunctions.net/criarCobrancaStone";
    let provedorPagamentoCartao = "mercadopago";
    let maquininhaAtiva = true;
    db.collection('configuracoes').doc('pagamentos').onSnapshot(snap => {
        const d = snap.exists ? snap.data() : null;
        provedorPagamentoCartao = d?.provedorCartao || "mercadopago";
        maquininhaAtiva = d?.maquininhaAtiva !== false;
    }, err => console.warn('Erro ao ler provedor de pagamento:', err.message));

    // Só usa o nome digitado se a caixinha "Identificar cliente" estiver
    // marcada — desmarcar esconde o campo, mas se não checasse isso aqui
    // um nome digitado antes e depois desmarcado ainda vazaria pra nota
    // fiscal (o campo só fica invisível, o texto continua no input).
    function nomeClienteAtual() {
        const identificar = $('chk-identificar-cliente').checked;
        const nome = identificar ? $('cliente-nome').value.trim() : '';
        return nome || "Balcão";
    }

    async function finalizarVenda() {
        if (!sessaoAtual || !carrinho.length) return;
        // Com a maquininha desativada, o Cartão segue o mesmo caminho manual de
        // Dinheiro/PIX abaixo: forma_pagamento continua "Cartão" (conta certo nos
        // relatórios), só não tenta acionar nenhum terminal físico.
        if (formaPagamento === "Cartão" && maquininhaAtiva) {
            return provedorPagamentoCartao === "stone" ? finalizarVendaCartaoMaquininha(CRIAR_COBRANCA_STONE_URL, "Stone") : finalizarVendaCartaoMaquininha(CRIAR_COBRANCA_POINT_URL, "Point");
        }

        const btn = $('btn-finalizar');
        btn.disabled = true;

        const total = totalCarrinho();
        const enviarCozinha = $('chk-cozinha').checked;
        const chave = CHAVE_PAG[formaPagamento] || "Dinheiro";

        const pedidoRef = db.collection(COL_PEDIDOS).doc();
        const movRef = db.collection(COL_MOVS).doc();
        const sessaoRef = db.collection(COL_SESSOES).doc(sessaoAtual.id);

        const pedido = {
            origem: "BALCAO",
            nome_cliente: nomeClienteAtual(),
            itens: carrinho.map(c => ({ nome_exibicao: c.nome, nome: c.nome, preco: c.preco, quantidade: c.qtd })),
            valor_total: total,
            forma_pagamento: formaPagamento,
            status: enviarCozinha ? "PENDENTE_PREPARO" : "CONCLUIDO",
            hora_pedido: FieldValue.serverTimestamp(),
            caixa_sessao_id: sessaoAtual.id
        };

        const movimento = {
            sessao_id: sessaoAtual.id,
            tipo: "VENDA",
            valor: total,
            forma_pagamento: formaPagamento,
            descricao: `Venda balcão (${carrinho.reduce((s, c) => s + c.qtd, 0)} itens)`,
            pedido_id: pedidoRef.id,
            operador: usuarioEmail,
            hora: FieldValue.serverTimestamp()
        };

        const updateSessao = {
            total_vendas: FieldValue.increment(total),
            qtd_vendas: FieldValue.increment(1),
            ["totais." + chave]: FieldValue.increment(total)
        };

        const batch = db.batch();
        batch.set(pedidoRef, pedido);
        batch.set(movRef, movimento);
        batch.update(sessaoRef, updateSessao);

        // Não faz "await" no commit: com persistência offline habilitada, a
        // Promise só resolve quando o servidor confirma (offline ela fica
        // pendurada). O pedido já foi gravado no cache local do Firestore
        // (por ID fixo, sem risco de duplicar) — a UI segue na hora e o
        // erro definitivo do servidor (se houver) chega depois, em segundo plano.
        batch.commit().catch(err => {
            flash(`⚠️ Falha ao sincronizar a venda de ${money(total)}: ${err.message}`);
        });

        // Venda de balcão sem cozinha já sai CONCLUIDA -> baixa o estoque
        if (!enviarCozinha && window.GestorChefEstoque) {
            window.GestorChefEstoque.baixarDoPedido(db, pedidoRef.id).then(avisarPratosDesativados).catch(() => {});
        }

        carrinho = [];
        $('cliente-nome').value = "";
        $('chk-identificar-cliente').checked = false;
        $('campo-cliente').classList.add('hidden');
        $('chk-cozinha').checked = false;
        renderCarrinho();
        atualizarBotaoFinalizar();
        flash(`✅ Venda registrada • ${money(total)} (${formaPagamento})`);

        // Emissão automática de NFC-e (se configurado) — só para venda concluída
        if (!enviarCozinha) {
            autoEmitirNFCe(pedidoRef.id, pedido);
        }
    }

    // Venda no Cartão via maquininha física (Point/Mercado Pago ou Stone): dispara a
    // cobrança no terminal e só grava a venda como concluída quando o pagamento é
    // confirmado (webhook do backend atualiza o pedido). Não trava a tela esperando —
    // o caixa pode ver o status "Aguardando pagamento..." e o resultado chega sozinho.
    async function finalizarVendaCartaoMaquininha(criarCobrancaUrl, nomeProvedor) {
        const btn = $('btn-finalizar');
        btn.disabled = true;
        btn.textContent = 'Aguardando pagamento na maquininha...';

        const total = totalCarrinho();
        const enviarCozinha = $('chk-cozinha').checked;
        const pedidoRef = db.collection(COL_PEDIDOS).doc();

        let resp, data;
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (nomeProvedor === 'Stone') {
                const user = firebase.auth().currentUser;
                if (!user) throw new Error('Sessao expirada. Entre novamente no sistema.');
                headers.Authorization = `Bearer ${await user.getIdToken()}`;
            }
            resp = await fetch(criarCobrancaUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    amount: total,
                    externalReference: pedidoRef.id,
                    description: `Pedido balcão ${pedidoRef.id.slice(0, 6)}`
                })
            });
            data = await resp.json().catch(() => ({}));
        } catch (err) {
            alert('Falha ao contatar a maquininha: ' + err.message);
            atualizarBotaoFinalizar();
            return;
        }
        if (!resp.ok) {
            alert('Maquininha recusou a cobrança: ' + (data.message || `erro ${resp.status}`));
            atualizarBotaoFinalizar();
            return;
        }

        const paymentIntentId = data.id;
        if (!paymentIntentId) {
            alert('Resposta inesperada da maquininha (sem id da cobrança).');
            atualizarBotaoFinalizar();
            return;
        }

        const pedido = {
            origem: "BALCAO",
            nome_cliente: nomeClienteAtual(),
            itens: carrinho.map(c => ({ nome_exibicao: c.nome, nome: c.nome, preco: c.preco, quantidade: c.qtd })),
            valor_total: total,
            forma_pagamento: formaPagamento,
            status: "AGUARDANDO_CARTAO",
            status_pos_pagamento: enviarCozinha ? "PENDENTE_PREPARO" : "CONCLUIDO",
            pagamento_id: paymentIntentId,
            operador: usuarioEmail,
            hora_pedido: FieldValue.serverTimestamp(),
            caixa_sessao_id: sessaoAtual.id
        };

        try {
            await pedidoRef.set(pedido);
        } catch (err) {
            alert("Erro ao registrar a venda: " + err.message);
            atualizarBotaoFinalizar();
            return;
        }

        // Limpa o carrinho na hora — a venda já foi disparada na maquininha, o
        // caixa pode atender o próximo cliente enquanto espera a confirmação.
        carrinho = [];
        $('cliente-nome').value = "";
        $('chk-identificar-cliente').checked = false;
        $('campo-cliente').classList.add('hidden');
        $('chk-cozinha').checked = false;
        renderCarrinho();
        flash(`💳 Aguardando confirmação da maquininha (${nomeProvedor}) • ${money(total)}`);
        atualizarBotaoFinalizar();

        // Observa o pedido até a confirmação (ou cancelamento) chegar pelo webhook,
        // para então dar baixa no estoque e emitir a NFC-e — só uma vez.
        const unsub = pedidoRef.onSnapshot(snap => {
            const d = snap.data();
            if (!d || d.status === 'AGUARDANDO_CARTAO') return;
            unsub();
            if (d.status === 'CANCELADO_PAGAMENTO') {
                flash(`❌ Pagamento no cartão não aprovado (pedido ${pedidoRef.id.slice(0, 6)})`);
                return;
            }
            flash(`✅ Cartão aprovado • ${money(d.valor_total)}`);
            if (window.GestorChefEstoque) {
                window.GestorChefEstoque.baixarDoPedido(db, pedidoRef.id).then(avisarPratosDesativados).catch(() => {});
            }
            if (d.status === 'CONCLUIDO') autoEmitirNFCe(pedidoRef.id, d);
        }, err => console.error('Erro ao observar pagamento no cartão:', err));
    }

    // ============================================================
    //  OPERAÇÃO DE CAIXA
    // ============================================================
    function configurarCaixa() {
        $('btn-abrir-caixa').addEventListener('click', abrirCaixa);
        $('btn-fechar-caixa').addEventListener('click', fecharCaixa);
        $('btn-sangria').addEventListener('click', () => movimentoManual('SANGRIA'));
        $('btn-suprimento').addEventListener('click', () => movimentoManual('SUPRIMENTO'));
    }

    function ouvirSessaoAberta() {
        db.collection(COL_SESSOES)
            .where("status", "==", "ABERTO")
            .limit(1)
            .onSnapshot(snap => {
                if (snap.empty) {
                    sessaoAtual = null;
                } else {
                    const doc = snap.docs[0];
                    sessaoAtual = { id: doc.id, ...doc.data() };
                }
                renderEstadoCaixa();
                atualizarBotaoFinalizar();
                renderComandasPendentes();
                ouvirMovimentos();
            }, err => console.error("Erro sessão:", err));
    }

    function renderEstadoCaixa() {
        const ind = $('caixa-indicador');
        if (sessaoAtual) {
            ind.textContent = "Caixa: ABERTO";
            ind.className = "aberto";
            $('caixa-fechado-area').classList.add('hidden');
            $('caixa-aberto-area').classList.remove('hidden');
            const ab = sessaoAtual.aberto_em && sessaoAtual.aberto_em.toDate
                ? sessaoAtual.aberto_em.toDate().toLocaleString('pt-BR') : '--';
            $('info-abertura').textContent = ab;
            $('info-fundo').textContent = money(sessaoAtual.fundo_troco);
            renderResumo();
        } else {
            ind.textContent = "Caixa: FECHADO";
            ind.className = "fechado";
            $('caixa-fechado-area').classList.remove('hidden');
            $('caixa-aberto-area').classList.add('hidden');
            $('resumo-conteudo').innerHTML = '<p style="color:#7f8c8d;font-size:.9rem;">Abra o caixa para ver o resumo.</p>';
        }
    }

    function saldoDinheiroEsperado(s) {
        const dinheiro = (s.totais && s.totais.Dinheiro) || 0;
        return (s.fundo_troco || 0) + dinheiro + (s.suprimentos_total || 0) - (s.sangrias_total || 0);
    }

    function renderResumo() {
        const s = sessaoAtual;
        const t = s.totais || {};
        $('resumo-conteudo').innerHTML = `
            <div class="linha"><span>💵 Dinheiro</span><span>${money(t.Dinheiro)}</span></div>
            <div class="linha"><span>📱 PIX</span><span>${money(t.PIX)}</span></div>
            <div class="linha"><span>💳 Cartão</span><span>${money(t.Cartao)}</span></div>
            <div class="linha"><span>Suprimentos</span><span>${money(s.suprimentos_total)}</span></div>
            <div class="linha"><span>Sangrias</span><span>- ${money(s.sangrias_total)}</span></div>
            <div class="linha"><span>Qtd. vendas</span><span>${s.qtd_vendas || 0}</span></div>
            <div class="linha total"><span>Total vendido</span><span>${money(s.total_vendas)}</span></div>
            <div class="linha"><span>Saldo esperado em dinheiro</span><strong>${money(saldoDinheiroEsperado(s))}</strong></div>
        `;
    }

    // Sem "await" no commit em nenhuma das operações abaixo: com persistência
    // offline habilitada, a Promise de commit só resolve quando o servidor
    // confirma (offline ela fica pendurada — o caixa pareceria travado). Como
    // a função inteira roda de forma síncrona até o fim (sem pontos de
    // suspensão), um segundo clique não consegue começar antes do primeiro
    // terminar — isso já evita abrir/fechar caixa ou lançar o mesmo
    // movimento em duplicidade.
    function abrirCaixa() {
        if (sessaoAtual) return;
        const fundo = parseFloat($('fundo-troco').value) || 0;
        const ref = db.collection(COL_SESSOES).doc();
        const movRef = db.collection(COL_MOVS).doc();
        const batch = db.batch();
        batch.set(ref, {
            status: "ABERTO",
            operador: usuarioEmail,
            aberto_em: FieldValue.serverTimestamp(),
            fechado_em: null,
            fundo_troco: fundo,
            totais: { Dinheiro: 0, PIX: 0, Cartao: 0 },
            total_vendas: 0,
            qtd_vendas: 0,
            suprimentos_total: 0,
            sangrias_total: 0
        });
        batch.set(movRef, {
            sessao_id: ref.id, tipo: "ABERTURA", valor: fundo, forma_pagamento: "Dinheiro",
            descricao: "Abertura de caixa (fundo de troco)", operador: usuarioEmail,
            hora: FieldValue.serverTimestamp()
        });
        batch.commit().catch(err => flash("⚠️ Falha ao sincronizar abertura de caixa: " + err.message));
        flash("Caixa aberto.");
        trocarAba('pdv');
    }

    function movimentoManual(tipo) {
        if (!sessaoAtual) return;
        const label = tipo === 'SANGRIA' ? 'Sangria (retirada)' : 'Suprimento (entrada)';
        const valStr = prompt(`${label}\nValor em R$:`);
        if (valStr === null) return;
        const valor = parseFloat(valStr.replace(',', '.'));
        if (isNaN(valor) || valor <= 0) { alert("Valor inválido."); return; }
        const descricao = prompt("Descrição (opcional):") || label;

        const campo = tipo === 'SANGRIA' ? 'sangrias_total' : 'suprimentos_total';
        const batch = db.batch();
        batch.set(db.collection(COL_MOVS).doc(), {
            sessao_id: sessaoAtual.id, tipo, valor, forma_pagamento: "Dinheiro",
            descricao, operador: usuarioEmail, hora: FieldValue.serverTimestamp()
        });
        batch.update(db.collection(COL_SESSOES).doc(sessaoAtual.id), {
            [campo]: FieldValue.increment(valor)
        });
        batch.commit().catch(err => flash(`⚠️ Falha ao sincronizar ${label.toLowerCase()}: ${err.message}`));
        flash(`${label} de ${money(valor)} registrada.`);
    }

    async function fecharCaixa() {
        if (!sessaoAtual) return;
        const esperado = saldoDinheiroEsperado(sessaoAtual);
        const contadoStr = prompt(`Fechamento de caixa.\nSaldo esperado em dinheiro: ${money(esperado)}\n\nValor contado na gaveta (R$):`);
        if (contadoStr === null) return;
        const contado = parseFloat(contadoStr.replace(',', '.'));
        if (isNaN(contado)) { alert("Valor inválido."); return; }
        const diferenca = contado - esperado;
        const msgDif = diferenca === 0 ? "Sem diferença." :
            (diferenca > 0 ? `Sobra de ${money(diferenca)}` : `Falta de ${money(Math.abs(diferenca))}`);
        if (!confirm(`Confirmar fechamento?\n${msgDif}`)) return;

        const batch = db.batch();
        batch.update(db.collection(COL_SESSOES).doc(sessaoAtual.id), {
            status: "FECHADO",
            fechado_em: FieldValue.serverTimestamp(),
            conferencia: contado,
            saldo_esperado: esperado,
            diferenca: diferenca
        });
        batch.set(db.collection(COL_MOVS).doc(), {
            sessao_id: sessaoAtual.id, tipo: "FECHAMENTO", valor: contado, forma_pagamento: "Dinheiro",
            descricao: `Fechamento. Esperado ${money(esperado)} | Contado ${money(contado)} | ${msgDif}`,
            operador: usuarioEmail, hora: FieldValue.serverTimestamp()
        });
        batch.commit().catch(err => flash("⚠️ Falha ao sincronizar fechamento de caixa: " + err.message));
        flash("Caixa fechado. " + msgDif);
    }

    // ---------- Movimentos da sessão ----------
    function ouvirMovimentos() {
        if (unsubMovs) { unsubMovs(); unsubMovs = null; }
        const lista = $('lista-movimentos');
        if (!sessaoAtual) {
            lista.innerHTML = '<p style="color:#7f8c8d;">Sem movimentações.</p>';
            vendasPendentes = 0;
            atualizarIndicadorConexao();
            return;
        }
        unsubMovs = db.collection(COL_MOVS)
            .where("sessao_id", "==", sessaoAtual.id)
            .onSnapshot({ includeMetadataChanges: true }, snap => {
                vendasPendentes = snap.docs.filter(d => d.metadata.hasPendingWrites).length;
                atualizarIndicadorConexao();
                const movs = [];
                snap.forEach(d => movs.push(d.data()));
                movs.sort((a, b) => {
                    const ta = a.hora && a.hora.toDate ? a.hora.toDate().getTime() : 0;
                    const tb = b.hora && b.hora.toDate ? b.hora.toDate().getTime() : 0;
                    return tb - ta;
                });
                if (!movs.length) { lista.innerHTML = '<p style="color:#7f8c8d;">Sem movimentações.</p>'; return; }
                lista.innerHTML = movs.map(m => {
                    const h = m.hora && m.hora.toDate ? m.hora.toDate().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '--';
                    const sinal = (m.tipo === 'SANGRIA') ? '-' : '';
                    return `<div class="linha">
                        <span>${h} • <strong>${m.tipo}</strong> ${escapeHtml(m.descricao || '')}</span>
                        <span>${sinal}${money(m.valor)}</span>
                    </div>`;
                }).join('');
            }, err => console.error("Erro movimentos:", err));
    }

    // ---------- Emissão fiscal automática (respeita Configurações → Fiscal) ----------
    // FiscalClient.emitirAutomatico já marca o pedido como pendente quando falha
    // (ex.: sem internet no momento da venda) — o retry automático do
    // fiscal-client.js tenta de novo sozinho assim que a conexão voltar.
    async function autoEmitirNFCe(pedidoId, pedido) {
        if (!window.FiscalClient) return;
        try {
            const nota = await FiscalClient.emitirAutomatico(pedidoId, pedido);
            if (nota) flash(`🧾 NFC-e emitida (nº ${nota.nNF})`);
        } catch (err) {
            flash('⚠️ NFC-e automática não emitida — tentaremos de novo quando a conexão voltar.');
        }
    }

    // Avisa o operador quando a baixa de estoque desativou algum prato
    // automaticamente (insumo esgotou) — pra não passar batido.
    function avisarPratosDesativados(resultado) {
        const pratos = resultado && resultado.pratos_desativados;
        if (pratos && pratos.length) {
            flash(`⚠️ Estoque esgotado: ${pratos.join(', ')} ${pratos.length > 1 ? 'foram desativados' : 'foi desativado'} do cardápio.`);
        }
    }

    // ---------- Feedback rápido ----------
    function flash(msg) {
        const d = document.createElement('div');
        d.textContent = msg;
        d.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#2c3e50;color:#fff;padding:12px 20px;border-radius:10px;z-index:9999;box-shadow:0 4px 14px rgba(0,0,0,.3);font-size:.95rem;';
        document.body.appendChild(d);
        setTimeout(() => d.remove(), 2600);
    }
});
