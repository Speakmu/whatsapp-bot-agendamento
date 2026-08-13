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
    const BOT_BASE_URL = "https://whatsapp-bot-agendamento.onrender.com";

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
        $('check-todos-rota').addEventListener('change', (e) => {
            document.querySelectorAll('.chk-rota').forEach(chk => chk.checked = e.target.checked);
        });
        $('btn-imprimir-rota').addEventListener('click', imprimirRotaSelecionada);
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
            <div class="ped-top">
                <span><input type="checkbox" class="chk-rota" data-id="${p.id}"><span class="ped-id">#${p.id.substring(0, 5)}</span></span>
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
            if (window.GestorChefEstoque) window.GestorChefEstoque.baixarDoPedido(db, id).then(avisarPratosDesativados).catch(() => {});
            contarEntreguesHoje();
        } catch (err) { alert("Erro: " + err.message); }
    }

    function itensTextoPedido(p) {
        const lista = p.itens || p.itens_pedido;
        if (lista && Array.isArray(lista)) {
            return lista.map(item => {
                const nome = item.nome || item.nome_exibicao || item;
                const texto = (typeof nome === 'object') ? 'Item sem nome' : nome;
                const qtd = item.quantidade ? `${item.quantidade}x ` : '';
                return `${qtd}${escapeHtml(texto)}`;
            }).join(', ');
        }
        return escapeHtml(p.item_pedido || lista || 'Sem detalhes');
    }

    // Imprime numa folha só a relação dos pedidos selecionados em "Em rota",
    // agrupados por entregador — pra loja entregar uma lista organizada ao
    // moto boy em vez de um cupom avulso por pedido.
    function imprimirRotaSelecionada() {
        const ids = Array.from(document.querySelectorAll('.chk-rota:checked')).map(chk => chk.dataset.id);
        if (!ids.length) { alert("Selecione ao menos um pedido em rota."); return; }
        const selecionados = pedidos.filter(p => ids.includes(p.id) && p.status === 'SAIU_PARA_ENTREGA');

        const porEntregador = {};
        selecionados.forEach(p => {
            const nome = p.entregador_nome || 'Sem entregador';
            (porEntregador[nome] = porEntregador[nome] || []).push(p);
        });

        const secoes = Object.keys(porEntregador).sort().map(nome => {
            const paradas = porEntregador[nome].map((p, i) => `
                <div class="parada">
                    <div class="parada-cab"><strong>${i + 1}. #${p.id.substring(0, 5)}</strong> — ${escapeHtml(p.nome_cliente || 'Cliente')}</div>
                    ${p.bairro ? `<div>Bairro: <strong>${escapeHtml(p.bairro)}</strong></div>` : ''}
                    <div>Endereço: ${escapeHtml(p.endereco || '-')}</div>
                    <div>Itens: ${itensTextoPedido(p)}</div>
                    <div>Pagamento: ${escapeHtml((p.forma_pagamento || '-').replace(/_/g, ' ').toUpperCase())} — Total: R$ ${Number(p.valor_total || 0).toFixed(2).replace('.', ',')}</div>
                </div>`).join('');
            return `<h2>🛵 ${escapeHtml(nome)} (${porEntregador[nome].length} parada${porEntregador[nome].length > 1 ? 's' : ''})</h2>${paradas}`;
        }).join('<hr>');

        const janela = window.open('', '_blank', 'width=500,height=700');
        janela.document.write(`
            <html><head><title>Relação de entregas</title>
            <style>
                body { font-family:'Courier New', monospace; font-size:13px; padding:14px; color:#000; }
                h1 { font-size:16px; text-align:center; margin-bottom:4px; }
                h2 { font-size:14px; margin:14px 0 8px; border-bottom:1px solid #000; padding-bottom:4px; }
                .parada { padding:6px 0; border-bottom:1px dashed #999; }
                .parada-cab { margin-bottom:3px; }
                hr { border:none; border-top:2px solid #000; margin:10px 0; }
                .center { text-align:center; }
            </style>
            </head><body>
                <h1>Relação de entregas</h1>
                <div class="center">${new Date().toLocaleString('pt-BR')}</div>
                ${secoes}
            </body></html>
        `);
        janela.document.close();
        janela.focus();
        setTimeout(() => janela.print(), 300);
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

    // Avisa o operador quando a baixa de estoque desativou algum prato
    // automaticamente (insumo esgotou) — pra não passar batido.
    function avisarPratosDesativados(resultado) {
        const pratos = resultado && resultado.pratos_desativados;
        if (!pratos || !pratos.length) return;
        const d = document.createElement('div');
        d.textContent = `⚠️ Estoque esgotado: ${pratos.join(', ')} ${pratos.length > 1 ? 'foram desativados' : 'foi desativado'} do cardápio.`;
        d.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#2c3e50;color:#fff;padding:12px 20px;border-radius:10px;z-index:9999;box-shadow:0 4px 14px rgba(0,0,0,.3);font-size:.95rem;';
        document.body.appendChild(d);
        setTimeout(() => d.remove(), 4000);
    }
});
