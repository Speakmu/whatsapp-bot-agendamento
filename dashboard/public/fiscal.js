// Fiscal module dashboard, inspired by the Construline fiscal workflow.
document.addEventListener('DOMContentLoaded', () => {
    const firebaseConfig = window.__FIREBASE_CONFIG__;
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);

    const db = firebase.firestore();
    const auth = firebase.auth();
    const $ = (id) => document.getElementById(id);

    const state = { tab: 'overview', cfg: {}, notas: [], pedidos: [], produtos: [], dfe: [], ibptCache: {} };
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
        ['products', 'Produtos']
    ];

    const money = (v) => 'R$ ' + (Number(v) || 0).toFixed(2).replace('.', ',');
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const dateTxt = (v) => v?.toDate ? v.toDate().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '--';

    auth.onAuthStateChanged(async user => {
        if (!user) { window.location.href = '/login.html'; return; }
        renderTabs();
        await loadConfig();
        listenNotes();
        listenOrders();
        listenProducts();
        listenIbptCache();
        listenDfe();
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
        db.collection('notas_fiscais').onSnapshot(snap => {
            state.notas = [];
            snap.forEach(doc => state.notas.push({ id: doc.id, ...doc.data() }));
            state.notas.sort((a, b) => (b.criado_em?.toMillis?.() || 0) - (a.criado_em?.toMillis?.() || 0));
            render();
        }, err => console.warn('notas_fiscais:', err.message));
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

    function render() {
        const content = $('fiscal-content');
        if (!content) return;
        if (state.tab === 'overview') content.innerHTML = renderOverview();
        if (state.tab === 'settings') content.innerHTML = renderSettings();
        if (state.tab === 'documents') content.innerHTML = renderDocuments();
        if (state.tab === 'issuance') content.innerHTML = renderIssuance();
        if (state.tab === 'dfe') content.innerHTML = renderDfe();
        if (state.tab === 'devolution') content.innerHTML = renderPlaceholder('Devolucao', 'Estrutura reservada para emitir devolucao referenciada a uma nota de entrada ou venda.');
        if (state.tab === 'inutilization') content.innerHTML = renderInutilization();
        if (state.tab === 'rules') content.innerHTML = renderRules();
        if (state.tab === 'company') content.innerHTML = renderCompany();
        if (state.tab === 'products') content.innerHTML = renderProducts();
        bindActions();
    }

    function counts() {
        const base = { total: state.notas.length, autorizada: 0, rejeitada: 0, cancelada: 0, contingencia: 0, inutilizada: 0 };
        state.notas.forEach(n => {
            const s = String(n.status || '').toUpperCase();
            if (s === 'AUTORIZADA') base.autorizada++;
            else if (s === 'CANCELADA') base.cancelada++;
            else if (s === 'CONTINGENCIA') base.contingencia++;
            else if (s === 'INUTILIZADA') base.inutilizada++;
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
                ${metric('Pendencias', c.rejeitada + c.contingencia)}
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
        return `<table><thead><tr><th>Numero</th><th>Status</th><th>Chave</th><th class="num">Valor</th><th>Data</th><th class="num">Acoes</th></tr></thead><tbody>${notas.map(n => {
            const status = String(n.status || '-').toUpperCase();
            const cls = status === 'AUTORIZADA' ? 'b-ok' : (status === 'CANCELADA' || status === 'INUTILIZADA' ? 'b-muted' : (status === 'CONTINGENCIA' ? 'b-warn' : 'b-danger'));
            const num = n.tipo === 'INUTILIZACAO' ? `Inut. ${n.nNFIni}-${n.nNFFin}` : (n.nNF || '-');
            const actions = [];
            if (n.danfeBase64) actions.push(`<button class="btn" data-danfe="${n.id}">DANFE</button>`);
            if (status === 'CONTINGENCIA') actions.push(`<button class="btn primary" data-transmitir="${n.id}">Transmitir</button>`);
            if (status === 'AUTORIZADA' && n.chave && n.protocolo) actions.push(`<button class="btn danger" data-cancelar="${n.id}">Cancelar</button>`);
            return `<tr><td>${esc(num)}</td><td><span class="badge ${cls}">${esc(status)}</span>${n.motivo ? `<br><span class="muted">${esc(n.motivo)}</span>` : ''}</td><td class="chave">${esc(n.chave || (n.tipo === 'INUTILIZACAO' ? 'Inutilizacao de numeracao' : '-'))}</td><td class="num">${n.valor != null ? money(n.valor) : '-'}</td><td>${dateTxt(n.criado_em)}</td><td class="num">${actions.join(' ') || '<span class="muted">-</span>'}</td></tr>`;
        }).join('')}</tbody></table>`;
    }

    function renderIssuance() {
        const emitted = {};
        state.notas.forEach(n => {
            if (n.pedido_id && ['AUTORIZADA', 'CONTINGENCIA'].includes(String(n.status || '').toUpperCase())) emitted[n.pedido_id] = true;
        });
        if (!state.pedidos.length) return '<div class="panel"><h2>Emissao NFC-e</h2><div class="empty">Nenhuma venda concluida recente.</div></div>';
        return `<div class="panel"><div class="panel-head"><h2>Emitir NFC-e por venda concluida</h2></div><table><thead><tr><th>Pedido</th><th>Cliente</th><th>Pagamento</th><th class="num">Valor</th><th>Data</th><th class="num">Acao</th></tr></thead><tbody>${state.pedidos.map(p => `<tr><td>#${esc(String(p.id).slice(0, 6))}</td><td>${esc(p.nome_cliente || 'Cliente')}</td><td>${esc(p.forma_pagamento || '-')}</td><td class="num">${money(p.valor_total)}</td><td>${dateTxt(p.hora_pedido)}</td><td class="num">${emitted[p.id] ? '<span class="badge b-ok">Emitida</span>' : `<button class="btn primary" data-emitir="${p.id}">Emitir NFC-e</button>`}</td></tr>`).join('')}</tbody></table></div>`;
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
                <button class="btn primary" id="btn-sync-dfe">Sincronizar SEFAZ</button>
            </div>
            ${dfeTable()}
        </div>`;
    }

    function dfeTable() {
        if (!state.dfe.length) return '<div class="empty">Nenhuma nota recebida sincronizada.</div>';
        return `<table><thead><tr><th>NSU</th><th>Chave</th><th>Emitente</th><th class="num">Valor</th><th>Emissao</th><th>Schema</th></tr></thead><tbody>${state.dfe.map(d => `<tr>
            <td>${esc(d.nsu || '-')}</td>
            <td class="chave">${esc(d.chave || '-')}</td>
            <td>${esc(d.emitente || d.cnpjEmitente || '-')}</td>
            <td class="num">${d.valor != null ? money(d.valor) : '-'}</td>
            <td>${esc(d.dhEmi || '-')}</td>
            <td><span class="badge ${d.resumo ? 'b-warn' : 'b-ok'}">${esc(d.schema || '-')}</span></td>
        </tr>`).join('')}</tbody></table>`;
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
                        <div class="settings-grid full">
                            <label>URL base do QR Code<input id="f-qrbase"></label>
                            <label>URL de consulta por chave<input id="f-urlchave"></label>
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
        document.querySelectorAll('[data-danfe]').forEach(btn => btn.onclick = () => baixarDanfe(state.notas.find(n => n.id === btn.dataset.danfe)));
        document.querySelectorAll('[data-transmitir]').forEach(btn => btn.onclick = () => transmitir(btn));
        document.querySelectorAll('[data-cancelar]').forEach(btn => btn.onclick = () => cancelar(btn));
        const inut = $('btn-inutilizar-range');
        if (inut) inut.onclick = inutilizar;
        const syncDfe = $('btn-sync-dfe');
        if (syncDfe) syncDfe.onclick = () => sincronizarDfe(syncDfe);
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
        setVal('f-qrbase', d.qrBaseUrl || '');
        setVal('f-urlchave', d.urlChave || '');
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
            qrBaseUrl: getVal('f-qrbase').replace(/\/$/, ''),
            urlChave: getVal('f-urlchave').replace(/\/$/, ''),
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
        btn.textContent = 'Emitindo...';
        try {
            const nota = await FiscalClient.emitir(pedido.id, pedido);
            alert(nota.status === 'CONTINGENCIA' ? 'NFC-e emitida em contingencia.' : `NFC-e autorizada. Numero ${nota.nNF}.`);
        } catch (err) {
            alert(err.message);
            btn.disabled = false;
            btn.textContent = 'Emitir NFC-e';
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
        URL.revokeObjectURL(a.href);
    }
});
