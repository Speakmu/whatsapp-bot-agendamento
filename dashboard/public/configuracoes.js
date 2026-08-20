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
    // horario_funcionamento mora no mesmo doc do bot (configuracoes/bot) porque
    // é lido por ele (backend-bot) e pelo app — não é exclusivo desta tela.
    const DOC_BOT = db.collection('configuracoes').doc('bot');
    const COL_USUARIOS = db.collection('usuarios_admin');
    const ADMIN_EMAIL = 'lileamarloja04@gmail.com';
    const MODULOS = ['pedidos', 'kds', 'mesas', 'entregas', 'caixa', 'bi', 'financeiro', 'fiscal', 'relatorios', 'estoque', 'fichas', 'cardapio', 'marketing', 'bot', 'mensalidade', 'configuracoes'];
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
        mensalidade: 'Mensalidade',
        configuracoes: 'Configuracoes'
    };
    const DIAS_SEMANA = [
        { chave: 'seg', nome: 'Segunda' },
        { chave: 'ter', nome: 'Terça' },
        { chave: 'qua', nome: 'Quarta' },
        { chave: 'qui', nome: 'Quinta' },
        { chave: 'sex', nome: 'Sexta' },
        { chave: 'sab', nome: 'Sábado' },
        { chave: 'dom', nome: 'Domingo' }
    ];
    const HORARIO_MENSAGEM_PADRAO = 'No momento estamos fechados. Nosso horário de funcionamento: {horario}';

    let usuarioAtual = null;
    let editandoEmail = null;

    auth.onAuthStateChanged(user => {
        if (!user) { window.location.href = '/login.html'; return; }
        usuarioAtual = user;
        montarTabelaHorario();
        carregar();
        $('salvar-geral').addEventListener('click', salvarGeral);
        $('salvar-pagamentos').addEventListener('click', salvarPagamentos);
        $('pag-provedor').addEventListener('change', aplicarVisibilidadeProvedor);
        $('pag-maquininha-ativa').addEventListener('change', aplicarVisibilidadeMaquininha);
        $('testar-stone').addEventListener('click', testarMaquininhaStone);
        $('salvar-exibicao').addEventListener('click', salvarExibicao);
        $('salvar-usuario').addEventListener('click', salvarUsuario);
        $('novo-usuario').addEventListener('click', limparUsuarioForm);
        $('salvar-horario').addEventListener('click', salvarHorario);
        if (!isAdmin(user.email)) {
            $('usuarios-admin-box').style.display = 'none';
        } else {
            carregarUsuarios();
        }
    });

    function montarTabelaHorario() {
        const body = $('horario-dias-body');
        body.innerHTML = DIAS_SEMANA.map(d => `
            <tr>
                <td style="padding:6px 4px;">${d.nome}</td>
                <td style="padding:6px 4px;"><input type="checkbox" id="horario-${d.chave}-aberto" style="width:18px;height:18px;"></td>
                <td style="padding:6px 4px;"><input type="time" id="horario-${d.chave}-abre" style="padding:6px;"></td>
                <td style="padding:6px 4px;"><input type="time" id="horario-${d.chave}-fecha" style="padding:6px;"></td>
            </tr>
        `).join('');
    }

    async function carregarHorario() {
        try {
            const snap = await DOC_BOT.get();
            const horario = (snap.exists ? snap.data() : {})?.horario_funcionamento || {};
            const dias = horario.dias || {};
            $('horario-ativo').checked = horario.ativo === true;
            $('horario-mensagem-fechado').value = horario.mensagem_fechado || '';
            DIAS_SEMANA.forEach(dd => {
                const cfgDia = dias[dd.chave] || {};
                $(`horario-${dd.chave}-aberto`).checked = cfgDia.aberto === true;
                $(`horario-${dd.chave}-abre`).value = cfgDia.abre || '';
                $(`horario-${dd.chave}-fecha`).value = cfgDia.fecha || '';
            });
        } catch (err) {
            console.warn('horario:', err.message);
        }
    }

    async function salvarHorario() {
        const dias = {};
        DIAS_SEMANA.forEach(d => {
            dias[d.chave] = {
                aberto: $(`horario-${d.chave}-aberto`).checked,
                abre: $(`horario-${d.chave}-abre`).value || '',
                fecha: $(`horario-${d.chave}-fecha`).value || ''
            };
        });
        try {
            await DOC_BOT.set({
                horario_funcionamento: {
                    ativo: $('horario-ativo').checked,
                    mensagem_fechado: $('horario-mensagem-fechado').value.trim() || HORARIO_MENSAGEM_PADRAO,
                    dias
                },
                atualizado_em: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            flash('Horário de funcionamento salvo.');
        } catch (err) {
            alert('Erro ao salvar horário: ' + err.message);
        }
    }

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
            await carregarHorario();
        } catch (err) {
            alert('Erro ao carregar configuracoes: ' + err.message);
        }
    }

    function aplicarVisibilidadeMaquininha() {
        $('pag-campos-maquininha').style.display = $('pag-maquininha-ativa').checked ? 'block' : 'none';
    }

    function aplicarVisibilidadeProvedor() {
        const stone = $('pag-provedor').value === 'stone';
        $('campo-point').style.display = stone ? 'none' : 'block';
        $('campo-stone').style.display = stone ? 'block' : 'none';
        $('campo-stone-code').style.display = stone ? 'block' : 'none';
        $('campo-stone-referer').style.display = stone ? 'block' : 'none';
        $('campo-stone-secret').style.display = stone ? 'block' : 'none';
        $('campo-teste-stone').style.display = stone ? 'block' : 'none';
    }

    const CRIAR_COBRANCA_STONE_URL = "https://us-central1-salgadinhos-lileamar.cloudfunctions.net/criarCobrancaStone";
    const CONFIGURAR_STONE_URL = "https://us-central1-salgadinhos-lileamar.cloudfunctions.net/configurarStoneConnect";

    async function authHeaders() {
        if (!usuarioAtual) throw new Error('Sessao expirada. Entre novamente no sistema.');
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${await usuarioAtual.getIdToken()}`
        };
    }

    async function testarMaquininhaStone() {
        const btn = $('testar-stone');
        const resultado = $('pag-teste-resultado');
        const serial = $('pag-stone-serial').value.trim();
        if (!serial) {
            alert('Informe o número de série da maquininha antes de testar.');
            return;
        }

        try {
            await salvarStoneConnect();
        } catch (err) {
            alert('Não foi possível validar a configuração Stone: ' + err.message);
            return;
        }

        btn.disabled = true;
        btn.textContent = 'Enviando cobrança de teste...';
        resultado.style.display = 'block';
        resultado.textContent = 'Aguardando resposta da maquininha...';

        try {
            const resp = await fetch(CRIAR_COBRANCA_STONE_URL, {
                method: 'POST',
                headers: await authHeaders(),
                body: JSON.stringify({
                    amount: 0.01,
                    externalReference: 'teste-conexao-' + Date.now(),
                    description: 'Teste de conexão da maquininha'
                })
            });
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok) {
                resultado.textContent = '❌ Falha ao acionar a maquininha: ' + (data.message || `erro ${resp.status}`);
                return;
            }
            resultado.textContent = `✅ Pedido de teste criado (id: ${data.id || '?'}). Confira se apareceu R$ 0,01 na tela da maquininha — se sim, a conexão está ok. Cancele o valor direto por lá.`;
        } catch (err) {
            resultado.textContent = '❌ Erro ao contatar o servidor: ' + err.message;
        } finally {
            btn.disabled = false;
            btn.textContent = 'Testar maquininha (R$ 0,01)';
        }
    }

    async function carregarPagamentos() {
        try {
            const snap = await DOC_PAGAMENTOS.get();
            const d = snap.exists ? (snap.data() || {}) : {};
            $('pag-point-device').value = d.pointDeviceId || '';
            $('pag-stone-serial').value = d.stoneDeviceSerial || '';
            $('pag-stone-code').value = d.stoneCode || '';
            $('pag-stone-referer').value = d.stoneServiceRefererName || '';
            $('pag-stone-secret').value = '';
            $('pag-stone-secret').placeholder = d.stoneSecretConfigured ? 'Chave Connect salva no servidor' : 'sk_...';
            $('pag-provedor').value = d.provedorCartao || 'mercadopago';
            $('pag-maquininha-ativa').checked = d.maquininhaAtiva !== false;
            aplicarVisibilidadeProvedor();
            aplicarVisibilidadeMaquininha();
        } catch (err) {
            console.warn('pagamentos:', err.message);
        }
    }

    async function salvarPagamentos() {
        try {
            const maquininhaAtiva = $('pag-maquininha-ativa').checked;
            if (maquininhaAtiva && $('pag-provedor').value === 'stone') await salvarStoneConnect();
            await DOC_PAGAMENTOS.set({
                maquininhaAtiva,
                provedorCartao: $('pag-provedor').value,
                pointDeviceId: $('pag-point-device').value.trim(),
                atualizado_em: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            flash('Configuracoes de pagamento salvas.');
        } catch (err) {
            alert('Erro ao salvar pagamentos: ' + err.message);
        }
    }

    async function salvarStoneConnect() {
        const resp = await fetch(CONFIGURAR_STONE_URL, {
            method: 'POST',
            headers: await authHeaders(),
            body: JSON.stringify({
                stoneCode: $('pag-stone-code').value.trim(),
                stoneDeviceSerial: $('pag-stone-serial').value.trim(),
                stoneServiceRefererName: $('pag-stone-referer').value.trim(),
                stoneSecretKey: $('pag-stone-secret').value.trim()
            })
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.message || `erro ${resp.status}`);
        $('pag-stone-secret').value = '';
        $('pag-stone-secret').placeholder = 'Chave Connect salva no servidor';
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
