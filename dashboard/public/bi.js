// ============================================================
//  BI / VENDAS — dashboard analítico (Chart.js) sobre `pedidos`
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    const firebaseConfig = window.__FIREBASE_CONFIG__;
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    const db = firebase.firestore();
    const auth = firebase.auth();
    const Timestamp = firebase.firestore.Timestamp;

    const $ = (id) => document.getElementById(id);
    const money = (v) => "R$ " + (Number(v) || 0).toFixed(2).replace('.', ',');
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const CORES = ['#ff5200', '#2f6fed', '#2ecc71', '#f1c40f', '#9b59b6', '#1abc9c', '#e67e22', '#34495e', '#e84393', '#00b894'];

    const charts = {};
    let categoriasMap = {};

    function ymd(d) { return d.toISOString().slice(0, 10); }
    (function init() {
        const hoje = new Date();
        $('data-ini').value = ymd(new Date(hoje.getFullYear(), hoje.getMonth(), 1));
        $('data-fim').value = ymd(hoje);
    })();

    auth.onAuthStateChanged(async user => {
        if (!user) { window.location.href = '/login.html'; return; }
        await carregarCategorias();
        $('btn-aplicar').addEventListener('click', carregar);
        carregar();
    });

    async function carregarCategorias() {
        try {
            const snap = await db.collection('cardapio').get();
            snap.forEach(d => {
                const c = d.data();
                const nome = (c.nome_exibicao || c.nome || '').toLowerCase().trim();
                if (nome) categoriasMap[nome] = c.categoria || 'Outros';
            });
        } catch (e) { console.warn('cardapio:', e.message); }
    }

    function intervalo() {
        const ini = new Date($('data-ini').value + "T00:00:00");
        const fim = new Date($('data-fim').value + "T23:59:59");
        return { ini, fim };
    }

    async function buscarPedidos(ini, fim) {
        const snap = await db.collection('pedidos')
            .where('hora_pedido', '>=', Timestamp.fromDate(ini))
            .where('hora_pedido', '<=', Timestamp.fromDate(fim))
            .get();
        const arr = [];
        snap.forEach(d => arr.push({ id: d.id, ...d.data() }));
        return arr;
    }

    async function carregar() {
        const { ini, fim } = intervalo();
        if (ini > fim) { alert('Período inválido.'); return; }
        const ms = fim - ini;
        const iniAnt = new Date(ini.getTime() - ms - 1000);
        const fimAnt = new Date(ini.getTime() - 1000);
        try {
            const [atual, anterior] = await Promise.all([
                buscarPedidos(ini, fim),
                buscarPedidos(iniAnt, fimAnt)
            ]);
            render(atual, anterior, ini, fim);
        } catch (e) {
            console.error(e);
            alert('Erro ao carregar BI: ' + e.message + (e.message.includes('index') ? '\n\nCrie o índice no link do console.' : ''));
        }
    }

    const nomeItem = (i) => ((typeof i === 'object') ? (i.nome_exibicao || i.nome || '') : String(i)).replace(/^\d+x\s/, '').trim();
    const qtdItem = (i) => (typeof i === 'object' && i.quantidade) ? Number(i.quantidade) : 1;

    function somaValidos(pedidos) {
        return pedidos.filter(p => p.status !== 'CANCELADO').reduce((s, p) => s + (Number(p.valor_total) || 0), 0);
    }

    function render(pedidos, anteriores, ini, fim) {
        const validos = pedidos.filter(p => p.status !== 'CANCELADO');
        const cancelados = pedidos.filter(p => p.status === 'CANCELADO');
        const fat = validos.reduce((s, p) => s + (Number(p.valor_total) || 0), 0);
        const qtd = validos.length;
        const tkt = qtd ? fat / qtd : 0;
        let itensVendidos = 0;
        validos.forEach(p => (p.itens || []).forEach(i => itensVendidos += qtdItem(i)));
        const taxaCanc = pedidos.length ? (cancelados.length / pedidos.length) * 100 : 0;

        // comparativo
        const fatAnt = somaValidos(anteriores);
        const qtdAnt = anteriores.filter(p => p.status !== 'CANCELADO').length;
        delta('k-fat-d', fat, fatAnt);
        delta('k-ped-d', qtd, qtdAnt);

        $('k-fat').textContent = money(fat);
        $('k-ped').textContent = qtd;
        $('k-tkt').textContent = money(tkt);
        $('k-itens').textContent = itensVendidos;
        $('k-canc').textContent = taxaCanc.toFixed(1).replace('.', ',') + '%';

        renderPorDia(validos, ini, fim);
        renderPorHora(validos);
        renderCanal(validos);
        renderPagamento(validos);
        renderCategoria(validos);
        renderProdutos(validos);
        renderClientes(validos);
    }

    function delta(id, atual, anterior) {
        const el = $(id);
        if (!anterior) { el.textContent = ''; return; }
        const v = ((atual - anterior) / anterior) * 100;
        el.textContent = (v >= 0 ? '▲ ' : '▼ ') + Math.abs(v).toFixed(1).replace('.', ',') + '% vs período anterior';
        el.className = 'delta ' + (v >= 0 ? 'up' : 'down');
    }

    function desenhar(id, config) {
        if (charts[id]) charts[id].destroy();
        charts[id] = new Chart($(id), config);
    }

    function renderPorDia(pedidos, ini, fim) {
        const dias = {};
        for (let d = new Date(ini); d <= fim; d.setDate(d.getDate() + 1)) dias[ymd(new Date(d))] = 0;
        pedidos.forEach(p => {
            if (p.hora_pedido?.toDate) {
                const k = ymd(p.hora_pedido.toDate());
                if (k in dias) dias[k] += Number(p.valor_total) || 0;
            }
        });
        const labels = Object.keys(dias).map(k => k.slice(8) + '/' + k.slice(5, 7));
        desenhar('c-dia', {
            type: 'line',
            data: { labels, datasets: [{ label: 'Receita', data: Object.values(dias), borderColor: '#ff5200', backgroundColor: 'rgba(255,82,0,.12)', fill: true, tension: .3 }] },
            options: { plugins: { legend: { display: false } }, responsive: true }
        });
    }

    function renderPorHora(pedidos) {
        const horas = Array(24).fill(0);
        pedidos.forEach(p => { if (p.hora_pedido?.toDate) horas[p.hora_pedido.toDate().getHours()]++; });
        desenhar('c-hora', {
            type: 'bar',
            data: { labels: horas.map((_, h) => h + 'h'), datasets: [{ data: horas, backgroundColor: '#2f6fed' }] },
            options: { plugins: { legend: { display: false } }, responsive: true }
        });
    }

    function canalDe(p) {
        const o = (p.origem || '').toUpperCase();
        if (o === 'BALCAO') return 'Balcão (PDV)';
        if (o === 'MESA') return 'Mesa';
        if (o === 'BOT' || o === 'WHATSAPP') return 'WhatsApp';
        if (o === 'APP') return 'App';
        // inferência: pedidos do app usam usuario_id "cliente_..."
        if (p.usuario_id && String(p.usuario_id).startsWith('cliente_')) return 'App';
        return 'App/Bot';
    }

    function renderPie(id, contagem) {
        const labels = Object.keys(contagem);
        desenhar(id, {
            type: 'doughnut',
            data: { labels: labels.length ? labels : ['Sem dados'], datasets: [{ data: labels.length ? Object.values(contagem) : [1], backgroundColor: CORES }] },
            options: { responsive: true, plugins: { legend: { position: 'right' } } }
        });
    }

    function renderCanal(pedidos) {
        const c = {};
        pedidos.forEach(p => { const k = canalDe(p); c[k] = (c[k] || 0) + (Number(p.valor_total) || 0); });
        renderPie('c-canal', c);
    }

    function renderPagamento(pedidos) {
        const c = {};
        pedidos.forEach(p => {
            const k = (p.forma_pagamento || 'N/I').replace(/_/g, ' ');
            c[k] = (c[k] || 0) + (Number(p.valor_total) || 0);
        });
        renderPie('c-pag', c);
    }

    function renderCategoria(pedidos) {
        const c = {};
        pedidos.forEach(p => (p.itens || []).forEach(i => {
            const nome = nomeItem(i).toLowerCase();
            const cat = categoriasMap[nome] || 'Outros';
            const preco = (typeof i === 'object' && i.preco) ? Number(i.preco) * qtdItem(i) : 0;
            c[cat] = (c[cat] || 0) + (preco || qtdItem(i));
        }));
        const labels = Object.keys(c).sort((a, b) => c[b] - c[a]);
        desenhar('c-cat', {
            type: 'bar',
            data: { labels: labels.length ? labels : ['Sem dados'], datasets: [{ data: labels.length ? labels.map(l => c[l]) : [0], backgroundColor: '#9b59b6' }] },
            options: { indexAxis: 'y', plugins: { legend: { display: false } }, responsive: true }
        });
    }

    function renderProdutos(pedidos) {
        const c = {};
        pedidos.forEach(p => (p.itens || []).forEach(i => {
            const nome = nomeItem(i);
            if (nome) c[nome] = (c[nome] || 0) + qtdItem(i);
        }));
        const top = Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 10);
        desenhar('c-prod', {
            type: 'bar',
            data: { labels: top.map(t => t[0]), datasets: [{ label: 'Qtd vendida', data: top.map(t => t[1]), backgroundColor: '#ff5200' }] },
            options: { indexAxis: 'y', plugins: { legend: { display: false } }, responsive: true }
        });
    }

    function renderClientes(pedidos) {
        const c = {};
        pedidos.forEach(p => {
            const nome = p.nome_cliente || 'Cliente';
            if (!c[nome]) c[nome] = { qtd: 0, total: 0 };
            c[nome].qtd++; c[nome].total += Number(p.valor_total) || 0;
        });
        const top = Object.entries(c).sort((a, b) => b[1].total - a[1].total).slice(0, 10);
        const tb = $('t-clientes');
        tb.innerHTML = top.length ? top.map(([nome, v]) =>
            `<tr><td>${esc(nome)}</td><td class="num">${v.qtd}</td><td class="num">${money(v.total)}</td></tr>`
        ).join('') : '<tr><td colspan="3" class="vazio">Sem dados.</td></tr>';
    }
});
