// Fiscal module dashboard, inspired by the Construline fiscal workflow.
document.addEventListener('DOMContentLoaded', () => {
    const firebaseConfig = window.__FIREBASE_CONFIG__;
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);

    const db = firebase.firestore();
    const auth = firebase.auth();
    const $ = (id) => document.getElementById(id);

    const docFiltro = { busca: '', status: '', forma: '', de: '', ate: '', pagina: 1, porPagina: 20 };
    // Emissao e Notas recebidas: mesmos filtros/paginacao no navegador, sobre o
    // que ja esta carregado (state.pedidos / state.dfe).
    const emiFiltro = { busca: '', situacao: '', pagamento: '', de: '', ate: '', pagina: 1, porPagina: 20 };
    const dfeFiltro = { busca: '', tipo: '', estoque: '', de: '', ate: '', pagina: 1, porPagina: 20 };
    const listas = {
        emi: { filtro: emiFiltro, alvo: 'emi-lista', render: () => renderListaEmissao() },
        dfe: { filtro: dfeFiltro, alvo: 'dfe-lista', render: () => renderListaDfe() }
    };
    const state = { tab: 'overview', cfg: {}, notas: [], notasRelatorio: [], pedidos: [], produtos: [], dfe: [], ibptCache: {}, insumos: [], dfeExpandido: null, dfeEdicao: null, dfeEdicaoDados: null, relatorioMes: mesAtualStr(), notasMesAtual: [] };
    let unsubRelatorio = null;
    let unsubMesAtual = null;
    const tabs = [
        ['overview', 'Visao Geral'],
        ['settings', 'Config fiscal'],
        ['documents', 'Documentos'],
        ['issuance', 'Emissao'],
        ['dfe', 'Notas recebidas'],
        ['devolution', 'Devolucao'],
        ['inutilization', 'Inutilizacao'],
        ['rules', 'Regras'],
        ['company', 'Empresa'],
        ['products', 'Produtos'],
        ['report', 'Relatorio']
    ];

    // "YYYY-MM" do mes corrente, no fuso local (nao UTC) — usado como valor
    // inicial do seletor de periodo do relatorio.
    function mesAtualStr() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
    // Converte "YYYY-MM" no intervalo [inicio, fim) do mes, em Date local.
    function limitesDoMes(mesStr) {
        const [ano, mes] = String(mesStr || mesAtualStr()).split('-').map(Number);
        return { inicio: new Date(ano, (mes || 1) - 1, 1), fim: new Date(ano, mes || 1, 1) };
    }

    const money = (v) => 'R$ ' + (Number(v) || 0).toFixed(2).replace('.', ',');
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const dateTxt = (v) => v?.toDate ? v.toDate().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '--';

    auth.onAuthStateChanged(async user => {
        if (!user) { window.location.href = '/login.html'; return; }
        renderTabs();
        await loadConfig();
        listenNotes();
        listenRelatorio(state.relatorioMes);
        listenOrders();
        listenProducts();
        listenIbptCache();
        listenDfe();
        listenInsumos();
    });

    function renderTabs() {
        $('fiscal-tabs').innerHTML = tabs.map(([id, label]) =>
            `<button class="tab ${state.tab === id ? 'active' : ''}" data-tab="${id}">${label}</button>`
        ).join('');
        $('fiscal-tabs').querySelectorAll('[data-tab]').forEach(btn => {
            btn.onclick = () => {
                state.tab = btn.dataset.tab;
                renderTabs();
                render();
            };
        });
    }

    async function loadConfig() {
        try {
            state.cfg = await FiscalClient.getConfig();
            if (!state.cfg.ativo) showAlert('A emissao fiscal esta desativada. Ative em Fiscal > Config fiscal.');
            else if (!state.cfg.url) showAlert('Informe a URL do servico fiscal em Fiscal > Config fiscal.');
            else showAlert('');
        } catch (err) {
            showAlert('Configuracao fiscal ainda nao encontrada. Preencha Fiscal > Config fiscal.');
            state.cfg = {};
        }
        render();
    }

    function showAlert(text) {
        const el = $('fiscal-alert');
        el.textContent = text;
        el.style.display = text ? 'block' : 'none';
    }

    function listenNotes() {
        // limit no servidor (nao filtro por "hoje"): um filtro de data aqui
        // fazia a aba Documentos e o pareamento pedido->nota (notaFiscalPorPedido,
        // usado na aba Emissao) esquecerem qualquer nota de dias anteriores —
        // pedido com nota rejeitada/autorizada ontem voltava a mostrar "Emitir
        // NFC-e" como se nunca tivesse sido tentado.
        db.collection('notas_fiscais')
            .orderBy('criado_em', 'desc').limit(300)
            .onSnapshot(snap => {
                state.notas = [];
                snap.forEach(doc => state.notas.push({ id: doc.id, ...doc.data() }));
                render();
            }, err => console.warn('notas_fiscais:', err.message));
    }

    // O Relatorio pra contabilidade precisa de qualquer mes, não só hoje —
    // por isso tem sua própria consulta (state.notas do listenNotes() acima
    // é sempre "hoje em diante", só serve pra aba Documentos). Reconsulta
    // sempre que o mes selecionado no relatorio muda.
    function listenRelatorio(mes) {
        if (unsubRelatorio) unsubRelatorio();
        garantirMesAtual(mes);
        const { inicio, fim } = limitesDoMes(mes);
        unsubRelatorio = db.collection('notas_fiscais')
            .where('criado_em', '>=', inicio)
            .where('criado_em', '<', fim)
            .onSnapshot(snap => {
                state.notasRelatorio = [];
                snap.forEach(doc => state.notasRelatorio.push({ id: doc.id, ...doc.data() }));
                state.notasRelatorio.sort((a, b) => (b.criado_em?.toMillis?.() || 0) - (a.criado_em?.toMillis?.() || 0));
                if (state.tab === 'report' || (state.tab === 'overview' && state.relatorioMes === mesAtualStr())) render();
            }, err => console.warn('notas_fiscais (relatorio):', err.message));
    }

    // A Visao Geral mostra o MES ATUAL. Quando o seletor do relatorio esta no mes
    // atual, os dois dividem a mesma consulta (state.notasRelatorio). Se o relatorio
    // for para outro mes, abre uma consulta propria so do mes atual — sem isso o
    // resumo passaria a mostrar o mes que estivesse escolhido no relatorio.
    function garantirMesAtual(mesDoRelatorio) {
        if (mesDoRelatorio === mesAtualStr()) {
            if (unsubMesAtual) { unsubMesAtual(); unsubMesAtual = null; state.notasMesAtual = []; }
            return;
        }
        if (unsubMesAtual) return;
        const { inicio, fim } = limitesDoMes(mesAtualStr());
        unsubMesAtual = db.collection('notas_fiscais')
            .where('criado_em', '>=', inicio)
            .where('criado_em', '<', fim)
            .onSnapshot(snap => {
                state.notasMesAtual = [];
                snap.forEach(doc => state.notasMesAtual.push({ id: doc.id, ...doc.data() }));
                if (state.tab === 'overview') render();
            }, err => console.warn('notas_fiscais (mes atual):', err.message));
    }
    function notasDoMesAtual() {
        return state.relatorioMes === mesAtualStr() ? state.notasRelatorio : state.notasMesAtual;
    }

    function listenOrders() {
        // limit no servidor: sem isso o listener re-cobra leitura da coleção
        // inteira de pedidos concluidos (historico completo) a cada mudanca.
        db.collection('pedidos').where('status', '==', 'CONCLUIDO')
            .orderBy('hora_pedido', 'desc').limit(60)
            .onSnapshot(snap => {
                state.pedidos = [];
                snap.forEach(doc => state.pedidos.push({ id: doc.id, ...doc.data() }));
                render();
            }, err => console.warn('pedidos:', err.message));
    }

    function listenProducts() {
        db.collection('cardapio').onSnapshot(snap => {
            state.produtos = [];
            snap.forEach(doc => state.produtos.push({ id: doc.id, ...doc.data() }));
            state.produtos.sort((a, b) => String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR'));
            render();
        }, err => console.warn('cardapio:', err.message));
    }

    function listenIbptCache() {
        db.collection('ibpt_cache').onSnapshot(snap => {
            const mapa = {};
            snap.forEach(doc => mapa[doc.id] = doc.data());
            state.ibptCache = mapa;
            render();
        }, err => console.warn('ibpt_cache:', err.message));
    }

    function aliquotaIbptDoNcm(ncm) {
        const uf = (state.cfg.uf || '').toUpperCase();
        const d = state.ibptCache[`${uf}_${ncm}_0`];
        if (!d) return null;
        const pct = Number(d.nacional || 0) + Number(d.estadual || 0) + Number(d.municipal || 0);
        return pct;
    }

    function listenDfe() {
        db.collection('dfe_documentos').onSnapshot(snap => {
            state.dfe = [];
            snap.forEach(doc => state.dfe.push({ id: doc.id, ...doc.data() }));
            state.dfe.sort((a, b) => String(b.nsu || '').localeCompare(String(a.nsu || '')));
            render();
        }, err => console.warn('dfe_documentos:', err.message));
    }

    function listenInsumos() {
        db.collection('estoque_insumos').onSnapshot(snap => {
            state.insumos = [];
            snap.forEach(doc => state.insumos.push({ id: doc.id, ...doc.data() }));
            state.insumos.sort((a, b) => String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR'));
            render();
        }, err => console.warn('estoque_insumos:', err.message));
    }

    // A tela inteira e redesenhada a cada mudanca no banco (pedido concluido,
    // baixa de estoque, cardapio...). Sem isto, o formulario de entrada de
    // estoque de uma nota voltava pras sugestoes automaticas no meio do
    // preenchimento, e o operador confirmava sem perceber (ex.: Tampico 450 ml
    // ligado ao produto de 250 ml).
    const CAMPOS_ENTRADA = ['item-tipo', 'item-produto', 'item-insumo', 'item-novo-nome', 'item-prod-nome', 'item-prod-categoria', 'item-prod-ncm', 'item-prod-cfop', 'item-prod-csosn', 'item-prod-origem', 'item-qtd'];
    // Valor do select de produto que significa "cadastrar um produto novo".
    const PRODUTO_NOVO = '__novo__';
    function capturarFormEntrada() {
        if (!state.dfeExpandido) return null;
        const valores = {};
        CAMPOS_ENTRADA.forEach(campo => document.querySelectorAll(`[data-${campo}]`).forEach(el => {
            valores[`${campo}:${el.getAttribute('data-' + campo)}`] = el.value;
        }));
        const ativo = document.activeElement;
        const foco = CAMPOS_ENTRADA.find(c => ativo && ativo.hasAttribute && ativo.hasAttribute('data-' + c));
        return {
            dfeId: state.dfeExpandido, valores,
            foco: foco ? `${foco}:${ativo.getAttribute('data-' + foco)}` : null
        };
    }
    function restaurarFormEntrada(salvo) {
        if (!salvo || salvo.dfeId !== state.dfeExpandido) return;
        Object.entries(salvo.valores).forEach(([chave, valor]) => {
            const [campo, idx] = chave.split(':');
            const el = document.querySelector(`[data-${campo}="${idx}"]`);
            if (!el) return;
            if (el.tagName === 'SELECT' && ![...el.options].some(o => o.value === valor)) return;
            el.value = valor;
        });
        // Reaplica visibilidade dos selects e o custo recalculado.
        document.querySelectorAll('[data-item-tipo],[data-item-insumo],[data-item-produto]').forEach(el => el.onchange && el.onchange());
        document.querySelectorAll('[data-item-qtd]').forEach(el => el.oninput && el.oninput());
        if (salvo.foco) {
            const [campo, idx] = salvo.foco.split(':');
            document.querySelector(`[data-${campo}="${idx}"]`)?.focus();
        }
    }

    function render() {
        const content = $('fiscal-content');
        if (!content) return;
        const formEntrada = capturarFormEntrada();
        const formEdicao = capturarEdicao();
        if (state.tab === 'overview') content.innerHTML = renderOverview();
        if (state.tab === 'settings') content.innerHTML = renderSettings();
        if (state.tab === 'documents') content.innerHTML = renderDocuments();
        if (state.tab === 'issuance') content.innerHTML = renderIssuance();
        if (state.tab === 'report') content.innerHTML = renderReport();
        if (state.tab === 'dfe') content.innerHTML = renderDfe();
        if (state.tab === 'devolution') content.innerHTML = renderPlaceholder('Devolucao', 'Estrutura reservada para emitir devolucao referenciada a uma nota de entrada ou venda.');
        if (state.tab === 'inutilization') content.innerHTML = renderInutilization();
        if (state.tab === 'rules') content.innerHTML = renderRules();
        if (state.tab === 'company') content.innerHTML = renderCompany();
        if (state.tab === 'products') content.innerHTML = renderProducts();
        bindActions();
        restaurarFormEntrada(formEntrada);
        restaurarEdicao(formEdicao);
    }

    function counts(notas) {
        const base = { total: notas.length, autorizada: 0, rejeitada: 0, cancelada: 0, contingencia: 0, inutilizada: 0, processando: 0 };
        notas.forEach(n => {
            const s = String(n.status || '').toUpperCase();
            if (s === 'AUTORIZADA') base.autorizada++;
            else if (s === 'CANCELADA') base.cancelada++;
            else if (s === 'CONTINGENCIA') base.contingencia++;
            else if (s === 'INUTILIZADA') base.inutilizada++;
            else if (s === 'PROCESSANDO') base.processando++;
            else if (s) base.rejeitada++;
        });
        return base;
    }

    function renderOverview() {
        // Cartoes do MES atual (nao do dia). Inutilizacao nao e documento de venda.
        const mes = notasDoMesAtual().filter(n => n.tipo !== 'INUTILIZACAO');
        const c = counts(mes);
        const total = mes.filter(n => n.status === 'AUTORIZADA').reduce((sum, n) => sum + Number(n.valor || 0), 0);
        // Pendencia = nota que nao deu certo E cuja venda ainda nao tem nota autorizada.
        // Uma tentativa que falhou mas foi refeita (outra nota AUTORIZADA no mesmo pedido)
        // nao e pendencia — so historico.
        const pedidosComNotaOk = new Set(mes.filter(n => ['AUTORIZADA', 'CANCELADA'].includes(n.status) && n.pedido_id).map(n => n.pedido_id));
        const pendencias = mes.filter(n => !['AUTORIZADA', 'CANCELADA', 'INUTILIZADA'].includes(String(n.status || '').toUpperCase())
            && !(n.pedido_id && pedidosComNotaOk.has(n.pedido_id))).length;
        const [ano, nMes] = mesAtualStr().split('-').map(Number);
        const nomeMes = new Date(ano, nMes - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
        return `
            <p class="muted" style="margin:0 0 8px">Resumo de <strong>${esc(nomeMes)}</strong> (mes inteiro, do dia 1 ate hoje)</p>
            <div class="grid cards">
                ${metric('Documentos no mes', c.total)}
                ${metric('Autorizadas', c.autorizada)}
                ${metric('Pendencias', pendencias)}
                ${metric('Valor autorizado', money(total))}
            </div>
            <div class="panel" style="margin-top:14px">
                <div class="panel-head"><h2>Saude fiscal</h2><button class="btn" data-tab-go="settings">Abrir config fiscal</button></div>
                ${healthRows()}
            </div>
            <div class="panel" style="margin-top:14px">
                <div class="panel-head"><h2>Ultimos documentos</h2><button class="btn" data-tab-go="documents">Ver todos</button></div>
                ${documentsTable(state.notas.slice(0, 6))}
            </div>`;
    }

    function metric(label, value) {
        return `<div class="card"><div class="metric-label">${esc(label)}</div><div class="metric-value">${esc(value)}</div></div>`;
    }

    function healthRows() {
        const rows = [
            ['Servico fiscal', state.cfg.url || 'Nao informado', !!state.cfg.url],
            ['Emissao ativa', state.cfg.ativo ? 'Ativa' : 'Desativada', !!state.cfg.ativo],
            ['Ambiente', state.cfg.ambiente || 'homologacao', true],
            ['Empresa', state.cfg.cnpj && state.cfg.ie ? `${state.cfg.cnpj} / IE ${state.cfg.ie}` : 'CNPJ/IE incompletos', !!(state.cfg.cnpj && state.cfg.ie)],
            ['CSC', state.cfg.csc && state.cfg.cscId ? `ID ${state.cfg.cscId}` : 'Nao informado', !!(state.cfg.csc && state.cfg.cscId)]
        ];
        return `<table><tbody>${rows.map(([a, b, ok]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td><td><span class="badge ${ok ? 'b-ok' : 'b-warn'}">${ok ? 'OK' : 'Pendente'}</span></td></tr>`).join('')}</tbody></table>`;
    }

    // Filtros e paginacao da aba Documentos (so no navegador, sobre state.notas).

    function statusDaNota(n) { return String(n.status || '-').toUpperCase(); }
    // A SEFAZ devolve o mesmo texto do modelo 55 ("Autorizado o uso da NF-e")
    // tambem para o modelo 65. Tudo em notas_fiscais e NFC-e, entao a tela
    // mostra o nome certo; o texto gravado na nota fica como a SEFAZ mandou.
    function motivoDaNota(n) { return String(n.motivo || '').replace(/\bNF-e\b/g, 'NFC-e'); }
    function formaDaNota(n) {
        if (n.tipo === 'INUTILIZACAO') return '-';
        return n.formaEmissao || (n.contingencia || statusDaNota(n) === 'CONTINGENCIA' ? 'CONTINGENCIA' : 'NORMAL');
    }

    function notasFiltradas() {
        const f = docFiltro;
        const busca = f.busca.trim().toLowerCase();
        const de = f.de ? new Date(f.de + 'T00:00:00').getTime() : null;
        const ate = f.ate ? new Date(f.ate + 'T23:59:59.999').getTime() : null;
        return state.notas.filter(n => {
            if (f.status && statusDaNota(n) !== f.status) return false;
            if (f.forma && formaDaNota(n) !== f.forma) return false;
            const ms = n.criado_em?.toMillis?.() ?? Date.now(); // escrita pendente = agora
            if (de != null && ms < de) return false;
            if (ate != null && ms > ate) return false;
            if (busca) {
                const alvo = [n.nNF, n.cliente, n.chave, n.pedido_id, n.motivo, n.protocolo].join(' ').toLowerCase();
                if (!alvo.includes(busca)) return false;
            }
            return true;
        });
    }

    function renderDocuments() {
        const f = docFiltro;
        const statusOpts = ['AUTORIZADA', 'CANCELADA', 'REJEITADA', 'ERRO', 'ERRO_REDE', 'CONTINGENCIA', 'PROCESSANDO', 'INUTILIZADA'];
        const opt = (v, atual, txt) => `<option value="${v}" ${atual === v ? 'selected' : ''}>${txt || v}</option>`;
        return `<div class="panel"><div class="panel-head"><h2>Documentos fiscais</h2><button class="btn" data-refresh-config>Atualizar config</button></div>
            <div class="actions" style="margin:0 0 12px;flex-wrap:wrap;gap:8px;align-items:flex-end">
                <label class="sub" style="margin:0">Buscar <input type="search" id="doc-busca" placeholder="Numero, cliente, chave, pedido" value="${esc(f.busca)}"></label>
                <label class="sub" style="margin:0">Status <select id="doc-status">${opt('', f.status, 'Todos')}${statusOpts.map(v => opt(v, f.status)).join('')}</select></label>
                <label class="sub" style="margin:0">Emissao <select id="doc-forma">${opt('', f.forma, 'Todas')}${opt('NORMAL', f.forma, 'Normal')}${opt('CONTINGENCIA', f.forma, 'Contingencia')}</select></label>
                <label class="sub" style="margin:0">De <input type="date" id="doc-de" value="${esc(f.de)}"></label>
                <label class="sub" style="margin:0">Ate <input type="date" id="doc-ate" value="${esc(f.ate)}"></label>
                <button class="btn" id="doc-limpar">Limpar filtros</button>
            </div>
            <div id="docs-lista">${renderListaDocumentos()}</div></div>`;
    }

    function renderListaDocumentos() {
        const f = docFiltro;
        const lista = notasFiltradas();
        const totalPag = Math.max(1, Math.ceil(lista.length / f.porPagina));
        if (f.pagina > totalPag) f.pagina = totalPag;
        const ini = (f.pagina - 1) * f.porPagina;
        const pagina = lista.slice(ini, ini + f.porPagina);
        const pager = `<div class="actions" style="margin:12px 0 0;justify-content:space-between;flex-wrap:wrap;gap:8px;align-items:center">
            <span class="muted">${lista.length ? `${ini + 1}-${ini + pagina.length} de ${lista.length}` : '0 resultados'}${lista.length !== state.notas.length ? ` (${state.notas.length} carregados)` : ''}</span>
            <span style="display:flex;gap:8px;align-items:center">
                <label class="sub" style="margin:0">Por pagina <select id="doc-por-pagina">${[10, 20, 50, 100].map(v => `<option value="${v}" ${f.porPagina === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
                <button class="btn" data-doc-pag="-1" ${f.pagina <= 1 ? 'disabled' : ''}>&lsaquo; Anterior</button>
                <span class="muted">Pagina ${f.pagina} de ${totalPag}</span>
                <button class="btn" data-doc-pag="1" ${f.pagina >= totalPag ? 'disabled' : ''}>Proxima &rsaquo;</button>
            </span></div>`;
        return documentsTable(pagina) + pager;
    }

    // Atualiza so a lista (sem recriar os campos de filtro, pra nao perder o foco da busca).
    function atualizarListaDocumentos() {
        const alvo = $('docs-lista');
        if (!alvo) return;
        alvo.innerHTML = renderListaDocumentos();
        bindActions();
    }

    function documentsTable(notas) {
        if (!notas.length) return '<div class="empty">Nenhum documento fiscal encontrado.</div>';
        return `<table><thead><tr><th>Numero</th><th>Pedido</th><th>Status</th><th>Forma emissao</th><th>Cliente</th><th>Chave</th><th class="num">Valor</th><th>Data</th><th class="num">Acoes</th></tr></thead><tbody>${notas.map(n => {
            const status = String(n.status || '-').toUpperCase();
            const cls = status === 'AUTORIZADA' ? 'b-ok' : (status === 'CANCELADA' || status === 'INUTILIZADA' ? 'b-muted' : ((status === 'CONTINGENCIA' || status === 'PROCESSANDO') ? 'b-warn' : 'b-danger'));
            const num = n.tipo === 'INUTILIZACAO' ? `Inut. ${n.nNFIni}-${n.nNFFin}` : (n.nNF || '-');
            // formaEmissao e permanente (historico); notas antigas sem esse campo caem no fallback abaixo
            const forma = n.tipo === 'INUTILIZACAO' ? '-' : (n.formaEmissao || (n.contingencia || status === 'CONTINGENCIA' ? 'CONTINGENCIA' : 'NORMAL'));
            const actions = [];
            if (n.danfeBase64) actions.push(`<button class="btn" data-danfe="${n.id}">DANFE</button>`);
            if (n.danfeBase64) actions.push(`<button class="btn" data-imprimir="${n.id}" title="Imprimir cupom">🖨️ Imprimir</button>`);
            if (n.xml || n.xmlAssinado) actions.push(`<button class="btn" data-xml="${n.id}">Baixar XML</button>`);
            if (status === 'CONTINGENCIA') actions.push(`<button class="btn primary" data-transmitir="${n.id}">Transmitir</button>`);
            if (status === 'AUTORIZADA' && n.chave && n.protocolo) actions.push(`<button class="btn danger" data-cancelar="${n.id}">Cancelar</button>`);
            const pedidoRef = n.pedido_id ? `#${esc(String(n.pedido_id).slice(0, 6))}` : '-';
            return `<tr><td>${esc(num)}</td><td>${pedidoRef}</td><td><span class="badge ${cls}">${esc(status)}</span>${n.motivo ? `<br><span class="muted">${esc(motivoDaNota(n))}</span>` : ''}</td><td>${esc(forma)}</td><td>${esc(n.cliente || '-')}</td><td class="chave">${esc(n.chave || (n.tipo === 'INUTILIZACAO' ? 'Inutilizacao de numeracao' : '-'))}</td><td class="num">${n.valor != null ? money(n.valor) : '-'}</td><td>${dateTxt(n.criado_em)}</td><td class="num">${actions.join(' ') || '<span class="muted">-</span>'}</td></tr>`;
        }).join('')}</tbody></table>`;
    }

    // Relatorio por periodo pra contabilidade: totais + a mesma tabela de
    // documentos (reaproveitada), filtrada pelo mes escolhido, com exportacao
    // em CSV e download de todos os XMLs do periodo num .zip so.
    function renderReport() {
        const mes = state.relatorioMes || mesAtualStr();
        const notasDoMes = state.notasRelatorio;
        const validas = notasDoMes.filter(n => n.tipo !== 'INUTILIZACAO' && (n.status === 'AUTORIZADA' || n.status === 'CONTINGENCIA'));
        const canceladas = notasDoMes.filter(n => n.status === 'CANCELADA');
        const totalFaturado = validas.reduce((s, n) => s + Number(n.valor || 0), 0);
        const comXml = notasValidasParaContabilidade(notasDoMes).filter(n => n.xmlProc || n.xml || n.xmlAssinado);

        return `<div class="panel">
            <div class="panel-head">
                <h2>Relatorio para contabilidade</h2>
                <div class="actions" style="margin:0">
                    <label class="sub" style="margin:0">Periodo <input type="month" id="relatorio-mes" value="${esc(mes)}"></label>
                    <button class="btn" id="btn-relatorio-csv" ${notasDoMes.length ? '' : 'disabled'}>Exportar CSV</button>
                    <button class="btn primary" id="btn-relatorio-zip" ${comXml.length ? '' : 'disabled'}>Baixar XMLs (.zip)</button>
                </div>
            </div>
            <div class="grid cards" style="margin-bottom:16px">
                ${metric('NFC-e emitidas', validas.length)}
                ${metric('Valor faturado', money(totalFaturado))}
                ${metric('Canceladas', canceladas.length)}
                ${metric('XMLs disponiveis', comXml.length)}
            </div>
            ${documentsTable(notasDoMes)}
        </div>`;
    }

    // CSV com os campos que a contabilidade costuma pedir pra conciliar as
    // vendas do periodo (numero, serie, chave, datas, valores, status).
    // So documentos validos fiscalmente (autorizadas/canceladas) entram no relatorio
    // da contabilidade — ERRO/REJEITADA/contingencia nao transmitida nao existem na SEFAZ.
    function notasValidasParaContabilidade(notas) {
        return notas.filter(n => n.tipo !== 'INUTILIZACAO' && ['AUTORIZADA', 'CANCELADA'].includes(String(n.status || '').toUpperCase()));
    }

    function exportarRelatorioCsv(notas, mes) {
        const cols = ['Numero', 'Serie', 'Chave', 'Status', 'Forma emissao', 'Cliente', 'Valor', 'Data emissao', 'Protocolo'];
        const inut = notas.filter(n => n.tipo === 'INUTILIZACAO' && n.status === 'INUTILIZADA');
        const linhas = [...notasValidasParaContabilidade(notas), ...inut].map(n => [
            n.tipo === 'INUTILIZACAO' ? `Inut. ${n.nNFIni}-${n.nNFFin}` : (n.nNF ?? ''),
            n.serie ?? '',
            { texto: n.chave || '' },
            n.status || '',
            n.tipo === 'INUTILIZACAO' ? '' : (n.formaEmissao || (n.contingencia ? 'CONTINGENCIA' : 'NORMAL')),
            n.cliente || '',
            n.valor != null ? String(n.valor).replace('.', ',') : '',
            n.criado_em?.toDate ? n.criado_em.toDate().toLocaleString('pt-BR') : '',
            { texto: n.protocolo || '' }
        ]);
        // Chave (44 digitos) e protocolo (15) precisam ir como TEXTO: o Excel os
        // converte para notacao cientifica (3,12609E+43) e perde os digitos.
        const escCsv = (v) => (v && typeof v === 'object')
            ? (v.texto ? `"=""${v.texto}"""` : '""')
            : `"${String(v).replace(/"/g, '""')}"`;
        const csv = '﻿' + [cols, ...linhas].map(l => l.map(escCsv).join(';')).join('\r\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `relatorio-fiscal-${mes}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    // Zip com todos os XMLs (autorizados ou transmitidos em contingencia) do
    // periodo, nomeados pela chave de acesso — formato que a contabilidade
    // espera pra importar num sistema de escrituracao (SPED etc.).
    async function exportarXmlsZip(notas, mes, btn) {
        if (!window.JSZip) { alert('Biblioteca de .zip nao carregou (sem internet?). Tente novamente.'); return; }
        // So AUTORIZADA/CANCELADA (ERRO/REJEITADA nunca existiram na SEFAZ). O arquivo
        // e o nfeProc (NFe + protocolo); sem ele a nota entra marcada SEM-PROTOCOLO.
        const validas = notasValidasParaContabilidade(notas).filter(n => n.xmlProc || n.xml || n.xmlAssinado);
        if (!validas.length) return;
        const textoOriginal = btn ? btn.textContent : '';
        if (btn) { btn.disabled = true; btn.textContent = 'Gerando .zip...'; }
        try {
            const zip = new window.JSZip();
            let semProtocolo = 0;
            validas.forEach(n => {
                const base = n.chave || `nNF-${n.nNF || n.id}`;
                if (n.xmlProc) zip.file(base + '-procNFe.xml', n.xmlProc);
                else { semProtocolo++; zip.file(base + '-SEM-PROTOCOLO.xml', n.xml || n.xmlAssinado); }
                // Evento de cancelamento (110111) — prova do cancelamento perante a SEFAZ.
                const ev = n.cancelamento?.xmlProcEvento || n.cancelamento?.xmlEvento;
                if (ev) zip.file(base + '-cancelamento.xml', ev);
                else if (n.status === 'CANCELADA') zip.file(base + '-SEM-EVENTO-CANCELAMENTO.txt', 'XML do evento de cancelamento nao disponivel.');
            });
            const blob = await zip.generateAsync({ type: 'blob' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `xmls-nfce-${mes}.zip`;
            a.click();
            URL.revokeObjectURL(a.href);
            if (semProtocolo) alert(`${semProtocolo} XML(s) ficaram sem protocolo (arquivos "-SEM-PROTOCOLO.xml"). Avise o suporte antes de enviar para a contabilidade.`);
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = textoOriginal; }
        }
    }

    // ---- Filtros e paginacao das abas Emissao e Notas recebidas ----
    function fatiarPagina(lista, f) {
        const totalPag = Math.max(1, Math.ceil(lista.length / f.porPagina));
        f.pagina = Math.min(Math.max(1, f.pagina), totalPag);
        const ini = (f.pagina - 1) * f.porPagina;
        return { itens: lista.slice(ini, ini + f.porPagina), ini, totalPag };
    }

    function pagerHtml(chave, lista, pag, carregados, rotuloCarregados) {
        const f = listas[chave].filtro;
        return `<div class="actions" style="margin:12px 0 0;justify-content:space-between;flex-wrap:wrap;gap:8px;align-items:center">
            <span class="muted">${lista.length ? `${pag.ini + 1}-${pag.ini + pag.itens.length} de ${lista.length}` : '0 resultados'}${lista.length !== carregados ? ` (${carregados} ${rotuloCarregados})` : ''}</span>
            <span style="display:flex;gap:8px;align-items:center">
                <label class="sub" style="margin:0">Por pagina <select data-lista-por-pagina="${chave}">${[10, 20, 50, 100].map(v => `<option value="${v}" ${f.porPagina === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
                <button class="btn" data-lista-pag="${chave}:-1" ${f.pagina <= 1 ? 'disabled' : ''}>&lsaquo; Anterior</button>
                <span class="muted">Pagina ${f.pagina} de ${pag.totalPag}</span>
                <button class="btn" data-lista-pag="${chave}:1" ${f.pagina >= pag.totalPag ? 'disabled' : ''}>Proxima &rsaquo;</button>
            </span></div>`;
    }

    // Redesenha so a lista (sem recriar os campos de filtro, pra nao perder o
    // foco da busca), preservando o formulario de entrada de estoque aberto.
    function atualizarLista(chave) {
        const alvo = $(listas[chave].alvo);
        if (!alvo) return;
        const formEntrada = capturarFormEntrada();
        const formEdicao = capturarEdicao();
        alvo.innerHTML = listas[chave].render();
        bindActions();
        restaurarFormEntrada(formEntrada);
        restaurarEdicao(formEdicao);
    }

    const optFiltro = (v, atual, txt) => `<option value="${esc(v)}" ${atual === v ? 'selected' : ''}>${esc(txt || v)}</option>`;

    function notaFiscalPorPedido() {
        // state.notas ja vem ordenado do mais recente pro mais antigo (listenNotes),
        // entao a primeira ocorrencia por pedido_id e sempre a tentativa mais atual.
        const map = {};
        state.notas.forEach(n => {
            if (n.pedido_id && !(n.pedido_id in map)) map[n.pedido_id] = n;
        });
        return map;
    }

    // Situacao fiscal da venda, a partir do status da nota mais recente dela.
    function situacaoFiscal(st) {
        if (st === 'AUTORIZADA' || st === 'CONTINGENCIA') return 'EMITIDA';
        if (st === 'PROCESSANDO' || st === 'ERRO_REDE') return 'PENDENTE';
        if (st === 'REJEITADA' || st === 'ERRO') return 'FALHA';
        if (st === 'CANCELADA' || st === 'INUTILIZADA') return 'CANCELADA';
        return 'SEM_NOTA';
    }

    function pedidosFiltrados(notaPorPedido) {
        const f = emiFiltro;
        const busca = f.busca.trim().toLowerCase();
        const de = f.de ? new Date(f.de + 'T00:00:00').getTime() : null;
        const ate = f.ate ? new Date(f.ate + 'T23:59:59.999').getTime() : null;
        return state.pedidos.filter(p => {
            const nota = notaPorPedido[p.id];
            if (f.situacao && situacaoFiscal(nota ? statusDaNota(nota) : null) !== f.situacao) return false;
            if (f.pagamento && String(p.forma_pagamento || '-') !== f.pagamento) return false;
            const ms = p.hora_pedido?.toMillis?.() ?? null;
            if (de != null && (ms == null || ms < de)) return false;
            if (ate != null && (ms == null || ms > ate)) return false;
            if (busca) {
                const alvo = [p.id, p.nome_cliente, p.forma_pagamento, nota?.nNF].join(' ').toLowerCase();
                if (!alvo.includes(busca)) return false;
            }
            return true;
        });
    }

    function renderIssuance() {
        if (!state.pedidos.length) return '<div class="panel"><h2>Emissao NFC-e</h2><div class="empty">Nenhuma venda concluida recente.</div></div>';
        const f = emiFiltro;
        const pagamentos = [...new Set(state.pedidos.map(p => String(p.forma_pagamento || '-')))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
        const situacoes = [['SEM_NOTA', 'Sem nota'], ['EMITIDA', 'Emitida'], ['PENDENTE', 'Em processamento'], ['FALHA', 'Com falha'], ['CANCELADA', 'Nota cancelada']];
        return `<div class="panel"><div class="panel-head"><h2>Emitir NFC-e por venda concluida</h2></div>
            <div class="actions" style="margin:0 0 12px;flex-wrap:wrap;gap:8px;align-items:flex-end">
                <label class="sub" style="margin:0">Buscar <input type="search" data-lista-filtro="emi:busca" placeholder="Pedido, cliente, numero da nota" value="${esc(f.busca)}"></label>
                <label class="sub" style="margin:0">Situacao <select data-lista-filtro="emi:situacao">${optFiltro('', f.situacao, 'Todas')}${situacoes.map(([v, t]) => optFiltro(v, f.situacao, t)).join('')}</select></label>
                <label class="sub" style="margin:0">Pagamento <select data-lista-filtro="emi:pagamento">${optFiltro('', f.pagamento, 'Todos')}${pagamentos.map(v => optFiltro(v, f.pagamento)).join('')}</select></label>
                <label class="sub" style="margin:0">De <input type="date" data-lista-filtro="emi:de" value="${esc(f.de)}"></label>
                <label class="sub" style="margin:0">Ate <input type="date" data-lista-filtro="emi:ate" value="${esc(f.ate)}"></label>
                <button class="btn" data-lista-limpar="emi">Limpar filtros</button>
            </div>
            <div id="emi-lista">${renderListaEmissao()}</div></div>`;
    }

    function renderListaEmissao() {
        const notaPorPedido = notaFiscalPorPedido();
        const lista = pedidosFiltrados(notaPorPedido);
        const pag = fatiarPagina(lista, emiFiltro);
        const pager = pagerHtml('emi', lista, pag, state.pedidos.length, 'vendas carregadas');
        if (!lista.length) return '<div class="empty">Nenhuma venda encontrada com esses filtros.</div>' + pager;
        return `<table><thead><tr><th>Pedido</th><th>Cliente</th><th>Pagamento</th><th class="num">Valor</th><th>Data</th><th class="num">Acao</th></tr></thead><tbody>${pag.itens.map(p => {
            const nota = notaPorPedido[p.id];
            const st = nota ? String(nota.status || '').toUpperCase() : null;
            let acao;
            // AUTORIZADA/CONTINGENCIA/PROCESSANDO = NFC-e valida ou em curso, bloqueia
            // cancelar a venda por aqui (cancele a nota primeiro). CANCELADA/INUTILIZADA
            // significam que a nota ja nao vale mais fiscalmente, entao a venda pode
            // ser cancelada normalmente.
            const nfEmitida = st === 'AUTORIZADA' || st === 'CONTINGENCIA' || st === 'PROCESSANDO';
            if (st === 'AUTORIZADA' || st === 'CONTINGENCIA') {
                acao = '<span class="badge b-ok">Emitida</span>';
                if (nota.danfeBase64) acao += `<br><button class="btn" data-imprimir="${nota.id}" title="Imprimir cupom" style="margin-top:6px">🖨️ Imprimir</button>`;
            }
            else if (st === 'PROCESSANDO') acao = '<span class="badge b-warn">Processando...</span>';
            else if (st === 'ERRO_REDE') acao = '<span class="badge b-warn">Aguardando conexão (reenvia sozinho)</span>';
            else if (st === 'REJEITADA' || st === 'ERRO') {
                acao = `<button class="btn primary" data-emitir="${p.id}">Retry</button><br><span class="muted" style="font-size:.76rem">Tentativa anterior falhou: ${esc(motivoDaNota(nota) || st)}</span>`;
            } else if (st === 'CANCELADA' || st === 'INUTILIZADA') {
                acao = `<span class="badge b-muted">NFC-e cancelada</span><br><button class="btn primary" data-emitir="${p.id}" style="margin-top:6px">Emitir nova NFC-e</button>`;
            } else acao = `<button class="btn primary" data-emitir="${p.id}">Emitir NFC-e</button>`;
            acao += `<br><button class="btn danger" data-cancelar-venda="${p.id}" ${nfEmitida ? 'disabled title="NFC-e já emitida — cancele a nota antes de cancelar a venda."' : ''} style="margin-top:6px">Cancelar venda</button>`;
            return `<tr><td>#${esc(String(p.id).slice(0, 6))}</td><td>${esc(p.nome_cliente || 'Cliente')}</td><td>${esc(p.forma_pagamento || '-')}</td><td class="num">${money(p.valor_total)}</td><td>${dateTxt(p.hora_pedido)}</td><td class="num">${acao}</td></tr>`;
        }).join('')}</tbody></table>` + pager;
    }

    function renderInutilization() {
        return `<div class="panel"><h2>Inutilizacao de numeracao</h2><div class="form-grid"><label>Serie<input id="inut-serie" type="number" min="1" value="${esc(state.cfg.serie || 1)}"></label><label>Numero inicial<input id="inut-ini" type="number" min="1"></label><label>Numero final<input id="inut-fim" type="number" min="1"></label><button class="btn primary" id="btn-inutilizar-range">Inutilizar</button></div><label style="margin-top:12px">Justificativa<textarea id="inut-just" placeholder="Informe uma justificativa com pelo menos 15 caracteres"></textarea></label></div>`;
    }

    function renderDfe() {
        return `<div class="panel">
            <div class="panel-head">
                <div>
                    <h2>Notas recebidas</h2>
                    <p class="muted">Ultimo NSU: ${esc(state.cfg.dfeUltNSU || '0')} / Max NSU: ${esc(state.cfg.dfeMaxNSU || '0')}</p>
                </div>
                <div style="display:flex;gap:8px;align-items:center">
                    <input type="file" id="dfe-arquivo-xml" accept=".xml" style="display:none">
                    <button class="btn" id="btn-importar-xml">Importar XML</button>
                    <button class="btn primary" id="btn-sync-dfe">Sincronizar SEFAZ</button>
                </div>
            </div>
            <p class="sub" id="dfe-import-msg" style="margin-top:-6px"></p>
            ${state.dfe.length ? `<div class="actions" style="margin:0 0 12px;flex-wrap:wrap;gap:8px;align-items:flex-end">
                <label class="sub" style="margin:0">Buscar <input type="search" data-lista-filtro="dfe:busca" placeholder="Emitente, CNPJ, chave, NSU" value="${esc(dfeFiltro.busca)}"></label>
                <label class="sub" style="margin:0">Tipo <select data-lista-filtro="dfe:tipo">${optFiltro('', dfeFiltro.tipo, 'Todos')}${optFiltro('COMPLETA', dfeFiltro.tipo, 'Nota completa')}${optFiltro('RESUMO', dfeFiltro.tipo, 'Resumo')}</select></label>
                <label class="sub" style="margin:0">Estoque <select data-lista-filtro="dfe:estoque">${optFiltro('', dfeFiltro.estoque, 'Todos')}${optFiltro('PENDENTE', dfeFiltro.estoque, 'Entrada pendente')}${optFiltro('OK', dfeFiltro.estoque, 'Entrada OK')}${optFiltro('SEM_ITENS', dfeFiltro.estoque, 'Sem itens')}</select></label>
                <label class="sub" style="margin:0">Emissao de <input type="date" data-lista-filtro="dfe:de" value="${esc(dfeFiltro.de)}"></label>
                <label class="sub" style="margin:0">Ate <input type="date" data-lista-filtro="dfe:ate" value="${esc(dfeFiltro.ate)}"></label>
                <button class="btn" data-lista-limpar="dfe">Limpar filtros</button>
            </div>` : ''}
            <div id="dfe-lista">${renderListaDfe()}</div>
        </div>`;
    }

    function estoqueDoDfe(d) {
        if (d.entrada_confirmada) return 'OK';
        return Array.isArray(d.itens) && d.itens.length > 0 ? 'PENDENTE' : 'SEM_ITENS';
    }

    function dfeFiltrados() {
        const f = dfeFiltro;
        const busca = f.busca.trim().toLowerCase();
        return state.dfe.filter(d => {
            if (f.tipo && (d.resumo ? 'RESUMO' : 'COMPLETA') !== f.tipo) return false;
            if (f.estoque && estoqueDoDfe(d) !== f.estoque) return false;
            // dhEmi vem do XML como texto ISO (2026-09-01T10:00:00-03:00): o dia sao os 10 primeiros caracteres.
            const dia = String(d.dhEmi || '').slice(0, 10);
            if (f.de && (!dia || dia < f.de)) return false;
            if (f.ate && (!dia || dia > f.ate)) return false;
            if (busca) {
                const alvo = [d.nsu, d.chave, d.emitente, d.cnpjEmitente].join(' ').toLowerCase();
                if (!alvo.includes(busca)) return false;
            }
            return true;
        });
    }

    function renderListaDfe() {
        if (!state.dfe.length) return '<div class="empty">Nenhuma nota recebida sincronizada.</div>';
        const lista = dfeFiltrados();
        const pag = fatiarPagina(lista, dfeFiltro);
        const pager = pagerHtml('dfe', lista, pag, state.dfe.length, 'notas carregadas');
        if (!lista.length) return '<div class="empty">Nenhuma nota recebida encontrada com esses filtros.</div>' + pager;
        return dfeTable(pag.itens) + pager;
    }

    function dfeTable(docs) {
        return `<table><thead><tr><th>NSU</th><th>Chave</th><th>Emitente</th><th class="num">Valor</th><th>Emissao</th><th>Schema</th><th class="num">Estoque</th></tr></thead><tbody>${docs.map(d => {
            const temItens = Array.isArray(d.itens) && d.itens.length > 0;
            let acaoEstoque;
            if (d.entrada_confirmada) acaoEstoque = `<span class="badge b-ok">Entrada OK</span>${temItens ? ` <button class="btn" data-dfe-editar="${d.id}" style="margin-top:4px">${state.dfeEdicao === d.id ? 'Fechar' : 'Ver / editar itens'}</button>` : ''}`;
            else if (temItens) acaoEstoque = `<button class="btn" data-dfe-toggle="${d.id}">${state.dfeExpandido === d.id ? 'Fechar' : 'Ver itens'}</button>`;
            else acaoEstoque = '<span class="muted">Sem itens</span>';
            const linhaPrincipal = `<tr>
                <td>${esc(d.nsu || '-')}</td>
                <td class="chave">${esc(d.chave || '-')}</td>
                <td>${esc(d.emitente || d.cnpjEmitente || '-')}</td>
                <td class="num">${d.valor != null ? money(d.valor) : '-'}</td>
                <td>${esc(d.dhEmi || '-')}</td>
                <td><span class="badge ${d.resumo ? 'b-warn' : 'b-ok'}">${esc(d.schema || '-')}</span></td>
                <td class="num">${acaoEstoque}</td>
            </tr>`;
            const linhaExpandida = state.dfeExpandido === d.id ? linhaEntradaEstoque(d)
                : (state.dfeEdicao === d.id && d.entrada_confirmada ? linhaEdicaoEntrada(d) : '');
            return linhaPrincipal + linhaExpandida;
        }).join('')}</tbody></table>`;
    }

    // Normaliza (sem acento/pontuacao) pra comparar nomes de formas diferentes
    // de escrever o mesmo produto (nota fiscal x cadastro do cardapio/estoque).
    function normalizarNome(s) {
        return String(s || '').trim().toLowerCase()
            .normalize('NFD').replace(/[̀-ͯ]/g, '')
            .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function pontuarMatch(nomeNota, alvo) {
        const a = normalizarNome(nomeNota);
        if (!a) return 0;
        const apelidos = (alvo.apelidos || []).map(normalizarNome);
        if (apelidos.includes(a)) return 1000; // ja aprendido antes = certeza
        const b = normalizarNome(alvo.nome);
        if (a === b) return 999;
        // Tamanho (ml/litro/g/kg) decide: "TAMPICO 12X450ML" nunca casa com
        // "tampico 250 ml", nem "COCA-COLA PET 600ML" com "coca cola pet 200ml".
        // Antes so contava palavras em comum, e produtos da mesma marca em
        // tamanhos diferentes empatavam (ou o tamanho errado ganhava).
        const tamA = tamanhoDoNome(nomeNota), tamB = tamanhoDoNome(alvo.nome);
        if (tamA && tamB && tamA !== tamB) return 0;
        // Palavras com numero (tamanho, "12x", "12un") ficam fora da conta de
        // palavras: o tamanho ja foi comparado acima.
        const palavras = s => new Set(s.split(' ').filter(w => w.length > 2 && !/\d/.test(w)));
        const palavrasA = palavras(a), palavrasB = palavras(b);
        // Marca (primeira palavra) tem que bater: sem isso "PEPSI ZERO LATA"
        // caia em "sprite zero lata" e "DEL VALLE LARANJA" em "fanta laranja".
        // Sem sugestao e melhor que sugestao errada.
        const [marcaA] = palavrasA, [marcaB] = palavrasB;
        if (marcaA !== marcaB) return 0;
        // Sabor/variante tambem tem que bater exatamente: "PEPSI ZERO" nao e
        // "pepsi black", "FANTA UVA" nao e "fanta maracuja", "GUARANA DIET" nao
        // e o guarana normal.
        if (variantesDoNome(a) !== variantesDoNome(b)) return 0;
        let comuns = 0;
        palavrasA.forEach(w => { if (palavrasB.has(w)) comuns++; });
        if (comuns === 0 || !palavrasA.size || !palavrasB.size) return 0;
        // Divide pela uniao: palavra que so o cadastro tem (ex.: "zero") pesa
        // contra, pra "coca cola 600 ml" ganhar de "coca cola zero 600ml".
        const uniao = new Set([...palavrasA, ...palavrasB]).size;
        const pontos = (comuns / uniao) * 100;
        if (tamA && tamA === tamB) return pontos + 10;
        // So um dos lados tem tamanho: nao da pra confirmar que e o mesmo item.
        return (tamA || tamB) ? pontos * 0.6 : pontos;
    }

    // Sabores/variantes que distinguem produtos da mesma marca e tamanho.
    // "sa"/"acucar" (Coca-Cola SA, Sprite S/ACUCAR) contam como "zero".
    const VARIANTES = { zero: 'zero', sa: 'zero', acucar: 'zero', diet: 'diet', light: 'light', black: 'black',
        laranja: 'laranja', uva: 'uva', maracuja: 'maracuja', limao: 'limao', morango: 'morango',
        pessego: 'pessego', manga: 'manga', abacaxi: 'abacaxi', caju: 'caju', goiaba: 'goiaba', maca: 'maca', cafe: 'cafe' };
    function variantesDoNome(nomeNormalizado) {
        return [...new Set(nomeNormalizado.split(' ').map(w => VARIANTES[w]).filter(Boolean))].sort().join(',');
    }

    // Tamanho do produto no nome, convertido pra ml/g (ex.: "12x450ml" -> 450,
    // "2litros" -> 2000, "1,5L" -> 1500). null se o nome nao tiver tamanho.
    // Le do nome original (nao normalizado) pra nao perder a virgula decimal.
    function tamanhoDoNome(nome) {
        const s = String(nome || '').toLowerCase().replace(',', '.');
        const m = s.match(/(\d+(?:\.\d+)?)\s*(ml|litros?|lts?|l|kg|g)(?![a-z])/);
        if (!m) return null;
        const n = Number(m[1]);
        return Math.round(/^(litro|lt|l|kg)/.test(m[2]) ? n * 1000 : n);
    }

    // Sugere o item mais parecido com o nome vindo da nota (exato > apelido ja
    // aprendido > palavras em comum), numa lista generica (insumos ou cardapio).
    // Abaixo de um limiar, nao sugere nada, pra nao arriscar um match errado.
    function melhorMatch(nomeNota, lista) {
        let melhor = null, melhorPontos = 0;
        lista.forEach(i => {
            const p = pontuarMatch(nomeNota, i);
            if (p > melhorPontos) { melhorPontos = p; melhor = i; }
        });
        return melhorPontos >= 30 ? melhor : null;
    }

    function opcoesInsumos(selecionadoNome) {
        const match = melhorMatch(selecionadoNome, state.insumos);
        const opcoes = state.insumos.map(i =>
            `<option value="${esc(i.id)}" ${match && match.id === i.id ? 'selected' : ''}>${esc(i.nome)}</option>`
        ).join('');
        return `<option value="">+ Criar novo insumo</option>${opcoes}`;
    }

    function opcoesProdutos(selecionadoNome) {
        const match = melhorMatch(selecionadoNome, state.produtos);
        const opcoes = state.produtos.map(p =>
            `<option value="${esc(p.id)}" ${match && match.id === p.id ? 'selected' : ''}>${esc(p.nome || p.name || p.id)}</option>`
        ).join('');
        return `<option value="">Selecione o produto no cardapio...</option><option value="${PRODUTO_NOVO}">+ Cadastrar produto novo</option>${opcoes}`;
    }

    // Categorias pro produto novo. Mesma lista fixa do cadastro do Cardapio
    // (painel.html, #product-categoria) — antes so aparecia o que ja tinha
    // produto cadastrado, entao "Doces" nunca aparecia numa loja sem doce no
    // cardapio. Categorias extras que ja existam em produtos entram tambem, sem
    // duplicar por diferenca de maiuscula/acento ("Salgados fritos"/"Salgados Fritos").
    const CATEGORIAS_PADRAO = ['Doces', 'Bebidas', 'Salgados Fritos', 'Salgados assados', 'Molhos'];
    function opcoesCategorias(selecionada = '') {
        const chave = (c) => normalizarNome(c);
        const vistas = new Set(CATEGORIAS_PADRAO.map(chave));
        const extras = [];
        state.produtos.forEach(p => {
            const c = p.categoria;
            if (c && !vistas.has(chave(c))) { vistas.add(chave(c)); extras.push(c); }
        });
        extras.sort((a, b) => a.localeCompare(b, 'pt-BR'));
        return `<option value="">Categoria...</option>${[...CATEGORIAS_PADRAO, ...extras].map(c => `<option value="${esc(c)}" ${c === selecionada ? 'selected' : ''}>${esc(c)}</option>`).join('')}`;
    }

    // Origem da mercadoria (campo 'orig' do ICMS) — mesmas opcoes do Cardapio.
    const ORIGENS_FISCAIS = [
        ['0', '0 - Nacional'], ['1', '1 - Estrangeira (importacao direta)'], ['2', '2 - Estrangeira (mercado interno)'],
        ['3', '3 - Nacional, conteudo importado > 40%'], ['4', '4 - Nacional, PPB'], ['5', '5 - Nacional, conteudo importado <= 40%'],
        ['6', '6 - Estrangeira, sem similar nacional'], ['7', '7 - Estrangeira, mercado interno sem similar'], ['8', '8 - Nacional, conteudo importado > 70%'],
    ];
    function opcoesOrigem(selecionada = '') {
        return `<option value="">Usar padrao fiscal</option>${ORIGENS_FISCAIS.map(([v, t]) => `<option value="${v}" ${v === String(selecionada) ? 'selected' : ''}>${esc(t)}</option>`).join('')}`;
    }

    // Custo e unidade de um item NOVO no estoque, a partir da quantidade que o
    // operador confirmou. O vUnCom da nota e por unidade comercial (ex.: R$ 37,20
    // por PC = fardo de 12). Se o operador digitou outra quantidade (ex.: 24
    // garrafas), o custo vira valor total da linha / quantidade digitada, e a
    // unidade da nota (PC) deixa de valer, entao usa UN.
    function custoEUnidadeNovoItem(it, qtd) {
        const qCom = Number(it.qCom) || 0;
        const vUn = Number(it.vUnCom) || 0;
        if (!(qtd > 0) || !(qCom > 0) || Math.abs(qtd - qCom) < 1e-9) {
            return { custo: vUn, unidade: it.uCom || 'UN' };
        }
        return { custo: Math.round((qCom * vUn / qtd) * 10000) / 10000, unidade: 'UN' };
    }

    function linhaEntradaEstoque(d) {
        const linhasItens = d.itens.map((it, idx) => `<tr>
            <td>${esc(it.xProd || '-')}</td>
            <td>
                <select data-item-tipo="${idx}" style="margin-bottom:4px">
                    <option value="produto">Produto do cardapio</option>
                    <option value="insumo">Insumo (ingrediente)</option>
                </select>
                <select data-item-produto="${idx}">${opcoesProdutos(it.xProd)}</select>
                <div data-item-prod-novo="${idx}" style="display:none;margin-top:4px">
                    <input type="text" data-item-prod-nome="${idx}" placeholder="Nome do produto no cardapio" value="${esc(it.xProd || '')}">
                    <select data-item-prod-categoria="${idx}" style="margin-top:4px">${opcoesCategorias()}</select>
                    <div style="margin-top:6px;font-weight:700;font-size:.8rem">Classificacao fiscal (contabilidade)</div>
                    <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px;margin-top:2px">
                        <input type="text" data-item-prod-ncm="${idx}" placeholder="NCM (8 digitos)" inputmode="numeric" maxlength="8" value="${esc(String(it.ncm || '').replace(/\D/g, '').slice(0, 8))}" title="NCM da mercadoria — ja sugerido pelo da nota">
                        <input type="text" data-item-prod-cfop="${idx}" placeholder="CFOP venda (ex: 5102)" inputmode="numeric" maxlength="4" title="CFOP da VENDA (5102 revenda). Nao e o CFOP da compra que vem na nota.">
                        <input type="text" data-item-prod-csosn="${idx}" placeholder="CSOSN/CST (ex: 102)" inputmode="numeric" maxlength="3">
                        <select data-item-prod-origem="${idx}">${opcoesOrigem()}</select>
                    </div>
                    <small class="muted" style="display:block;margin-top:2px">Em branco = usa o padrao de Config fiscal. O NCM ja vem sugerido da nota; confirme com a contabilidade.</small>
                    <small class="muted" style="display:block;margin-top:4px">Entra no estoque agora e fica oculto do caixa, do app e do bot, sem preco, ate a loja completar o cadastro no Cardapio.</small>
                </div>
                <select data-item-insumo="${idx}" style="display:none">${opcoesInsumos(it.xProd)}</select>
                <input type="text" data-item-novo-nome="${idx}" placeholder="Nome do novo insumo" value="${esc(it.xProd || '')}" style="margin-top:4px;display:none">
            </td>
            <td class="num"><input type="number" step="0.001" min="0" data-item-qtd="${idx}" value="${esc(it.qCom ?? '')}" style="width:90px"></td>
            <td>${esc(it.uCom || '-')}</td>
            <td class="num" data-item-custo="${idx}">${it.vUnCom != null ? money(it.vUnCom) : '-'}</td>
        </tr>`).join('');
        return `<tr><td colspan="7" style="background:#f8fafc">
            <div class="panel" style="margin:6px 0;box-shadow:none">
                <p class="sub" style="margin-top:0">Escolha se cada item e um produto pronto do cardapio ou um insumo/ingrediente, confira a quantidade e confirme. Produto do cardapio ja liga sozinho com a baixa automatica de estoque nas vendas.</p>
                <table><thead><tr><th>Produto na nota</th><th>Corresponde a</th><th class="num">Quantidade</th><th>Unidade</th><th class="num">Custo unit.</th></tr></thead>
                <tbody>${linhasItens}</tbody></table>
                <div class="actions"><button class="btn primary" data-dfe-confirmar="${d.id}">Confirmar entrada no estoque</button><span class="msg" id="dfe-entrada-msg-${esc(d.id)}"></span></div>
            </div>
        </td></tr>`;
    }

    // ---------- Edicao de uma entrada JA lancada ----------
    // Mostra os itens da nota com o que foi lancado em cada um e deixa corrigir
    // quantidade, custo e dados fiscais do produto. O que entrou no estoque e lido
    // dos movimentos ("Entrada NF <chave>", mais as correcoes anteriores), entao
    // funciona tambem para notas lancadas antes de existir o vinculo item->insumo.
    // Correcao de quantidade nao reescreve a historia: gera um movimento AJUSTE
    // com a diferenca e soma atomica (increment) no saldo, que pode ter mudado por vendas.
    const CAMPOS_EDICAO = ['ed-qtd', 'ed-custo', 'ed-categoria', 'ed-ncm', 'ed-cfop', 'ed-csosn', 'ed-origem'];
    function capturarEdicao() {
        if (!state.dfeEdicao) return null;
        const valores = {};
        CAMPOS_EDICAO.forEach(c => document.querySelectorAll(`[data-${c}]`).forEach(el => {
            valores[`${c}:${el.getAttribute('data-' + c)}`] = el.value;
        }));
        const ativo = document.activeElement;
        const foco = CAMPOS_EDICAO.find(c => ativo && ativo.hasAttribute && ativo.hasAttribute('data-' + c));
        return { dfeId: state.dfeEdicao, valores, foco: foco ? `${foco}:${ativo.getAttribute('data-' + foco)}` : null };
    }
    function restaurarEdicao(salvo) {
        if (!salvo || salvo.dfeId !== state.dfeEdicao) return;
        Object.entries(salvo.valores).forEach(([chave, valor]) => {
            const [campo, idx] = chave.split(':');
            const el = document.querySelector(`[data-${campo}="${idx}"]`);
            if (!el) return;
            if (el.tagName === 'SELECT' && ![...el.options].some(o => o.value === valor)) return;
            el.value = valor;
        });
        if (salvo.foco) {
            const [campo, idx] = salvo.foco.split(':');
            document.querySelector(`[data-${campo}="${idx}"]`)?.focus();
        }
    }

    const arred3 = (n) => Math.round(n * 1000) / 1000;

    async function carregarEdicaoEntrada(d, aviso) {
        state.dfeEdicaoDados = { dfeId: d.id, carregando: true };
        render();
        try {
            const prefixo = `Entrada NF ${d.chave || d.nsu}`;
            const snap = await db.collection('estoque_movimentos')
                .where('motivo', '>=', prefixo).where('motivo', '<=', prefixo + '').get();
            const porInsumo = {};
            snap.forEach(doc => {
                const m = doc.data();
                // O prefixo tambem casaria com outra NF de numero parecido: exige fim exato ou espaco depois.
                if (!(m.motivo === prefixo || String(m.motivo).startsWith(prefixo + ' '))) return;
                if (!['ENTRADA', 'AJUSTE'].includes(m.tipo)) return;
                const o = porInsumo[m.insumo_id] = porInsumo[m.insumo_id] || { insumo_id: m.insumo_id, nome: m.insumo_nome, qtd: 0 };
                o.qtd = arred3(o.qtd + (Number(m.quantidade) || 0));
            });
            state.dfeEdicaoDados = { dfeId: d.id, carregando: false, porInsumo, aviso: aviso || '' };
        } catch (err) {
            state.dfeEdicaoDados = { dfeId: d.id, carregando: false, erro: err.message };
        }
        render();
    }

    // Liga cada item da nota ao insumo que recebeu a entrada: pelo vinculo gravado
    // no lancamento (entrada_itens) ou, nas notas antigas, pelo nome/apelido
    // aprendido (mesma regra de sugestao da tela de lancamento).
    function vinculosDaEntrada(d, porInsumo) {
        const produtoDoInsumo = (id) => state.produtos.find(p => p.insumo_vinculado_id === id) || null;
        const vinc = (d.itens || []).map((it, idx) => {
            const salvo = Array.isArray(d.entrada_itens) ? d.entrada_itens.find(x => x.idx === idx) : null;
            let insumoId = salvo && porInsumo[salvo.insumo_id] ? salvo.insumo_id : null;
            if (!insumoId) {
                let melhor = null, pts = 0;
                Object.values(porInsumo).forEach(c => {
                    const ins = state.insumos.find(i => i.id === c.insumo_id) || { nome: c.nome, apelidos: [] };
                    const prod = produtoDoInsumo(c.insumo_id);
                    const p = Math.max(pontuarMatch(it.xProd, ins), prod ? pontuarMatch(it.xProd, { nome: prod.nome, apelidos: prod.apelidos }) : 0);
                    if (p > pts) { pts = p; melhor = c.insumo_id; }
                });
                if (pts >= 30) insumoId = melhor;
            }
            return { idx, it, insumoId };
        });
        const contagem = {};
        vinc.forEach(v => { if (v.insumoId) { v.primeiro = !contagem[v.insumoId]; contagem[v.insumoId] = (contagem[v.insumoId] || 0) + 1; } });
        vinc.forEach(v => { v.compartilhado = !!v.insumoId && contagem[v.insumoId] > 1; });
        return vinc;
    }

    function linhaEdicaoEntrada(d) {
        const dados = state.dfeEdicaoDados;
        const envolve = (html) => `<tr><td colspan="7" style="background:#f8fafc">${html}</td></tr>`;
        if (!dados || dados.dfeId !== d.id || dados.carregando) return envolve('<p class="muted" style="margin:6px 0">Carregando o que foi lancado...</p>');
        if (dados.erro) return envolve(`<p style="color:#c0392b;margin:6px 0">Nao foi possivel carregar os lancamentos: ${esc(dados.erro)}</p>`);

        const linhas = vinculosDaEntrada(d, dados.porInsumo).map(v => {
            const it = v.it;
            const nomeNota = `<td>${esc(it.xProd || '-')}<br><span class="muted">${esc(it.uCom || '')} · nota: ${esc(it.qCom ?? '-')} x ${it.vUnCom != null ? money(it.vUnCom) : '-'}</span></td>`;
            if (!v.insumoId) return `<tr>${nomeNota}<td colspan="4" class="muted">Nao encontrei onde este item foi lancado (nota lancada antes de guardar o vinculo). Corrija pelo Estoque.</td></tr>`;
            const ins = state.insumos.find(i => i.id === v.insumoId);
            if (!ins) return `<tr>${nomeNota}<td colspan="4" class="muted">O insumo deste item foi removido do estoque.</td></tr>`;
            if (v.compartilhado && !v.primeiro) return `<tr>${nomeNota}<td colspan="4" class="muted">Somado na linha acima (os dois itens foram para o mesmo insumo).</td></tr>`;
            const prod = state.produtos.find(p => p.insumo_vinculado_id === v.insumoId);
            const lanc = dados.porInsumo[v.insumoId].qtd;
            const fiscal = prod ? `<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px">
                    <select data-ed-categoria="${v.idx}" style="grid-column:1/-1">${opcoesCategorias(prod.categoria || '')}</select>
                    <input type="text" data-ed-ncm="${v.idx}" placeholder="NCM" inputmode="numeric" maxlength="8" value="${esc(prod.ncm || '')}">
                    <input type="text" data-ed-cfop="${v.idx}" placeholder="CFOP venda" inputmode="numeric" maxlength="4" value="${esc(prod.cfop || '')}">
                    <input type="text" data-ed-csosn="${v.idx}" placeholder="CSOSN/CST" inputmode="numeric" maxlength="3" value="${esc(prod.csosn || prod.cst || '')}">
                    <select data-ed-origem="${v.idx}">${opcoesOrigem(prod.origem || '')}</select>
                </div>` : '<span class="muted">Insumo (sem dados fiscais de venda)</span>';
            return `<tr>${nomeNota}
                <td>${esc(prod ? (prod.nome_exibicao || prod.nome) : ins.nome)}<br><span class="muted">${prod ? 'Produto do cardapio' : 'Insumo'}${v.compartilhado ? ' · soma de mais de um item da nota' : ''}</span></td>
                <td class="num"><input type="number" step="0.001" min="0" data-ed-qtd="${v.idx}" value="${esc(lanc)}" style="width:90px"><br><span class="muted">Estoque agora: ${esc(arred3(Number(ins.quantidade_atual) || 0))} ${esc(ins.unidade || '')}</span></td>
                <td class="num"><input type="number" step="0.0001" min="0" data-ed-custo="${v.idx}" value="${esc(ins.custo_unitario ?? '')}" style="width:90px"></td>
                <td>${fiscal}</td>
            </tr>`;
        }).join('');

        const editada = d.entrada_editada_por ? `<p class="muted" style="margin:0 0 6px">Ultima edicao por ${esc(d.entrada_editada_por)}.</p>` : '';
        return envolve(`<div class="panel" style="margin:6px 0;box-shadow:none">
            <p class="sub" style="margin-top:0">Itens desta nota ja lancados no estoque. Mudar a <strong>quantidade lancada</strong> corrige o estoque pela diferenca (fica registrado como ajuste); o <strong>custo</strong> e os <strong>dados fiscais</strong> sao do cadastro do item.</p>
            ${editada}
            <table><thead><tr><th>Item na nota</th><th>Lancado em</th><th class="num">Qtd lancada</th><th class="num">Custo unit.</th><th>Dados fiscais</th></tr></thead><tbody>${linhas}</tbody></table>
            <div class="actions"><button class="btn primary" data-dfe-salvar-edicao="${d.id}">Salvar alteracoes</button><span class="msg" style="${dados.aviso ? 'color:#1f8f4d' : ''}">${esc(dados.aviso || '')}</span><span class="msg" id="dfe-edicao-msg-${esc(d.id)}"></span></div>
        </div>`);
    }

    async function salvarEdicaoEntrada(btn) {
        const dfeId = btn.dataset.dfeSalvarEdicao;
        const d = state.dfe.find(x => x.id === dfeId);
        const dados = state.dfeEdicaoDados;
        const msg = $(`dfe-edicao-msg-${dfeId}`);
        const erro = (t) => { if (msg) { msg.style.color = '#c0392b'; msg.textContent = t; } else alert(t); };
        if (!d || !dados || dados.dfeId !== dfeId || !dados.porInsumo) return;
        if (msg) msg.textContent = '';
        const operador = (firebase.auth().currentUser && firebase.auth().currentUser.email) || 'operador';
        const now = firebase.firestore.FieldValue.serverTimestamp();
        const ref = d.chave || d.nsu;
        const batch = db.batch();
        const mudancas = [], negativos = [];
        try {
            vinculosDaEntrada(d, dados.porInsumo).forEach(v => {
                if (!v.insumoId || (v.compartilhado && !v.primeiro)) return;
                const ins = state.insumos.find(i => i.id === v.insumoId);
                if (!ins) return;
                const campo = (c) => document.querySelector(`[data-ed-${c}="${v.idx}"]`);
                const nome = v.it.xProd || `item ${v.idx + 1}`;
                const insRef = db.collection('estoque_insumos').doc(ins.id);
                const updIns = {};

                const qtdNova = parseFloat(String(campo('qtd')?.value ?? '').replace(',', '.'));
                if (!(qtdNova >= 0)) throw new Error(`Quantidade invalida em "${nome}".`);
                const qtdAntes = dados.porInsumo[v.insumoId].qtd;
                const delta = arred3(qtdNova - qtdAntes);
                if (Math.abs(delta) >= 0.0005) {
                    const saldoNovo = arred3((Number(ins.quantidade_atual) || 0) + delta);
                    if (saldoNovo < 0) negativos.push(`${ins.nome} (ficaria ${saldoNovo})`);
                    updIns.quantidade_atual = firebase.firestore.FieldValue.increment(delta);
                    batch.set(db.collection('estoque_movimentos').doc(), {
                        insumo_id: ins.id, insumo_nome: ins.nome, tipo: 'AJUSTE',
                        quantidade: delta, saldo_resultante: saldoNovo,
                        motivo: `Entrada NF ${ref} - correcao (de ${qtdAntes} para ${qtdNova})`, operador, data: now
                    });
                    mudancas.push(`${ins.nome}: quantidade ${qtdAntes} -> ${qtdNova}`);
                }

                const custoTxt = String(campo('custo')?.value ?? '').replace(',', '.');
                if (custoTxt !== '') {
                    const custoNovo = parseFloat(custoTxt);
                    if (!(custoNovo >= 0)) throw new Error(`Custo invalido em "${nome}".`);
                    if (Math.abs(custoNovo - (Number(ins.custo_unitario) || 0)) >= 0.00005) {
                        updIns.custo_unitario = custoNovo;
                        mudancas.push(`${ins.nome}: custo ${ins.custo_unitario ?? 0} -> ${custoNovo}`);
                    }
                }
                if (Object.keys(updIns).length) { updIns.atualizado_em = now; batch.update(insRef, updIns); }

                const prod = state.produtos.find(p => p.insumo_vinculado_id === v.insumoId);
                if (prod && campo('ncm')) {
                    const val = (c) => String(campo(c)?.value ?? '').trim();
                    const ncm = val('ncm').replace(/\D/g, ''), cfop = val('cfop').replace(/\D/g, ''), csosn = val('csosn').replace(/\D/g, '');
                    const categoria = val('categoria'), origem = val('origem');
                    if (ncm && ncm.length !== 8) throw new Error(`NCM de "${nome}" precisa ter 8 digitos (ou deixe em branco).`);
                    if (cfop && !/^5\d{3}$/.test(cfop)) throw new Error(`CFOP de "${nome}" deve ser de venda dentro do estado (5xxx, ex: 5102) — ou deixe em branco.`);
                    if (csosn && !/^\d{2,3}$/.test(csosn)) throw new Error(`CSOSN/CST de "${nome}" precisa ter 2 ou 3 digitos (ex: 102) — ou deixe em branco.`);
                    if (!categoria) throw new Error(`Escolha a categoria de "${nome}".`);
                    const antes = { ncm: prod.ncm || '', cfop: prod.cfop || '', csosn: prod.csosn || prod.cst || '', origem: String(prod.origem ?? ''), categoria: prod.categoria || '' };
                    const depois = { ncm, cfop, csosn, origem, categoria };
                    const alterados = Object.keys(depois).filter(k => antes[k] !== depois[k]);
                    if (alterados.length) {
                        batch.update(db.collection('cardapio').doc(prod.id), { ncm, cfop, csosn, cst: csosn, origem, categoria, ultima_atualizacao: now });
                        mudancas.push(`${prod.nome_exibicao || prod.nome}: ${alterados.map(k => `${k} "${antes[k]}" -> "${depois[k]}"`).join(', ')}`);
                    }
                }
            });
            if (!mudancas.length) { erro('Nada foi alterado.'); return; }
            if (negativos.length && !confirm('Estas correcoes deixam o estoque NEGATIVO:\n\n- ' + negativos.join('\n- ') + '\n\nSalvar mesmo assim?')) return;
            batch.update(db.collection('dfe_documentos').doc(dfeId), {
                entrada_editada_em: now, entrada_editada_por: operador,
                entrada_edicoes: firebase.firestore.FieldValue.arrayUnion({ em: new Date().toISOString(), por: operador, resumo: mudancas.join('; ') })
            });
            btn.disabled = true;
            await batch.commit();
            await carregarEdicaoEntrada(d, `Salvo: ${mudancas.length} alteracao(oes).`);
        } catch (err) {
            btn.disabled = false;
            erro(err.message);
        }
    }

    function renderSettings() {
        return `<div class="panel">
            <div class="panel-head">
                <div>
                    <h2>Configuracao fiscal</h2>
                    <p class="muted">Servico fiscal, certificado, dados do emitente e classificacao padrao.</p>
                </div>
                <div style="display:flex;gap:8px">
                    <button class="btn" id="btn-testar-fiscal">Testar conexao</button>
                    <button class="btn" id="btn-visualizar-cupom">Visualizar cupom</button>
                </div>
            </div>
            <div class="switch-row">
                <div><div class="t">Ativar emissao fiscal</div><div class="d">Habilita NFC-e no sistema.</div></div>
                <label class="toggle"><input type="checkbox" id="f-ativo"><span></span></label>
            </div>
            <div id="fiscal-fields">
                <details class="acc" open>
                    <summary><span>Servico fiscal e emissao</span><span class="chev">&#9656;</span></summary>
                    <div class="acc-body">
                        <div class="settings-grid">
                            <label>Modo de emissao<select id="f-modo"><option value="manual">Manual</option><option value="automatico">Automatico</option><option value="ambos">Ambos</option></select></label>
                            <label>Ambiente<select id="f-ambiente"><option value="homologacao">Homologacao</option><option value="producao">Producao</option></select></label>
                            <label>URL do servico fiscal<input id="f-url" placeholder="https://seu-servico.onrender.com"></label>
                            <label>Chave API do servico<input id="f-apikey" placeholder="token de acesso"></label>
                        </div>
                    </div>
                </details>

                <details class="acc">
                    <summary><span>Certificado A1</span><span class="chev">&#9656;</span></summary>
                    <div class="acc-body">
                        <p class="sub">Envie o .pfx/.p12 e a senha. O arquivo e a senha ficam protegidos no backend fiscal.</p>
                        <div class="settings-grid">
                            <label>Arquivo do certificado<input type="file" id="f-cert-file" accept=".pfx,.p12"></label>
                            <label>Senha do certificado<input type="password" id="f-cert-senha" autocomplete="off"></label>
                        </div>
                        <div class="actions"><button class="btn" id="btn-enviar-cert">Enviar certificado</button><span class="msg" id="cert-msg"></span></div>
                    </div>
                </details>

                <details class="acc" open>
                    <summary><span>Empresa emitente</span><span class="chev">&#9656;</span></summary>
                    <div class="acc-body">
                        <div class="settings-grid">
                            <label>Razao social<input id="f-razao"></label>
                            <label>Nome fantasia<input id="f-fantasia"></label>
                            <label>CNPJ<input id="f-cnpj"></label>
                            <label>Inscricao Estadual<input id="f-ie"></label>
                            <label>UF<input id="f-uf" maxlength="2" placeholder="MG"></label>
                            <label>Regime tributario<select id="f-regime"><option value="simples">Simples Nacional</option><option value="normal">Regime Normal</option></select></label>
                            <label>Serie NFC-e<input id="f-serie" type="number" min="1"></label>
                            <label>ID token CSC<input id="f-cscid"></label>
                        </div>
                        <div class="settings-grid full" style="margin-top:12px">
                            <label>CSC<input id="f-csc"></label>
                        </div>
                    </div>
                </details>

                <details class="acc">
                    <summary><span>Numeracao da NFC-e</span><span class="chev">&#9656;</span></summary>
                    <div class="acc-body">
                        <p class="sub">Defina qual sera o proximo numero de nota emitido pelo sistema. Use isso para continuar a partir da numeracao ja usada em outro sistema (ex: HGestor Chef), evitando duplicidade na SEFAZ.</p>
                        <div class="settings-grid">
                            <label>Proximo numero a emitir<input id="f-proximo-nnf" type="number" min="1"></label>
                        </div>
                        <div class="actions"><button class="btn" id="btn-definir-numeracao">Definir numeracao</button><span class="msg" id="numeracao-msg"></span></div>
                    </div>
                </details>

                <details class="acc">
                    <summary><span>Endereco do emitente</span><span class="chev">&#9656;</span></summary>
                    <div class="acc-body">
                        <div class="settings-grid">
                            <label>Logradouro<input id="f-xlgr"></label>
                            <label>Numero<input id="f-nro"></label>
                            <label>Complemento<input id="f-xcpl"></label>
                            <label>Bairro<input id="f-xbairro"></label>
                            <label>Municipio<input id="f-xmun"></label>
                            <label>Codigo IBGE municipio<input id="f-cmun" placeholder="Ex: 3147907"></label>
                            <label>CEP<input id="f-cep"></label>
                            <label>Telefone<input id="f-fone"></label>
                        </div>
                    </div>
                </details>

                <details class="acc">
                    <summary><span>URLs NFC-e</span><span class="chev">&#9656;</span></summary>
                    <div class="acc-body">
                        <p class="sub">O sistema escolhe automaticamente o par certo com base no Ambiente selecionado acima (Homologacao/Producao) — nao precisa trocar manualmente ao migrar de ambiente.</p>
                        <div class="settings-grid">
                            <label>URL do QR Code (Homologacao)<input id="f-qrbase-hom"></label>
                            <label>URL do QR Code (Producao)<input id="f-qrbase-prod"></label>
                            <label>URL de consulta por chave (Homologacao)<input id="f-urlchave-hom"></label>
                            <label>URL de consulta por chave (Producao)<input id="f-urlchave-prod"></label>
                        </div>
                    </div>
                </details>

                <details class="acc">
                    <summary><span>Classificacao fiscal padrao</span><span class="chev">&#9656;</span></summary>
                    <div class="acc-body">
                        <div class="settings-grid">
                            <label>NCM padrao<input id="f-ncm"></label>
                            <label>CFOP padrao<input id="f-cfop"></label>
                            <label>CSOSN/CST padrao<input id="f-cst"></label>
                            <label>Origem<select id="f-origem"><option value="0">0 - Nacional</option><option value="1">1 - Estrangeira direta</option><option value="2">2 - Estrangeira mercado interno</option></select></label>
                        </div>
                    </div>
                </details>

                <details class="acc">
                    <summary><span>Tributos aproximados (Lei 12.741/2012)</span><span class="chev">&#9656;</span></summary>
                    <div class="acc-body">
                        <p class="sub">Valor exigido no cupom mostrando a carga tributaria aproximada. Prioridade: se o Token IBPT estiver preenchido, a aliquota real de cada item e consultada por NCM (tabela oficial, atualizada automaticamente); senao, usa o percentual fixo abaixo.</p>
                        <div class="settings-grid">
                            <label>Token IBPT (De Olho no Imposto)<input id="f-ibpt-token" placeholder="Gerado em deolhonoimposto.ibpt.org.br"></label>
                            <label>Aliquota fixa alternativa (%)<input id="f-trib" type="number" min="0" max="100" step="0.01" placeholder="Ex: 12.5"></label>
                        </div>
                    </div>
                </details>
            </div>
            <div class="actions"><button class="btn primary" id="btn-salvar-fiscal">Salvar configuracao fiscal</button><span class="msg" id="fiscal-msg"></span></div>
        </div>`;
    }

    function renderRules() {
        return `<div class="panel"><div class="panel-head"><h2>Regras e defaults fiscais</h2><button class="btn" data-tab-go="settings">Editar defaults</button></div><table><tbody><tr><td>NCM padrao</td><td>${esc(state.cfg.ncm || '-')}</td></tr><tr><td>CFOP padrao</td><td>${esc(state.cfg.cfop || '-')}</td></tr><tr><td>CSOSN/CST padrao</td><td>${esc(state.cfg.cst || state.cfg.csosn || '-')}</td></tr><tr><td>Origem padrao</td><td>${esc(state.cfg.origem || '0')}</td></tr><tr><td>Ambiente</td><td>${esc(state.cfg.ambiente || 'homologacao')}</td></tr></tbody></table></div>`;
    }

    function renderCompany() {
        return `<div class="panel"><div class="panel-head"><h2>Empresa e certificado</h2><button class="btn" data-tab-go="settings">Editar</button></div><table><tbody><tr><td>Razao social</td><td>${esc(state.cfg.razao || '-')}</td></tr><tr><td>Fantasia</td><td>${esc(state.cfg.fantasia || '-')}</td></tr><tr><td>CNPJ</td><td>${esc(state.cfg.cnpj || '-')}</td></tr><tr><td>IE / UF</td><td>${esc(state.cfg.ie || '-')} / ${esc(state.cfg.uf || '-')}</td></tr><tr><td>Servico fiscal</td><td class="chave">${esc(state.cfg.url || '-')}</td></tr><tr><td>Certificado</td><td>Cadastro protegido no backend fiscal</td></tr></tbody></table></div>`;
    }

    function renderProducts() {
        if (!state.produtos.length) return '<div class="panel"><h2>Produtos</h2><div class="empty">Nenhum item no cardapio.</div></div>';
        return `<div class="panel"><div class="panel-head"><h2>Produtos e classificacao fiscal</h2><div style="display:flex;gap:8px;align-items:center"><button class="btn" id="btn-prewarm-ibpt">Atualizar tributos (IBPT)</button><a class="link" href="/painel.html#cardapio">Editar cardapio</a></div></div><p class="sub" id="prewarm-msg" style="margin-top:-6px"></p><table><thead><tr><th>Produto</th><th>NCM</th><th>CFOP</th><th>CSOSN/CST</th><th>Tributos aprox.</th><th>Status</th></tr></thead><tbody>${state.produtos.map(p => {
            const ncm = p.ncm || state.cfg.ncm;
            const ok = !!ncm && !!(p.cfop || state.cfg.cfop) && !!(p.csosn || p.cst || state.cfg.cst || state.cfg.csosn);
            const pct = ncm ? aliquotaIbptDoNcm(ncm) : null;
            const trib = pct != null
                ? `<span class="badge b-ok">${pct.toFixed(2).replace('.', ',')}%</span>`
                : `<span class="badge b-warn">Nao consultado</span>`;
            return `<tr><td>${esc(p.nome || p.name || '-')}</td><td>${esc(ncm || '-')}</td><td>${esc(p.cfop || state.cfg.cfop || '-')}</td><td>${esc(p.csosn || p.cst || state.cfg.cst || state.cfg.csosn || '-')}</td><td>${trib}</td><td><span class="badge ${ok ? 'b-ok' : 'b-warn'}">${ok ? 'OK' : 'Pendente'}</span></td></tr>`;
        }).join('')}</tbody></table></div>`;
    }

    function renderPlaceholder(title, text) {
        return `<div class="panel"><h2>${esc(title)}</h2><p class="muted">${esc(text)}</p></div>`;
    }

    function bindActions() {
        document.querySelectorAll('[data-tab-go]').forEach(btn => btn.onclick = () => { state.tab = btn.dataset.tabGo; renderTabs(); render(); });
        document.querySelectorAll('[data-refresh-config]').forEach(btn => btn.onclick = loadConfig);
        document.querySelectorAll('[data-emitir]').forEach(btn => btn.onclick = () => emitir(btn));
        document.querySelectorAll('[data-cancelar-venda]').forEach(btn => btn.onclick = () => cancelarVenda(btn));
        // A tabela de documentos e reaproveitada pela aba Relatorio (que pode
        // mostrar notas de meses passados, fora de state.notas — que so tem
        // as de hoje), entao o botao de cada linha precisa procurar nas duas.
        const notaPorId = (id) => state.notas.find(n => n.id === id) || state.notasRelatorio.find(n => n.id === id);
        document.querySelectorAll('[data-danfe]').forEach(btn => btn.onclick = () => baixarDanfe(notaPorId(btn.dataset.danfe)));
        document.querySelectorAll('[data-xml]').forEach(btn => btn.onclick = () => baixarXml(notaPorId(btn.dataset.xml)));
        document.querySelectorAll('[data-imprimir]').forEach(btn => btn.onclick = () => imprimirDanfe(notaPorId(btn.dataset.imprimir)));
        document.querySelectorAll('[data-transmitir]').forEach(btn => btn.onclick = () => transmitir(btn));
        document.querySelectorAll('[data-cancelar]').forEach(btn => btn.onclick = () => cancelar(btn));
        const docBind = (id, campo, evento) => {
            const el = $(id);
            if (!el) return;
            el[evento] = () => { docFiltro[campo] = el.value; docFiltro.pagina = 1; atualizarListaDocumentos(); };
        };
        docBind('doc-busca', 'busca', 'oninput');
        docBind('doc-status', 'status', 'onchange');
        docBind('doc-forma', 'forma', 'onchange');
        docBind('doc-de', 'de', 'onchange');
        docBind('doc-ate', 'ate', 'onchange');
        const docLimpar = $('doc-limpar');
        if (docLimpar) docLimpar.onclick = () => { Object.assign(docFiltro, { busca: '', status: '', forma: '', de: '', ate: '', pagina: 1 }); render(); };
        const docPorPag = $('doc-por-pagina');
        if (docPorPag) docPorPag.onchange = () => { docFiltro.porPagina = Number(docPorPag.value) || 20; docFiltro.pagina = 1; atualizarListaDocumentos(); };
        document.querySelectorAll('[data-doc-pag]').forEach(btn => btn.onclick = () => { docFiltro.pagina += Number(btn.dataset.docPag); atualizarListaDocumentos(); });
        document.querySelectorAll('[data-lista-filtro]').forEach(el => {
            const [chave, campo] = el.dataset.listaFiltro.split(':');
            const f = listas[chave].filtro;
            el[el.type === 'search' ? 'oninput' : 'onchange'] = () => { f[campo] = el.value; f.pagina = 1; atualizarLista(chave); };
        });
        document.querySelectorAll('[data-lista-limpar]').forEach(btn => btn.onclick = () => {
            const f = listas[btn.dataset.listaLimpar].filtro;
            Object.keys(f).forEach(k => { if (k !== 'pagina' && k !== 'porPagina') f[k] = ''; });
            f.pagina = 1;
            render();
        });
        document.querySelectorAll('[data-lista-por-pagina]').forEach(sel => sel.onchange = () => {
            const f = listas[sel.dataset.listaPorPagina].filtro;
            f.porPagina = Number(sel.value) || 20;
            f.pagina = 1;
            atualizarLista(sel.dataset.listaPorPagina);
        });
        document.querySelectorAll('[data-lista-pag]').forEach(btn => btn.onclick = () => {
            const [chave, passo] = btn.dataset.listaPag.split(':');
            listas[chave].filtro.pagina += Number(passo);
            atualizarLista(chave);
        });
        const inut = $('btn-inutilizar-range');
        if (inut) inut.onclick = inutilizar;
        const syncDfe = $('btn-sync-dfe');
        if (syncDfe) syncDfe.onclick = () => sincronizarDfe(syncDfe);
        const importarXml = $('btn-importar-xml');
        const arquivoXml = $('dfe-arquivo-xml');
        if (importarXml && arquivoXml) {
            importarXml.onclick = () => arquivoXml.click();
            arquivoXml.onchange = () => importarXmlAvulso(arquivoXml);
        }
        const ativo = $('f-ativo');
        if (ativo) {
            preencherFiscalForm();
            ativo.onchange = refletirFiscalAtivo;
        }
        const salvarFiscal = $('btn-salvar-fiscal');
        if (salvarFiscal) salvarFiscal.onclick = salvarConfiguracaoFiscal;
        const testarFiscal = $('btn-testar-fiscal');
        if (testarFiscal) testarFiscal.onclick = testarConexaoFiscal;
        const visualizarCupom = $('btn-visualizar-cupom');
        if (visualizarCupom) visualizarCupom.onclick = () => visualizarCupomFiscal(visualizarCupom);
        const prewarmIbpt = $('btn-prewarm-ibpt');
        if (prewarmIbpt) prewarmIbpt.onclick = () => atualizarTributosIbpt(prewarmIbpt);
        const enviarCert = $('btn-enviar-cert');
        if (enviarCert) enviarCert.onclick = enviarCertificadoFiscal;
        const definirNumeracao = $('btn-definir-numeracao');
        if (definirNumeracao) definirNumeracao.onclick = definirNumeracaoFiscal;
        document.querySelectorAll('[data-dfe-editar]').forEach(btn => btn.onclick = () => {
            const id = btn.dataset.dfeEditar;
            if (state.dfeEdicao === id) { state.dfeEdicao = null; state.dfeEdicaoDados = null; render(); return; }
            state.dfeEdicao = id;
            state.dfeExpandido = null;
            carregarEdicaoEntrada(state.dfe.find(x => x.id === id));
        });
        document.querySelectorAll('[data-dfe-salvar-edicao]').forEach(btn => btn.onclick = () => salvarEdicaoEntrada(btn));
        document.querySelectorAll('[data-dfe-toggle]').forEach(btn => btn.onclick = () => {
            state.dfeExpandido = state.dfeExpandido === btn.dataset.dfeToggle ? null : btn.dataset.dfeToggle;
            render();
        });
        document.querySelectorAll('[data-item-insumo]').forEach(sel => sel.onchange = () => {
            const idx = sel.dataset.itemInsumo;
            const novoNome = document.querySelector(`[data-item-novo-nome="${idx}"]`);
            // So vale com "Insumo" escolhido: este select existe (escondido)
            // tambem no modo "Produto do cardapio", e sem essa checagem o campo
            // "Nome do novo insumo" aparecia solto embaixo do produto.
            const ehInsumo = document.querySelector(`[data-item-tipo="${idx}"]`)?.value === 'insumo';
            if (novoNome) novoNome.style.display = (ehInsumo && sel.value === '') ? 'block' : 'none';
        });
        document.querySelectorAll('[data-item-tipo]').forEach(sel => sel.onchange = () => {
            const idx = sel.dataset.itemTipo;
            const selProduto = document.querySelector(`[data-item-produto="${idx}"]`);
            const selInsumo = document.querySelector(`[data-item-insumo="${idx}"]`);
            const novoNome = document.querySelector(`[data-item-novo-nome="${idx}"]`);
            const prodNovo = document.querySelector(`[data-item-prod-novo="${idx}"]`);
            const ehInsumo = sel.value === 'insumo';
            if (selProduto) selProduto.style.display = ehInsumo ? 'none' : 'block';
            if (selInsumo) selInsumo.style.display = ehInsumo ? 'block' : 'none';
            if (novoNome) novoNome.style.display = (ehInsumo && selInsumo && selInsumo.value === '') ? 'block' : 'none';
            if (prodNovo) prodNovo.style.display = (!ehInsumo && selProduto && selProduto.value === PRODUTO_NOVO) ? 'block' : 'none';
        });
        document.querySelectorAll('[data-item-produto]').forEach(sel => sel.onchange = () => {
            const idx = sel.dataset.itemProduto;
            const prodNovo = document.querySelector(`[data-item-prod-novo="${idx}"]`);
            const ehProduto = document.querySelector(`[data-item-tipo="${idx}"]`)?.value !== 'insumo';
            if (prodNovo) prodNovo.style.display = (ehProduto && sel.value === PRODUTO_NOVO) ? 'block' : 'none';
        });
        // Mostra o custo unitario ja recalculado pela quantidade digitada (so vale
        // pra item novo no estoque; item existente mantem o custo do cadastro).
        document.querySelectorAll('[data-item-qtd]').forEach(inp => inp.oninput = () => {
            const idx = inp.dataset.itemQtd;
            const dfeId = inp.closest('.panel')?.querySelector('[data-dfe-confirmar]')?.dataset.dfeConfirmar;
            const d = state.dfe.find(x => x.id === dfeId);
            const it = d && d.itens && d.itens[idx];
            const cel = document.querySelector(`[data-item-custo="${idx}"]`);
            if (!it || !cel || it.vUnCom == null) return;
            cel.textContent = money(custoEUnidadeNovoItem(it, parseFloat(inp.value)).custo);
        });
        document.querySelectorAll('[data-dfe-confirmar]').forEach(btn => btn.onclick = () => confirmarEntradaEstoque(btn));

        const relatorioMes = $('relatorio-mes');
        if (relatorioMes) relatorioMes.onchange = () => {
            state.relatorioMes = relatorioMes.value || mesAtualStr();
            listenRelatorio(state.relatorioMes);
            render();
        };
        const relatorioCsv = $('btn-relatorio-csv');
        if (relatorioCsv) relatorioCsv.onclick = () => {
            exportarRelatorioCsv(state.notasRelatorio, state.relatorioMes || mesAtualStr());
        };
        const relatorioZip = $('btn-relatorio-zip');
        if (relatorioZip) relatorioZip.onclick = () => {
            exportarXmlsZip(state.notasRelatorio, state.relatorioMes || mesAtualStr(), relatorioZip);
        };
    }

    function setVal(id, value) {
        const el = $(id);
        if (el) el.value = value == null ? '' : value;
    }

    function getVal(id) {
        const el = $(id);
        return el ? String(el.value || '').trim() : '';
    }

    function preencherFiscalForm() {
        const d = state.cfg || {};
        const ativo = $('f-ativo');
        if (ativo) ativo.checked = !!d.ativo;
        setVal('f-modo', d.modo || 'manual');
        setVal('f-url', d.url || '');
        setVal('f-apikey', d.apiKey || '');
        setVal('f-razao', d.razao || '');
        setVal('f-fantasia', d.fantasia || '');
        setVal('f-cnpj', d.cnpj || '');
        setVal('f-ie', d.ie || '');
        setVal('f-uf', d.uf || '');
        setVal('f-regime', d.regime || 'simples');
        setVal('f-ambiente', d.ambiente || 'homologacao');
        setVal('f-serie', d.serie || 1);
        setVal('f-proximo-nnf', (Number(d.seqNNF) || 0) + 1);
        setVal('f-csc', d.csc || '');
        setVal('f-cscid', d.cscId || '');
        setVal('f-xlgr', d.xLgr || '');
        setVal('f-nro', d.nro || '');
        setVal('f-xcpl', d.xCpl || '');
        setVal('f-xbairro', d.xBairro || '');
        setVal('f-xmun', d.xMun || '');
        setVal('f-cmun', d.cMun || '');
        setVal('f-cep', d.cep || '');
        setVal('f-fone', d.fone || '');
        // Migracao: se ainda so existir o valor antigo (unico), usa como Homologacao.
        setVal('f-qrbase-hom', d.qrBaseUrlHom || d.qrBaseUrl || '');
        setVal('f-qrbase-prod', d.qrBaseUrlProd || '');
        setVal('f-urlchave-hom', d.urlChaveHom || d.urlChave || '');
        setVal('f-urlchave-prod', d.urlChaveProd || '');
        setVal('f-ncm', d.ncm || '');
        setVal('f-cfop', d.cfop || '');
        setVal('f-cst', d.cst || '');
        setVal('f-origem', d.origem || '0');
        setVal('f-trib', d.aliquotaAproxTributos != null ? d.aliquotaAproxTributos : '');
        setVal('f-ibpt-token', d.ibptToken || '');
        refletirFiscalAtivo();
    }

    function refletirFiscalAtivo() {
        const fields = $('fiscal-fields');
        const ativo = $('f-ativo');
        if (fields && ativo) fields.classList.toggle('disabled', !ativo.checked);
    }

    function fiscalPayload() {
        return {
            ativo: !!$('f-ativo')?.checked,
            modo: getVal('f-modo') || 'manual',
            url: getVal('f-url').replace(/\/$/, ''),
            apiKey: getVal('f-apikey'),
            razao: getVal('f-razao'),
            fantasia: getVal('f-fantasia'),
            cnpj: getVal('f-cnpj'),
            ie: getVal('f-ie'),
            uf: getVal('f-uf').toUpperCase(),
            regime: getVal('f-regime') || 'simples',
            ambiente: getVal('f-ambiente') || 'homologacao',
            serie: parseInt(getVal('f-serie'), 10) || 1,
            csc: getVal('f-csc'),
            cscId: getVal('f-cscid'),
            xLgr: getVal('f-xlgr'),
            nro: getVal('f-nro'),
            xCpl: getVal('f-xcpl'),
            xBairro: getVal('f-xbairro'),
            xMun: getVal('f-xmun'),
            cMun: getVal('f-cmun'),
            cep: getVal('f-cep'),
            fone: getVal('f-fone'),
            qrBaseUrlHom: getVal('f-qrbase-hom').replace(/\/$/, ''),
            qrBaseUrlProd: getVal('f-qrbase-prod').replace(/\/$/, ''),
            urlChaveHom: getVal('f-urlchave-hom').replace(/\/$/, ''),
            urlChaveProd: getVal('f-urlchave-prod').replace(/\/$/, ''),
            ncm: getVal('f-ncm'),
            cfop: getVal('f-cfop'),
            cst: getVal('f-cst'),
            origem: getVal('f-origem') || '0',
            aliquotaAproxTributos: parseFloat(getVal('f-trib')) || 0,
            ibptToken: getVal('f-ibpt-token')
        };
    }

    async function salvarConfiguracaoFiscal() {
        const msg = $('fiscal-msg');
        if (msg) msg.textContent = 'Salvando...';
        try {
            const payload = fiscalPayload();
            await db.collection('configuracoes').doc('fiscal').set(payload, { merge: true });
            state.cfg = { ...state.cfg, ...payload };
            showAlert(payload.ativo && payload.url ? '' : 'Complete a configuracao fiscal para emitir NFC-e.');
            if (msg) msg.textContent = 'Configuracao fiscal salva.';
        } catch (err) {
            if (msg) msg.textContent = '';
            alert('Erro ao salvar: ' + err.message);
        }
    }

    async function testarConexaoFiscal() {
        const msg = $('fiscal-msg');
        const url = getVal('f-url').replace(/\/$/, '');
        const apiKey = getVal('f-apikey');
        if (!url) { if (msg) msg.textContent = 'Informe a URL do servico fiscal.'; return; }
        if (msg) msg.textContent = 'Testando...';
        try {
            const resp = await fetch(`${url}/fiscal/health`, {
                headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}
            });
            if (msg) msg.textContent = resp.ok ? 'Conexao OK com o servico fiscal.' : `Servico respondeu ${resp.status}.`;
        } catch (err) {
            if (msg) msg.textContent = 'Nao foi possivel conectar ao servico fiscal.';
        }
    }

    async function definirNumeracaoFiscal() {
        const msg = $('numeracao-msg');
        const proximo = parseInt(getVal('f-proximo-nnf'), 10);
        if (!proximo || proximo < 1) { if (msg) msg.textContent = 'Informe um numero valido (maior que zero).'; return; }
        if (!confirm(`Confirma que a proxima NFC-e emitida por este sistema usara o numero ${proximo}? So faca isso se souber qual foi o ultimo numero emitido no outro sistema (ex: HGestor Chef), para nao gerar numeracao duplicada ou com falhas perante a SEFAZ.`)) return;
        if (msg) msg.textContent = 'Salvando...';
        try {
            await db.collection('configuracoes').doc('fiscal').set({ seqNNF: proximo - 1 }, { merge: true });
            state.cfg = { ...state.cfg, seqNNF: proximo - 1 };
            if (msg) msg.textContent = `Numeracao definida. Proxima NFC-e sera emitida com o numero ${proximo}.`;
        } catch (err) {
            if (msg) msg.textContent = '';
            alert('Erro ao definir numeracao: ' + err.message);
        }
    }

    async function atualizarTributosIbpt(btn) {
        const msg = $('prewarm-msg');
        if (!state.cfg.ibptToken) { if (msg) msg.textContent = 'Configure o Token IBPT em Config fiscal primeiro.'; return; }
        const ncms = [...new Set(state.produtos.map(p => p.ncm || state.cfg.ncm).filter(Boolean))];
        if (!ncms.length) { if (msg) msg.textContent = 'Nenhum NCM encontrado nos produtos ou na config padrao.'; return; }
        btn.disabled = true;
        btn.textContent = 'Iniciando...';
        if (msg) msg.textContent = '';
        try {
            const result = await FiscalClient.prewarmTributosIbpt(ncms);
            if (msg) msg.textContent = `Atualizacao iniciada em segundo plano para ${result.iniciados} NCM(s) distintos. Pode levar alguns minutos na primeira vez (consultas novas levam ~15-20s cada); as proximas emissoes/visualizacoes ja usam o cache.`;
        } catch (err) {
            if (msg) msg.textContent = err.message;
        } finally {
            btn.disabled = false;
            btn.textContent = 'Atualizar tributos (IBPT)';
        }
    }

    async function visualizarCupomFiscal(btn) {
        // Abre a aba já aqui (dentro do clique), senão o navegador bloqueia o
        // popup depois que a Promise resolve (perde o "gesto do usuário").
        const janela = window.open('', '_blank');
        btn.disabled = true;
        btn.textContent = 'Gerando...';
        try {
            await FiscalClient.visualizarCupom(janela);
        } catch (err) {
            if (janela && !janela.closed) janela.close();
            alert(err.message);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Visualizar cupom';
        }
    }

    async function enviarCertificadoFiscal() {
        const msg = $('cert-msg');
        const url = getVal('f-url').replace(/\/$/, '');
        const apiKey = getVal('f-apikey');
        const file = $('f-cert-file')?.files?.[0];
        const senha = getVal('f-cert-senha');
        if (!url) { if (msg) msg.textContent = 'Informe a URL do servico fiscal.'; return; }
        if (!file) { if (msg) msg.textContent = 'Selecione o arquivo .pfx/.p12.'; return; }
        if (!senha) { if (msg) msg.textContent = 'Informe a senha do certificado.'; return; }
        if (msg) msg.textContent = 'Enviando...';
        try {
            const fd = new FormData();
            fd.append('certificado', file);
            fd.append('password', senha);
            const resp = await fetch(`${url}/fiscal/certificado`, {
                method: 'POST',
                headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {},
                body: fd
            });
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok || !data.ok) throw new Error(data.error || `Falha (${resp.status}).`);
            if ($('f-cert-file')) $('f-cert-file').value = '';
            if ($('f-cert-senha')) $('f-cert-senha').value = '';
            if (msg) msg.textContent = data.message || 'Certificado enviado.';
        } catch (err) {
            if (msg) msg.textContent = err.message;
        }
    }

    async function emitir(btn) {
        const pedido = state.pedidos.find(p => p.id === btn.dataset.emitir);
        if (!pedido) return;
        btn.disabled = true;
        btn.textContent = 'Iniciando...';
        try {
            // So espera a reserva do numero e a gravacao do registro "PROCESSANDO"
            // (rapido, so Firestore) — a comunicacao com a SEFAZ roda em segundo
            // plano e o status muda sozinho na tabela (badge "Processando...")
            // assim que o listener do Firestore receber a atualizacao.
            await FiscalClient.emitir(pedido.id, pedido);
        } catch (err) {
            alert(err.message);
            btn.disabled = false;
            btn.textContent = 'Emitir NFC-e';
        }
    }

    async function cancelarVenda(btn) {
        const id = btn.dataset.cancelarVenda;
        const pedido = state.pedidos.find(p => p.id === id);
        if (!pedido) return;
        const nota = notaFiscalPorPedido()[id];
        const st = nota ? String(nota.status || '').toUpperCase() : null;
        if (st === 'AUTORIZADA' || st === 'CONTINGENCIA' || st === 'PROCESSANDO') {
            alert('Esta venda tem uma NFC-e ativa — cancele a nota fiscal antes de cancelar a venda.');
            return;
        }
        if (!confirm(`Cancelar a venda #${String(id).slice(0, 6)} (${money(pedido.valor_total)})? Isso não pode ser desfeito.`)) return;
        btn.disabled = true;
        btn.textContent = 'Cancelando...';
        try {
            await db.collection('pedidos').doc(id).update({ status: 'CANCELADO' });
        } catch (err) {
            alert(err.message);
            btn.disabled = false;
            btn.textContent = 'Cancelar venda';
        }
    }

    async function transmitir(btn) {
        if (!confirm('Transmitir esta NFC-e de contingencia para a SEFAZ agora?')) return;
        btn.disabled = true;
        btn.textContent = 'Transmitindo...';
        try {
            await FiscalClient.transmitirContingencia(btn.dataset.transmitir);
            alert('NFC-e transmitida com sucesso.');
        } catch (err) {
            alert(err.message);
            btn.disabled = false;
            btn.textContent = 'Transmitir';
        }
    }

    async function cancelar(btn) {
        const just = prompt('Justificativa do cancelamento (15 a 255 caracteres):', '');
        if (just == null) return;
        if (just.trim().length < 15) { alert('A justificativa precisa ter pelo menos 15 caracteres.'); return; }
        if (!confirm('Confirmar cancelamento na SEFAZ?')) return;
        btn.disabled = true;
        btn.textContent = 'Cancelando...';
        try {
            await FiscalClient.cancelar(btn.dataset.cancelar, just.trim());
            alert('NFC-e cancelada.');
        } catch (err) {
            alert(err.message);
            btn.disabled = false;
            btn.textContent = 'Cancelar';
        }
    }

    async function inutilizar() {
        const payload = {
            serie: Number($('inut-serie').value),
            nNFIni: Number($('inut-ini').value),
            nNFFin: Number($('inut-fim').value),
            justificativa: $('inut-just').value.trim()
        };
        if (!payload.nNFIni || !payload.nNFFin || payload.nNFIni > payload.nNFFin) { alert('Informe uma faixa valida.'); return; }
        if (payload.justificativa.length < 15) { alert('A justificativa precisa ter pelo menos 15 caracteres.'); return; }
        if (!confirm(`Inutilizar numeracao ${payload.nNFIni}-${payload.nNFFin}, serie ${payload.serie}?`)) return;
        try {
            await FiscalClient.inutilizar(payload);
            alert('Numeracao inutilizada com sucesso.');
            $('inut-ini').value = '';
            $('inut-fim').value = '';
            $('inut-just').value = '';
        } catch (err) {
            alert(err.message);
        }
    }

    async function sincronizarDfe(btn) {
        btn.disabled = true;
        btn.textContent = 'Sincronizando...';
        try {
            const result = await FiscalClient.sincronizarDfe();
            await loadConfig();
            alert(`${result.documentos?.length || 0} documento(s) sincronizado(s). ${result.motivo || ''}`.trim());
        } catch (err) {
            alert(err.message);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Sincronizar SEFAZ';
        }
    }

    async function importarXmlAvulso(inputEl) {
        const arquivo = inputEl.files?.[0];
        inputEl.value = ''; // permite selecionar o mesmo arquivo de novo depois
        if (!arquivo) return;
        const msg = $('dfe-import-msg');
        if (msg) msg.textContent = 'Lendo arquivo...';
        try {
            const texto = await arquivo.text();
            const documento = await FiscalClient.importarXmlAvulso(texto);
            if (msg) msg.textContent = `Nota importada: ${documento.emitente || documento.chave || arquivo.name}.`;
        } catch (err) {
            if (msg) msg.textContent = '';
            alert('Erro ao importar XML: ' + err.message);
        }
    }

    async function confirmarEntradaEstoque(btn) {
        const dfeId = btn.dataset.dfeConfirmar;
        const d = state.dfe.find(x => x.id === dfeId);
        if (!d || !Array.isArray(d.itens)) return;
        const msg = $(`dfe-entrada-msg-${dfeId}`);
        const operador = (firebase.auth().currentUser && firebase.auth().currentUser.email) || 'operador';
        const now = firebase.firestore.FieldValue.serverTimestamp();

        // Dois itens diferentes da nota ligados ao mesmo destino quase sempre e
        // engano (ex.: Tampico 450 ml e 250 ml os dois no produto de 250 ml).
        const destinos = {};
        d.itens.forEach((it, idx) => {
            const tipo = document.querySelector(`[data-item-tipo="${idx}"]`)?.value || 'produto';
            let alvo = tipo === 'produto'
                ? document.querySelector(`[data-item-produto="${idx}"]`)?.value
                : document.querySelector(`[data-item-insumo="${idx}"]`)?.value;
            if (alvo === PRODUTO_NOVO) alvo = 'novo:' + normalizarNome(document.querySelector(`[data-item-prod-nome="${idx}"]`)?.value);
            if (!alvo) return;
            (destinos[tipo + ':' + alvo] = destinos[tipo + ':' + alvo] || []).push(it.xProd || `item ${idx + 1}`);
        });
        const repetidos = Object.values(destinos).filter(nomes => nomes.length > 1);
        if (repetidos.length && !confirm(
            'Atencao: estes itens da nota estao ligados ao MESMO produto/insumo:\n\n'
            + repetidos.map(n => '- ' + n.join('\n- ')).join('\n\n')
            + '\n\nAs quantidades vao ser somadas num item so. Confirmar mesmo assim?'
        )) return;

        try {
            const batch = db.batch();
            // Saldo corrente por insumo dentro desta nota, e insumo ja criado por
            // produto nesta nota: sem isso, dois itens no mesmo destino criavam
            // dois insumos (produto sem vinculo) ou o segundo sobrescrevia o
            // saldo do primeiro (produto/insumo existente).
            const saldoNoLote = {};
            const insumoCriadoPorProduto = {};
            // Produto novo ja criado nesta nota, por nome (dois itens da nota no
            // mesmo produto novo nao podem virar dois cadastros).
            const produtoNovoPorNome = {};
            // Insumos que receberam entrada: no fim, produto pausado sozinho por
            // falta de estoque volta a ficar disponivel.
            const insumosRepostos = new Set();
            // Vinculo de cada item da nota com o insumo/produto que recebeu a entrada —
            // e o que permite abrir a nota depois e editar o que foi lancado.
            const entradaItens = [];
            d.itens.forEach((it, idx) => {
                const qtd = parseFloat(document.querySelector(`[data-item-qtd="${idx}"]`)?.value);
                if (!(qtd > 0)) throw new Error(`Informe uma quantidade valida para "${it.xProd || 'item ' + (idx + 1)}".`);
                const tipo = document.querySelector(`[data-item-tipo="${idx}"]`)?.value || 'produto';

                let insumoId, insumoNome, insumoAtual, motivoExtra = '';
                let produtoLigado = null;

                if (tipo === 'produto') {
                    let produtoId = document.querySelector(`[data-item-produto="${idx}"]`)?.value;
                    if (!produtoId) throw new Error(`Selecione o produto do cardapio para "${it.xProd || 'item ' + (idx + 1)}" (ou troque pra "Insumo").`);
                    let produto;
                    if (produtoId === PRODUTO_NOVO) {
                        // Cadastro do produto a partir da nota. Nasce SEM preco e
                        // indisponivel em tudo (caixa, mesas, totem, app e bot leem
                        // "disponivel"), ate a loja completar foto, descricao e preco
                        // no Cardapio.
                        const nomeNovo = String(document.querySelector(`[data-item-prod-nome="${idx}"]`)?.value || '').trim();
                        const categoria = document.querySelector(`[data-item-prod-categoria="${idx}"]`)?.value || '';
                        if (!nomeNovo) throw new Error(`Informe o nome do produto novo para "${it.xProd || 'item ' + (idx + 1)}".`);
                        if (!categoria) throw new Error(`Escolha a categoria do produto novo "${nomeNovo}".`);
                        const fval = (campo) => String(document.querySelector(`[data-item-prod-${campo}="${idx}"]`)?.value || '').trim();
                        const ncmNovo = fval('ncm').replace(/\D/g, ''), cfopNovo = fval('cfop').replace(/\D/g, ''), csosnNovo = fval('csosn').replace(/\D/g, '');
                        const origemNovo = fval('origem');
                        if (ncmNovo && ncmNovo.length !== 8) throw new Error(`NCM de "${nomeNovo}" precisa ter 8 digitos (ou deixe em branco).`);
                        if (cfopNovo && !/^5\d{3}$/.test(cfopNovo)) throw new Error(`CFOP de "${nomeNovo}" deve ser de venda dentro do estado (5xxx, ex: 5102) — ou deixe em branco.`);
                        if (csosnNovo && !/^\d{2,3}$/.test(csosnNovo)) throw new Error(`CSOSN/CST de "${nomeNovo}" precisa ter 2 ou 3 digitos (ex: 102) — ou deixe em branco.`);
                        const chaveNome = normalizarNome(nomeNovo);
                        const jaExiste = state.produtos.find(p => normalizarNome(p.nome_exibicao || p.nome) === chaveNome);
                        if (jaExiste) throw new Error(`Ja existe no cardapio um produto chamado "${jaExiste.nome_exibicao || jaExiste.nome}". Selecione-o na lista em vez de cadastrar de novo.`);
                        if (produtoNovoPorNome[chaveNome]) {
                            produto = produtoNovoPorNome[chaveNome];
                        } else {
                            const novoProdutoRef = db.collection('cardapio').doc();
                            produto = { id: novoProdutoRef.id, nome: nomeNovo, apelidos: [] };
                            batch.set(novoProdutoRef, {
                                nome: nomeNovo.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
                                nome_exibicao: nomeNovo,
                                categoria,
                                preco: 0,
                                ingredientes: '',
                                disponivel: false,
                                disponivel_online: false,
                                cadastro_pendente: true,
                                pontos_fidelidade: 0,
                                ncm: ncmNovo, cfop: cfopNovo, csosn: csosnNovo, cst: '', origem: origemNovo,
                                custo_unitario: custoEUnidadeNovoItem(it, qtd).custo,
                                criado_pela_nota: d.chave || d.nsu || null,
                                criado_por: operador,
                                criado_em: now,
                                ultima_atualizacao: now
                            });
                            produtoNovoPorNome[chaveNome] = produto;
                        }
                        produtoId = produto.id;
                    } else {
                        produto = state.produtos.find(p => p.id === produtoId);
                    }
                    if (!produto) throw new Error('Produto selecionado nao encontrado.');
                    produtoLigado = produtoId;

                    if (insumoCriadoPorProduto[produtoId]) {
                        // Outro item desta mesma nota ja criou o insumo desse produto.
                        insumoId = insumoCriadoPorProduto[produtoId]; insumoNome = produto.nome; insumoAtual = 0;
                    } else if (produto.insumo_vinculado_id && state.insumos.find(i => i.id === produto.insumo_vinculado_id)) {
                        // Ja existe a ponte produto <-> insumo/ficha tecnica, so reusa.
                        const insumo = state.insumos.find(i => i.id === produto.insumo_vinculado_id);
                        insumoId = insumo.id; insumoNome = insumo.nome; insumoAtual = Number(insumo.quantidade_atual) || 0;
                    } else {
                        // Primeira entrada desse produto: cria o insumo e a ficha tecnica
                        // 1:1 que liga a venda no cardapio a baixa automatica de estoque.
                        const novoInsumoRef = db.collection('estoque_insumos').doc();
                        const novo = custoEUnidadeNovoItem(it, qtd);
                        batch.set(novoInsumoRef, {
                            nome: produto.nome, categoria: 'Produto revenda', unidade: novo.unidade,
                            quantidade_atual: 0, estoque_minimo: 0, custo_unitario: novo.custo,
                            criado_em: now, atualizado_em: now
                        });
                        batch.set(db.collection('fichas_tecnicas').doc(produtoId), {
                            produto_nome: produto.nome, itens: [{ insumo_id: novoInsumoRef.id, quantidade: 1 }],
                            atualizado_em: now
                        });
                        // set+merge (nao update): o produto pode ter sido criado neste mesmo lote.
                        batch.set(db.collection('cardapio').doc(produtoId), { insumo_vinculado_id: novoInsumoRef.id }, { merge: true });
                        insumoId = novoInsumoRef.id; insumoNome = produto.nome; insumoAtual = 0;
                        insumoCriadoPorProduto[produtoId] = novoInsumoRef.id;
                        motivoExtra = ' (produto novo no estoque)';
                    }

                    // Aprende o nome da nota como apelido do produto do cardapio.
                    const nomeNota = normalizarNome(it.xProd);
                    const jaConhecido = nomeNota === normalizarNome(produto.nome)
                        || (produto.apelidos || []).some(a => normalizarNome(a) === nomeNota);
                    if (it.xProd && !jaConhecido) {
                        batch.set(db.collection('cardapio').doc(produtoId), { apelidos: firebase.firestore.FieldValue.arrayUnion(it.xProd) }, { merge: true });
                    }
                } else {
                    const selInsumoId = document.querySelector(`[data-item-insumo="${idx}"]`)?.value;
                    if (selInsumoId) {
                        const insumo = state.insumos.find(i => i.id === selInsumoId);
                        if (!insumo) throw new Error('Insumo selecionado nao encontrado.');
                        insumoId = insumo.id; insumoNome = insumo.nome; insumoAtual = Number(insumo.quantidade_atual) || 0;
                        const nomeNota = normalizarNome(it.xProd);
                        const jaConhecido = nomeNota === normalizarNome(insumo.nome)
                            || (insumo.apelidos || []).some(a => normalizarNome(a) === nomeNota);
                        if (it.xProd && !jaConhecido) {
                            batch.update(db.collection('estoque_insumos').doc(selInsumoId), { apelidos: firebase.firestore.FieldValue.arrayUnion(it.xProd) });
                        }
                    } else {
                        const nomeNovo = document.querySelector(`[data-item-novo-nome="${idx}"]`)?.value.trim();
                        if (!nomeNovo) throw new Error(`Informe o nome do novo insumo para "${it.xProd || 'item ' + (idx + 1)}".`);
                        const novoRef = db.collection('estoque_insumos').doc();
                        const novo = custoEUnidadeNovoItem(it, qtd);
                        batch.set(novoRef, {
                            nome: nomeNovo, categoria: '', unidade: novo.unidade,
                            quantidade_atual: 0, estoque_minimo: 0, custo_unitario: novo.custo,
                            criado_em: now, atualizado_em: now
                        });
                        insumoId = novoRef.id; insumoNome = nomeNovo; insumoAtual = 0;
                        motivoExtra = ' (insumo novo)';
                    }
                }

                entradaItens.push({ idx, insumo_id: insumoId, produto_id: produtoLigado, quantidade: qtd });
                const novoSaldo = (insumoId in saldoNoLote ? saldoNoLote[insumoId] : insumoAtual) + qtd;
                saldoNoLote[insumoId] = novoSaldo;
                if (novoSaldo > 0) insumosRepostos.add(insumoId);
                batch.set(db.collection('estoque_insumos').doc(insumoId), { quantidade_atual: novoSaldo, atualizado_em: now }, { merge: true });
                batch.set(db.collection('estoque_movimentos').doc(), {
                    insumo_id: insumoId, insumo_nome: insumoNome, tipo: 'ENTRADA',
                    quantidade: qtd, saldo_resultante: novoSaldo,
                    motivo: `Entrada NF ${d.chave || d.nsu}${motivoExtra}`, operador, data: now
                });
            });

            // Produto que a baixa automatica pausou por estoque zerado
            // (desativado_motivo) volta a ficar disponivel quando a nota repoe o
            // estoque dele. Pausado a mao ou com cadastro pendente nao e mexido.
            state.produtos.forEach(p => {
                if (p.disponivel !== false || !p.desativado_motivo || p.cadastro_pendente) return;
                if (!p.insumo_vinculado_id || !insumosRepostos.has(p.insumo_vinculado_id)) return;
                batch.update(db.collection('cardapio').doc(p.id), {
                    disponivel: true,
                    desativado_motivo: firebase.firestore.FieldValue.delete(),
                    desativado_automaticamente_em: firebase.firestore.FieldValue.delete(),
                    reativado_automaticamente_em: now,
                    ultima_atualizacao: now
                });
            });

            batch.update(db.collection('dfe_documentos').doc(dfeId), {
                entrada_confirmada: true, entrada_confirmada_em: now, entrada_confirmada_por: operador,
                entrada_itens: entradaItens
            });

            await batch.commit();
            state.dfeExpandido = null;
            render();
        } catch (err) {
            // A tela pode ter sido redesenhada enquanto o servidor respondia (o
            // elemento "msg" de antes ja nao esta mais na pagina): procura de novo.
            const alvo = $(`dfe-entrada-msg-${dfeId}`);
            if (alvo && alvo.isConnected) alvo.textContent = err.message;
            else alert('Nao foi possivel confirmar a entrada: ' + err.message);
        }
    }

    function danfeBlobUrl(nota) {
        const bytes = atob(nota.danfeBase64);
        const arr = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
        const blob = new Blob([arr], { type: 'application/pdf' });
        return URL.createObjectURL(blob);
    }

    function baixarDanfe(nota) {
        if (!nota?.danfeBase64) return;
        const url = danfeBlobUrl(nota);
        const a = document.createElement('a');
        a.href = url;
        a.download = `DANFE-NFCe-${nota.nNF || nota.chave || 'nota'}.pdf`;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    // Abre o cupom (PDF de 80mm) numa aba nova e manda pra impressão direto —
    // o visualizador de PDF nativo do navegador cuida do resto (escolher a
    // impressora térmica, etc.). A janela precisa ser aberta de forma síncrona
    // no clique (window.open aqui, ainda dentro do handler), senão o
    // navegador bloqueia por não ser mais um gesto do usuário.
    function imprimirDanfe(nota) {
        if (!nota?.danfeBase64) return;
        const url = danfeBlobUrl(nota);
        const janela = window.open(url, '_blank');
        if (!janela) { window.open(url, '_blank'); return; }
        janela.addEventListener('load', () => {
            try { janela.print(); } catch (e) { /* navegador não deixou automatizar — usuário imprime pelo próprio visualizador */ }
        });
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    function baixarXml(nota) {
        const xml = nota?.xmlProc || nota?.xml || nota?.xmlAssinado;
        if (!xml) return;
        const blob = new Blob([xml], { type: 'application/xml' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `NFCe-${nota.nNF || nota.chave || 'nota'}.xml`;
        a.click();
        URL.revokeObjectURL(a.href);
    }
});
