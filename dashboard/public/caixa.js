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

    // forma de pagamento (rótulo) -> chave do mapa de totais
    const CHAVE_PAG = { "Dinheiro": "Dinheiro", "PIX": "PIX", "Cartão": "Cartao" };

    // Estado
    let cardapio = [];
    let carrinho = [];        // {id, nome, preco, qtd}
    let formaPagamento = "Dinheiro";
    let sessaoAtual = null;   // {id, ...dados}
    let usuarioEmail = null;
    let unsubMovs = null;

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
        const grid = $('grid-produtos');
        const termo = filtro.trim().toLowerCase();
        const itens = cardapio.filter(i => {
            const nome = (i.nome_exibicao || i.nome || "").toLowerCase();
            return !termo || nome.includes(termo);
        });
        if (!itens.length) { grid.innerHTML = '<p style="color:#7f8c8d">Nenhum item.</p>'; return; }
        grid.innerHTML = itens.map(i => {
            const nome = i.nome_exibicao || i.nome || "Item";
            const indisp = (i.disponivel === false) ? "indisp" : "";
            return `<div class="prod ${indisp}" data-id="${i.id}">
                <div><div class="nome">${escapeHtml(nome)}</div>
                <div class="cat">${escapeHtml(i.categoria || '')}</div></div>
                <div class="preco">${money(i.preco)}</div>
            </div>`;
        }).join('');
        grid.querySelectorAll('.prod').forEach(el =>
            el.addEventListener('click', () => addAoCarrinho(el.dataset.id)));
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
        $('btn-limpar').addEventListener('click', () => { carrinho = []; renderCarrinho(); });
        $('pag-grid').querySelectorAll('.pag-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                $('pag-grid').querySelectorAll('.pag-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                formaPagamento = btn.dataset.pag;
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
