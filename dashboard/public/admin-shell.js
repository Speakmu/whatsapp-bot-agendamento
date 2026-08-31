(function () {
    const frame = document.getElementById('admin-frame');
    const allowed = new Set([
        'home.html', 'painel.html', 'kds.html', 'mesas.html', 'entrega.html',
        'caixa.html', 'bi.html', 'financeiro.html', 'fiscal.html',
        'estoque.html', 'ficha-tecnica.html', 'marketing.html',
        'bot-chat.html', 'bot-config.html', 'mensalidades.html',
        'configuracoes.html'
    ]);
    const ADMIN_EMAIL = 'lileamarloja04@gmail.com';
    // Acesso de suporte (mesmo e-mail tratado como "Suporte" na tela de
    // Usuários — configuracoes.js/firestore.rules): acesso total a todos os
    // módulos, incondicional (não passa pelo filtro de exibição do admin
    // nem pela permissão por módulo de usuario comum). Era restrito só à
    // Mensalidade antes, mas isso ficou incoerente com o resto do sistema
    // já tratar esse e-mail como acesso protegido e total.
    const VENDOR_ADMIN_EMAIL = 'contato.seusuportetec@gmail.com';
    const MODULE_KEYS = ['pedidos', 'kds', 'mesas', 'entregas', 'caixa', 'bi', 'financeiro', 'fiscal', 'relatorios', 'estoque', 'fichas', 'cardapio', 'marketing', 'bot', 'mensalidade', 'configuracoes'];
    const PAGE_KEYS = {
        'painel.html': function (page) {
            const hash = (String(page || '').split('#')[1] || '').toLowerCase();
            if (hash === 'cardapio') return ['cardapio'];
            if (hash === 'relatorios') return ['relatorios'];
            return ['pedidos'];
        },
        'kds.html': ['kds'],
        'mesas.html': ['mesas'],
        'entrega.html': ['entregas'],
        'caixa.html': ['caixa'],
        'bi.html': ['bi'],
        'financeiro.html': ['financeiro'],
        'fiscal.html': ['fiscal'],
        'estoque.html': ['estoque'],
        'ficha-tecnica.html': ['fichas'],
        'marketing.html': ['marketing'],
        'bot-chat.html': ['bot'],
        'bot-config.html': ['bot'],
        'mensalidades.html': ['mensalidade'],
        'configuracoes.html': ['configuracoes']
    };
    let acessoEfetivo = null;
    let acessoCarregado = false;

    function normalizePage(raw) {
        let page = raw || '/home.html';
        try { page = decodeURIComponent(page); } catch (e) { /* keep raw */ }
        if (!page.startsWith('/')) page = '/' + page;
        const clean = page.split('?')[0].split('#')[0].split('/').pop().toLowerCase();
        return allowed.has(clean) ? page : '/home.html';
    }

    function pageFromUrl() {
        const params = new URLSearchParams(location.search);
        const page = normalizePage(params.get('page'));
        return params.get('refresh') ? withRefreshParam(page, params.get('refresh')) : page;
    }

    function cleanFile(page) {
        return String(page || '').split('?')[0].split('#')[0].split('/').pop().toLowerCase();
    }

    function normalizarEmail(email) {
        return String(email || '').trim().toLowerCase();
    }

    function isAdmin(email) {
        return normalizarEmail(email) === ADMIN_EMAIL;
    }

    function isVendor(email) {
        return normalizarEmail(email) === VENDOR_ADMIN_EMAIL;
    }

    function paginaPadrao() {
        return '/home.html';
    }

    async function carregarAcesso(user) {
        if (isVendor(user && user.email)) {
            const suporte = {};
            MODULE_KEYS.forEach(k => suporte[k] = true);
            return suporte;
        }

        const db = firebase.firestore();

        // Offline sem cache local (ex.: primeiro acesso já sem internet), a
        // consulta ao Firestore rejeita. Sem cache, a única coisa segura a
        // fazer é liberar geral para o admin (dono do sistema) e negar para
        // os demais — nunca deixar a config "sumida" travar o admin de fora.
        let globalCfg = {};
        try {
            const globalSnap = await db.collection('configuracoes').doc('exibicao').get();
            globalCfg = globalSnap.exists ? (globalSnap.data() || {}) : {};
        } catch (e) {
            console.warn('Config de exibição indisponível (offline sem cache):', e);
        }

        if (isAdmin(user && user.email)) {
            const admin = {};
            MODULE_KEYS.forEach(k => admin[k] = globalCfg[k] !== false);
            admin.configuracoes = true;
            return admin;
        }
        const email = normalizarEmail(user && user.email);
        if (!email) return {};
        try {
            const userSnap = await db.collection('usuarios_admin').doc(email).get();
            if (!userSnap.exists) return {};
            const data = userSnap.data() || {};
            if (data.ativo === false) return {};
            const perms = data.permissoes || {};
            const final = {};
            MODULE_KEYS.forEach(k => final[k] = perms[k] === true && globalCfg[k] !== false);
            if (data.admin) final.configuracoes = true;
            return final;
        } catch (e) {
            console.warn('Permissões indisponíveis (offline sem cache):', e);
            return {};
        }
    }

    function keysDaPagina(page) {
        const file = cleanFile(page);
        const entry = PAGE_KEYS[file];
        if (!entry) return [];
        return typeof entry === 'function' ? entry(page) : entry;
    }

    function podeAcessar(page) {
        if (!acessoCarregado) return true;
        const keys = keysDaPagina(page);
        if (!keys.length) {
            // Páginas sem permissão de módulo definida (ex.: home.html) ficam
            // abertas por padrão pra qualquer um que já passou pelo login.
            return true;
        }
        return keys.some(k => acessoEfetivo && acessoEfetivo[k] === true);
    }

    function filtrarMenu() {
        if (!acessoCarregado) return;
        document.querySelectorAll('#app-sidebar .sb-item').forEach(a => {
            const key = a.getAttribute('data-key');
            if (key) a.style.display = acessoEfetivo && acessoEfetivo[key] === true ? '' : 'none';
        });
        document.querySelectorAll('#app-sidebar .sb-group').forEach(gh => {
            let visiveis = 0;
            let el = gh.nextElementSibling;
            while (el && el.classList.contains('sb-item')) {
                if (el.style.display !== 'none') visiveis++;
                el = el.nextElementSibling;
            }
            gh.style.display = visiveis ? '' : 'none';
        });
    }

    function withRefreshParam(page, stamp) {
        const parts = String(page || '/home.html').split('#');
        const pathAndQuery = parts[0];
        const hash = parts[1] ? '#' + parts.slice(1).join('#') : '';
        const sep = pathAndQuery.includes('?') ? '&' : '?';
        return pathAndQuery + sep + 'refresh=' + encodeURIComponent(stamp || Date.now()) + hash;
    }

    function removeStrayEllipsis(doc) {
        try {
            const body = doc?.body;
            if (!body) return;
            Array.from(body.childNodes).forEach(node => {
                if (node.nodeType === Node.TEXT_NODE && node.textContent.trim() === '...') {
                    node.remove();
                }
            });
        } catch (e) {
            // Best-effort cleanup for stale cached markup.
        }
    }

    function setActive(page) {
        const cleanPage = page.split('?')[0].split('#')[0].split('/').pop().toLowerCase();
        const hash = page.split('#')[1] || '';
        document.querySelectorAll('#app-sidebar .sb-item').forEach(a => {
            const href = a.getAttribute('data-href') || a.getAttribute('href') || '';
            const cleanHref = href.split('?')[0].split('#')[0].split('/').pop().toLowerCase();
            const hrefHash = href.split('#')[1] || '';
            a.classList.toggle('active', cleanHref === cleanPage && hrefHash === hash);
        });
    }

    function loadPage(page, push) {
        let normalized = normalizePage(page);
        if (!podeAcessar(normalized)) normalized = paginaPadrao();
        if (frame.getAttribute('src') !== normalized) frame.setAttribute('src', normalized);
        if (push) history.pushState({ page: normalized }, '', '/admin.html?page=' + encodeURIComponent(normalized));
        setActive(normalized);
        filtrarMenu();
    }

    async function recarregarAcesso() {
        const user = firebase.auth().currentUser;
        if (!user) return;
        acessoEfetivo = await carregarAcesso(user);
        acessoCarregado = true;
        filtrarMenu();
        const atual = frame.getAttribute('src') || pageFromUrl();
        if (!podeAcessar(atual)) loadPage(paginaPadrao(), true);
    }

    function wireMenu() {
        document.addEventListener('click', event => {
            const target = event.target && event.target.nodeType === 1 ? event.target : event.target?.parentElement;
            const link = target?.closest?.('#app-sidebar .sb-item');
            if (!link) return;
            const href = link.getAttribute('data-href') || link.getAttribute('href') || '';
            if (!href.startsWith('/')) return;
            event.preventDefault();
            event.stopPropagation();
            if (!podeAcessar(href)) {
                loadPage(paginaPadrao(), true);
                return;
            }
            document.getElementById('app-sidebar')?.classList.remove('open');
            loadPage(href, true);
        }, true);
        setActive(frame.getAttribute('src') || pageFromUrl());
    }

    function syncFromFrame() {
        try {
            cleanupFrameChrome();
            const path = frame.contentWindow.location.pathname + frame.contentWindow.location.search + frame.contentWindow.location.hash;
            const clean = path.split('?')[0].split('#')[0].split('/').pop().toLowerCase();
            if (allowed.has(clean)) {
                if (!podeAcessar(path)) {
                    loadPage(paginaPadrao(), true);
                    return;
                }
                history.replaceState({ page: path }, '', '/admin.html?page=' + encodeURIComponent(path));
                setActive(path);
            }
        } catch (e) {
            // Cross-origin navigation is not expected here; ignore if it happens.
        }
    }

    function cleanupFrameChrome() {
        try {
            removeStrayEllipsis(document);
            const doc = frame.contentDocument;
            if (!doc) return;
            removeStrayEllipsis(doc);

            let style = doc.getElementById('admin-frame-cleanup-style');
            if (!style) {
                style = doc.createElement('style');
                style.id = 'admin-frame-cleanup-style';
                style.textContent = [
                    '#app-sidebar,#sb-toggle,#sb-backdrop{display:none!important;}',
                    'body{margin-left:0!important;}',
                    '@media (max-width:1100px){.painel-header,.topbar,header.top{display:grid!important;grid-template-columns:1fr!important;gap:10px!important;min-height:92px!important;padding:16px 14px 14px 76px!important;}.painel-header h1,header.top h1,.topbar h1{min-height:48px!important;display:flex!important;align-items:center!important;padding-left:0!important;margin:0!important;}}'
                ].join('');
                doc.head.appendChild(style);
            }

            ['app-sidebar', 'sb-toggle', 'sb-backdrop'].forEach(id => {
                const el = doc.getElementById(id);
                if (el) el.remove();
            });
            if (doc.body) doc.body.style.marginLeft = '0';
        } catch (e) {
            // Same-origin iframe is expected; ignore if the frame navigates elsewhere.
        }
    }

    function scheduleFrameCleanup() {
        cleanupFrameChrome();
        [50, 150, 400, 900, 1500].forEach(ms => setTimeout(cleanupFrameChrome, ms));
    }

    async function refreshSystem() {
        const btn = document.getElementById('system-refresh');
        const stamp = Date.now();
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Atualizando...';
        }

        try {
            if ('caches' in window) {
                const keys = await caches.keys();
                await Promise.all(keys.map(key => caches.delete(key)));
            }
            if ('serviceWorker' in navigator) {
                const regs = await navigator.serviceWorker.getRegistrations();
                await Promise.all(regs.map(reg => reg.unregister()));
            }
        } catch (e) {
            console.warn('Atualizacao de cache:', e);
        }

        const currentPage = frame.getAttribute('src') || pageFromUrl();
        const refreshedPage = withRefreshParam(currentPage, stamp);
        const url = '/admin.html?page=' + encodeURIComponent(refreshedPage) + '&refresh=' + stamp;
        location.replace(url);
    }

    window.GestorChefAdminShell = {
        recarregarAcesso
    };

    function wireRefreshButton() {
        const btn = document.getElementById('system-refresh');
        if (btn) btn.addEventListener('click', refreshSystem);
    }

    function init() {
        try {
            if (window.firebase && firebase.apps && firebase.apps.length === 0 && window.__FIREBASE_CONFIG__) {
                firebase.initializeApp(window.__FIREBASE_CONFIG__);
            }
            // SESSION (não LOCAL): fechar o navegador tem que exigir login de
            // novo — isso é só a sessão de auth, não mexe na persistência
            // offline do Firestore (enablePersistence logo abaixo).
            firebase.auth().setPersistence(firebase.auth.Auth.Persistence.SESSION).catch(() => {});
            // Sem isso, a config de exibição e as permissões só existem em
            // memória: reabrir o admin.html offline (sem ter passado por
            // carregarAcesso antes nesta sessão) rejeita a consulta e derruba
            // o menu inteiro (só sobra o "Início", que não tem data-key).
            firebase.firestore().enablePersistence({ synchronizeTabs: true }).catch(err => {
                if (err.code === 'failed-precondition') {
                    console.warn('Persistência offline: já ativa em outra aba deste navegador.');
                } else if (err.code === 'unimplemented') {
                    console.warn('Persistência offline: navegador sem suporte (IndexedDB).');
                }
            });
            firebase.auth().onAuthStateChanged(async user => {
                if (!user) { window.location.href = '/login.html'; return; }
                try {
                    acessoEfetivo = await carregarAcesso(user);
                    acessoCarregado = true;
                    filtrarMenu();
                    loadPage(pageFromUrl(), false);
                } catch (err) {
                    console.warn('Permissoes:', err);
                    acessoEfetivo = {};
                    acessoCarregado = true;
                    loadPage(paginaPadrao(), false);
                }
            });
        } catch (e) { /* page scripts also protect routes */ }

        removeStrayEllipsis(document);
        frame.addEventListener('load', () => {
            scheduleFrameCleanup();
            syncFromFrame();
        });
        setTimeout(wireMenu, 0);
        wireRefreshButton();
        window.addEventListener('popstate', () => loadPage(pageFromUrl(), false));
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
