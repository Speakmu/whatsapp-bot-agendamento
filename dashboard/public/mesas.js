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
    let empresaNome = 'GestorChef';
    let comandaAberta = null;      // {id, ...dados} no modal
    let mesaDoModal = null;
    let unsubComanda = null;
    const mesasEmAbertura = new Set(); // evita corrida ao clicar 2x rápido na mesma mesa

    auth.onAuthStateChanged(user => {
        if (!user) { window.location.href = '/login.html'; return; }
        usuarioEmail = user.email || 'operador';
        configurar();
        carregarEmpresa();
        ouvirMesas();
        ouvirCardapio();
    });

    function configurar() {
        $('btn-add-mesa').addEventListener('click', addMesa);
        $('btn-foco-add').addEventListener('click', () => {
            $('config-mesas').scrollIntoView({ behavior: 'smooth', block: 'center' });
            setTimeout(() => $('nova-mesa-num').focus(), 250);
        });
        $('busca-mesas').addEventListener('input', renderMesas);
        $('cmd-fechar-modal').addEventListener('click', fecharModal);
        $('cmd-imprimir').addEventListener('click', imprimirComanda);
        $('cmd-enviar-caixa').addEventListener('click', enviarParaCaixa);
        $('cmd-cancelar').addEventListener('click', cancelarComanda);
        $('busca-card').addEventListener('input', () => renderCardapioModal($('busca-card').value));
    }

    async function carregarEmpresa() {
        try {
            const snap = await db.collection('configuracoes').doc('sistema').get();
            const nome = snap.exists ? (snap.data().nome || '').trim() : '';
            if (nome) empresaNome = nome;
        } catch (err) {
            console.warn('Empresa nao carregada:', err.message);
        }
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
        renderResumoMesas();
        const termo = ($('busca-mesas').value || '').trim().toLowerCase();
        const mesasFiltradas = mesas.filter(m => {
            const alvo = `${m.numero || ''} ${m.nome || ''} ${m.status || ''}`.toLowerCase();
            return !termo || alvo.includes(termo);
        });

        if (!mesas.length) {
            grid.innerHTML = '<div class="vazio">Nenhuma mesa configurada. Use a área de configuração abaixo para criar Mesa 1, Balcão ou Área externa.</div>';
            return;
        }
        if (!mesasFiltradas.length) {
            grid.innerHTML = '<div class="vazio">Nenhuma mesa encontrada para esta busca.</div>';
            return;
        }

        grid.innerHTML = mesasFiltradas.map(m => {
            const pendente = m.status === 'AGUARDANDO_PAGAMENTO';
            const ocup = m.status === 'OCUPADA' || pendente;
            return `<div class="mesa ${ocup ? 'ocupada' : 'livre'}" data-id="${m.id}">
                <span class="x" data-del="${m.id}" title="Remover mesa">×</span>
                <div class="num">Mesa ${escapeHtml(String(m.numero ?? '?'))}</div>
                <div class="nome">${escapeHtml(m.nome || 'Mesa')}</div>
                <div class="st">${pendente ? 'AGUARDANDO PAGAMENTO' : (ocup ? 'OCUPADA' : 'LIVRE')}</div>
                ${ocup ? `<div class="tot">${money(m.total_atual)}</div><div class="hint">${pendente ? 'Conta enviada ao caixa' : 'Clique para lançar itens ou enviar ao caixa'}</div>` : '<div class="hint">Clique para abrir comanda</div>'}
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

    function renderResumoMesas() {
        const total = mesas.length;
        const ocupadas = mesas.filter(m => m.status === 'OCUPADA' || m.status === 'AGUARDANDO_PAGAMENTO').length;
        const livres = total - ocupadas;
        const totalAberto = mesas.reduce((s, m) => s + ((m.status === 'OCUPADA' || m.status === 'AGUARDANDO_PAGAMENTO') ? Number(m.total_atual) || 0 : 0), 0);
        $('mesa-kpi-total').textContent = String(total);
        $('mesa-kpi-livres').textContent = String(livres);
        $('mesa-kpi-ocupadas').textContent = String(ocupadas);
        $('mesa-kpi-total-aberto').textContent = money(totalAberto);
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
        // Clique duplo/rápido na mesma mesa disparava 2 criações de comanda em corrida
        // (uma ficava órfã e a mesa ficava com o comanda_id trocado no meio da abertura,
        // fazendo o modal abrir e fechar sozinho). Trava por mesa até a abertura terminar.
        if (mesasEmAbertura.has(mesaId)) return;
        mesasEmAbertura.add(mesaId);
        try {
            const mesa = mesas.find(m => m.id === mesaId);
            if (!mesa) return;
            mesaDoModal = mesa;
            let comandaId = mesa.comanda_id;
            if ((mesa.status !== 'OCUPADA' && mesa.status !== 'AGUARDANDO_PAGAMENTO') || !comandaId) {
                // Transação: lê o estado mais recente da mesa e só cria comanda nova
                // se ninguém mais já tiver aberto essa mesa nesse meio-tempo.
                const mesaRef = db.collection(COL_MESAS).doc(mesaId);
                const comandaRef = db.collection(COL_COMANDAS).doc();
                comandaId = await db.runTransaction(async (tx) => {
                    const snap = await tx.get(mesaRef);
                    const dados = snap.data() || {};
                    if ((dados.status === 'OCUPADA' || dados.status === 'AGUARDANDO_PAGAMENTO') && dados.comanda_id) {
                        return dados.comanda_id; // outra chamada já abriu; reaproveita
                    }
                    tx.set(comandaRef, {
                        mesa_id: mesaId, mesa_numero: mesa.numero, status: 'ABERTA',
                        itens: [], total: 0, operador: usuarioEmail, aberta_em: FieldValue.serverTimestamp()
                    });
                    tx.update(mesaRef, {
                        status: 'OCUPADA', comanda_id: comandaRef.id, total_atual: 0, aberta_em: FieldValue.serverTimestamp()
                    });
                    return comandaRef.id;
                });
            }
            abrirModalComanda(comandaId, mesa);
        } catch (err) {
            alert("Erro ao abrir mesa: " + err.message);
        } finally {
            mesasEmAbertura.delete(mesaId);
        }
    }

    function abrirModalComanda(comandaId, mesa) {
        $('cmd-titulo').textContent = `Mesa ${mesa.numero}${mesa.nome ? ' — ' + mesa.nome : ''}`;
        $('busca-card').value = '';
        renderCardapioModal('');
        $('modal-comanda').classList.add('show');
        if (unsubComanda) unsubComanda();
        unsubComanda = db.collection(COL_COMANDAS).doc(comandaId).onSnapshot(doc => {
            if (!doc.exists) {
                // Mesa apontava para uma comanda que não existe mais (dado antigo/corrompido).
                // Em vez de só fechar (o que parecia "piscar e não abrir"), libera a mesa
                // automaticamente para que ela volte a funcionar no próximo clique.
                fecharModal();
                db.collection(COL_MESAS).doc(mesa.id).update({
                    status: 'LIVRE', comanda_id: null, total_atual: 0
                }).catch(() => { });
                alert('Esta mesa estava com uma comanda inválida (registro antigo). Ela foi liberada — pode abrir de novo.');
                return;
            }
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
    }

    function imprimirComanda() {
        if (!comandaAberta) return;
        const itens = comandaAberta.itens || [];
        const linhasMinimas = Math.max(14, itens.length + 8);
        const linhas = [];
        for (let i = 0; i < linhasMinimas; i += 1) {
            const item = itens[i];
            linhas.push(`<tr>
                <td>${item ? escapeHtml(String(item.qtd || 1)) : '&nbsp;'}</td>
                <td>${item ? escapeHtml(item.nome) : '&nbsp;'}</td>
                <td>${item ? money(item.preco * item.qtd) : '&nbsp;'}</td>
            </tr>`);
        }
        const hoje = new Date().toLocaleDateString('pt-BR');
        const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        const mesa = comandaAberta.mesa_numero || (mesaDoModal && mesaDoModal.numero) || '';
        const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Comanda Mesa ${escapeHtml(mesa)}</title>
<style>
    @page { size: 80mm auto; margin: 6mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #111; font-family: Arial, Helvetica, sans-serif; font-size: 10px; }
    .comanda { width: 68mm; min-height: 130mm; border: 1px solid #111; padding: 5mm 3mm; }
    .brand { text-align: center; font-size: 18px; font-weight: 800; line-height: 1.05; margin-bottom: 5mm; }
    .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 3mm; margin-bottom: 3mm; font-size: 9px; }
    .line { border-bottom: 1px solid #111; min-height: 14px; padding: 2px 0; }
    .line strong { display: inline-block; min-width: 30px; font-size: 8px; text-transform: uppercase; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { border: 1px solid #111; padding: 3px 4px; height: 18px; vertical-align: middle; }
    th { background: #111; color: #fff; font-size: 8px; text-transform: uppercase; }
    th:nth-child(1), td:nth-child(1) { width: 10mm; text-align: center; }
    th:nth-child(3), td:nth-child(3) { width: 18mm; text-align: right; }
    .foot { display: grid; grid-template-columns: 1fr 22mm; gap: 3mm; margin-top: 4mm; font-size: 8px; }
    .total { font-weight: 800; text-align: right; }
    .muted { margin-top: 3mm; text-align: center; font-size: 8px; }
    @media screen {
        body { background: #e5e7eb; padding: 16px; }
        .comanda { background: #fff; margin: 0 auto; box-shadow: 0 8px 24px rgba(0,0,0,.16); }
    }
</style>
</head>
<body>
    <div class="comanda">
        <div class="brand">${escapeHtml(empresaNome)}</div>
        <div class="meta">
            <div class="line"><strong>Data</strong> ${hoje}</div>
            <div class="line"><strong>Hora</strong> ${hora}</div>
            <div class="line"><strong>Mesa</strong> ${escapeHtml(mesa)}</div>
            <div class="line"><strong>Cmd</strong> ${escapeHtml(comandaAberta.id.slice(0, 6).toUpperCase())}</div>
        </div>
        <table>
            <thead><tr><th>Qtd</th><th>Descrição</th><th>Valor</th></tr></thead>
            <tbody>${linhas.join('')}</tbody>
        </table>
        <div class="foot">
            <div class="line"><strong>Atendente</strong> ${escapeHtml(usuarioEmail || '')}</div>
            <div class="line total">${money(comandaAberta.total)}</div>
        </div>
        <div class="muted">Itens adicionais podem ser preenchidos manualmente.</div>
    </div>
    <script>
        window.addEventListener('load', function () {
            window.focus();
            window.print();
        });
    <\/script>
</body>
</html>`;

        const win = window.open('', '_blank', 'width=420,height=720');
        if (!win) {
            alert('O navegador bloqueou a janela de impressão. Permita pop-ups para imprimir a comanda.');
            return;
        }
        win.document.open();
        win.document.write(html);
        win.document.close();
    }

    // ---------- Enviar para caixa / cancelar ----------
    async function enviarParaCaixa() {
        if (!comandaAberta) return;
        const itens = comandaAberta.itens || [];
        if (!itens.length) { alert("Comanda vazia. Cancele a comanda se não houve consumo."); return; }
        const total = comandaAberta.total || 0;
        if (!confirm(`Enviar a conta da mesa ${comandaAberta.mesa_numero} para o caixa?\nTotal: ${money(total)}`)) return;

        try {
            const pedidoRef = comandaAberta.pedido_id
                ? db.collection(COL_PEDIDOS).doc(comandaAberta.pedido_id)
                : db.collection(COL_PEDIDOS).doc();
            const pedidoData = {
                origem: "MESA",
                mesa_id: comandaAberta.mesa_id,
                mesa_numero: comandaAberta.mesa_numero,
                comanda_id: comandaAberta.id,
                nome_cliente: `Mesa ${comandaAberta.mesa_numero}`,
                itens: itens.map(i => ({ nome_exibicao: i.nome, nome: i.nome, preco: i.preco, quantidade: i.qtd })),
                valor_total: total,
                forma_pagamento: "",
                status: "AGUARDANDO_PAGAMENTO",
                hora_pedido: comandaAberta.pedido_id ? (comandaAberta.aberta_em || FieldValue.serverTimestamp()) : FieldValue.serverTimestamp(),
                atualizado_em: FieldValue.serverTimestamp()
            };
            const batch = db.batch();
            batch.set(pedidoRef, pedidoData, { merge: true });
            batch.update(db.collection(COL_COMANDAS).doc(comandaAberta.id), {
                status: 'AGUARDANDO_CAIXA',
                pedido_id: pedidoRef.id,
                enviado_caixa_em: FieldValue.serverTimestamp()
            });
            batch.update(db.collection(COL_MESAS).doc(comandaAberta.mesa_id), {
                status: 'AGUARDANDO_PAGAMENTO',
                pedido_id: pedidoRef.id,
                total_atual: total
            });
            await batch.commit();
            fecharModal();
            alert("Comanda enviada ao caixa para recebimento.");
        } catch (err) { alert("Erro ao enviar para o caixa: " + err.message); }
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
                status: 'LIVRE', comanda_id: null, pedido_id: null, total_atual: 0
            });
            // Comanda já enviada ao caixa (tem pedido_id) tem um pedido
            // "AGUARDANDO_PAGAMENTO" pendurado esperando ser recebido — sem
            // cancelar ele também, a mesa some/libera aqui mas o pedido
            // continua aparecendo pra sempre na lista de comandas do caixa.
            if (comandaAberta.pedido_id) {
                batch.update(db.collection(COL_PEDIDOS).doc(comandaAberta.pedido_id), {
                    status: 'CANCELADO', cancelado_em: FieldValue.serverTimestamp()
                });
            }
            await batch.commit();
            fecharModal();
        } catch (err) { alert("Erro: " + err.message); }
    }
});

