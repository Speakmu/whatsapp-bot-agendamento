// Configuracoes gerais e exibicao de modulos.
document.addEventListener('DOMContentLoaded', () => {
    const firebaseConfig = window.__FIREBASE_CONFIG__;
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);

    const db = firebase.firestore();
    const auth = firebase.auth();
    const $ = (id) => document.getElementById(id);

    const DOC_GERAL = db.collection('configuracoes').doc('sistema');
    const DOC_EXIB = db.collection('configuracoes').doc('exibicao');
    const DOC_PAGAMENTOS = db.collection('configuracoes').doc('pagamentos');
    const COL_USUARIOS = db.collection('usuarios_admin');
    const ADMIN_EMAIL = 'lileamarloja04@gmail.com';
    const MODULOS = ['pedidos', 'kds', 'mesas', 'entregas', 'caixa', 'bi', 'financeiro', 'fiscal', 'relatorios', 'estoque', 'fichas', 'cardapio', 'marketing', 'bot', 'configuracoes'];
    const NOMES_MODULOS = {
        pedidos: 'Pedidos',
        kds: 'Cozinha (KDS)',
        mesas: 'Mesas & Comandas',
        entregas: 'Entregas',
        caixa: 'Caixa / PDV',
        bi: 'BI / Vendas',
        financeiro: 'Financeiro',
        fiscal: 'Fiscal',
        relatorios: 'Relatorios',
        estoque: 'Estoque',
        fichas: 'Ficha Tecnica / Custos',
        cardapio: 'Cardapio',
        marketing: 'Marketing & App',
        bot: 'Bot',
        configuracoes: 'Configuracoes'
    };
    let usuarioAtual = null;
    let editandoEmail = null;

    auth.onAuthStateChanged(user => {
        if (!user) { window.location.href = '/login.html'; return; }
        usuarioAtual = user;
        carregar();
        $('salvar-geral').addEventListener('click', salvarGeral);
        $('salvar-pagamentos').addEventListener('click', salvarPagamentos);
        $('salvar-exibicao').addEventListener('click', salvarExibicao);
        $('salvar-usuario').addEventListener('click', salvarUsuario);
        $('novo-usuario').addEventListener('click', limparUsuarioForm);
        if (!isAdmin(user.email)) {
            $('usuarios-admin-box').style.display = 'none';
        } else {
            carregarUsuarios();
        }
    });

    function chk(mod) {
        return document.querySelector(`input[data-mod="${mod}"]`);
    }
    function userChk(mod) {
        return document.querySelector(`input[data-user-mod="${mod}"]`);
    }
    function docIdEmail(email) {
        return String(email || '').trim().toLowerCase();
    }
    function isAdmin(email) {
        return docIdEmail(email) === ADMIN_EMAIL;
    }

    async function carregar() {
        try {
            const g = await DOC_GERAL.get();
            if (g.exists) {
                const d = g.data();
                $('g-nome').value = d.nome || '';
                $('g-telefone').value = d.telefone || '';
                $('g-endereco').value = d.endereco || '';
            }
            await carregarExibicao();
            await carregarPagamentos();
        } catch (err) {
            alert('Erro ao carregar configuracoes: ' + err.message);
        }
    }

    async function carregarPagamentos() {
        try {
            const snap = await DOC_PAGAMENTOS.get();
            const d = snap.exists ? (snap.data() || {}) : {};
            $('pag-point-device').value = d.pointDeviceId || '';
        } catch (err) {
            console.warn('pagamentos:', err.message);
        }
    }

    async function salvarPagamentos() {
        try {
            await DOC_PAGAMENTOS.set({
                pointDeviceId: $('pag-point-device').value.trim(),
                atualizado_em: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            flash('Configuracoes de pagamento salvas.');
        } catch (err) {
            alert('Erro ao salvar pagamentos: ' + err.message);
        }
    }

    async function carregarExibicao() {
        try {
            const snap = await DOC_EXIB.get();
            const cfg = snap.exists ? (snap.data() || {}) : {};
            MODULOS.forEach(m => {
                const c = chk(m);
                if (c) c.checked = cfg[m] !== false;
            });
        } catch (err) {
            console.warn('exibicao:', err.message);
        }
    }

    async function salvarGeral() {
        try {
            await DOC_GERAL.set({
                nome: $('g-nome').value.trim(),
                telefone: $('g-telefone').value.trim(),
                endereco: $('g-endereco').value.trim()
            }, { merge: true });
            flash('Dados gerais salvos.');
        } catch (err) {
            alert('Erro: ' + err.message);
        }
    }

    async function salvarExibicao() {
        const cfg = {};
        MODULOS.forEach(m => {
            const c = chk(m);
            cfg[m] = c ? c.checked : true;
        });
        try {
            await DOC_EXIB.set(cfg, { merge: true });
            if (window.GestorChefShell) window.GestorChefShell.aplicarExibicao(cfg);
            if (window.parent && window.parent !== window && window.parent.GestorChefShell) {
                window.parent.GestorChefShell.aplicarExibicao(cfg);
            }
            if (window.parent && window.parent !== window && window.parent.GestorChefAdminShell) {
                await window.parent.GestorChefAdminShell.recarregarAcesso();
            }
            flash('Exibicao salva.');
        } catch (err) {
            alert('Erro ao salvar exibicao: ' + err.message);
        }
    }

    function permissoesDoForm() {
        const permissoes = {};
        MODULOS.forEach(m => {
            const c = userChk(m);
            permissoes[m] = c ? c.checked : false;
        });
        return permissoes;
    }

    function aplicarPermissoesNoForm(permissoes, admin) {
        MODULOS.forEach(m => {
            const c = userChk(m);
            if (!c) return;
            c.checked = admin ? true : !!(permissoes && permissoes[m]);
            c.disabled = !!admin;
        });
    }

    function limparUsuarioForm() {
        editandoEmail = null;
        $('u-nome').value = '';
        $('u-email').value = '';
        $('u-email').disabled = false;
        aplicarPermissoesNoForm(Object.fromEntries(MODULOS.map(m => [m, m !== 'configuracoes'])), false);
    }

    async function garantirAdmin() {
        const ref = COL_USUARIOS.doc(ADMIN_EMAIL);
        const snap = await ref.get();
        const permissoes = Object.fromEntries(MODULOS.map(m => [m, true]));
        const base = {
            email: ADMIN_EMAIL,
            nome: 'Administrador',
            admin: true,
            ativo: true,
            permissoes,
            atualizado_em: firebase.firestore.FieldValue.serverTimestamp()
        };
        await ref.set(snap.exists ? base : { ...base, criado_em: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
    }

    async function carregarUsuarios() {
        const lista = $('usuarios-lista');
        lista.innerHTML = '<div class="muted-box">Carregando usuarios...</div>';
        try {
            await garantirAdmin();
            const snap = await COL_USUARIOS.orderBy('email').get();
            const usuarios = [];
            snap.forEach(doc => usuarios.push({ id: doc.id, ...doc.data() }));
            renderUsuarios(usuarios);
        } catch (err) {
            lista.innerHTML = `<div class="muted-box">Erro ao carregar usuarios: ${escapeHtml(err.message)}</div>`;
        }
    }

    function renderUsuarios(usuarios) {
        const lista = $('usuarios-lista');
        if (!usuarios.length) {
            lista.innerHTML = '<div class="muted-box">Nenhum usuario cadastrado.</div>';
            return;
        }
        lista.innerHTML = usuarios.map(u => {
            const permissoes = u.admin ? MODULOS : MODULOS.filter(m => u.permissoes && u.permissoes[m]);
            const mods = permissoes.length
                ? permissoes.map(m => `<span>${escapeHtml(NOMES_MODULOS[m] || m)}</span>`).join('')
                : '<span>Nenhum modulo</span>';
            const badge = u.admin ? '<span class="usuario-badge admin">ADMIN</span>' : '<span class="usuario-badge">Usuario</span>';
            const remove = u.admin ? '' : `<button class="btn btn-vermelho" data-del-user="${escapeHtml(u.email)}">Remover</button>`;
            const avisoAdmin = u.admin ? '<div class="usuario-meta">Admin principal: somente este login pode editar usuarios e permissoes.</div>' : '';
            return `<div class="usuario-card">
                <div class="usuario-top">
                    <div>
                        <div class="usuario-email">${escapeHtml(u.email || u.id)}</div>
                        <div class="usuario-meta">${escapeHtml(u.nome || 'Sem nome')} ${u.ativo === false ? '- inativo' : ''}</div>
                        ${avisoAdmin}
                    </div>
                    ${badge}
                </div>
                <div class="usuario-modulos">${mods}</div>
                <div class="usuario-actions">
                    <button class="btn btn-azul" data-edit-user="${escapeHtml(u.email)}">Editar acesso</button>
                    ${remove}
                </div>
            </div>`;
        }).join('');
        lista.querySelectorAll('[data-edit-user]').forEach(btn => btn.addEventListener('click', () => editarUsuario(btn.dataset.editUser)));
        lista.querySelectorAll('[data-del-user]').forEach(btn => btn.addEventListener('click', () => removerUsuario(btn.dataset.delUser)));
    }

    async function salvarUsuario() {
        if (!isAdmin(usuarioAtual && usuarioAtual.email)) {
            alert('Apenas o administrador pode gerenciar usuarios.');
            return;
        }
        const email = docIdEmail($('u-email').value);
        const nome = $('u-nome').value.trim();
        if (!email || !email.includes('@')) {
            alert('Informe um e-mail valido.');
            return;
        }
        const admin = isAdmin(email);
        const permissoes = admin ? Object.fromEntries(MODULOS.map(m => [m, true])) : permissoesDoForm();
        try {
            const ref = COL_USUARIOS.doc(email);
            const snap = await ref.get();
            await ref.set({
                email,
                nome: nome || email,
                admin,
                ativo: true,
                permissoes,
                atualizado_em: firebase.firestore.FieldValue.serverTimestamp(),
                ...(snap.exists ? {} : { criado_em: firebase.firestore.FieldValue.serverTimestamp() })
            }, { merge: true });
            flash('Usuario salvo.');
            limparUsuarioForm();
            carregarUsuarios();
        } catch (err) {
            alert('Erro ao salvar usuario: ' + err.message);
        }
    }

    async function editarUsuario(email) {
        try {
            const id = docIdEmail(email);
            const snap = await COL_USUARIOS.doc(id).get();
            if (!snap.exists) return;
            const u = snap.data();
            editandoEmail = id;
            $('u-nome').value = u.nome || '';
            $('u-email').value = u.email || id;
            $('u-email').disabled = true;
            aplicarPermissoesNoForm(u.permissoes || {}, !!u.admin);
            $('usuarios-admin-box').scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch (err) {
            alert('Erro ao editar usuario: ' + err.message);
        }
    }

    async function removerUsuario(email) {
        const id = docIdEmail(email);
        if (isAdmin(id)) {
            alert('O admin principal nao pode ser removido.');
            return;
        }
        if (!confirm(`Remover acesso de ${id}?`)) return;
        try {
            await COL_USUARIOS.doc(id).delete();
            if (editandoEmail === id) limparUsuarioForm();
            carregarUsuarios();
            flash('Usuario removido.');
        } catch (err) {
            alert('Erro ao remover usuario: ' + err.message);
        }
    }

    function escapeHtml(s) {
        return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    function flash(t) {
        const d = document.createElement('div');
        d.textContent = t;
        d.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#2c3e50;color:#fff;padding:12px 20px;border-radius:10px;z-index:9999;box-shadow:0 4px 14px rgba(0,0,0,.3);';
        document.body.appendChild(d);
        setTimeout(() => d.remove(), 2400);
    }
});
