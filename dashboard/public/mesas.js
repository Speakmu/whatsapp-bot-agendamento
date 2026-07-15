// ============================================================
//  MESAS & COMANDAS
//  Coleções:
//    mesas    { numero, nome, status: LIVRE|OCUPADA, comanda_id,
//               total_atual, aberta_em }
//    comandas { mesa_id, mesa_numero, status: ABERTA|FECHADA|CANCELADA,
//               itens:[{nome,preco,qtd}], total, aberta_em, fechada_em,
//               forma_pagamento, operador }
//  Ao fechar a conta gera um documento em `pedidos` (origem MESA),
//  para entrar na receita do Financeiro/Relatórios.
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
    const firebaseConfig = window.__FIREBASE_CONFIG__;
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    const db = firebase.firestore();
    const auth = firebase.auth();
    const FieldValue = firebase.firestore.FieldValue;

    const COL_MESAS = "mesas";
    const COL_COMANDAS = "comandas";
    const COL_PEDIDOS = "pedidos";

    const $ = (id) => document.getElementById(id);
    const money = (v) => "R$ " + (Number(v) || 0).toFixed(2).replace('.', ',');
    const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    let mesas = [];
    let cardapio = [];
    let usuarioEmail = null;
    let comandaAberta = null;      // {id, ...dados} no modal
    let mesaDoModal = null;
    let unsubComanda = null;

    auth.onAuthStateChanged(user => {
        if (!user) { window.location.href = '/login.html'; return; }
        usuarioEmail = user.email || 'operador';
        configurar();
        ouvirMesas();
        ouvirCardapio();
    });

    function configurar() {
        $('btn-add-mesa').addEventListener('click', addMesa);
        $('cmd-fechar-modal').addEventListener('click', fecharModal);
        $('cmd-fechar-conta').addEventListener('click', fecharConta);
        $('cmd-cancelar').addEventListener('click', cancelarComanda);
        $('busca-card').addEventListener('input', () => renderCardapioModal($('busca-card').value));
        $('cmd-dividir').addEventListener('input', atualizarDivisao);
    }

    // ---------- Mesas ----------
    function ouvirMesas() {
        db.collection(COL_MESAS).orderBy("numero").onSnapshot(snap => {
            mesas = [];
            snap.forEach(d => mesas.push({ id: d.id, ...d.data() }));
            renderMesas();
        }, err => alert("Erro ao carregar mesas: " + err.message));
    }

    function renderMesas() {
        const grid = $('grid-mesas');
        if (!mesas.length) { grid.innerHTML = '<p style="color:#7f8c8d">Nenhuma mesa. Adicione acima.</p>'; return; }
        grid.innerHTML = mesas.map(m => {
            const ocup = m.status === 'OCUPADA';
            return `<div class="mesa ${ocup ? 'ocupada' : 'livre'}" data-id="${m.id}">
                <span class="x" data-del="${m.id}">✕</span>
                <div class="num">${escapeHtml(String(m.numero ?? '?'))}</div>
                <div class="nome">${escapeHtml(m.nome || 'Mesa')}</div>
                <div class="st">${ocup ? 'OCUPADA' : 'LIVRE'}</div>
                ${ocup ? `<div class="tot">${money(m.total_atual)}</div>` : ''}
            </div>`;
        }).join('');
        grid.querySelectorAll('.mesa').forEach(el => el.addEventListener('click', e => {
            if (e.target.dataset.del) return;
            abrirMesa(el.dataset.id);
        }));
        grid.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', (e) => {
            e.stopPropagation(); removerMesa(b.dataset.del);
        }));
    }

    async function addMesa() {
        const numero = parseInt($('nova-mesa-num').value);
        if (isNaN(numero)) { alert("Informe o número da mesa."); return; }
        if (mesas.some(m => m.numero === numero)) { alert("Já existe uma mesa com esse número."); return; }
        try {
            await db.collection(COL_MESAS).add({
                numero, nome: $('nova-mesa-nome').value.trim(),
                status: 'LIVRE', comanda_id: null, total_atual: 0
            });
            $('nova-mesa-num').value = ''; $('nova-mesa-nome').value = '';
        } catch (err) { alert("Erro: " + err.message); }
    }

    async function removerMesa(id) {
        const m = mesas.find(x => x.id === id);
        if (m && m.status === 'OCUPADA') { alert("Feche a comanda antes de remover a mesa."); return; }
        if (!confirm("Remover esta mesa?")) return;
        try { await db.collection(COL_MESAS).doc(id).delete(); }
        catch (err) { alert("Erro: " + err.message); }
    }

    // ---------- Cardápio ----------
    function ouvirCardapio() {
        db.collection("cardapio").orderBy("categoria").onSnapshot(snap => {
            cardapio = [];
            snap.forEach(d => cardapio.push({ id: d.id, ...d.data() }));
            if ($('modal-comanda').classList.contains('show')) renderCardapioModal($('busca-card').value);
        });
    }

    function renderCardapioModal(filtro = "") {
        const termo = (filtro || "").trim().toLowerCase();
        const itens = cardapio.filter(i => {
            const nome = (i.nome_exibicao || i.nome || "").toLowerCase();
            return (i.disponivel !== false) && (!termo || nome.includes(termo));
        });
        $('grid-cardapio').innerHTML = itens.map(i => {
            const nome = i.nome_exibicao || i.nome || "Item";
            return `<div class="pc" data-id="${i.id}"><div>${escapeHtml(nome)}</div><div class="p">${money(i.preco)}</div></div>`;
        }).join('') || '<p style="color:#7f8c8d">Nenhum item.</p>';
        $('grid-cardapio').querySelectorAll('.pc').forEach(el =>
            el.addEventListener('click', () => addItemComanda(el.dataset.id)));
    }

    // ---------- Abrir mesa / comanda ----------
    async function abrirMesa(mesaId) {
        const mesa = mesas.find(m => m.id === mesaId);
        if (!mesa) return;
        mesaDoModal = mesa;
        try {
            let comandaId = mesa.comanda_id;
            if (mesa.status !== 'OCUPADA' || !comandaId) {
                // cria nova comanda e ocupa a mesa
                const ref = await db.collection(COL_COMANDAS).add({
                    mesa_id: mesaId, mesa_numero: mesa.numero, status: 'ABERTA',
                    itens: [], total: 0, operador: usuarioEmail, aberta_em: FieldValue.serverTimestamp()
                });
                await db.collection(COL_MESAS).doc(mesaId).update({
                    status: 'OCUPADA', comanda_id: ref.id, total_atual: 0, aberta_em: FieldValue.serverTimestamp()
                });
                comandaId = ref.id;
            }
            abrirModalComanda(comandaId, mesa);
        } catch (err) { alert("Erro ao abrir mesa: " + err.message); }
    }

    function abrirModalComanda(comandaId, mesa) {
        $('cmd-titulo').textContent = `Mesa ${mesa.numero}${mesa.nome ? ' — ' + mesa.nome : ''}`;
        $('busca-card').value = '';
        renderCardapioModal('');
        $('modal-comanda').classList.add('show');
        if (unsubComanda) unsubComanda();
        unsubComanda = db.collection(COL_COMANDAS).doc(comandaId).onSnapshot(doc => {
            if (!doc.exists) { fecharModal(); return; }
            comandaAberta = { id: doc.id, ...doc.data() };
            renderComanda();
        });
    }

    function fecharModal() {
        $('modal-comanda').classList.remove('show');
        if (unsubComanda) { unsubComanda(); unsubComanda = null; }
        comandaAberta = null; mesaDoModal = null;
    }

    // ---------- Itens da comanda ----------
    function totalItens(itens) { return (itens || []).reduce((s, i) => s + (i.preco * i.qtd), 0); }

    async function persistirItens(novosItens) {
        if (!comandaAberta) return;
        const total = totalItens(novosItens);
        const batch = db.batch();
        batch.update(db.collection(COL_COMANDAS).doc(comandaAberta.id), { itens: novosItens, total });
        batch.update(db.collection(COL_MESAS).doc(comandaAberta.mesa_id), { total_atual: total });
        await batch.commit();
    }

    async function addItemComanda(cardapioId) {
        if (!comandaAberta) return;
        const item = cardapio.find(i => i.id === cardapioId);
        if (!item) return;
        const nome = item.nome_exibicao || item.nome || "Item";
        const preco = Number(item.preco) || 0;
        const itens = [...(comandaAberta.itens || [])];
        const ex = itens.find(i => i.nome === nome && i.preco === preco);
        if (ex) ex.qtd += 1;
        else itens.push({ nome, preco, qtd: 1 });
        try { await persistirItens(itens); } catch (err) { alert("Erro: " + err.message); }
    }

    async function mudarQtd(idx, delta) {
        const itens = [...(comandaAberta.itens || [])];
        if (!itens[idx]) return;
        itens[idx].qtd += delta;
        if (itens[idx].qtd <= 0) itens.splice(idx, 1);
        try { await persistirItens(itens); } catch (err) { alert("Erro: " + err.message); }
    }

    function renderComanda() {
        const itens = comandaAberta.itens || [];
        const wrap = $('cmd-itens');
        if (!itens.length) { wrap.innerHTML = '<div class="vazio">Nenhum item. Adicione pelo cardápio ao lado.</div>'; }
        else {
            wrap.innerHTML = itens.map((i, idx) => `
                <div class="ci">
                    <div><strong>${escapeHtml(i.nome)}</strong><br><span style="color:#7f8c8d;font-size:.8rem">${money(i.preco)} · ${money(i.preco * i.qtd)}</span></div>
                    <div class="qty">
                        <button data-menos="${idx}">−</button><span>${i.qtd}</span><button data-mais="${idx}">+</button>
                        <button class="rmci" data-rm="${idx}">remover</button>
                    </div>
                </div>`).join('');
            wrap.querySelectorAll('[data-mais]').forEach(b => b.onclick = () => mudarQtd(+b.dataset.mais, +1));
            wrap.querySelectorAll('[data-menos]').forEach(b => b.onclick = () => mudarQtd(+b.dataset.menos, -1));
            wrap.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => mudarQtd(+b.dataset.rm, -9999));
        }
        $('cmd-total').textContent = money(comandaAberta.total);
        atualizarDivisao();
    }

    function atualizarDivisao() {
        const n = parseInt($('cmd-dividir').value) || 1;
        const total = comandaAberta ? (comandaAberta.total || 0) : 0;
        $('cmd-por-pessoa').textContent = n > 1 ? `= ${money(total / n)} por pessoa` : '';
    }

    // ---------- Fechar / cancelar ----------
    async function fecharConta() {
        if (!comandaAberta) return;
        const itens = comandaAberta.itens || [];
        if (!itens.length) { alert("Comanda vazia. Cancele a comanda se não houve consumo."); return; }
        const total = comandaAberta.total || 0;
        const forma = $('cmd-pagamento').value;
        if (!confirm(`Fechar conta da mesa ${comandaAberta.mesa_numero}?\nTotal: ${money(total)} (${forma})`)) return;

        try {
            const pedidoRef = db.collection(COL_PEDIDOS).doc();
            const pedidoData = {
                origem: "MESA",
                mesa_numero: comandaAberta.mesa_numero,
                comanda_id: comandaAberta.id,
                nome_cliente: `Mesa ${comandaAberta.mesa_numero}`,
                itens: itens.map(i => ({ nome_exibicao: i.nome, nome: i.nome, preco: i.preco, quantidade: i.qtd })),
                valor_total: total,
                forma_pagamento: forma,
                status: "CONCLUIDO",
                hora_pedido: FieldValue.serverTimestamp()
            };
            const batch = db.batch();
            batch.set(pedidoRef, pedidoData);
            batch.update(db.collection(COL_COMANDAS).doc(comandaAberta.id), {
                status: 'FECHADA', fechada_em: FieldValue.serverTimestamp(),
                forma_pagamento: forma, pedido_id: pedidoRef.id
            });
            batch.update(db.collection(COL_MESAS).doc(comandaAberta.mesa_id), {
                status: 'LIVRE', comanda_id: null, total_atual: 0
            });
            await batch.commit();
            if (window.GestorChefEstoque) window.GestorChefEstoque.baixarDoPedido(db, pedidoRef.id).catch(() => {});
            fecharModal();
            autoEmitirNFCe(pedidoRef.id, pedidoData);
        } catch (err) { alert("Erro ao fechar conta: " + err.message); }
    }

    // Emissão fiscal automática (respeita Configurações → Fiscal)
    async function autoEmitirNFCe(pedidoId, pedido) {
        if (!window.FiscalClient) return;
        let cfg;
        try { cfg = await FiscalClient.getConfig(); } catch { return; }
        if (!cfg || !cfg.ativo) return;
        if (!['automatico', 'ambos'].includes(cfg.modo)) return;
        try {
            const nota = await FiscalClient.emitir(pedidoId, pedido);
            alert(`🧾 NFC-e emitida automaticamente (nº ${nota.nNF}).`);
        } catch (err) {
            console.warn('NFC-e automática (mesa) não emitida:', err.message);
        }
    }

    async function cancelarComanda() {
        if (!comandaAberta) return;
        if (!confirm("Cancelar a comanda? Os itens serão descartados e a mesa ficará livre.")) return;
        try {
            const batch = db.batch();
            batch.update(db.collection(COL_COMANDAS).doc(comandaAberta.id), {
                status: 'CANCELADA', fechada_em: FieldValue.serverTimestamp()
            });
            batch.update(db.collection(COL_MESAS).doc(comandaAberta.mesa_id), {
                status: 'LIVRE', comanda_id: null, total_atual: 0
            });
            await batch.commit();
            fecharModal();
        } catch (err) { alert("Erro: " + err.message); }
    }
});
