// Fiscal module dashboard, inspired by the Construline fiscal workflow.
document.addEventListener('DOMContentLoaded', () => {
    const firebaseConfig = window.__FIREBASE_CONFIG__;
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);

    const db = firebase.firestore();
    const auth = firebase.auth();
    const $ = (id) => document.getElementById(id);

    const state = { tab: 'overview', cfg: {}, notas: [], notasRelatorio: [], pedidos: [], produtos: [], dfe: [], ibptCache: {}, insumos: [], dfeExpandido: null, relatorioMes: mesAtualStr() };
    let unsubRelatorio = null;
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
        const inicioHoje = new Date();
        inicioHoje.setHours(0, 0, 0, 0);
        db.collection('notas_fiscais')
            .where('criado_em', '>=', inicioHoje)
            .onSnapshot(snap => {
                state.notas = [];
                snap.forEach(doc => state.notas.push({ id: doc.id, ...doc.data() }));
                state.notas.sort((a, b) => (b.criado_em?.toMillis?.() || 0) - (a.criado_em?.toMillis?.() || 0));
                render();
            }, err => console.warn('notas_fiscais:', err.message));
    }

    // O Relatorio pra contabilidade precisa de qualquer mes, não só hoje —
    // por isso tem sua própria consulta (state.notas do listenNotes() acima
    // é sempre "hoje em diante", só serve pra aba Documentos). Reconsulta
    // sempre que o mes selecionado no relatorio muda.
    function listenRelatorio(mes) {
        if (unsubRelatorio) unsubRelatorio();
        const { inicio, fim } = limitesDoMes(mes);
        unsubRelatorio = db.collection('notas_fiscais')
            .where('criado_em', '>=', inicio)
            .where('criado_em', '<', fim)
            .onSnapshot(snap => {
                state.notasRelatorio = [];
                snap.forEach(doc => state.notasRelatorio.push({ id: doc.id, ...doc.data() }));
                state.notasRelatorio.sort((a, b) => (b.criado_em?.toMillis?.() || 0) - (a.criado_em?.toMillis?.() || 0));
                if (state.tab === 'report') render();
            }, err => console.warn('notas_fiscais (relatorio):', err.message));
    }

    function listenOrders() {
        db.collection('pedidos').where('status', '==', 'CONCLUIDO').onSnapshot(snap => {
            state.pedidos = [];
            snap.forEach(doc => state.pedidos.push({ id: doc.id, ...doc.data() }));
            state.pedidos.sort((a, b) => (b.hora_pedido?.toMillis?.() || 0) - (a.hora_pedido?.toMillis?.() || 0));
            state.pedidos = state.pedidos.slice(0, 60);
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

    function render() {
        const content = $('fiscal-content');
        if (!content) return;
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
    }

    function counts() {
        const base = { total: state.notas.length, autorizada: 0, rejeitada: 0, cancelada: 0, contingencia: 0, inutilizada: 0, processando: 0 };
        state.notas.forEach(n => {
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
        const c = counts();
        const total = state.notas.filter(n => n.status === 'AUTORIZADA').reduce((sum, n) => sum + Number(n.valor || 0), 0);
        return `
            <div class="grid cards">
                ${metric('Documentos', c.total)}
                ${metric('Autorizadas', c.autorizada)}
                ${metric('Pendencias', c.rejeitada + c.contingencia + c.processando)}
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

    function renderDocuments() {
        return `<div class="panel"><div class="panel-head"><h2>Documentos fiscais</h2><button class="btn" data-refresh-config>Atualizar config</button></div>${documentsTable(state.notas)}</div>`;
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
            return `<tr><td>${esc(num)}</td><td>${pedidoRef}</td><td><span class="badge ${cls}">${esc(status)}</span>${n.motivo ? `<br><span class="muted">${esc(n.motivo)}</span>` : ''}</td><td>${esc(forma)}</td><td>${esc(n.cliente || '-')}</td><td class="chave">${esc(n.chave || (n.tipo === 'INUTILIZACAO' ? 'Inutilizacao de numeracao' : '-'))}</td><td class="num">${n.valor != null ? money(n.valor) : '-'}</td><td>${dateTxt(n.criado_em)}</td><td class="num">${actions.join(' ') || '<span class="muted">-</span>'}</td></tr>`;
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
        const comXml = notasDoMes.filter(n => n.xml || n.xmlAssinado);

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
                ${metric('NF-e emitidas', validas.length)}
                ${metric('Valor faturado', money(totalFaturado))}
                ${metric('Canceladas', canceladas.length)}
                ${metric('XMLs disponiveis', comXml.length)}
            </div>
            ${documentsTable(notasDoMes)}
        </div>`;
    }

    // CSV com os campos que a contabilidade costuma pedir pra conciliar as
    // vendas do periodo (numero, serie, chave, datas, valores, status).
    function exportarRelatorioCsv(notas, mes) {
        const cols = ['Numero', 'Serie', 'Chave', 'Status', 'Forma emissao', 'Cliente', 'Valor', 'Data emissao', 'Protocolo'];
        const linhas = notas.map(n => [
            n.tipo === 'INUTILIZACAO' ? `Inut. ${n.nNFIni}-${n.nNFFin}` : (n.nNF ?? ''),
            n.serie ?? '',
            n.chave || '',
            n.status || '',
            n.formaEmissao || (n.contingencia ? 'CONTINGENCIA' : 'NORMAL'),
            n.cliente || '',
            n.valor != null ? String(n.valor).replace('.', ',') : '',
            n.criado_em?.toDate ? n.criado_em.toDate().toLocaleString('pt-BR') : '',
            n.protocolo || ''
        ]);
        const escCsv = (v) => `"${String(v).replace(/"/g, '""')}"`;
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
        const comXml = notas.filter(n => n.xml || n.xmlAssinado);
        if (!comXml.length) return;
        const textoOriginal = btn ? btn.textContent : '';
        if (btn) { btn.disabled = true; btn.textContent = 'Gerando .zip...'; }
        try {
            const zip = new window.JSZip();
            comXml.forEach(n => {
                const nome = (n.chave || `nNF-${n.nNF || n.id}`) + '-nfce.xml';
                zip.file(nome, n.xml || n.xmlAssinado);
            });
            const blob = await zip.generateAsync({ type: 'blob' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `xmls-nfce-${mes}.zip`;
            a.click();
            URL.revokeObjectURL(a.href);
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = textoOriginal; }
        }
    }

    function notaFiscalPorPedido() {
        // state.notas ja vem ordenado do mais recente pro mais antigo (listenNotes),
        // entao a primeira ocorrencia por pedido_id e sempre a tentativa mais atual.
        const map = {};
        state.notas.forEach(n => {
            if (n.pedido_id && !(n.pedido_id in map)) map[n.pedido_id] = n;
        });
        return map;
    }

    function renderIssuance() {
        const notaPorPedido = notaFiscalPorPedido();
        if (!state.pedidos.length) return '<div class="panel"><h2>Emissao NFC-e</h2><div class="empty">Nenhuma venda concluida recente.</div></div>';
        return `<div class="panel"><div class="panel-head"><h2>Emitir NFC-e por venda concluida</h2></div><table><thead><tr><th>Pedido</th><th>Cliente</th><th>Pagamento</th><th class="num">Valor</th><th>Data</th><th class="num">Acao</th></tr></thead><tbody>${state.pedidos.map(p => {
            const nota = notaPorPedido[p.id];
            const st = nota ? String(nota.status || '').toUpperCase() : null;
            let acao;
            // AUTORIZADA/CONTINGENCIA/PROCESSANDO = NF-e valida ou em curso. CANCELADA/
            // INUTILIZADA tambem contam: a venda ja teve uma NF-e oficialmente emitida
            // (e depois cancelada na SEFAZ) — cancelar a venda por aqui nao desfaz isso,
            // entao continua bloqueado mesmo com a nota cancelada.
            const nfEmitida = st === 'AUTORIZADA' || st === 'CONTINGENCIA' || st === 'PROCESSANDO' || st === 'CANCELADA' || st === 'INUTILIZADA';
            if (st === 'AUTORIZADA' || st === 'CONTINGENCIA') {
                acao = '<span class="badge b-ok">Emitida</span>';
                if (nota.danfeBase64) acao += `<br><button class="btn" data-imprimir="${nota.id}" title="Imprimir cupom" style="margin-top:6px">🖨️ Imprimir</button>`;
            }
            else if (st === 'PROCESSANDO') acao = '<span class="badge b-warn">Processando...</span>';
            else if (st === 'ERRO_REDE') acao = '<span class="badge b-warn">Aguardando conexão (reenvia sozinho)</span>';
            else if (st === 'REJEITADA' || st === 'ERRO') {
                acao = `<button class="btn primary" data-emitir="${p.id}">Retry</button><br><span class="muted" style="font-size:.76rem">Tentativa anterior falhou: ${esc(nota.motivo || st)}</span>`;
            } else if (st === 'CANCELADA' || st === 'INUTILIZADA') {
                acao = `<span class="badge b-muted">NF-e cancelada</span><br><button class="btn primary" data-emitir="${p.id}" style="margin-top:6px">Emitir nova NFC-e</button>`;
            } else acao = `<button class="btn primary" data-emitir="${p.id}">Emitir NFC-e</button>`;
            acao += `<br><button class="btn danger" data-cancelar-venda="${p.id}" ${nfEmitida ? 'disabled title="NF-e já emitida — cancele a nota antes de cancelar a venda."' : ''} style="margin-top:6px">Cancelar venda</button>`;
            return `<tr><td>#${esc(String(p.id).slice(0, 6))}</td><td>${esc(p.nome_cliente || 'Cliente')}</td><td>${esc(p.forma_pagamento || '-')}</td><td class="num">${money(p.valor_total)}</td><td>${dateTxt(p.hora_pedido)}</td><td class="num">${acao}</td></tr>`;
        }).join('')}</tbody></table></div>`;
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
            ${dfeTable()}
        </div>`;
    }

    function dfeTable() {
        if (!state.dfe.length) return '<div class="empty">Nenhuma nota recebida sincronizada.</div>';
        return `<table><thead><tr><th>NSU</th><th>Chave</th><th>Emitente</th><th class="num">Valor</th><th>Emissao</th><th>Schema</th><th class="num">Estoque</th></tr></thead><tbody>${state.dfe.map(d => {
            const temItens = Array.isArray(d.itens) && d.itens.length > 0;
            let acaoEstoque;
            if (d.entrada_confirmada) acaoEstoque = '<span class="badge b-ok">Entrada OK</span>';
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
            const linhaExpandida = state.dfeExpandido === d.id ? linhaEntradaEstoque(d) : '';
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
        const palavrasA = new Set(a.split(' ').filter(w => w.length > 2));
        const palavrasB = new Set(b.split(' ').filter(w => w.length > 2));
        let comuns = 0;
        palavrasA.forEach(w => { if (palavrasB.has(w)) comuns++; });
        if (comuns === 0 || !palavrasA.size || !palavrasB.size) return 0;
        return (comuns / Math.max(palavrasA.size, palavrasB.size)) * 100;
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
        return `<option value="">Selecione o produto no cardapio...</option>${opcoes}`;
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
                <select data-item-insumo="${idx}" style="display:none">${opcoesInsumos(it.xProd)}</select>
                <input type="text" data-item-novo-nome="${idx}" placeholder="Nome do novo insumo" value="${esc(it.xProd || '')}" style="margin-top:4px;display:none">
            </td>
            <td class="num"><input type="number" step="0.001" min="0" data-item-qtd="${idx}" value="${esc(it.qCom ?? '')}" style="width:90px"></td>
            <td>${esc(it.uCom || '-')}</td>
            <td class="num">${it.vUnCom != null ? money(it.vUnCom) : '-'}</td>
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
        document.querySelectorAll('[data-dfe-toggle]').forEach(btn => btn.onclick = () => {
            state.dfeExpandido = state.dfeExpandido === btn.dataset.dfeToggle ? null : btn.dataset.dfeToggle;
            render();
        });
        document.querySelectorAll('[data-item-insumo]').forEach(sel => sel.onchange = () => {
            const idx = sel.dataset.itemInsumo;
            const novoNome = document.querySelector(`[data-item-novo-nome="${idx}"]`);
            if (novoNome) novoNome.style.display = sel.value === '' ? 'block' : 'none';
        });
        document.querySelectorAll('[data-item-tipo]').forEach(sel => sel.onchange = () => {
            const idx = sel.dataset.itemTipo;
            const selProduto = document.querySelector(`[data-item-produto="${idx}"]`);
            const selInsumo = document.querySelector(`[data-item-insumo="${idx}"]`);
            const novoNome = document.querySelector(`[data-item-novo-nome="${idx}"]`);
            const ehInsumo = sel.value === 'insumo';
            if (selProduto) selProduto.style.display = ehInsumo ? 'none' : 'block';
            if (selInsumo) selInsumo.style.display = ehInsumo ? 'block' : 'none';
            if (novoNome) novoNome.style.display = (ehInsumo && selInsumo && selInsumo.value === '') ? 'block' : 'none';
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
        if (st === 'AUTORIZADA' || st === 'CONTINGENCIA' || st === 'PROCESSANDO' || st === 'CANCELADA' || st === 'INUTILIZADA') {
            alert('Esta venda já teve NF-e emitida (mesmo que a nota tenha sido cancelada depois) — não é possível cancelar a venda por aqui.');
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

        try {
            const batch = db.batch();
            d.itens.forEach((it, idx) => {
                const qtd = parseFloat(document.querySelector(`[data-item-qtd="${idx}"]`)?.value);
                if (!(qtd > 0)) throw new Error(`Informe uma quantidade valida para "${it.xProd || 'item ' + (idx + 1)}".`);
                const tipo = document.querySelector(`[data-item-tipo="${idx}"]`)?.value || 'produto';

                let insumoId, insumoNome, insumoAtual, motivoExtra = '';

                if (tipo === 'produto') {
                    const produtoId = document.querySelector(`[data-item-produto="${idx}"]`)?.value;
                    if (!produtoId) throw new Error(`Selecione o produto do cardapio para "${it.xProd || 'item ' + (idx + 1)}" (ou troque pra "Insumo").`);
                    const produto = state.produtos.find(p => p.id === produtoId);
                    if (!produto) throw new Error('Produto selecionado nao encontrado.');

                    if (produto.insumo_vinculado_id && state.insumos.find(i => i.id === produto.insumo_vinculado_id)) {
                        // Ja existe a ponte produto <-> insumo/ficha tecnica, so reusa.
                        const insumo = state.insumos.find(i => i.id === produto.insumo_vinculado_id);
                        insumoId = insumo.id; insumoNome = insumo.nome; insumoAtual = Number(insumo.quantidade_atual) || 0;
                    } else {
                        // Primeira entrada desse produto: cria o insumo e a ficha tecnica
                        // 1:1 que liga a venda no cardapio a baixa automatica de estoque.
                        const novoInsumoRef = db.collection('estoque_insumos').doc();
                        batch.set(novoInsumoRef, {
                            nome: produto.nome, categoria: 'Produto revenda', unidade: it.uCom || 'UN',
                            quantidade_atual: 0, estoque_minimo: 0, custo_unitario: it.vUnCom || 0,
                            criado_em: now, atualizado_em: now
                        });
                        batch.set(db.collection('fichas_tecnicas').doc(produtoId), {
                            produto_nome: produto.nome, itens: [{ insumo_id: novoInsumoRef.id, quantidade: 1 }],
                            atualizado_em: now
                        });
                        batch.update(db.collection('cardapio').doc(produtoId), { insumo_vinculado_id: novoInsumoRef.id });
                        insumoId = novoInsumoRef.id; insumoNome = produto.nome; insumoAtual = 0;
                        motivoExtra = ' (produto novo no estoque)';
                    }

                    // Aprende o nome da nota como apelido do produto do cardapio.
                    const nomeNota = normalizarNome(it.xProd);
                    const jaConhecido = nomeNota === normalizarNome(produto.nome)
                        || (produto.apelidos || []).some(a => normalizarNome(a) === nomeNota);
                    if (it.xProd && !jaConhecido) {
                        batch.update(db.collection('cardapio').doc(produtoId), { apelidos: firebase.firestore.FieldValue.arrayUnion(it.xProd) });
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
                        batch.set(novoRef, {
                            nome: nomeNovo, categoria: '', unidade: it.uCom || 'UN',
                            quantidade_atual: 0, estoque_minimo: 0, custo_unitario: it.vUnCom || 0,
                            criado_em: now, atualizado_em: now
                        });
                        insumoId = novoRef.id; insumoNome = nomeNovo; insumoAtual = 0;
                        motivoExtra = ' (insumo novo)';
                    }
                }

                const novoSaldo = insumoAtual + qtd;
                batch.set(db.collection('estoque_insumos').doc(insumoId), { quantidade_atual: novoSaldo, atualizado_em: now }, { merge: true });
                batch.set(db.collection('estoque_movimentos').doc(), {
                    insumo_id: insumoId, insumo_nome: insumoNome, tipo: 'ENTRADA',
                    quantidade: qtd, saldo_resultante: novoSaldo,
                    motivo: `Entrada NF ${d.chave || d.nsu}${motivoExtra}`, operador, data: now
                });
            });

            batch.update(db.collection('dfe_documentos').doc(dfeId), {
                entrada_confirmada: true, entrada_confirmada_em: now, entrada_confirmada_por: operador
            });

            await batch.commit();
            state.dfeExpandido = null;
            render();
        } catch (err) {
            if (msg) msg.textContent = err.message;
            else alert(err.message);
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
        const xml = nota?.xml || nota?.xmlAssinado;
        if (!xml) return;
        const blob = new Blob([xml], { type: 'application/xml' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `NFCe-${nota.nNF || nota.chave || 'nota'}.xml`;
        a.click();
        URL.revokeObjectURL(a.href);
    }
});
