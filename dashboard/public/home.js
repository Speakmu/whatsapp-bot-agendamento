// HOME / Dashboard operacional do dia
document.addEventListener('DOMContentLoaded', () => {
    const firebaseConfig = window.__FIREBASE_CONFIG__;
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    const db = firebase.firestore();
    const auth = firebase.auth();
    const Timestamp = firebase.firestore.Timestamp;

    const $ = (id) => document.getElementById(id);
    const money = (v) => "R$ " + (Number(v) || 0).toFixed(2).replace('.', ',');
    const num = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
    const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    const hoje = new Date();
    const inicioDia = new Date(); inicioDia.setHours(0, 0, 0, 0);
    const STATUS_ATIVOS = ["AGUARDANDO_PIX", "PENDENTE_PREPARO", "PENDENTE_VALIDACAO", "EM_PREPARO", "PRONTO_PARA_ENTREGA", "SAIU_PARA_ENTREGA"];
    const STATUS_NAO_VENDA = new Set(["CANCELADO", "AGUARDANDO_PAGAMENTO", "AGUARDANDO_PIX"]);

    const estado = {
        comandasCaixa: 0,
        mesasTotal: 0,
        mesasOcupadas: 0,
        totalMesasAberto: 0,
        estoqueBaixo: [],
        caixaAberto: false,
        caixaOperador: ''
    };

    $('data-hoje').textContent = hoje.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });

    auth.onAuthStateChanged(user => {
        if (!user) { window.location.href = '/login.html'; return; }
        carregarNomeEmpresa();
        ouvirMesas();
        ouvirComandasCaixa();
        ouvirEstoque();
        ouvirCaixaAberto();
        ouvirVendasHoje();
        ouvirPedidosAtivos();
        ouvirUltimosPedidos();
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
                $('titulo-boas-vindas').textContent = `\uD83D\uDC4B Bem-vindo ao GestorChef - ${nome}`;
                document.title = `Inicio | GestorChef - ${nome}`;
            }
        } catch (e) {
            console.warn('nome da empresa:', e.message);
        }
    }

    function ouvirVendasHoje() {
        db.collection("pedidos")
            .where("hora_pedido", ">=", Timestamp.fromDate(inicioDia))
            .onSnapshot(snap => {
                let total = 0;
                let qtd = 0;
                const produtos = new Map();
                const statusHoje = {};
                snap.forEach(doc => {
                    const p = doc.data() || {};
                    if (STATUS_NAO_VENDA.has(p.status)) return;
                    total += Number(p.valor_total) || 0;
                    qtd++;
                    const status = p.status || 'SEM_STATUS';
                    statusHoje[status] = (statusHoje[status] || 0) + 1;
                    itensDoPedido(p).forEach(item => {
                        const nome = item.nome || 'Item';
                        const atual = produtos.get(nome) || { nome, qtd: 0, total: 0 };
                        atual.qtd += item.qtd;
                        atual.total += item.preco * item.qtd;
                        produtos.set(nome, atual);
                    });
                });
                estado.vendasHoje = total;
                estado.qtdVendasHoje = qtd;
                estado.statusHoje = statusHoje;
                estado.ranking = Array.from(produtos.values()).sort((a, b) => b.qtd - a.qtd || b.total - a.total).slice(0, 5);
                $('kpi-vendas').textContent = money(total);
                $('kpi-ticket').textContent = `Ticket medio ${money(qtd ? total / qtd : 0)}`;
                renderGraficoVendas();
                renderMaisVendidos();
                renderResumoOperacao();
            }, e => console.warn("Vendas hoje:", e.message));
    }

    function ouvirPedidosAtivos() {
        db.collection("pedidos")
            .where("status", "in", STATUS_ATIVOS)
            .onSnapshot(s => {
                estado.pedidosAtivos = s.size;
                $('kpi-ativos').textContent = String(s.size);
                renderPendencias();
                renderResumoOperacao();
            }, e => console.warn("Pedidos ativos:", e.message));
    }

    function ouvirMesas() {
        db.collection("mesas").onSnapshot(s => {
            let ocupadas = 0;
            let totalMesas = 0;
            let totalAberto = 0;
            s.forEach(d => {
                totalMesas++;
                const m = d.data() || {};
                const ocupada = m.status === 'OCUPADA' || m.status === 'AGUARDANDO_PAGAMENTO';
                if (ocupada) {
                    ocupadas++;
                    totalAberto += Number(m.total_atual) || 0;
                }
            });
            estado.mesasTotal = num(s.size || totalMesas);
            estado.mesasOcupadas = ocupadas;
            estado.totalMesasAberto = totalAberto;
            $('kpi-mesas').textContent = `${ocupadas}/${estado.mesasTotal}`;
            renderPendencias();
            renderResumoOperacao();
        }, e => console.warn("Mesas:", e.message));
    }

    function pct(valor, total) {
        if (!total) return 0;
        return Math.max(0, Math.min(100, Math.round((valor / total) * 100)));
    }

    // Paleta categorica validada (dataviz skill) - ordem fixa, nunca ciclada por indice.
    const PALETA_CATEGORICA = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
    // Cada status sempre usa o MESMO slot de cor, independente de quais outros status existem agora.
    const SLOT_STATUS = {
        CONCLUIDO: 0,
        EM_PREPARO: 1,
        PENDENTE_PREPARO: 2,
        PRONTO_PARA_ENTREGA: 3,
        SAIU_PARA_ENTREGA: 4,
        PENDENTE_VALIDACAO: 5,
        AGUARDANDO_PAGAMENTO: 6,
        AGUARDANDO_PIX: 7
    };
    function corStatus(status) {
        const slot = SLOT_STATUS[status];
        return PALETA_CATEGORICA[slot != null ? slot : PALETA_CATEGORICA.length - 1];
    }

    let chartStatus = null;
    function renderGraficoVendas() {
        const total = estado.qtdVendasHoje;
        $('grafico-vendas-legenda').textContent = `${total} ${total === 1 ? 'pedido' : 'pedidos'}`;
        const entries = Object.entries(estado.statusHoje || {}).sort((a, b) => (SLOT_STATUS[a[0]] ?? 99) - (SLOT_STATUS[b[0]] ?? 99));
        const ctx = $('chart-status');
        if (chartStatus) { chartStatus.destroy(); chartStatus = null; }
        if (!entries.length) {
            ctx.getContext('2d').clearRect(0, 0, ctx.width, ctx.height);
            return;
        }
        // Barra horizontal empilhada de 1 categoria só ("Hoje") - forma recomendada
        // para parte-do-todo, com legenda (>=2 series) e tooltip por segmento.
        chartStatus = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: ['Hoje'],
                datasets: entries.map(([status, qtd]) => ({
                    label: labelStatus(status),
                    data: [qtd],
                    backgroundColor: corStatus(status),
                    borderRadius: 4,
                    borderSkipped: false,
                    maxBarThickness: 40,
                }))
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: { stacked: true, grid: { color: '#e1e0d9' }, ticks: { color: '#898781', precision: 0 } },
                    y: { stacked: true, grid: { display: false }, ticks: { display: false } }
                },
                plugins: {
                    legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, padding: 12, color: '#52514e', font: { size: 11 } } },
                    tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.x}` } }
                }
            }
        });
    }

    function renderResumoOperacao() {
        const mesasOcupadas = num(estado.mesasOcupadas);
        const mesasTotal = num(estado.mesasTotal);
        const comandasCaixa = num(estado.comandasCaixa);
        const estoqueBaixo = Array.isArray(estado.estoqueBaixo) ? estado.estoqueBaixo : [];
        const ocupacao = pct(mesasOcupadas, mesasTotal);
        const caixaPct = estado.caixaAberto ? 100 : 0;
        const recebimentoPct = pct(comandasCaixa, Math.max(comandasCaixa + mesasOcupadas, 1));
        const estoquePct = pct(estoqueBaixo.length, Math.max(estoqueBaixo.length + 5, 1));
        const estoqueClasse = estoqueBaixo.length ? 'danger' : '';
        $('resumo-operacao').innerHTML = `
            <div class="meter-card">
                <div class="meter-top"><span>Ocupacao de mesas</span><strong>${mesasOcupadas}/${mesasTotal}</strong></div>
                <div class="meter-track"><div class="meter-fill ${ocupacao > 80 ? 'warn' : ''}" style="width:${ocupacao}%"></div></div>
                <div class="meter-note">Total em mesas abertas: ${money(estado.totalMesasAberto)}</div>
            </div>
            <div class="meter-card">
                <div class="meter-top"><span>Comandas no caixa</span><strong>${comandasCaixa}</strong></div>
                <div class="meter-track"><div class="meter-fill ${comandasCaixa ? 'warn' : ''}" style="width:${recebimentoPct}%"></div></div>
                <div class="meter-note">${comandasCaixa ? 'Ha contas aguardando recebimento.' : 'Nenhuma comanda pendente.'}</div>
            </div>
            <div class="meter-card">
                <div class="meter-top"><span>Status do caixa</span><strong>${estado.caixaAberto ? 'Aberto' : 'Fechado'}</strong></div>
                <div class="meter-track"><div class="meter-fill ${estado.caixaAberto ? '' : 'danger'}" style="width:${caixaPct}%"></div></div>
                <div class="meter-note">${estado.caixaAberto ? 'Vendas liberadas.' : 'Abra o caixa para vender.'}</div>
            </div>
            <div class="meter-card">
                <div class="meter-top"><span>Estoque baixo</span><strong>${estoqueBaixo.length}</strong></div>
                <div class="meter-track"><div class="meter-fill ${estoqueClasse}" style="width:${estoquePct}%"></div></div>
                <div class="meter-note">${estoqueBaixo.length ? 'Itens precisam de reposicao.' : 'Sem alertas de estoque.'}</div>
            </div>
        `;
    }

    function ouvirComandasCaixa() {
        db.collection("comandas")
            .where("status", "==", "AGUARDANDO_CAIXA")
            .onSnapshot(snap => {
                const qtd = snap.size;
                estado.comandasCaixa = qtd;
                $('kpi-comandas').textContent = `${qtd} ${qtd === 1 ? 'comanda no caixa' : 'comandas no caixa'}`;
                renderPendencias();
                renderResumoOperacao();
            }, e => console.warn("Comandas no caixa:", e.message));
    }

    function ouvirEstoque() {
        db.collection("estoque_insumos").onSnapshot(s => {
            const baixos = [];
            s.forEach(d => {
                const i = d.data() || {};
                const atual = Number(i.quantidade_atual) || 0;
                const minimo = Number(i.estoque_minimo) || 0;
                if (atual <= minimo) baixos.push({ nome: i.nome || 'insumo', atual, minimo });
            });
            estado.estoqueBaixo = baixos;
            $('kpi-estoque').textContent = String(baixos.length);
            const banner = $('banner-estoque');
            if (baixos.length) {
                banner.style.display = 'block';
                const nomes = baixos.slice(0, 4).map(i => i.nome).join(', ');
                const resto = baixos.length > 4 ? ` e mais ${baixos.length - 4}` : '';
                $('banner-estoque-txt').textContent = ` - ${baixos.length} insumo(s) precisam de reposicao: ${nomes}${resto}.`;
            } else {
                banner.style.display = 'none';
            }
            renderPendencias();
            renderResumoOperacao();
        }, e => console.warn("Estoque:", e.message));
    }

    function ouvirCaixaAberto() {
        db.collection("caixa_sessoes")
            .where("status", "==", "ABERTO")
            .limit(1)
            .onSnapshot(snap => {
                estado.caixaAberto = !snap.empty;
                estado.caixaOperador = '';
                if (!snap.empty) {
                    snap.forEach(doc => estado.caixaOperador = (doc.data() || {}).operador || '');
                }
                const card = $('kpi-caixa-card');
                card.classList.toggle('caixa-aberto', estado.caixaAberto);
                card.classList.toggle('caixa-fechado', !estado.caixaAberto);
                $('kpi-caixa').textContent = estado.caixaAberto ? 'ABERTO' : 'FECHADO';
                $('kpi-caixa-sub').textContent = estado.caixaAberto ? (estado.caixaOperador || 'Operacao liberada') : 'Abra para vender';
                renderPendencias();
                renderResumoOperacao();
            }, e => console.warn("Caixa:", e.message));
    }

    function ouvirUltimosPedidos() {
        db.collection("pedidos")
            .orderBy("hora_pedido", "desc")
            .limit(6)
            .onSnapshot(snap => {
                const pedidos = [];
                snap.forEach(doc => pedidos.push({ id: doc.id, ...doc.data() }));
                renderUltimosPedidos(pedidos);
            }, e => {
                console.warn("Ultimos pedidos:", e.message);
                $('ultimos-pedidos').innerHTML = '<div class="empty">Nao foi possivel carregar os ultimos pedidos.</div>';
            });
    }

    function renderPendencias() {
        const pendencias = [];
        if (!estado.caixaAberto) {
            pendencias.push({ tipo: 'danger', ic: '\uD83D\uDCB5', titulo: 'Caixa fechado', desc: 'Abra o caixa antes de vender ou receber comandas.', href: '/caixa.html', acao: 'Abrir caixa' });
        }
        if (estado.comandasCaixa > 0) {
            pendencias.push({ tipo: 'warn', ic: '\uD83E\uDDFE', titulo: `${estado.comandasCaixa} comanda(s) aguardando recebimento`, desc: 'Ha mesas enviadas para pagamento no caixa.', href: '/caixa.html', acao: 'Receber' });
        }
        if (estado.estoqueBaixo.length > 0) {
            pendencias.push({ tipo: 'danger', ic: '\uD83D\uDCE6', titulo: `${estado.estoqueBaixo.length} item(ns) com estoque baixo`, desc: estado.estoqueBaixo.slice(0, 3).map(i => i.nome).join(', '), href: '/estoque.html', acao: 'Ver estoque' });
        }
        if (estado.mesasOcupadas > 0) {
            pendencias.push({ tipo: 'ok', ic: '\uD83C\uDF7D', titulo: `${estado.mesasOcupadas} mesa(s) ocupada(s)`, desc: `Total aberto em mesas: ${money(estado.totalMesasAberto)}.`, href: '/mesas.html', acao: 'Ver mesas' });
        }
        if (!pendencias.length) {
            pendencias.push({ tipo: 'ok', ic: '\u2713', titulo: 'Operacao sem pendencias criticas', desc: 'Caixa, mesas e estoque sem alertas no momento.', href: '/caixa.html', acao: 'Nova venda' });
        }

        $('pendencias-total').textContent = `${pendencias.length} ${pendencias.length === 1 ? 'alerta' : 'alertas'}`;
        $('pendencias-lista').innerHTML = pendencias.map(p => `
            <div class="pending ${p.tipo}">
                <div class="pi">${p.ic}</div>
                <div><strong>${escapeHtml(p.titulo)}</strong><small>${escapeHtml(p.desc)}</small></div>
                <a href="${p.href}">${escapeHtml(p.acao)}</a>
            </div>
        `).join('');
    }

    function renderUltimosPedidos(pedidos) {
        const el = $('ultimos-pedidos');
        if (!pedidos.length) {
            el.innerHTML = '<div class="empty">Nenhum pedido registrado ainda.</div>';
            return;
        }
        el.innerHTML = pedidos.map(p => {
            const data = p.hora_pedido && p.hora_pedido.toDate ? p.hora_pedido.toDate() : null;
            const hora = data ? data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '--:--';
            const cliente = p.cliente_nome || p.nome_cliente || p.cliente || (p.mesa_numero ? `Mesa ${p.mesa_numero}` : 'Cliente nao informado');
            const itens = itensDoPedido(p).slice(0, 2).map(i => `${i.qtd}x ${i.nome}`).join(', ') || 'Sem itens listados';
            return `<div class="order-row">
                <div class="order-time">${hora}</div>
                <div>
                    <div class="order-title">${escapeHtml(cliente)}</div>
                    <div class="order-sub">${escapeHtml(itens)}</div>
                    <span class="badge">${escapeHtml(labelStatus(p.status))}</span>
                </div>
                <div class="order-total">${money(p.valor_total)}</div>
            </div>`;
        }).join('');
    }

    // Plugin leve (sem dependencia extra) que escreve o valor na ponta de cada barra.
    const valorNaPontaPlugin = {
        id: 'valorNaPonta',
        afterDatasetsDraw(chart) {
            const { ctx } = chart;
            chart.data.datasets.forEach((ds, di) => {
                const meta = chart.getDatasetMeta(di);
                meta.data.forEach((bar, i) => {
                    const valor = ds.data[i];
                    if (valor == null) return;
                    ctx.save();
                    ctx.fillStyle = '#52514e';
                    ctx.font = '600 11px system-ui, -apple-system, "Segoe UI", sans-serif';
                    ctx.textBaseline = 'middle';
                    ctx.textAlign = 'left';
                    ctx.fillText(String(valor), bar.x + 6, bar.y);
                    ctx.restore();
                });
            });
        }
    };

    let chartProdutos = null;
    function renderMaisVendidos() {
        const ctx = $('chart-produtos');
        if (chartProdutos) { chartProdutos.destroy(); chartProdutos = null; }
        if (!estado.ranking.length) {
            ctx.getContext('2d').clearRect(0, 0, ctx.width, ctx.height);
            return;
        }
        // Ranking de magnitude, 1 serie so -> hue sequencial (azul), sem legenda
        // (uma serie so nao precisa de caixa de legenda), valor direto na ponta.
        chartProdutos = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: estado.ranking.map(item => item.nome),
                datasets: [{
                    data: estado.ranking.map(item => item.qtd),
                    backgroundColor: '#2a78d6',
                    borderRadius: 4,
                    borderSkipped: false,
                    maxBarThickness: 22,
                }]
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                layout: { padding: { right: 28 } },
                scales: {
                    x: { display: false, grid: { display: false } },
                    y: { grid: { display: false }, ticks: { color: '#0b0b0b', font: { size: 11, weight: '600' } } }
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (c) => {
                                const item = estado.ranking[c.dataIndex];
                                return `${item.qtd} un. - ${money(item.total)}`;
                            }
                        }
                    }
                }
            },
            plugins: [valorNaPontaPlugin]
        });
    }

    function itensDoPedido(p) {
        if (Array.isArray(p.itens)) {
            return p.itens.map(i => ({
                nome: i.nome_exibicao || i.nome || i.item || 'Item',
                qtd: Number(i.quantidade || i.qtd || 1) || 1,
                preco: Number(i.preco || i.valor || 0) || 0
            }));
        }
        const texto = p.item_pedido || p.itens_pedido || '';
        if (!texto) return [];
        return String(texto).split(',').map(nome => ({ nome: nome.trim(), qtd: 1, preco: 0 })).filter(i => i.nome);
    }

    function labelStatus(status) {
        const map = {
            AGUARDANDO_PIX: 'Aguardando PIX',
            PENDENTE_PREPARO: 'Pendente preparo',
            PENDENTE_VALIDACAO: 'Pendente validacao',
            EM_PREPARO: 'Em preparo',
            PRONTO_PARA_ENTREGA: 'Pronto',
            SAIU_PARA_ENTREGA: 'Saiu para entrega',
            AGUARDANDO_PAGAMENTO: 'Aguardando pagamento',
            CONCLUIDO: 'Concluido',
            CANCELADO: 'Cancelado'
        };
        return map[status] || status || '-';
    }
});
