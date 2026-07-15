// ============================================================
//  Shell — injeta a navegação lateral em todas as telas admin.
//  Inclua na página:
//    <link rel="stylesheet" href="/shell.css">
//    <script src="/shell.js" defer></script>
//  Requer o Firebase (auth) já carregado na página (para o logout).
// ============================================================

(function () {
    const NAV = [
        {
            grupo: "Operação", itens: [
                { label: "Início", icon: "🏠", href: "/home.html" },
                { label: "Pedidos", icon: "🧾", href: "/painel.html", key: "pedidos" },
                { label: "Cozinha (KDS)", icon: "👨‍🍳", href: "/kds.html", key: "kds" },
                { label: "Mesas", icon: "🍽️", href: "/mesas.html", key: "mesas" },
                { label: "Entregas", icon: "🛵", href: "/entrega.html", key: "entregas" },
                { label: "Caixa / PDV", icon: "💵", href: "/caixa.html", key: "caixa" }
            ]
        },
        {
            grupo: "Gestão", itens: [
                { label: "BI / Vendas", icon: "📈", href: "/bi.html", key: "bi" },
                { label: "Financeiro", icon: "📊", href: "/financeiro.html", key: "financeiro" },
                { label: "Notas Fiscais", icon: "🧾", href: "/notas.html", key: "notas" },
                { label: "Relatórios", icon: "📋", href: "/painel.html#relatorios", key: "relatorios" },
                { label: "Estoque", icon: "📦", href: "/estoque.html", key: "estoque" },
                { label: "Ficha Técnica / Custos", icon: "🧮", href: "/ficha-tecnica.html", key: "fichas" }
            ]
        },
        {
            grupo: "Cadastros", itens: [
                { label: "Cardápio", icon: "🍕", href: "/painel.html#cardapio", key: "cardapio" }
            ]
        },
        {
            grupo: "Sistema", itens: [
                { label: "Marketing & App", icon: "📣", href: "/marketing.html", key: "marketing" },
                { label: "Configurações", icon: "⚙️", href: "/configuracoes.html" }
            ]
        }
    ];

    const arquivoAtual = (location.pathname.split('/').pop() || 'home.html').toLowerCase();

    // Página -> módulos "donos". Bloqueia o acesso direto se TODOS estiverem ocultos.
    // painel.html é compartilhado por Pedidos, Cardápio e Relatórios.
    const PAGE_KEYS = {
        'painel.html': ['pedidos', 'cardapio', 'relatorios'],
        'kds.html': ['kds'],
        'mesas.html': ['mesas'],
        'entrega.html': ['entregas'],
        'caixa.html': ['caixa'],
        'bi.html': ['bi'],
        'financeiro.html': ['financeiro'],
        'notas.html': ['notas'],
        'estoque.html': ['estoque'],
        'ficha-tecnica.html': ['fichas'],
        'marketing.html': ['marketing']
    };

    function ehAtivo(href) {
        const arq = href.split('#')[0].split('/').pop().toLowerCase();
        const hash = (href.split('#')[1] || '');
        const hashAtual = (location.hash || '').replace('#', '');
        return arq === arquivoAtual && hash === hashAtual;
    }

    // Garante que o Firebase esteja inicializado antes de o shell usá-lo.
    // (O shell roda com defer e pode executar antes do JS da página inicializar o app.)
    function garantirApp() {
        try {
            if (window.firebase && firebase.apps && firebase.apps.length === 0 && window.__FIREBASE_CONFIG__) {
                firebase.initializeApp(window.__FIREBASE_CONFIG__);
            }
        } catch (e) { /* já inicializado */ }
    }

    function montar() {
        if (document.getElementById('app-sidebar')) return;
        garantirApp();

        const aside = document.createElement('aside');
        aside.id = 'app-sidebar';

        let html = `<div class="sb-brand"><span class="logo">🍕</span> GestorChef</div><nav>`;
        NAV.forEach(g => {
            html += `<div class="sb-group">${g.grupo}</div>`;
            g.itens.forEach(it => {
                const ativo = ehAtivo(it.href) ? ' active' : '';
                html += `<a class="sb-item${ativo}" data-href="${it.href}" data-key="${it.key || ''}" href="${it.href}"><span class="ic">${it.icon}</span>${it.label}</a>`;
            });
        });
        html += `</nav>
            <div class="sb-foot">
                <div class="sb-user" id="sb-user">—</div>
                <button class="sb-logout" id="sb-logout">⎋ Sair</button>
            </div>`;
        aside.innerHTML = html;

        const toggle = document.createElement('button');
        toggle.id = 'sb-toggle';
        toggle.innerHTML = '☰';
        const backdrop = document.createElement('div');
        backdrop.id = 'sb-backdrop';

        document.body.appendChild(toggle);
        document.body.appendChild(aside);
        document.body.appendChild(backdrop);

        // Aplica a configuração de exibição de módulos (configuracoes/exibicao)
        aplicarVisibilidade(aside);

        // empurra o conteúdo no desktop
        aplicarMargem();
        window.addEventListener('resize', aplicarMargem);

        toggle.addEventListener('click', () => aside.classList.toggle('open'));
        backdrop.addEventListener('click', () => aside.classList.remove('open'));

        // fecha o menu (mobile) ao clicar num item e atualiza o destaque ao vivo
        aside.querySelectorAll('.sb-item').forEach(a => a.addEventListener('click', () => aside.classList.remove('open')));
        window.addEventListener('hashchange', reavaliarAtivo);
        function reavaliarAtivo() {
            aside.querySelectorAll('.sb-item').forEach(a => {
                a.classList.toggle('active', ehAtivo(a.getAttribute('data-href')));
            });
        }

        // logout (usa Firebase já presente na página)
        const btnLogout = document.getElementById('sb-logout');
        btnLogout.addEventListener('click', () => {
            if (window.firebase && firebase.auth) {
                firebase.auth().signOut().finally(() => window.location.href = '/login.html');
            } else {
                window.location.href = '/login.html';
            }
        });

        // mostra o e-mail do usuário, se autenticado
        if (window.firebase && firebase.auth) {
            firebase.auth().onAuthStateChanged(u => {
                if (u) document.getElementById('sb-user').textContent = u.email || 'Conectado';
            });
        }
    }

    // Aplica a config de exibição diretamente no DOM da sidebar (mostra/esconde itens e grupos)
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

    // Exposto para o painel de Configurações atualizar o menu ao vivo, sem recarregar
    window.GestorChefShell = {
        aplicarExibicao: function (cfg) {
            const aside = document.getElementById('app-sidebar');
            if (aside) aplicarExibicaoNoDOM(aside, cfg);
        }
    };

    function aplicarVisibilidade(aside) {
        if (!(window.firebase && firebase.firestore && firebase.auth)) return;
        garantirApp();
        firebase.auth().onAuthStateChanged(function (user) {
            if (!user) return;
            firebase.firestore().collection('configuracoes').doc('exibicao').get().then(function (snap) {
                if (!snap.exists) return;
                const cfg = snap.data() || {};
                // Bloqueio de acesso direto: se a página pertence só a módulo(s) oculto(s), volta ao Início
                const donos = PAGE_KEYS[arquivoAtual];
                if (donos && donos.every(function (k) { return cfg[k] === false; })) {
                    window.location.replace('/home.html');
                    return;
                }
                aplicarExibicaoNoDOM(aside, cfg);
            }).catch(function () { /* sem config = mostra tudo */ });
        });
    }

    function aplicarMargem() {
        const desktop = window.matchMedia('(min-width: 881px)').matches;
        document.body.style.marginLeft = desktop ? 'var(--sb-w)' : '0';
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', montar);
    } else {
        montar();
    }
})();
