// ============================================================
//  FINANCEIRO — DRE / fluxo de caixa por período
//  Fontes:
//    pedidos                (receita de vendas; status != CANCELADO)
//    financeiro_lancamentos { tipo: RECEITA|DESPESA, categoria,
//                             descricao, valor, data(Timestamp),
//                             pago(bool), criado_em }
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
    const firebaseConfig = window.__FIREBASE_CONFIG__;
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    const db = firebase.firestore();
    const auth = firebase.auth();
    const FieldValue = firebase.firestore.FieldValue;
    const Timestamp = firebase.firestore.Timestamp;

    const COL_PEDIDOS = "pedidos";
    const COL_LANC = "financeiro_lancamentos";

    const $ = (id) => document.getElementById(id);
    const money = (v) => "R$ " + (Number(v) || 0).toFixed(2).replace('.', ',');
    const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    let chartRD = null, chartCat = null;
    let lancamentosPeriodo = [];   // cache para CSV/remover
    let receitaVendas = 0;

    // ---------- Datas padrão: mês atual ----------
    function ymd(d) { return d.toISOString().slice(0, 10); }
    (function initDatas() {
        const hoje = new Date();
        const ini = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
        $('data-ini').value = ymd(ini);
        $('data-fim').value = ymd(hoje);
        $('l-data').value = ymd(hoje);
    })();

    function intervalo() {
        const ini = new Date($('data-ini').value + "T00:00:00");
        const fim = new Date($('data-fim').value + "T23:59:59");
        return { ini, fim };
    }

    // ---------- Auth ----------
    auth.onAuthStateChanged(user => {
        if (!user) { window.location.href = '/login.html'; return; }
        $('btn-aplicar').addEventListener('click', carregar);
        $('btn-csv').addEventListener('click', exportarCSV);
        $('form-lanc').addEventListener('submit', adicionarLancamento);
        carregar();
    });

    // ---------- Carregamento principal ----------
    async function carregar() {
        const { ini, fim } = intervalo();
        if (ini > fim) { alert("Período inválido."); return; }
        try {
            const [vendas, lancs] = await Promise.all([
                buscarReceitaVendas(ini, fim),
                buscarLancamentos(ini, fim)
            ]);
            receitaVendas = vendas;
            lancamentosPeriodo = lancs;
            renderTudo(vendas, lancs);
        } catch (err) {
            console.error(err);
            alert("Erro ao carregar dados: " + err.message);
        }
    }

    async function buscarReceitaVendas(ini, fim) {
        // Apenas range em hora_pedido (uma inequality); status filtrado no cliente.
        const snap = await db.collection(COL_PEDIDOS)
            .where("hora_pedido", ">=", Timestamp.fromDate(ini))
            .where("hora_pedido", "<=", Timestamp.fromDate(fim))
            .get();
        let total = 0;
        snap.forEach(doc => {
            const p = doc.data();
            if (p.status === "CANCELADO") return;
            total += Number(p.valor_total) || 0;
        });
        return total;
    }

    async function buscarLancamentos(ini, fim) {
        const snap = await db.collection(COL_LANC)
            .where("data", ">=", Timestamp.fromDate(ini))
            .where("data", "<=", Timestamp.fromDate(fim))
            .get();
        const arr = [];
        snap.forEach(doc => arr.push({ id: doc.id, ...doc.data() }));
        arr.sort((a, b) => (b.data?.toDate?.() || 0) - (a.data?.toDate?.() || 0));
        return arr;
    }

    // ---------- Render ----------
    function renderTudo(receitaVendas, lancs) {
        const outrasReceitas = lancs.filter(l => l.tipo === 'RECEITA').reduce((s, l) => s + (Number(l.valor) || 0), 0);
        const despesas = lancs.filter(l => l.tipo === 'DESPESA');
        const despesaTotal = despesas.reduce((s, l) => s + (Number(l.valor) || 0), 0);
        const receitaTotal = receitaVendas + outrasReceitas;
        const resultado = receitaTotal - despesaTotal;
        const margem = receitaTotal > 0 ? (resultado / receitaTotal) * 100 : 0;

        // KPIs
        $('kpi-receita').textContent = money(receitaTotal);
        $('kpi-despesa').textContent = money(despesaTotal);
        $('kpi-resultado').textContent = money(resultado);
        $('kpi-margem').textContent = margem.toFixed(1).replace('.', ',') + '%';
        const boxRes = $('kpi-box-resultado');
        boxRes.classList.toggle('pos', resultado >= 0);
        boxRes.classList.toggle('neg', resultado < 0);

        // Despesas por categoria
        const porCat = {};
        despesas.forEach(l => {
            const c = l.categoria || 'Outros';
            porCat[c] = (porCat[c] || 0) + (Number(l.valor) || 0);
        });

        // DRE
        const linhasCat = Object.entries(porCat).sort((a, b) => b[1] - a[1])
            .map(([c, v]) => `<div class="linha sub"><span>${escapeHtml(c)}</span><span class="neg">- ${money(v)}</span></div>`).join('');
        $('dre').innerHTML = `
            <div class="linha"><span>(+) Receita de vendas</span><span class="pos">${money(receitaVendas)}</span></div>
            <div class="linha"><span>(+) Outras receitas</span><span class="pos">${money(outrasReceitas)}</span></div>
            <div class="linha"><span><strong>(=) Receita bruta</strong></span><span class="pos"><strong>${money(receitaTotal)}</strong></span></div>
            <div class="linha"><span>(-) Despesas</span><span class="neg">- ${money(despesaTotal)}</span></div>
            ${linhasCat}
            <div class="linha total"><span>(=) Resultado</span><span class="${resultado >= 0 ? 'pos' : 'neg'}">${money(resultado)}</span></div>
        `;

        renderGraficos(receitaTotal, despesaTotal, porCat);
        renderTabela(lancs);
    }

    function renderGraficos(receita, despesa, porCat) {
        if (chartRD) chartRD.destroy();
        chartRD = new Chart($('chart-rd'), {
            type: 'bar',
            data: {
                labels: ['Receitas', 'Despesas'],
                datasets: [{ data: [receita, despesa], backgroundColor: ['#2ecc71', '#e74c3c'] }]
            },
            options: { plugins: { legend: { display: false } }, responsive: true }
        });

        const cats = Object.keys(porCat);
        const vals = Object.values(porCat);
        if (chartCat) chartCat.destroy();
        chartCat = new Chart($('chart-cat'), {
            type: 'doughnut',
            data: {
                labels: cats.length ? cats : ['Sem despesas'],
                datasets: [{
                    data: vals.length ? vals : [1],
                    backgroundColor: ['#ff5200', '#2f6fed', '#f1c40f', '#9b59b6', '#1abc9c', '#e67e22', '#34495e', '#e84393', '#00b894', '#636e72']
                }]
            },
            options: { responsive: true, plugins: { legend: { position: 'right' } } }
        });
    }

    function renderTabela(lancs) {
        const tb = $('tbody-lanc');
        if (!lancs.length) { tb.innerHTML = '<tr><td colspan="7" style="color:#7f8c8d">Nenhum lançamento no período.</td></tr>'; return; }
        tb.innerHTML = lancs.map(l => {
            const d = l.data?.toDate ? l.data.toDate().toLocaleDateString('pt-BR') : '--';
            const tag = l.tipo === 'RECEITA' ? '<span class="tag rec">Receita</span>' : '<span class="tag desp">Despesa</span>';
            const status = l.pago ? 'Pago' : '<span style="color:#e67e22">Em aberto</span>';
            const sinal = l.tipo === 'RECEITA' ? '' : '- ';
            return `<tr>
                <td>${d}</td><td>${tag}</td><td>${escapeHtml(l.categoria)}</td>
                <td>${escapeHtml(l.descricao)}</td><td>${status}</td>
                <td style="text-align:right" class="${l.tipo === 'RECEITA' ? 'pos' : 'neg'}">${sinal}${money(l.valor)}</td>
                <td><button class="rm" data-id="${l.id}">excluir</button></td>
            </tr>`;
        }).join('');
        tb.querySelectorAll('.rm').forEach(b => b.onclick = () => removerLancamento(b.dataset.id));
    }

    // ---------- Lançamentos ----------
    async function adicionarLancamento(e) {
        e.preventDefault();
        const valor = parseFloat($('l-valor').value);
        if (isNaN(valor) || valor <= 0) { alert("Valor inválido."); return; }
        const dataStr = $('l-data').value;
        if (!dataStr) { alert("Informe a data."); return; }

        const lanc = {
            tipo: $('l-tipo').value,
            categoria: ($('l-categoria').value || 'Outros').trim(),
            descricao: $('l-descricao').value.trim(),
            valor: valor,
            data: Timestamp.fromDate(new Date(dataStr + "T12:00:00")),
            pago: $('l-pago').value === 'true',
            criado_em: FieldValue.serverTimestamp()
        };
        try {
            await db.collection(COL_LANC).add(lanc);
            $('form-lanc').reset();
            $('l-data').value = ymd(new Date());
            carregar();
        } catch (err) { alert("Erro ao salvar lançamento: " + err.message); }
    }

    async function removerLancamento(id) {
        if (!confirm("Excluir este lançamento?")) return;
        try { await db.collection(COL_LANC).doc(id).delete(); carregar(); }
        catch (err) { alert("Erro ao excluir: " + err.message); }
    }

    // ---------- CSV ----------
    function exportarCSV() {
        const linhas = [["Data", "Tipo", "Categoria", "Descricao", "Status", "Valor"]];
        lancamentosPeriodo.forEach(l => {
            const d = l.data?.toDate ? l.data.toDate().toLocaleDateString('pt-BR') : '';
            linhas.push([d, l.tipo, l.categoria || '', (l.descricao || '').replace(/;/g, ','), l.pago ? 'Pago' : 'Em aberto', (Number(l.valor) || 0).toFixed(2)]);
        });
        linhas.push([]);
        linhas.push(["Receita de vendas (pedidos)", "", "", "", "", receitaVendas.toFixed(2)]);
        const csv = linhas.map(l => l.join(";")).join("\n");
        const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `financeiro_${$('data-ini').value}_a_${$('data-fim').value}.csv`;
        a.click();
    }
});
