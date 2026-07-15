// ============================================================
//  ENTREGAS — despacho de pedidos + entregadores
//  Coleções:
//    entregadores { nome, telefone, veiculo, ativo, criado_em }
//    pedidos (reusa): atribui entregador e avança o status
//      PRONTO_PARA_ENTREGA -> SAIU_PARA_ENTREGA -> CONCLUIDO
//      campos: entregador_id, entregador_nome, hora_saida, hora_entrega
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
    const firebaseConfig = window.__FIREBASE_CONFIG__;
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    const db = firebase.firestore();
    const auth = firebase.auth();
    const FieldValue = firebase.firestore.FieldValue;
    const Timestamp = firebase.firestore.Timestamp;

    const COL_PEDIDOS = "pedidos";
    const COL_ENTREGADORES = "entregadores";
    const BOT_BASE_URL = "https://leann-southbound-vito.ngrok-free.dev";

    const $ = (id) => document.getElementById(id);
    const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    let entregadores = [];
    let pedidos = [];        // pedidos em PRONTO/SAIU
    let usuarioEmail = null;

    auth.onAuthStateChanged(user => {
        if (!user) { window.location.href = '/login.html'; return; }
        usuarioEmail = user.email || 'operador';
        $('form-ent').addEventListener('submit', addEntregador);
        ouvirEntregadores();
        ouvirPedidos();
        contarEntreguesHoje();
    });

    // ---------- Entregadores ----------
    function ouvirEntregadores() {
        db.collection(COL_ENTREGADORES).orderBy("nome").onSnapshot(snap => {
            entregadores = [];
            snap.forEach(d => entregadores.push({ id: d.id, ...d.data() }));
            renderEntregadores();
            render();
        }, err => alert("Erro ao carregar entregadores: " + err.message));
    }

    function renderEntregadores() {
        const ativos = entregadores.filter(e => e.ativo !== false);
        $('kpi-entregadores').textContent = ativos.length;
        const wrap = $('lista-entregadores');
        if (!entregadores.length) { wrap.innerHTML = '<div class="vazio">Nenhum entregador.</div>'; return; }
        wrap.innerHTML = entregadores.map(e => {
            const on = e.ativo !== false;
            return `<div class="ent-item">
                <span class="${on ? '' : 'off'}"><span class="dot ${on ? 'on' : 'off'}"></span>
                    <strong>${escapeHtml(e.nome)}</strong> — ${escapeHtml(e.veiculo || '')} ${e.telefone ? '• ' + escapeHtml(e.telefone) : ''}</span>
                <span>
                    <button class="btn btn-cinza" data-toggle="${e.id}">${on ? 'Desativar' : 'Ativar'}</button>
                    <button class="btn btn-vermelho" data-del="${e.id}">×</button>
                </span>
            </div>`;
        }).join('');
        wrap.querySelectorAll('[data-toggle]').forEach(b => b.onclick = () => toggleEntregador(b.dataset.toggle));
        wrap.querySelectorAll('[data-del]').forEach(b => b.onclick = () => delEntregador(b.dataset.del));
    }

    async function addEntregador(e) {
        e.preventDefault();
        const nome = $('e-nome').value.trim();
        if (!nome) return;
        try {
            await db.collection(COL_ENTREGADORES).add({
                nome, telefone: $('e-tel').value.trim(), veiculo: $('e-veiculo').value,
                ativo: true, criado_em: FieldValue.serverTimestamp()
            });
            $('form-ent').reset();
        } catch (err) { alert("Erro: " + err.message); }
    }
    async function toggleEntregador(id) {
        const e = entregadores.find(x => x.id === id);
        try { await db.collection(COL_ENTREGADORES).doc(id).update({ ativo: !(e.ativo !== false) }); }
        catch (err) { alert("Erro: " + err.message); }
    }
    async function delEntregador(id) {
        if (!confirm("Excluir entregador?")) return;
        try { await db.collection(COL_ENTREGADORES).doc(id).delete(); }
        catch (err) { alert("Erro: " + err.message); }
    }

    // ---------- Pedidos para entrega ----------
    function ouvirPedidos() {
        db.collection(COL_PEDIDOS)
            .where("status", "in", ["PRONTO_PARA_ENTREGA", "SAIU_PARA_ENTREGA"])
            .onSnapshot(snap => {
                pedidos = [];
                snap.forEach(d => pedidos.push({ id: d.id, ...d.data() }));
                render();
            }, err => console.error("Erro pedidos:", err));
    }

    function ehEntrega(p) {
        const end = (p.endereco || '').toLowerCase();
        return end && !end.includes('retirada') && !end.includes('balcão') && !end.includes('balcao');
    }

    function render() {
        const aguardando = pedidos.filter(p => p.status === 'PRONTO_PARA_ENTREGA' && ehEntrega(p));
        const rota = pedidos.filter(p => p.status === 'SAIU_PARA_ENTREGA');
        $('kpi-aguardando').textContent = aguardando.length;
        $('kpi-rota').textContent = rota.length;

        $('lista-aguardando').innerHTML = aguardando.length
            ? aguardando.map(cardAguardando).join('') : '<div class="vazio">Nada para despachar.</div>';
        $('lista-rota').innerHTML = rota.length
            ? rota.map(cardRota).join('') : '<div class="vazio">Ninguém em rota.</div>';

        // listeners
        document.querySelectorAll('[data-despachar]').forEach(b => b.onclick = () => despachar(b.dataset.despachar));
        document.querySelectorAll('[data-entregue]').forEach(b => b.onclick = () => marcarEntregue(b.dataset.entregue));
    }

    function mapsLink(end) {
        return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(end)}`;
    }

    function cardAguardando(p) {
        const opts = entregadores.filter(e => e.ativo !== false)
            .map(e => `<option value="${e.id}">${escapeHtml(e.nome)}</option>`).join('');
        return `<div class="ped">
            <div class="ped-top"><span class="ped-id">#${p.id.substring(0, 5)}</span>
                <span class="ped-meta">${escapeHtml(p.nome_cliente || 'Cliente')}</span></div>
            <div class="ped-end">📍 ${escapeHtml(p.endereco || '')}</div>
            <div class="ped-acoes">
                <select id="sel-${p.id}">${opts || '<option value="">(sem entregadores ativos)</option>'}</select>
                <button class="btn btn-azul" data-despachar="${p.id}">Despachar</button>
                <a class="maps" href="${mapsLink(p.endereco || '')}" target="_blank" rel="noopener">🗺️ Rota</a>
            </div>
        </div>`;
    }

    function cardRota(p) {
        const saida = p.hora_saida && p.hora_saida.toDate
            ? p.hora_saida.toDate().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '--';
        return `<div class="ped rota">
            <div class="ped-top"><span class="ped-id">#${p.id.substring(0, 5)}</span>
                <span class="ped-meta">${escapeHtml(p.nome_cliente || 'Cliente')}</span></div>
            <div class="ped-end">📍 ${escapeHtml(p.endereco || '')}</div>
            <div class="ped-meta">🛵 ${escapeHtml(p.entregador_nome || 'Entregador')} • saiu ${saida}</div>
            <div class="ped-acoes">
                <button class="btn btn-verde" data-entregue="${p.id}">✓ Marcar entregue</button>
                <a class="maps" href="${mapsLink(p.endereco || '')}" target="_blank" rel="noopener">🗺️ Rota</a>
            </div>
        </div>`;
    }

    async function despachar(id) {
        const sel = $('sel-' + id);
        const entId = sel ? sel.value : '';
        if (!entId) { alert("Cadastre/selecione um entregador ativo."); return; }
        const ent = entregadores.find(e => e.id === entId);
        try {
            await db.collection(COL_PEDIDOS).doc(id).update({
                status: "SAIU_PARA_ENTREGA",
                entregador_id: entId,
                entregador_nome: ent ? ent.nome : '',
                hora_saida: FieldValue.serverTimestamp()
            });
            const p = pedidos.find(x => x.id === id) || {};
            notificarBot(p, "SAIU");
        } catch (err) { alert("Erro ao despachar: " + err.message); }
    }

    async function marcarEntregue(id) {
        if (!confirm("Confirmar entrega deste pedido?")) return;
        try {
            await db.collection(COL_PEDIDOS).doc(id).update({
                status: "CONCLUIDO",
                hora_entrega: FieldValue.serverTimestamp()
            });
            if (window.GestorChefEstoque) window.GestorChefEstoque.baixarDoPedido(db, id).catch(() => {});
            contarEntreguesHoje();
        } catch (err) { alert("Erro: " + err.message); }
    }

    function notificarBot(pedido, evento) {
        if (!BOT_BASE_URL) return;
        fetch(`${BOT_BASE_URL}/notificar_saiu`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                wa_id: pedido.telefone_cliente || pedido.wa_id || pedido.telefone,
                nome: pedido.nome_cliente || pedido.nome,
                evento
            })
        }).catch(() => { /* endpoint opcional no bot */ });
    }

    // ---------- Entregues hoje ----------
    async function contarEntreguesHoje() {
        const inicio = new Date(); inicio.setHours(0, 0, 0, 0);
        try {
            const snap = await db.collection(COL_PEDIDOS)
                .where("hora_entrega", ">=", Timestamp.fromDate(inicio))
                .get();
            $('kpi-hoje').textContent = snap.size;
        } catch (err) {
            console.warn("Contagem de entregues hoje indisponível (talvez índice):", err.message);
        }
    }
});
