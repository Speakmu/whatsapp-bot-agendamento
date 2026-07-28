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
        ouvirCardapio();
        ouvirSessaoAberta();
        ouvirComandasPendentes();
        configurarPDV();
        configurarCaixa();
    });

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

    function renderCardapio(filtro = "") {
        const select = $('produto-select');
        if (!select) return;
        const termo = filtro.trim().toLowerCase();
        const itens = cardapio.filter(i => {
            const nome = (i.nome_exibicao || i.nome || "").toLowerCase();
            const categoria = (i.categoria || "").toLowerCase();
            return i.disponivel !== false && (!termo || nome.includes(termo) || categoria.includes(termo));
        });
        select.disabled = !itens.length;
        if (!itens.length) {
            select.innerHTML = '<option value="">Nenhum item encontrado</option>';
            return;
        }
        select.innerHTML = itens.map(i => {
            const nome = i.nome_exibicao || i.nome || "Item";
            const categoria = i.categoria ? ` - ${i.categoria}` : '';
            return `<option value="${i.id}">${escapeHtml(nome)}${escapeHtml(categoria)} - ${money(i.preco)}</option>`;
        }).join('');
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
        mostrarItemAdicionado(item.nome_exibicao || item.nome || "Item");
    }
    function mudarQtd(id, delta) {
        const c = carrinho.find(x => x.id === id);
        if (!c) return;
        c.qtd += delta;
        if (c.qtd <= 0) carrinho = carrinho.filter(x => x.id !== id);
        renderCarrinho();
    }
    function removerItem(id) { carrinho = carrinho.filter(x => x.id !== id); renderCarrinho(); }
    function totalCarrinho() { return carrinho.reduce((s, c) => s + c.preco * c.qtd, 0); }

    function renderCarrinho() {
        const wrap = $('cart-itens');
        $('cart-vazio').style.display = carrinho.length ? 'none' : 'block';
        wrap.innerHTML = carrinho.map(c => `
            <div class="cart-item">
                <div>
                    <div class="ci-nome">${escapeHtml(c.nome)}</div>
                    <div class="ci-sub">${money(c.preco)} • subtotal ${money(c.preco * c.qtd)}</div>
                    <button class="ci-rm" data-rm="${c.id}">remover</button>
                </div>
                <div class="qty">
                    <button data-menos="${c.id}">−</button>
                    <span>${c.qtd}</span>
                    <button data-mais="${c.id}">+</button>
                </div>
            </div>`).join('');
        wrap.querySelectorAll('[data-mais]').forEach(b => b.onclick = () => mudarQtd(b.dataset.mais, +1));
        wrap.querySelectorAll('[data-menos]').forEach(b => b.onclick = () => mudarQtd(b.dataset.menos, -1));
        wrap.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => removerItem(b.dataset.rm));
        $('cart-total').textContent = money(totalCarrinho());
        atualizarBotaoFinalizar();
    }

    function configurarPDV() {
        $('busca-produto').addEventListener('input', e => renderCardapio(e.target.value));
        $('btn-add-produto').addEventListener('click', () => {
            const id = $('produto-select').value;
            if (id) addAoCarrinho(id);
        });
        $('produto-select').addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const id = $('produto-select').value;
                if (id) addAoCarrinho(id);
            }
        });
        $('btn-limpar').addEventListener('click', () => { carrinho = []; renderCarrinho(); });
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

    function mostrarItemAdicionado(nome) {
        const feedback = $('pdv-feedback');
        if (!feedback) return;
        feedback.textContent = `${nome} adicionado à venda.`;
        feedback.classList.remove('hidden');
        clearTimeout(mostrarItemAdicionado.timer);
        mostrarItemAdicionado.timer = setTimeout(() => feedback.classList.add('hidden'), 2600);
        if (window.matchMedia('(max-width: 700px)').matches) {
            $('cart-itens').scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }


    function ouvirComandasPendentes() {
        db.collection(COL_PEDIDOS)
            .where("status", "==", "AGUARDANDO_PAGAMENTO")
            .onSnapshot(snap => {
                comandasPendentes = [];
                snap.forEach(doc => {
                    const data = doc.data();
                    if (data.origem === "MESA") comandasPendentes.push({ id: doc.id, ...data });
                });
                comandasPendentes.sort((a, b) => Number(a.mesa_numero || 0) - Number(b.mesa_numero || 0));
                renderComandasPendentes();
            }, err => console.error("Erro comandas pendentes:", err));
    }

    function renderComandasPendentes() {
        const lista = $('mesa-pendentes-lista');
        const total = $('mesa-pendentes-total');
        if (!lista) return;
        if (total) {
            total.textContent = `${comandasPendentes.length} ${comandasPendentes.length === 1 ? 'aberta' : 'abertas'}`;
        }
        if (!comandasPendentes.length) {
            lista.innerHTML = '<div class="empty-state">Nenhuma comanda enviada ao caixa.</div>';
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
            return `<div class="mesa-pendente">
                <div class="mesa-num">Mesa ${escapeHtml(p.mesa_numero || '-')}</div>
                <div>
                    <div class="meta">${qtd} item(ns) na comanda</div>
                    <details class="mesa-itens">
                        <summary>Ver itens</summary>
                        <ul>${itensHtml || '<li><span>Sem itens listados</span><strong>R$ 0,00</strong></li>'}</ul>
                    </details>
                </div>
                <div class="valor">${money(p.valor_total)}</div>
                <select class="mesa-pagamento" data-pag-mesa="${p.id}" ${disabled}>
                    <option value="Dinheiro">Dinheiro</option>
                    <option value="PIX">PIX</option>
                    <option value="Cartão">Cartão</option>
                </select>
                <button data-receber-mesa="${p.id}" ${disabled}>${label}</button>
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
        if (!confirm(`Receber Mesa ${pedido.mesa_numero}?\nTotal: ${money(total)}\nPagamento: ${formaRecebimento}`)) return;

        const chave = CHAVE_PAG[formaRecebimento] || "Dinheiro";
        const pedidoRef = db.collection(COL_PEDIDOS).doc(pedidoId);
        const movRef = db.collection(COL_MOVS).doc();
        const sessaoRef = db.collection(COL_SESSOES).doc(sessaoAtual.id);
        const batch = db.batch();

        batch.update(pedidoRef, {
            status: "CONCLUIDO",
            forma_pagamento: formaRecebimento,
            caixa_sessao_id: sessaoAtual.id,
            pago_em: FieldValue.serverTimestamp()
        });
        batch.set(movRef, {
            sessao_id: sessaoAtual.id,
            tipo: "VENDA",
            valor: total,
            forma_pagamento: formaRecebimento,
            descricao: `Recebimento mesa ${pedido.mesa_numero}`,
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

        try {
            await batch.commit();
            if (window.GestorChefEstoque) {
                window.GestorChefEstoque.baixarDoPedido(db, pedidoId).catch(() => {});
            }
            flash(`Comanda da mesa ${pedido.mesa_numero} recebida - ${money(total)} (${formaRecebimento})`);
            autoEmitirNFCe(pedidoId, { ...pedido, status: "CONCLUIDO", forma_pagamento: formaRecebimento });
        } catch (err) {
            alert("Erro ao receber comanda: " + err.message);
        }
    }
    async function finalizarVenda() {
        if (!sessaoAtual || !carrinho.length) return;
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
            nome_cliente: ($('cliente-nome').value || "Balcão").trim(),
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

        try {
            const batch = db.batch();
            batch.set(pedidoRef, pedido);
            batch.set(movRef, movimento);
            batch.update(sessaoRef, updateSessao);
            await batch.commit();

            // Venda de balcão sem cozinha já sai CONCLUIDA -> baixa o estoque
            if (!enviarCozinha && window.GestorChefEstoque) {
                window.GestorChefEstoque.baixarDoPedido(db, pedidoRef.id).catch(() => {});
            }

            carrinho = [];
            $('cliente-nome').value = "";
            $('chk-cozinha').checked = false;
            renderCarrinho();
            flash(`✅ Venda registrada • ${money(total)} (${formaPagamento})`);

            // Emissão automática de NFC-e (se configurado) — só para venda concluída
            if (!enviarCozinha) {
                autoEmitirNFCe(pedidoRef.id, pedido);
            }
        } catch (err) {
            alert("Erro ao finalizar venda: " + err.message);
        } finally {
            atualizarBotaoFinalizar();
        }
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

    async function abrirCaixa() {
        if (sessaoAtual) return;
        const fundo = parseFloat($('fundo-troco').value) || 0;
        try {
            const ref = await db.collection(COL_SESSOES).add({
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
            await db.collection(COL_MOVS).add({
                sessao_id: ref.id, tipo: "ABERTURA", valor: fundo, forma_pagamento: "Dinheiro",
                descricao: "Abertura de caixa (fundo de troco)", operador: usuarioEmail,
                hora: FieldValue.serverTimestamp()
            });
            flash("Caixa aberto.");
            trocarAba('pdv');
        } catch (err) { alert("Erro ao abrir caixa: " + err.message); }
    }

    async function movimentoManual(tipo) {
        if (!sessaoAtual) return;
        const label = tipo === 'SANGRIA' ? 'Sangria (retirada)' : 'Suprimento (entrada)';
        const valStr = prompt(`${label}\nValor em R$:`);
        if (valStr === null) return;
        const valor = parseFloat(valStr.replace(',', '.'));
        if (isNaN(valor) || valor <= 0) { alert("Valor inválido."); return; }
        const descricao = prompt("Descrição (opcional):") || label;

        const campo = tipo === 'SANGRIA' ? 'sangrias_total' : 'suprimentos_total';
        try {
            const batch = db.batch();
            batch.set(db.collection(COL_MOVS).doc(), {
                sessao_id: sessaoAtual.id, tipo, valor, forma_pagamento: "Dinheiro",
                descricao, operador: usuarioEmail, hora: FieldValue.serverTimestamp()
            });
            batch.update(db.collection(COL_SESSOES).doc(sessaoAtual.id), {
                [campo]: FieldValue.increment(valor)
            });
            await batch.commit();
            flash(`${label} de ${money(valor)} registrada.`);
        } catch (err) { alert("Erro: " + err.message); }
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

        try {
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
            await batch.commit();
            flash("Caixa fechado. " + msgDif);
        } catch (err) { alert("Erro ao fechar caixa: " + err.message); }
    }

    // ---------- Movimentos da sessão ----------
    function ouvirMovimentos() {
        if (unsubMovs) { unsubMovs(); unsubMovs = null; }
        const lista = $('lista-movimentos');
        if (!sessaoAtual) { lista.innerHTML = '<p style="color:#7f8c8d;">Sem movimentações.</p>'; return; }
        unsubMovs = db.collection(COL_MOVS)
            .where("sessao_id", "==", sessaoAtual.id)
            .onSnapshot(snap => {
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
    async function autoEmitirNFCe(pedidoId, pedido) {
        if (!window.FiscalClient) return;
        let cfg;
        try { cfg = await FiscalClient.getConfig(); } catch { return; }
        if (!cfg || !cfg.ativo) return;
        if (!['automatico', 'ambos'].includes(cfg.modo)) return;
        try {
            const nota = await FiscalClient.emitir(pedidoId, pedido);
            flash(`🧾 NFC-e emitida (nº ${nota.nNF})`);
        } catch (err) {
            flash('⚠️ NFC-e automática não emitida: ' + err.message);
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

