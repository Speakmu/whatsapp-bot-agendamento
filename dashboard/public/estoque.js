// ============================================================
//  ESTOQUE — insumos + movimentações
//  Coleções:
//    estoque_insumos   { nome, categoria, unidade, quantidade_atual,
//                        estoque_minimo, custo_unitario, atualizado_em }
//    estoque_movimentos{ insumo_id, insumo_nome, tipo: ENTRADA|SAIDA|AJUSTE,
//                        quantidade, saldo_resultante, motivo, operador, data }
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
    const firebaseConfig = window.__FIREBASE_CONFIG__;
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    const db = firebase.firestore();
    const auth = firebase.auth();
    const FieldValue = firebase.firestore.FieldValue;

    const COL_INSUMOS = "estoque_insumos";
    const COL_MOVS = "estoque_movimentos";

    const $ = (id) => document.getElementById(id);
    const money = (v) => "R$ " + (Number(v) || 0).toFixed(2).replace('.', ',');
    const numFmt = (v) => (Number(v) || 0).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
    const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    let insumos = [];
    let usuarioEmail = null;
    let consumo30 = {}; // insumo_id -> quantidade consumida (SAIDA) nos últimos 30 dias

    auth.onAuthStateChanged(user => {
        if (!user) { window.location.href = '/login.html'; return; }
        usuarioEmail = user.email || 'operador';
        configurar();
        ouvirInsumos();
        carregarConsumo30();
    });

    async function carregarConsumo30() {
        try {
            const d30 = new Date(); d30.setDate(d30.getDate() - 30);
            const snap = await db.collection(COL_MOVS).where('tipo', '==', 'SAIDA').get();
            const acc = {};
            snap.forEach(doc => {
                const m = doc.data();
                const dt = m.data && m.data.toDate ? m.data.toDate() : null;
                if (dt && dt < d30) return;
                acc[m.insumo_id] = (acc[m.insumo_id] || 0) + (Number(m.quantidade) || 0);
            });
            consumo30 = acc;
            render();
        } catch (e) { console.warn('Consumo 30d indisponível:', e.message); }
    }

    function ouvirInsumos() {
        db.collection(COL_INSUMOS).orderBy("nome").onSnapshot(snap => {
            insumos = [];
            snap.forEach(doc => insumos.push({ id: doc.id, ...doc.data() }));
            render();
        }, err => alert("Erro ao carregar estoque: " + err.message));
    }

    function statusDe(i) {
        const atual = Number(i.quantidade_atual) || 0;
        const min = Number(i.estoque_minimo) || 0;
        if (atual <= 0) return { cls: 'b-zero', txt: 'Zerado' };
        if (atual <= min) return { cls: 'b-baixo', txt: 'Baixo' };
        return { cls: 'b-ok', txt: 'OK' };
    }

    function render() {
        const termo = $('busca').value.trim().toLowerCase();
        const lista = insumos.filter(i => !termo || (i.nome || '').toLowerCase().includes(termo));

        // KPIs
        const abaixo = insumos.filter(i => (Number(i.quantidade_atual) || 0) <= (Number(i.estoque_minimo) || 0));
        const valorTotal = insumos.reduce((s, i) => s + (Number(i.quantidade_atual) || 0) * (Number(i.custo_unitario) || 0), 0);
        $('kpi-itens').textContent = insumos.length;
        $('kpi-baixo').textContent = abaixo.length;
        $('kpi-valor').textContent = money(valorTotal);

        // Alertas
        const boxAl = $('box-alertas');
        if (abaixo.length) {
            boxAl.style.display = 'block';
            $('lista-alertas').innerHTML = abaixo.map(i =>
                `<li><strong>${escapeHtml(i.nome)}</strong>: ${numFmt(i.quantidade_atual)} ${escapeHtml(i.unidade || '')} (mín. ${numFmt(i.estoque_minimo)})</li>`
            ).join('');
        } else { boxAl.style.display = 'none'; }

        // Compras sugeridas
        renderCompras(abaixo);

        // Tabela
        const tb = $('tbody');
        if (!lista.length) { tb.innerHTML = '<tr><td colspan="8" style="color:#7f8c8d">Nenhum insumo.</td></tr>'; return; }
        tb.innerHTML = lista.map(i => {
            const st = statusDe(i);
            const valor = (Number(i.quantidade_atual) || 0) * (Number(i.custo_unitario) || 0);
            return `<tr>
                <td><strong>${escapeHtml(i.nome)}</strong></td>
                <td>${escapeHtml(i.categoria || '-')}</td>
                <td class="num">${numFmt(i.quantidade_atual)} ${escapeHtml(i.unidade || '')}</td>
                <td class="num">${numFmt(i.estoque_minimo)}</td>
                <td class="num">${money(i.custo_unitario)}</td>
                <td class="num">${money(valor)}</td>
                <td><span class="badge ${st.cls}">${st.txt}</span></td>
                <td style="text-align:right" class="acoes-linha">
                    <button class="btn btn-azul" data-mov="${i.id}">Movimentar</button>
                    <button class="btn btn-cinza" data-edit="${i.id}">Editar</button>
                    <button class="btn btn-vermelho" data-del="${i.id}">×</button>
                </td>
            </tr>`;
        }).join('');
        tb.querySelectorAll('[data-mov]').forEach(b => b.onclick = () => abrirMov(b.dataset.mov));
        tb.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => abrirInsumo(b.dataset.edit));
        tb.querySelectorAll('[data-del]').forEach(b => b.onclick = () => removerInsumo(b.dataset.del));
    }

    function renderCompras(abaixo) {
        const box = $('box-compras');
        if (!abaixo || !abaixo.length) { box.style.display = 'none'; return; }
        box.style.display = 'block';
        let total = 0;
        $('tbody-compras').innerHTML = abaixo.map(i => {
            const atual = Number(i.quantidade_atual) || 0;
            const min = Number(i.estoque_minimo) || 0;
            const alvo = min > 0 ? min * 2 : Math.max(atual, 1); // recompor até 2× o mínimo
            const comprar = Math.max(alvo - atual, 0);
            const custo = comprar * (Number(i.custo_unitario) || 0);
            total += custo;
            const cons = consumo30[i.id] || 0;
            const un = escapeHtml(i.unidade || '');
            return `<tr>
                <td><strong>${escapeHtml(i.nome)}</strong></td>
                <td class="num">${numFmt(atual)} ${un}</td>
                <td class="num">${numFmt(min)} ${un}</td>
                <td class="num">${cons > 0 ? numFmt(cons) + ' ' + un : '—'}</td>
                <td class="num"><strong>${numFmt(comprar)} ${un}</strong></td>
                <td class="num">${money(custo)}</td>
            </tr>`;
        }).join('');
        $('compras-total').textContent = money(total);
    }

    function configurar() {
        $('busca').addEventListener('input', render);
        $('btn-novo').addEventListener('click', () => abrirInsumo());
        $('i-cancelar').addEventListener('click', () => fechar('modal-insumo'));
        $('i-salvar').addEventListener('click', salvarInsumo);
        $('m-cancelar').addEventListener('click', () => fechar('modal-mov'));
        $('m-salvar').addEventListener('click', salvarMov);
    }

    function fechar(id) { $(id).classList.remove('show'); }

    // ---------- CRUD insumo ----------
    function abrirInsumo(id) {
        const i = id ? insumos.find(x => x.id === id) : null;
        $('modal-titulo').textContent = i ? 'Editar insumo' : 'Novo insumo';
        $('i-id').value = i ? i.id : '';
        $('i-nome').value = i ? (i.nome || '') : '';
        $('i-categoria').value = i ? (i.categoria || '') : '';
        $('i-unidade').value = i ? (i.unidade || 'un') : 'un';
        $('i-qtd').value = i ? (i.quantidade_atual || 0) : 0;
        $('i-min').value = i ? (i.estoque_minimo || 0) : 0;
        $('i-custo').value = i ? (i.custo_unitario || 0) : 0;
        // ao editar, quantidade fica somente leitura (alterar via movimentação)
        $('i-qtd').readOnly = !!i;
        $('i-qtd').style.background = i ? '#f1f3f5' : '#fff';
        $('modal-insumo').classList.add('show');
    }

    async function salvarInsumo() {
        const nome = $('i-nome').value.trim();
        if (!nome) { alert('Informe o nome.'); return; }
        const dados = {
            nome,
            categoria: $('i-categoria').value.trim() || 'Outros',
            unidade: $('i-unidade').value,
            estoque_minimo: parseFloat($('i-min').value) || 0,
            custo_unitario: parseFloat($('i-custo').value) || 0,
            atualizado_em: FieldValue.serverTimestamp()
        };
        try {
            const id = $('i-id').value;
            if (id) {
                await db.collection(COL_INSUMOS).doc(id).update(dados);
            } else {
                dados.quantidade_atual = parseFloat($('i-qtd').value) || 0;
                const ref = await db.collection(COL_INSUMOS).add(dados);
                if (dados.quantidade_atual > 0) {
                    await db.collection(COL_MOVS).add({
                        insumo_id: ref.id, insumo_nome: nome, tipo: 'ENTRADA',
                        quantidade: dados.quantidade_atual, saldo_resultante: dados.quantidade_atual,
                        motivo: 'Estoque inicial', operador: usuarioEmail, data: FieldValue.serverTimestamp()
                    });
                }
            }
            fechar('modal-insumo');
        } catch (err) { alert('Erro ao salvar: ' + err.message); }
    }

    async function removerInsumo(id) {
        const i = insumos.find(x => x.id === id);
        if (!confirm(`Excluir "${i ? i.nome : ''}"? Isso não apaga o histórico de movimentações.`)) return;
        try { await db.collection(COL_INSUMOS).doc(id).delete(); }
        catch (err) { alert('Erro ao excluir: ' + err.message); }
    }

    // ---------- Movimentação ----------
    function abrirMov(id) {
        const i = insumos.find(x => x.id === id);
        if (!i) return;
        $('m-insumo-id').value = id;
        $('m-insumo-nome').textContent = `${i.nome} — atual: ${numFmt(i.quantidade_atual)} ${i.unidade || ''}`;
        $('m-tipo').value = 'ENTRADA';
        $('m-qtd').value = '';
        $('m-motivo').value = '';
        $('modal-mov').classList.add('show');
    }

    async function salvarMov() {
        const id = $('m-insumo-id').value;
        const i = insumos.find(x => x.id === id);
        if (!i) return;
        const tipo = $('m-tipo').value;
        const qtd = parseFloat($('m-qtd').value);
        if (isNaN(qtd) || qtd < 0) { alert('Quantidade inválida.'); return; }

        const atual = Number(i.quantidade_atual) || 0;
        let novoSaldo, deltaRegistro;
        if (tipo === 'ENTRADA') { novoSaldo = atual + qtd; deltaRegistro = qtd; }
        else if (tipo === 'SAIDA') {
            if (qtd > atual && !confirm('A saída deixa o estoque negativo. Continuar?')) return;
            novoSaldo = atual - qtd; deltaRegistro = qtd;
        } else { // AJUSTE -> define o total
            novoSaldo = qtd; deltaRegistro = qtd - atual;
        }

        try {
            const batch = db.batch();
            batch.update(db.collection(COL_INSUMOS).doc(id), {
                quantidade_atual: novoSaldo,
                atualizado_em: FieldValue.serverTimestamp()
            });
            batch.set(db.collection(COL_MOVS).doc(), {
                insumo_id: id, insumo_nome: i.nome, tipo,
                quantidade: deltaRegistro, saldo_resultante: novoSaldo,
                motivo: $('m-motivo').value.trim() || tipo, operador: usuarioEmail,
                data: FieldValue.serverTimestamp()
            });
            await batch.commit();
            fechar('modal-mov');
        } catch (err) { alert('Erro ao registrar movimentação: ' + err.message); }
    }
});
