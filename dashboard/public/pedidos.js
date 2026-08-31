// ============================================================
//  TODOS OS PEDIDOS — relação completa (link "Ver tudo" do início)
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    const firebaseConfig = window.__FIREBASE_CONFIG__;
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    const db = firebase.firestore();
    const auth = firebase.auth();

    const $ = (id) => document.getElementById(id);
    const money = (v) => "R$ " + (Number(v) || 0).toFixed(2).replace('.', ',');
    const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    const PAGE_SIZE = 300;
    let pedidos = [];
    let ultimoDoc = null;
    let acabou = false;

    auth.onAuthStateChanged(user => {
        if (!user) { window.location.href = '/login.html'; return; }
        $('f-data').addEventListener('change', render);
        $('f-status').addEventListener('change', render);
        $('f-pagamento').addEventListener('change', render);
        $('btn-carregar-mais').addEventListener('click', carregar);
        carregar();
    });

    async function carregar() {
        if (acabou) return;
        let query = db.collection('pedidos').orderBy('hora_pedido', 'desc').limit(PAGE_SIZE);
        if (ultimoDoc) query = query.startAfter(ultimoDoc);
        try {
            const snap = await query.get();
            if (snap.docs.length) ultimoDoc = snap.docs[snap.docs.length - 1];
            if (snap.docs.length < PAGE_SIZE) acabou = true;
            snap.forEach(doc => pedidos.push({ id: doc.id, ...doc.data() }));
            atualizarFiltros();
            render();
            $('btn-carregar-mais').style.display = acabou ? 'none' : 'inline-block';
        } catch (err) {
            console.warn('pedidos:', err.message);
            $('vazio').style.display = 'block';
            $('vazio').textContent = 'Não foi possível carregar os pedidos: ' + err.message;
        }
    }

    function atualizarFiltros() {
        const statusSet = new Set();
        const pagSet = new Set();
        pedidos.forEach(p => {
            if (p.status) statusSet.add(p.status);
            if (p.forma_pagamento) pagSet.add(p.forma_pagamento);
        });
        preencherSelect($('f-status'), statusSet, labelStatus);
        preencherSelect($('f-pagamento'), pagSet, s => s);
    }

    function preencherSelect(select, valores, label) {
        const atual = select.value;
        const primeira = select.options[0];
        select.innerHTML = '';
        select.appendChild(primeira);
        Array.from(valores).sort().forEach(v => {
            const opt = document.createElement('option');
            opt.value = v;
            opt.textContent = label(v);
            select.appendChild(opt);
        });
        select.value = atual;
    }

    function itensDoPedido(p) {
        if (Array.isArray(p.itens)) {
            return p.itens.map(i => ({
                nome: i.nome_exibicao || i.nome || i.item || 'Item',
                qtd: Number(i.quantidade || i.qtd || 1) || 1
            }));
        }
        const texto = p.item_pedido || p.itens_pedido || '';
        if (!texto) return [];
        return String(texto).split(',').map(nome => ({ nome: nome.trim(), qtd: 1 })).filter(i => i.nome);
    }

    function labelStatus(status) {
        const map = {
            AGUARDANDO_PIX: 'Aguardando PIX',
            AGUARDANDO_CARTAO: 'Aguardando cartão',
            PENDENTE_PREPARO: 'Pendente preparo',
            PENDENTE_VALIDACAO: 'Pendente validação',
            EM_PREPARO: 'Em preparo',
            PRONTO_PARA_ENTREGA: 'Pronto',
            SAIU_PARA_ENTREGA: 'Saiu para entrega',
            AGUARDANDO_PAGAMENTO: 'Aguardando pagamento',
            CONCLUIDO: 'Concluído',
            CANCELADO: 'Cancelado',
            CANCELADO_PAGAMENTO: 'Pagamento não aprovado'
        };
        return map[status] || status || '-';
    }

    function classeStatus(status) {
        if (status === 'CONCLUIDO') return 'b-ok';
        if (status === 'CANCELADO' || status === 'CANCELADO_PAGAMENTO') return 'b-can';
        return 'b-pend';
    }

    function render() {
        const dataFiltro = $('f-data').value;
        const statusFiltro = $('f-status').value;
        const pagFiltro = $('f-pagamento').value;

        const filtrados = pedidos.filter(p => {
            if (statusFiltro && p.status !== statusFiltro) return false;
            if (pagFiltro && p.forma_pagamento !== pagFiltro) return false;
            if (dataFiltro) {
                const data = p.hora_pedido && p.hora_pedido.toDate ? p.hora_pedido.toDate() : null;
                if (!data) return false;
                const dataLocal = new Date(data.getFullYear(), data.getMonth(), data.getDate());
                const [ano, mes, dia] = dataFiltro.split('-').map(Number);
                if (dataLocal.getFullYear() !== ano || dataLocal.getMonth() !== mes - 1 || dataLocal.getDate() !== dia) return false;
            }
            return true;
        });

        const tbody = $('tbody-pedidos');
        if (!filtrados.length) {
            tbody.innerHTML = '';
            $('vazio').style.display = 'block';
            $('vazio').textContent = 'Nenhum pedido encontrado.';
            return;
        }
        $('vazio').style.display = 'none';

        tbody.innerHTML = filtrados.map(p => {
            const data = p.hora_pedido && p.hora_pedido.toDate ? p.hora_pedido.toDate() : null;
            const dataHora = data ? data.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-';
            const cliente = p.cliente_nome || p.nome_cliente || p.cliente || (p.mesa_numero ? `Mesa ${p.mesa_numero}` : 'Cliente não informado');
            const itens = itensDoPedido(p);
            const itensTexto = itens.map(i => `${i.qtd}x ${i.nome}`).join(', ') || 'Sem itens listados';
            const pagamento = p.forma_pagamento || '-';
            return `<tr>
                <td>${dataHora}</td>
                <td>${escapeHtml(cliente)}</td>
                <td>${escapeHtml(itensTexto)}<div class="sub">#${escapeHtml(p.id.slice(0, 6))}</div></td>
                <td>${escapeHtml(pagamento)}</td>
                <td><span class="badge ${classeStatus(p.status)}">${escapeHtml(labelStatus(p.status))}</span></td>
                <td class="num">${money(p.valor_total)}</td>
            </tr>`;
        }).join('');
    }
});
