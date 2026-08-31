// ============================================================
//  Shell - injeta a navegacao lateral em todas as telas admin.
//  Inclua na pagina:
//    <link rel="stylesheet" href="/shell.css">
//    <script src="/shell.js" defer></script>
//  Requer o Firebase (auth) ja carregado na pagina para logout.
// ============================================================

(function () {
    if (window.self !== window.top) return;

    const arquivoAtual = (location.pathname.split('/').pop() || 'home.html').toLowerCase();
    const isAdminShell = arquivoAtual === 'admin.html';
    const ADMIN_EMAIL = 'lileamarloja04@gmail.com';
    // Acesso de suporte (mesmo e-mail da categoria "Suporte" em
    // configuracoes.js/firestore.rules): acesso total, igual admin.
    const VENDOR_ADMIN_EMAIL = 'contato.seusuportetec@gmail.com';
    const MODULE_KEYS = ['pedidos', 'kds', 'mesas', 'entregas', 'caixa', 'bi', 'financeiro', 'fiscal', 'relatorios', 'estoque', 'fichas', 'cardapio', 'marketing', 'bot', 'mensalidade', 'configuracoes'];

    if (!isAdminShell) {
        const page = location.pathname + location.search + location.hash;
        window.location.replace('/admin.html?page=' + encodeURIComponent(page));
        return;
    }

    const NAV = [
        {
            grupo: "Opera&ccedil;&atilde;o",
            itens: [
                { label: "In&iacute;cio", icon: "&#127968;", href: "/home.html" },
                { label: "Pedidos", icon: "&#129534;", href: "/painel.html", key: "pedidos" },
                { label: "Cozinha (KDS)", icon: "&#128104;&#8205;&#127859;", href: "/kds.html", key: "kds" },
                { label: "Mesas & Comandas", icon: "&#127869;&#65039;", href: "/mesas.html", key: "mesas" },
                { label: "Entregas", icon: "&#128757;", href: "/entrega.html", key: "entregas" },
                { label: "Caixa / PDV", icon: "&#128181;", href: "/caixa.html", key: "caixa" }
            ]
        },
        {
            grupo: "Gest&atilde;o",
            itens: [
                { label: "BI / Vendas", icon: "&#128200;", href: "/bi.html", key: "bi" },
                { label: "Financeiro", icon: "&#128202;", href: "/financeiro.html", key: "financeiro" },
                { label: "Fiscal", icon: "&#128220;", href: "/fiscal.html", key: "fiscal" },
                { label: "Relat&oacute;rios", icon: "&#128203;", href: "/painel.html#relatorios", key: "relatorios" },
                { label: "Estoque", icon: "&#128230;", href: "/estoque.html", key: "estoque" },
                { label: "Ficha T&eacute;cnica / Custos", icon: "&#129518;", href: "/ficha-tecnica.html", key: "fichas" }
            ]
        },
        {
            grupo: "Cadastros",
            itens: [
                { label: "Card&aacute;pio", icon: "&#127829;", href: "/painel.html#cardapio", key: "cardapio" }
            ]
        },
        {
            grupo: "Bot",
            itens: [
                { label: "Atendimento", icon: "&#128172;", href: "/bot-chat.html", key: "bot" }
            ]
        },
        {
            grupo: "Sistema",
            itens: [
                { label: "Marketing & App", icon: "&#128227;", href: "/marketing.html", key: "marketing" },
                { label: "Mensalidade", icon: "&#128179;", href: "/mensalidades.html", key: "mensalidade" },
                { label: "Configura&ccedil;&otilde;es", icon: "&#9881;&#65039;", href: "/configuracoes.html", key: "configuracoes" }
            ]
        }
    ];

    const PAGE_KEYS = {
        'painel.html': ['pedidos', 'cardapio', 'relatorios'],
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

    function normalizarEmail(email) {
        return String(email || '').trim().toLowerCase();
    }

    function isAdmin(email) {
        return normalizarEmail(email) === ADMIN_EMAIL;
    }

    function isVendor(email) {
        return normalizarEmail(email) === VENDOR_ADMIN_EMAIL;
    }

    async function carregarAcesso(user) {
        const db = firebase.firestore();
        if (isAdmin(user && user.email) || isVendor(user && user.email)) {
            const acessoAdmin = {};
            MODULE_KEYS.forEach(k => acessoAdmin[k] = true);
            return { admin: true, permissoes: acessoAdmin };
        }
        const email = normalizarEmail(user && user.email);
        if (!email) return { admin: false, permissoes: {} };
        const snap = await db.collection('usuarios_admin').doc(email).get();
        if (!snap.exists) return { admin: false, permissoes: {} };
        const data = snap.data() || {};
        if (data.ativo === false) return { admin: false, permissoes: {} };
        return { admin: !!data.admin, permissoes: data.permissoes || {} };
    }

    async function carregarExibicaoGlobal() {
        const snap = await firebase.firestore().collection('configuracoes').doc('exibicao').get();
        return snap.exists ? (snap.data() || {}) : {};
    }

    function acessoEfetivo(globalCfg, acesso) {
        const admin = !!(acesso && acesso.admin);
        const permissoes = admin
            ? Object.fromEntries(MODULE_KEYS.map(k => [k, true]))
            : ((acesso && acesso.permissoes) || {});
        const final = {};
        MODULE_KEYS.forEach(k => {
            final[k] = permissoes[k] === true && globalCfg[k] !== false;
        });
        if (admin) final.configuracoes = true;
        return final;
    }

    function ehAtivo(href) {
        const arq = href.split('#')[0].split('/').pop().toLowerCase();
        const hash = href.split('#')[1] || '';
        const hashAtual = (location.hash || '').replace('#', '');
        return arq === arquivoAtual && hash === hashAtual;
    }

    function garantirApp() {
        try {
            if (window.firebase && firebase.apps && firebase.apps.length === 0 && window.__FIREBASE_CONFIG__) {
                firebase.initializeApp(window.__FIREBASE_CONFIG__);
            }
        } catch (e) {
            // Firebase ja inicializado.
        }
    }

    function montar() {
        if (document.getElementById('app-sidebar')) return;
        garantirApp();

        const aside = document.createElement('aside');
        aside.id = 'app-sidebar';

        let html = '<div class="sb-brand"><span class="logo"><img src="/assets/gestorchef-logo.jpeg" alt="GestorChef"></span><span>GestorChef</span></div><nav>';
        NAV.forEach(g => {
            html += `<div class="sb-group">${g.grupo}</div>`;
            g.itens.forEach(it => {
                const ativo = ehAtivo(it.href) ? ' active' : '';
                html += `<a class="sb-item${ativo}" data-href="${it.href}" data-key="${it.key || ''}" href="${it.href}"><span class="ic">${it.icon}</span>${it.label}</a>`;
            });
        });
        html += `</nav>
            <div class="sb-foot">
                <button class="sb-refresh" id="system-refresh" type="button" title="Buscar a vers&atilde;o mais nova do sistema">&#8635; Atualizar sistema</button>
                <div class="sb-user" id="sb-user">-</div>
                <button class="sb-logout" id="sb-logout">&#9099; Sair</button>
            </div>`;
        aside.innerHTML = html;

        const toggle = document.createElement('button');
        toggle.id = 'sb-toggle';
        toggle.innerHTML = '&#9776;';
        toggle.setAttribute('aria-label', 'Abrir menu');
        toggle.setAttribute('title', 'Menu');

        const backdrop = document.createElement('div');
        backdrop.id = 'sb-backdrop';

        document.body.appendChild(toggle);
        document.body.appendChild(aside);
        document.body.appendChild(backdrop);

        aplicarVisibilidade(aside);
        aplicarMargem();
        window.addEventListener('resize', aplicarMargem);

        toggle.addEventListener('click', () => aside.classList.toggle('open'));
        backdrop.addEventListener('click', () => aside.classList.remove('open'));

        aside.querySelectorAll('.sb-item').forEach(a => {
            a.addEventListener('click', () => aside.classList.remove('open'));
        });

        window.addEventListener('hashchange', reavaliarAtivo);
        function reavaliarAtivo() {
            aside.querySelectorAll('.sb-item').forEach(a => {
                a.classList.toggle('active', ehAtivo(a.getAttribute('data-href')));
            });
        }

        const btnLogout = document.getElementById('sb-logout');
        btnLogout.addEventListener('click', () => {
            if (window.firebase && firebase.auth) {
                firebase.auth().signOut().finally(() => { window.location.href = '/login.html'; });
            } else {
                window.location.href = '/login.html';
            }
        });

        if (window.firebase && firebase.auth) {
            firebase.auth().onAuthStateChanged(u => {
                if (u) document.getElementById('sb-user').textContent = u.email || 'Conectado';
            });
        }
    }

    function aplicarExibicaoNoDOM(aside, cfg) {
        cfg = cfg || {};
        aside.querySelectorAll('.sb-item').forEach(function (a) {
            const k = a.getAttribute('data-key');
            if (k) a.style.display = (cfg[k] === false) ? 'none' : '';
        });
        aside.querySelectorAll('.sb-group').forEach(function (gh) {
            let visiveis = 0;
            let el = gh.nextElementSibling;
            while (el && el.classList.contains('sb-item')) {
                if (el.style.display !== 'none') visiveis++;
                el = el.nextElementSibling;
            }
            gh.style.display = visiveis ? '' : 'none';
        });
    }

    window.GestorChefShell = {
        aplicarExibicao: function (cfg) {
            const aside = document.getElementById('app-sidebar');
            if (aside) aplicarExibicaoNoDOM(aside, cfg);
        }
    };

    function aplicarVisibilidade(aside) {
        if (!(window.firebase && firebase.firestore && firebase.auth)) return;
        garantirApp();
        firebase.auth().onAuthStateChanged(async function (user) {
            if (!user) return;
            try {
                const globalCfg = await carregarExibicaoGlobal();
                const acesso = await carregarAcesso(user);
                const cfg = acessoEfetivo(globalCfg, acesso);
                const donos = PAGE_KEYS[arquivoAtual];
                if (donos && donos.every(function (k) { return cfg[k] !== true; })) {
                    window.location.replace('/admin.html?page=%2Fhome.html');
                    return;
                }
                aplicarExibicaoNoDOM(aside, cfg);
            } catch (e) {
                // Sem config = mostra tudo.
            }
        });
    }

    function aplicarMargem() {
        const desktop = window.matchMedia('(min-width: 1101px)').matches;
        document.body.style.marginLeft = desktop ? 'var(--sb-w)' : '0';
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', montar);
    } else {
        montar();
    }
})();
