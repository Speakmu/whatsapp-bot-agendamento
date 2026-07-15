// ============================================================
//  HOME / Dashboard — KPIs do dia
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    const firebaseConfig = window.__FIREBASE_CONFIG__;
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    const db = firebase.firestore();
    const auth = firebase.auth();
    const Timestamp = firebase.firestore.Timestamp;

    const $ = (id) => document.getElementById(id);
    const money = (v) => "R$ " + (Number(v) || 0).toFixed(2).replace('.', ',');

    const hoje = new Date();
    $('data-hoje').textContent = hoje.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });

    auth.onAuthStateChanged(user => {
        if (!user) { window.location.href = '/login.html'; return; }
        carregarNomeEmpresa();
        carregarVendasHoje();
        ouvirPedidosAtivos();
        ouvirMesas();
        ouvirEstoque();
    });

    async function carregarNomeEmpresa() {
        try {
            let nome = '';
            const cfg = await db.collection('configuracoes').doc('sistema').get();
            if (cfg.exists && cfg.data().nome) nome = cfg.data().nome;
            if (!nome) {
                const app = await db.collection('app_config').doc('geral').get();
                if (app.exists && (app.data().nomeApp || app.data().nome)) nome = app.data().nomeApp || app.data().nome;
            }
            if (nome) {
                $('titulo-boas-vindas').textContent = `👋 Bem-vindo ao GestorChef — ${nome}`;
                document.title = `Início | GestorChef — ${nome}`;
            }
        } catch (e) { console.warn('nome da empresa:', e.message); }
    }

    async function carregarVendasHoje() {
        const inicio = new Date(); inicio.setHours(0, 0, 0, 0);
        try {
            const snap = await db.collection("pedidos")
                .where("hora_pedido", ">=", Timestamp.fromDate(inicio))
                .get();
            let total = 0;
            snap.forEach(d => { const p = d.data(); if (p.status !== 'CANCELADO') total += Number(p.valor_total) || 0; });
            $('kpi-vendas').textContent = money(total);
        } catch (e) { console.warn("Vendas hoje:", e.message); }
    }

    function ouvirPedidosAtivos() {
        db.collection("pedidos")
            .where("status", "in", ["AGUARDANDO_PIX", "PENDENTE_PREPARO", "PENDENTE_VALIDACAO", "EM_PREPARO", "PRONTO_PARA_ENTREGA", "SAIU_PARA_ENTREGA"])
            .onSnapshot(s => $('kpi-ativos').textContent = s.size,
                e => console.warn("Pedidos ativos:", e.message));
    }

    function ouvirMesas() {
        db.collection("mesas").onSnapshot(s => {
            let ocup = 0; s.forEach(d => { if (d.data().status === 'OCUPADA') ocup++; });
            $('kpi-mesas').textContent = `${ocup}/${s.size}`;
        }, e => console.warn("Mesas:", e.message));
    }

    function ouvirEstoque() {
        db.collection("estoque_insumos").onSnapshot(s => {
            const baixos = [];
            s.forEach(d => { const i = d.data(); if ((Number(i.quantidade_atual) || 0) <= (Number(i.estoque_minimo) || 0)) baixos.push(i.nome || 'insumo'); });
            $('kpi-estoque').textContent = baixos.length;
            const banner = $('banner-estoque');
            if (baixos.length) {
                banner.style.display = 'block';
                const nomes = baixos.slice(0, 4).join(', ');
                const resto = baixos.length > 4 ? ` e mais ${baixos.length - 4}` : '';
                $('banner-estoque-txt').textContent = ` — ${baixos.length} insumo(s) precisam de reposição: ${nomes}${resto}.`;
            } else { banner.style.display = 'none'; }
        }, e => console.warn("Estoque:", e.message));
    }
});
