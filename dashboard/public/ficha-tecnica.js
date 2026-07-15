// ============================================================
//  FICHA TÉCNICA & CUSTOS (Fase 1)
//  Vincula insumos (estoque_insumos) aos produtos (cardapio) e
//  calcula custo do prato, margem e food cost (CMV%).
//  Coleção: fichas_tecnicas/{cardapioId} { produto_nome, itens:[
//     { insumo_id, nome, unidade, quantidade } ], atualizado_em }
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    const firebaseConfig = window.__FIREBASE_CONFIG__;
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    const db = firebase.firestore();
    const auth = firebase.auth();
    const FieldValue = firebase.firestore.FieldValue;

    const $ = (id) => document.getElementById(id);
    const money = (v) => "R$ " + (Number(v) || 0).toFixed(2).replace('.', ',');
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    let cardapio = [];      // {id, nome, preco}
    let insumos = [];       // {id, nome, unidade, custo_unitario}
    let fichas = {};        // cardapioId -> {itens:[...]}
    let fichasPorNome = {}; // nome normalizado -> ficha
    let selId = null;

    const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

    auth.onAuthStateChanged(user => {
        if (!user) { window.location.href = '/login.html'; return; }
        Promise.all([ouvirCardapio(), ouvirInsumos(), ouvirFichas()]);
        $('btn-add').addEventListener('click', addInsumoFicha);
        $('sel-insumo').addEventListener('change', atualizarUnidades);
        $('markup').addEventListener('input', renderEditor);
        // Período padrão: mês atual
        const hoje = new Date();
        $('p-ini').value = new Date(hoje.getFullYear(), hoje.getMonth(), 1).toISOString().slice(0, 10);
        $('p-fim').value = hoje.toISOString().slice(0, 10);
        $('btn-analisar').addEventListener('click', analisarPeriodo);
        $('custo-fixo').addEventListener('input', recalcularEquilibrio);
    });

    function ouvirCardapio() {
        return new Promise(res => db.collection('cardapio').orderBy('categoria').onSnapshot(s => {
            cardapio = []; s.forEach(d => cardapio.push({ id: d.id, ...d.data() }));
            renderProdList(); renderGeral(); if (selId) renderEditor(); res();
        }, e => { console.warn(e); res(); }));
    }
    function ouvirInsumos() {
        return new Promise(res => db.collection('estoque_insumos').orderBy('nome').onSnapshot(s => {
            insumos = []; s.forEach(d => insumos.push({ id: d.id, ...d.data() }));
            renderSelInsumos(); renderGeral(); if (selId) renderEditor(); res();
        }, e => { console.warn(e); res(); }));
    }
    function ouvirFichas() {
        return new Promise(res => db.collection('fichas_tecnicas').onSnapshot(s => {
            fichas = {}; fichasPorNome = {};
            s.forEach(d => { const f = d.data(); fichas[d.id] = f; if (f.produto_nome) fichasPorNome[norm(f.produto_nome)] = f; });
            renderProdList(); renderGeral(); if (selId) renderEditor(); res();
        }, e => { console.warn(e); res(); }));
    }

    const nomeProd = (p) => p.nome_exibicao || p.nome || 'Item';
    const custoInsumo = (id) => { const i = insumos.find(x => x.id === id); return i ? (Number(i.custo_unitario) || 0) : 0; };

    function custoDaFicha(cardapioId) {
        const f = fichas[cardapioId];
        if (!f || !Array.isArray(f.itens)) return null; // sem ficha
        return f.itens.reduce((s, it) => s + (Number(it.quantidade) || 0) * custoInsumo(it.insumo_id), 0);
    }
    function foodCost(preco, custo) { return preco > 0 ? (custo / preco) * 100 : 0; }
    function classeCMV(pct, temFicha) {
        if (!temFicha) return { c: 'c-none', t: '—' };
        if (pct <= 35) return { c: 'c-ok', t: 'Saudável' };
        if (pct <= 45) return { c: 'c-warn', t: 'Atenção' };
        return { c: 'c-bad', t: 'Alto' };
    }

    // ---------- Lista de produtos ----------
    function renderProdList() {
        const el = $('prod-list');
        if (!cardapio.length) { el.innerHTML = '<div class="vazio">Cadastre itens no Cardápio primeiro.</div>'; return; }
        el.innerHTML = cardapio.map(p => {
            const custo = custoDaFicha(p.id);
            const temFicha = custo !== null;
            const pct = temFicha ? foodCost(Number(p.preco) || 0, custo) : 0;
            const cl = classeCMV(pct, temFicha);
            const badge = temFicha ? `${pct.toFixed(0)}%` : 'sem ficha';
            return `<div class="prod-item ${p.id === selId ? 'sel' : ''}" data-id="${p.id}">
                <span>${esc(nomeProd(p))}</span>
                <span class="cmv ${cl.c}">${badge}</span></div>`;
        }).join('');
        el.querySelectorAll('.prod-item').forEach(d => d.onclick = () => { selId = d.dataset.id; renderProdList(); renderEditor(); });
    }

    function renderSelInsumos() {
        $('sel-insumo').innerHTML = insumos.length
            ? insumos.map(i => `<option value="${i.id}">${esc(i.nome)} (por ${esc(i.unidade || 'un')} · ${money(i.custo_unitario)})</option>`).join('')
            : '<option value="">Cadastre insumos no Estoque</option>';
        atualizarUnidades();
    }

    // Unidades de entrada disponíveis conforme a unidade base do insumo
    // e fator de conversão para a unidade base (kg, L, un).
    function opcoesUnidade(base) {
        const b = String(base || 'un').toLowerCase();
        if (b === 'kg') return [{ u: 'g', f: 0.001, sel: true }, { u: 'kg', f: 1 }];
        if (b === 'l' || b === 'litro') return [{ u: 'ml', f: 0.001, sel: true }, { u: 'L', f: 1 }];
        return [{ u: b || 'un', f: 1, sel: true }];
    }
    function atualizarUnidades() {
        const i = insumos.find(x => x.id === $('sel-insumo').value);
        const ops = opcoesUnidade(i ? i.unidade : 'un');
        $('sel-unidade').innerHTML = ops.map(o =>
            `<option value="${o.u}" data-f="${o.f}" ${o.sel ? 'selected' : ''}>${o.u}</option>`).join('');
    }

    // ---------- Editor ----------
    function renderEditor() {
        const p = cardapio.find(x => x.id === selId);
        if (!p) { $('editor').style.display = 'none'; return; }
        $('editor').style.display = 'block';
        $('prod-titulo').textContent = 'Ficha técnica — ' + nomeProd(p);
        const f = fichas[selId] || { itens: [] };
        const itens = f.itens || [];
        const tb = $('ficha-itens');
        if (!itens.length) tb.innerHTML = '<tr><td colspan="5" class="vazio">Nenhum insumo. Adicione acima.</td></tr>';
        else tb.innerHTML = itens.map((it, idx) => {
            const cu = custoInsumo(it.insumo_id);
            const custo = (Number(it.quantidade) || 0) * cu;
            const qtdTxt = (it.entrada_qtd != null && it.entrada_unidade)
                ? `${Number(it.entrada_qtd).toLocaleString('pt-BR', { maximumFractionDigits: 3 })} ${esc(it.entrada_unidade)}`
                : `${(Number(it.quantidade) || 0).toLocaleString('pt-BR', { maximumFractionDigits: 3 })} ${esc(it.unidade || '')}`;
            return `<tr>
                <td>${esc(it.nome)}</td>
                <td class="num">${qtdTxt}</td>
                <td class="num">${money(cu)}</td>
                <td class="num">${money(custo)}</td>
                <td class="num"><button class="btn btn-rm" data-rm="${idx}">×</button></td>
            </tr>`;
        }).join('');
        tb.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => removerItem(+b.dataset.rm));

        const preco = Number(p.preco) || 0;
        const custo = custoDaFicha(selId) || 0;
        const margem = preco - custo;
        const pct = foodCost(preco, custo);
        $('k-preco').textContent = money(preco);
        $('k-custo').textContent = money(custo);
        $('k-margem').textContent = money(margem);
        $('k-cmv').textContent = itens.length ? pct.toFixed(1).replace('.', ',') + '%' : '—';

        // sugestão de preço
        const alvo = Math.min(90, Math.max(1, parseInt($('markup').value) || 35)) / 100;
        const precoSug = custo > 0 ? custo / alvo : 0;
        $('preco-sugerido').textContent = money(precoSug);
        const al = $('alerta-preco');
        if (custo > 0 && preco > 0 && pct > 45) { al.textContent = '⚠️ food cost alto'; al.style.color = '#c0392b'; }
        else if (custo > 0 && preco < precoSug) { al.textContent = '⚠️ preço abaixo do sugerido'; al.style.color = '#e67e22'; }
        else { al.textContent = ''; }
    }

    async function addInsumoFicha() {
        if (!selId) return;
        const insumoId = $('sel-insumo').value;
        const i = insumos.find(x => x.id === insumoId);
        const qEntrada = parseFloat($('q-insumo').value);
        if (!i || isNaN(qEntrada) || qEntrada <= 0) { alert('Selecione um insumo e uma quantidade válida.'); return; }
        const optSel = $('sel-unidade').options[$('sel-unidade').selectedIndex];
        const fator = optSel ? (parseFloat(optSel.dataset.f) || 1) : 1;
        const unidadeEntrada = optSel ? optSel.value : (i.unidade || 'un');
        const q = qEntrada * fator; // quantidade convertida para a unidade base do insumo
        const p = cardapio.find(x => x.id === selId);
        const f = fichas[selId] || { itens: [] };
        const itens = [...(f.itens || [])];
        const ex = itens.find(it => it.insumo_id === insumoId);
        if (ex) {
            ex.quantidade = (Number(ex.quantidade) || 0) + q;
            ex.entrada_qtd = (Number(ex.entrada_qtd) || 0) + qEntrada;
            ex.entrada_unidade = unidadeEntrada;
        } else {
            itens.push({ insumo_id: insumoId, nome: i.nome, unidade: i.unidade || 'un', quantidade: q, entrada_qtd: qEntrada, entrada_unidade: unidadeEntrada });
        }
        try {
            await db.collection('fichas_tecnicas').doc(selId).set({
                produto_nome: nomeProd(p), itens, atualizado_em: FieldValue.serverTimestamp()
            }, { merge: true });
            $('q-insumo').value = '';
        } catch (e) { alert('Erro ao salvar: ' + e.message); }
    }

    async function removerItem(idx) {
        const f = fichas[selId]; if (!f) return;
        const itens = [...(f.itens || [])]; itens.splice(idx, 1);
        try { await db.collection('fichas_tecnicas').doc(selId).set({ itens, atualizado_em: FieldValue.serverTimestamp() }, { merge: true }); }
        catch (e) { alert('Erro: ' + e.message); }
    }

    // ---------- Tabela geral ----------
    function renderGeral() {
        const tb = $('tbody-geral');
        if (!cardapio.length) { tb.innerHTML = '<tr><td colspan="6" class="vazio">Sem produtos.</td></tr>'; return; }
        tb.innerHTML = cardapio.map(p => {
            const preco = Number(p.preco) || 0;
            const custo = custoDaFicha(p.id);
            const temFicha = custo !== null;
            const pct = temFicha ? foodCost(preco, custo) : 0;
            const cl = classeCMV(pct, temFicha);
            return `<tr>
                <td>${esc(nomeProd(p))}</td>
                <td class="num">${money(preco)}</td>
                <td class="num">${temFicha ? money(custo) : '—'}</td>
                <td class="num">${temFicha ? money(preco - custo) : '—'}</td>
                <td class="num">${temFicha ? pct.toFixed(0) + '%' : '—'}</td>
                <td><span class="cmv ${cl.c}" style="padding:2px 9px;border-radius:10px;font-size:.76rem;">${cl.t}</span></td>
            </tr>`;
        }).join('');
    }

    // ---------- Análise do período (CMV / margem / ponto de equilíbrio) ----------
    let ultimoFoodCost = null; // fração 0..1, para recalcular equilíbrio ao vivo

    function resolverFicha(item) {
        if (item && typeof item === 'object') {
            const id = item.id || item.cardapio_id || item.produto_id;
            if (id && fichas[id]) return fichas[id];
            const n = norm(item.nome_exibicao || item.nome);
            if (n && fichasPorNome[n]) return fichasPorNome[n];
        } else if (typeof item === 'string') {
            if (fichasPorNome[norm(item)]) return fichasPorNome[norm(item)];
        }
        return null;
    }
    const qtdItem = (it) => (it && typeof it === 'object' && Number(it.quantidade) > 0) ? Number(it.quantidade) : 1;
    function custoDoItem(item) {
        const f = resolverFicha(item);
        if (!f || !Array.isArray(f.itens)) return null;
        return f.itens.reduce((s, ins) => s + (Number(ins.quantidade) || 0) * custoInsumo(ins.insumo_id), 0) * qtdItem(item);
    }
    function dataDoPedido(p) {
        const ts = p.hora_pedido || p.hora_entrega || p.data;
        return ts && ts.toDate ? ts.toDate() : null;
    }
    const semPrefixoQtd = (s) => norm(s).replace(/^\s*\d+\s*x\s*/i, '').trim();
    function indiceProdutos() {
        const porId = {}, porNome = {};
        cardapio.forEach(p => { porId[p.id] = p; porNome[norm(nomeProd(p))] = p; if (p.nome) porNome[norm(p.nome)] = p; });
        return { porId, porNome };
    }
    function resolverProduto(item, idx) {
        if (item && typeof item === 'object') {
            const id = item.id || item.cardapio_id || item.produto_id;
            if (id && idx.porId[id]) return idx.porId[id];
            const n = semPrefixoQtd(item.nome_exibicao || item.nome);
            if (n && idx.porNome[n]) return idx.porNome[n];
        } else if (typeof item === 'string') {
            const n = semPrefixoQtd(item);
            if (idx.porNome[n]) return idx.porNome[n];
        }
        return null;
    }

    async function analisarPeriodo() {
        const ini = $('p-ini').value ? new Date($('p-ini').value + 'T00:00:00') : null;
        const fim = $('p-fim').value ? new Date($('p-fim').value + 'T23:59:59') : null;
        $('btn-analisar').disabled = true; $('btn-analisar').textContent = 'Analisando...';
        try {
            const snap = await db.collection('pedidos').where('status', '==', 'CONCLUIDO').get();
            let receita = 0, cmv = 0, nPed = 0, semFicha = 0, comFicha = 0;
            const idx = indiceProdutos();
            const agg = {}; // chave produto -> { produto, unidades, receita, margem }
            snap.forEach(d => {
                const p = d.data();
                const dt = dataDoPedido(p);
                if (ini && dt && dt < ini) return;
                if (fim && dt && dt > fim) return;
                nPed++;
                receita += Number(p.valor_total) || 0;
                if (Array.isArray(p.itens)) p.itens.forEach(it => {
                    const c = custoDoItem(it);
                    if (c == null) { semFicha++; } else { cmv += c; comFicha++; }
                    // agregação ABC por produto
                    const prod = resolverProduto(it, idx);
                    if (prod) {
                        const key = prod.id;
                        const un = qtdItem(it);
                        const precoUnit = Number(prod.preco) || 0;
                        const custoUnit = custoDaFicha(prod.id); // por unidade (ou null)
                        if (!agg[key]) agg[key] = { produto: prod, unidades: 0, receita: 0, margem: 0, temFicha: custoUnit != null };
                        agg[key].unidades += un;
                        agg[key].receita += precoUnit * un;
                        if (custoUnit != null) agg[key].margem += (precoUnit - custoUnit) * un;
                    }
                });
            });
            const margem = receita - cmv;
            const fc = receita > 0 ? cmv / receita : 0;
            ultimoFoodCost = comFicha > 0 ? fc : null;
            $('a-receita').textContent = money(receita);
            $('a-cmv').textContent = money(cmv);
            $('a-margem').textContent = money(margem);
            $('a-fc').textContent = (comFicha > 0 && receita > 0) ? (fc * 100).toFixed(1).replace('.', ',') + '%' : '—';
            $('a-ped').textContent = nPed;
            const hint = semFicha > 0 ? `${semFicha} item(ns) vendidos sem ficha técnica não entraram no CMV.` : '';
            $('a-pe-hint').textContent = hint;
            recalcularEquilibrio();
            renderABC(agg);
        } catch (e) {
            alert('Erro ao analisar: ' + e.message);
        } finally {
            $('btn-analisar').disabled = false; $('btn-analisar').textContent = 'Analisar';
        }
    }

    function renderABC(agg) {
        const tb = $('tbody-abc');
        const lista = Object.values(agg).sort((a, b) => b.receita - a.receita);
        if (!lista.length) { tb.innerHTML = '<tr><td colspan="7" class="vazio">Nenhum produto com ficha/venda no período.</td></tr>'; return; }
        const total = lista.reduce((s, x) => s + x.receita, 0) || 1;
        let acum = 0;
        tb.innerHTML = lista.map((x, i) => {
            const antes = (acum / total) * 100;       // % acumulado ANTES deste item
            acum += x.receita;
            const pctAcum = (acum / total) * 100;      // % acumulado após (exibido)
            const classe = antes < 80 ? 'A' : (antes < 95 ? 'B' : 'C');
            return `<tr>
                <td class="num">${i + 1}</td>
                <td>${esc(nomeProd(x.produto))}</td>
                <td class="num">${x.unidades.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}</td>
                <td class="num">${money(x.receita)}</td>
                <td class="num">${pctAcum.toFixed(1).replace('.', ',')}%</td>
                <td class="num">${x.temFicha ? money(x.margem) : '—'}</td>
                <td><span class="abc abc-${classe}">${classe}</span></td>
            </tr>`;
        }).join('');
    }

    function recalcularEquilibrio() {
        const custoFixo = parseFloat($('custo-fixo').value);
        // margem de contribuição % ≈ 1 - food cost (proxy do custo variável)
        if (ultimoFoodCost == null) { $('a-mc').textContent = '—'; }
        else { $('a-mc').textContent = ((1 - ultimoFoodCost) * 100).toFixed(1).replace('.', ',') + '%'; }
        if (isNaN(custoFixo) || custoFixo <= 0) { $('a-pe').textContent = 'informe o custo fixo'; return; }
        if (ultimoFoodCost == null || ultimoFoodCost >= 1) { $('a-pe').textContent = 'rode a análise primeiro'; return; }
        const mc = 1 - ultimoFoodCost;
        const pe = custoFixo / mc;
        $('a-pe').textContent = money(pe);
    }
});
