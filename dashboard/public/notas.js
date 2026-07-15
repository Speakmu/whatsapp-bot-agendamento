// ============================================================
//  NOTAS FISCAIS — emitir NFC-e por pedido + listar emitidas
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    const firebaseConfig = window.__FIREBASE_CONFIG__;
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    const db = firebase.firestore();
    const auth = firebase.auth();

    const $ = (id) => document.getElementById(id);
    const money = (v) => "R$ " + (Number(v) || 0).toFixed(2).replace('.', ',');
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    let notasPorPedido = {};   // pedido_id -> nota (autorizada)

    auth.onAuthStateChanged(user => {
        if (!user) { window.location.href = '/login.html'; return; }
        verificarConfig();
        ouvirNotas();
        ouvirPedidos();
    });

    async function verificarConfig() {
        try {
            const cfg = await FiscalClient.getConfig();
            if (!cfg.ativo) mostrarAviso('A emissão fiscal está <strong>desativada</strong>. Ative em Configurações → Fiscal.');
            else if (!cfg.url) mostrarAviso('Informe a URL do serviço fiscal em Configurações → Fiscal.');
        } catch (e) {
            mostrarAviso('Configuração fiscal ausente. Configure em Configurações → Fiscal.');
        }
    }
    function mostrarAviso(html) { const a = $('aviso-config'); a.innerHTML = '⚠️ ' + html; a.style.display = 'block'; }

    function ouvirNotas() {
        db.collection('notas_fiscais').onSnapshot(snap => {
            notasPorPedido = {};
            const notas = [];
            snap.forEach(d => {
                const n = { id: d.id, ...d.data() };
                notas.push(n);
                if (n.status === 'AUTORIZADA' && n.pedido_id) notasPorPedido[n.pedido_id] = n;
            });
            notas.sort((a, b) => (b.criado_em?.toMillis?.() || 0) - (a.criado_em?.toMillis?.() || 0));
            renderNotas(notas);
            renderPedidos(); // atualiza estado dos botões
        }, e => console.warn('notas:', e.message));
    }

    let pedidosCache = [];
    function ouvirPedidos() {
        db.collection('pedidos')
            .where('status', '==', 'CONCLUIDO')
            .onSnapshot(snap => {
                pedidosCache = [];
                snap.forEach(d => pedidosCache.push({ id: d.id, ...d.data() }));
                pedidosCache.sort((a, b) => (b.hora_pedido?.toMillis?.() || 0) - (a.hora_pedido?.toMillis?.() || 0));
                pedidosCache = pedidosCache.slice(0, 40);
                renderPedidos();
            }, e => console.warn('pedidos:', e.message));
    }

    function renderPedidos() {
        const tb = $('tbody-pedidos');
        if (!pedidosCache.length) { tb.innerHTML = '<tr><td colspan="6" class="vazio">Nenhuma venda concluída recente.</td></tr>'; return; }
        tb.innerHTML = pedidosCache.map(p => {
            const hora = p.hora_pedido?.toDate ? p.hora_pedido.toDate().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '--';
            const jaTem = notasPorPedido[p.id];
            const acao = jaTem
                ? `<span class="badge b-aut">NFC-e emitida</span>`
                : `<button class="btn btn-emitir" data-id="${p.id}">Emitir NFC-e</button>`;
            return `<tr>
                <td>#${p.id.substring(0, 5)}</td>
                <td>${esc(p.nome_cliente || 'Cliente')}</td>
                <td>${esc(p.forma_pagamento || '-')}</td>
                <td class="num">${money(p.valor_total)}</td>
                <td>${hora}</td>
                <td style="text-align:right">${acao}</td>
            </tr>`;
        }).join('');
        tb.querySelectorAll('[data-id]').forEach(b => b.onclick = () => emitir(b));
    }

    async function emitir(btn) {
        const id = btn.dataset.id;
        const pedido = pedidosCache.find(p => p.id === id);
        if (!pedido) return;
        btn.disabled = true; btn.textContent = 'Emitindo...';
        try {
            const nota = await FiscalClient.emitir(id, pedido);
            if (nota.status === 'CONTINGENCIA') {
                alert(`⚠️ SEFAZ indisponível — NFC-e emitida em CONTINGÊNCIA.\nA venda foi concluída e o DANFE pode ser impresso.\nTransmita à SEFAZ em até 24h (botão "Transmitir" na lista de notas).`);
            } else {
                alert(`✅ NFC-e autorizada!\nNº ${nota.nNF} • Chave: ${nota.chave}`);
            }
        } catch (err) {
            alert('❌ ' + err.message);
            btn.disabled = false; btn.textContent = 'Emitir NFC-e';
        }
    }

    function renderNotas(notas) {
        const tb = $('tbody-notas');
        if (!notas.length) { tb.innerHTML = '<tr><td colspan="6" class="vazio">Nenhuma nota emitida.</td></tr>'; return; }
        tb.innerHTML = notas.map(n => {
            const when = n.criado_em?.toDate ? n.criado_em.toDate().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '--';
            const cls = n.status === 'AUTORIZADA' ? 'b-aut' : (n.status === 'CONTINGENCIA' ? 'b-cont' : (n.status === 'CANCELADA' || n.status === 'INUTILIZADA' ? 'b-can' : 'b-rej'));
            const ehInut = n.tipo === 'INUTILIZACAO';
            const statusTxt = n.status === 'CONTINGENCIA' ? 'CONTINGÊNCIA (pendente)' : n.status;
            const numero = ehInut ? `Inut. ${n.nNFIni}–${n.nNFFin}` : (n.nNF || '-');
            const chaveTxt = ehInut ? '(inutilização de numeração)' : (n.chave || '-');
            const acoes = [];
            if (n.danfeBase64) acoes.push(`<button class="btn btn-danfe" data-danfe="${n.id}">DANFE</button>`);
            if (n.status === 'CONTINGENCIA') acoes.push(`<button class="btn btn-transmitir" data-transmitir="${n.id}">Transmitir</button>`);
            if (n.status === 'AUTORIZADA' && n.chave && n.protocolo) acoes.push(`<button class="btn btn-cancelar" data-cancelar="${n.id}">Cancelar</button>`);
            const acaoHtml = acoes.length ? acoes.join(' ') : '<span style="color:#7f8c8d">—</span>';
            const motivo = n.motivo ? `<br><span style="font-size:.75rem;color:#7f8c8d">${esc(n.motivo)}</span>` : '';
            return `<tr>
                <td>${esc(String(numero))}</td>
                <td><span class="badge ${cls}">${esc(statusTxt)}</span>${motivo}</td>
                <td class="chave">${esc(chaveTxt)}</td>
                <td class="num">${n.valor != null ? money(n.valor) : '—'}</td>
                <td>${when}</td>
                <td style="text-align:right">${acaoHtml}</td>
            </tr>`;
        }).join('');
        tb.querySelectorAll('[data-danfe]').forEach(b => b.onclick = () => baixarDanfe(notas.find(x => x.id === b.dataset.danfe)));
        tb.querySelectorAll('[data-cancelar]').forEach(b => b.onclick = () => cancelarNota(b));
        tb.querySelectorAll('[data-transmitir]').forEach(b => b.onclick = () => transmitirNota(b));
    }

    async function transmitirNota(btn) {
        const id = btn.dataset.transmitir;
        if (!confirm('Transmitir esta NFC-e de contingência à SEFAZ agora?')) return;
        btn.disabled = true; btn.textContent = 'Transmitindo...';
        try {
            await FiscalClient.transmitirContingencia(id);
            alert('✅ NFC-e de contingência autorizada na SEFAZ.');
        } catch (err) {
            alert('❌ ' + err.message);
            btn.disabled = false; btn.textContent = 'Transmitir';
        }
    }

    async function cancelarNota(btn) {
        const id = btn.dataset.cancelar;
        const just = prompt('Justificativa do cancelamento (15 a 255 caracteres):', '');
        if (just == null) return;
        if (just.trim().length < 15) { alert('A justificativa precisa ter no mínimo 15 caracteres.'); return; }
        if (!confirm('Confirmar o cancelamento desta NFC-e junto à SEFAZ? Esta ação é definitiva.')) return;
        btn.disabled = true; btn.textContent = 'Cancelando...';
        try {
            await FiscalClient.cancelar(id, just.trim());
            alert('✅ NFC-e cancelada com sucesso na SEFAZ.');
        } catch (err) {
            alert('❌ ' + err.message);
            btn.disabled = false; btn.textContent = 'Cancelar';
        }
    }

    async function inutilizarNumeracao() {
        const serie = prompt('Série (padrão 1):', '1'); if (serie == null) return;
        const ini = prompt('Número INICIAL a inutilizar:', ''); if (ini == null) return;
        const fim = prompt('Número FINAL a inutilizar:', ini); if (fim == null) return;
        const just = prompt('Justificativa (15 a 255 caracteres):', ''); if (just == null) return;
        if (just.trim().length < 15) { alert('A justificativa precisa ter no mínimo 15 caracteres.'); return; }
        if (!confirm(`Inutilizar a numeração ${ini}–${fim} (série ${serie})? Esta ação é definitiva.`)) return;
        try {
            await FiscalClient.inutilizar({ serie: Number(serie), nNFIni: Number(ini), nNFFin: Number(fim), justificativa: just.trim() });
            alert('✅ Numeração inutilizada com sucesso na SEFAZ.');
        } catch (err) { alert('❌ ' + err.message); }
    }
    const btnInut = $('btn-inutilizar');
    if (btnInut) btnInut.onclick = inutilizarNumeracao;

    function baixarDanfe(nota) {
        if (!nota?.danfeBase64) return;
        const bytes = atob(nota.danfeBase64);
        const arr = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
        const blob = new Blob([arr], { type: 'application/pdf' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `DANFE-NFCe-${nota.nNF || nota.chave || 'nota'}.pdf`;
        a.click();
    }
});
