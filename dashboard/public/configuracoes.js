// ============================================================
//  CONFIGURAÇÕES — gerais + fiscal (NFC-e)
//  Firestore:
//    configuracoes/sistema  { nome, telefone, endereco }
//    configuracoes/fiscal   { ativo, modo, url, apiKey, razao, fantasia,
//                             cnpj, ie, uf, regime, ambiente, serie,
//                             csc, cscId, ncm, cfop, cst, origem }
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
    const firebaseConfig = window.__FIREBASE_CONFIG__;
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    const db = firebase.firestore();
    const auth = firebase.auth();
    const $ = (id) => document.getElementById(id);

    const DOC_GERAL = db.collection('configuracoes').doc('sistema');
    const DOC_FISCAL = db.collection('configuracoes').doc('fiscal');
    const DOC_EXIB = db.collection('configuracoes').doc('exibicao');

    const MODULOS = ['pedidos', 'kds', 'mesas', 'entregas', 'caixa', 'bi', 'financeiro', 'notas', 'relatorios', 'estoque', 'fichas', 'cardapio', 'marketing'];

    auth.onAuthStateChanged(user => {
        if (!user) { window.location.href = '/login.html'; return; }
        carregar();
        $('salvar-geral').addEventListener('click', salvarGeral);
        $('salvar-fiscal').addEventListener('click', salvarFiscal);
        $('testar-fiscal').addEventListener('click', testarConexao);
        $('f-ativo').addEventListener('change', refletirAtivo);
        $('salvar-exibicao').addEventListener('click', salvarExibicao);
        $('secao-config').addEventListener('change', trocarSecao);
        $('enviar-cert').addEventListener('click', enviarCertificado);
    });

    async function enviarCertificado() {
        const url = $('f-url').value.trim().replace(/\/$/, '');
        const apiKey = $('f-apikey').value.trim();
        const msg = $('cert-msg');
        const file = $('f-cert-file').files[0];
        const senha = $('f-cert-senha').value;
        if (!url) { msg.textContent = 'Salve a URL do serviço fiscal primeiro.'; msg.style.color = '#c0392b'; return; }
        if (!file) { msg.textContent = 'Selecione o arquivo .pfx.'; msg.style.color = '#c0392b'; return; }
        if (!senha) { msg.textContent = 'Informe a senha do certificado.'; msg.style.color = '#c0392b'; return; }
        msg.textContent = 'Enviando...'; msg.style.color = '#7f8c8d';
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
            if (resp.ok && data.ok) {
                msg.textContent = `✅ ${data.message || 'Certificado enviado.'}`; msg.style.color = '#1e8e4f';
                $('f-cert-file').value = '';
                $('f-cert-senha').value = '';
            } else {
                msg.textContent = '❌ ' + (data.error || `Falha (${resp.status}).`); msg.style.color = '#c0392b';
            }
        } catch (err) {
            msg.textContent = '❌ Não foi possível enviar (verifique URL/CORS/serviço no ar).'; msg.style.color = '#c0392b';
        }
    }

    function trocarSecao() {
        const s = $('secao-config').value;
        $('painel-sistema').style.display = s === 'sistema' ? '' : 'none';
        $('painel-fiscal').style.display = s === 'fiscal' ? '' : 'none';
    }

    function chk(mod) { return document.querySelector(`input[data-mod="${mod}"]`); }

    async function carregarExibicao() {
        try {
            const snap = await DOC_EXIB.get();
            const cfg = snap.exists ? (snap.data() || {}) : {};
            MODULOS.forEach(m => { const c = chk(m); if (c) c.checked = cfg[m] !== false; }); // padrão: visível
        } catch (e) { console.warn('exibicao:', e.message); }
    }

    async function salvarExibicao() {
        const cfg = {};
        MODULOS.forEach(m => { const c = chk(m); cfg[m] = c ? c.checked : true; });
        try {
            await DOC_EXIB.set(cfg, { merge: true });
            if (window.GestorChefShell) window.GestorChefShell.aplicarExibicao(cfg); // atualiza o menu na hora
            flash('Exibição salva ✓');
        } catch (err) { alert('Erro ao salvar exibição: ' + err.message); }
    }

    function refletirAtivo() {
        const on = $('f-ativo').checked;
        $('fiscal-fields').classList.toggle('disabled', !on);
        const badge = $('fiscal-status');
        badge.textContent = on ? 'Ativado' : 'Desativado';
        badge.className = 'badge ' + (on ? 'on' : 'off');
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
            const f = await DOC_FISCAL.get();
            if (f.exists) {
                const d = f.data();
                $('f-ativo').checked = !!d.ativo;
                $('f-modo').value = d.modo || 'manual';
                $('f-url').value = d.url || '';
                $('f-apikey').value = d.apiKey || '';
                $('f-razao').value = d.razao || '';
                $('f-fantasia').value = d.fantasia || '';
                $('f-cnpj').value = d.cnpj || '';
                $('f-ie').value = d.ie || '';
                $('f-uf').value = d.uf || '';
                $('f-regime').value = d.regime || 'simples';
                $('f-ambiente').value = d.ambiente || 'homologacao';
                $('f-serie').value = d.serie || 1;
                $('f-csc').value = d.csc || '';
                $('f-cscid').value = d.cscId || '';
                $('f-ncm').value = d.ncm || '';
                $('f-cfop').value = d.cfop || '';
                $('f-cst').value = d.cst || '';
                $('f-origem').value = d.origem || '0';
                $('f-xlgr').value = d.xLgr || '';
                $('f-nro').value = d.nro || '';
                $('f-xcpl').value = d.xCpl || '';
                $('f-xbairro').value = d.xBairro || '';
                $('f-xmun').value = d.xMun || '';
                $('f-cmun').value = d.cMun || '';
                $('f-cep').value = d.cep || '';
                $('f-fone').value = d.fone || '';
                $('f-qrbase').value = d.qrBaseUrl || '';
                $('f-urlchave').value = d.urlChave || '';
            }
            refletirAtivo();
            await carregarExibicao();
        } catch (err) { alert('Erro ao carregar configurações: ' + err.message); }
    }

    async function salvarGeral() {
        try {
            await DOC_GERAL.set({
                nome: $('g-nome').value.trim(),
                telefone: $('g-telefone').value.trim(),
                endereco: $('g-endereco').value.trim()
            }, { merge: true });
            flash('Dados gerais salvos.');
        } catch (err) { alert('Erro: ' + err.message); }
    }

    async function salvarFiscal() {
        try {
            await DOC_FISCAL.set({
                ativo: $('f-ativo').checked,
                modo: $('f-modo').value,
                url: $('f-url').value.trim().replace(/\/$/, ''),
                apiKey: $('f-apikey').value.trim(),
                razao: $('f-razao').value.trim(),
                fantasia: $('f-fantasia').value.trim(),
                cnpj: $('f-cnpj').value.trim(),
                ie: $('f-ie').value.trim(),
                uf: $('f-uf').value.trim().toUpperCase(),
                regime: $('f-regime').value,
                ambiente: $('f-ambiente').value,
                serie: parseInt($('f-serie').value) || 1,
                csc: $('f-csc').value.trim(),
                cscId: $('f-cscid').value.trim(),
                ncm: $('f-ncm').value.trim(),
                cfop: $('f-cfop').value.trim(),
                cst: $('f-cst').value.trim(),
                origem: $('f-origem').value,
                xLgr: $('f-xlgr').value.trim(),
                nro: $('f-nro').value.trim(),
                xCpl: $('f-xcpl').value.trim(),
                xBairro: $('f-xbairro').value.trim(),
                xMun: $('f-xmun').value.trim(),
                cMun: $('f-cmun').value.trim(),
                cep: $('f-cep').value.trim(),
                fone: $('f-fone').value.trim(),
                qrBaseUrl: $('f-qrbase').value.trim().replace(/\/$/, ''),
                urlChave: $('f-urlchave').value.trim().replace(/\/$/, '')
            }, { merge: true });
            flash('Configuração fiscal salva.');
        } catch (err) { alert('Erro ao salvar: ' + err.message); }
    }

    async function testarConexao() {
        const url = $('f-url').value.trim().replace(/\/$/, '');
        const apiKey = $('f-apikey').value.trim();
        const msg = $('fiscal-msg');
        if (!url) { msg.textContent = 'Informe a URL do serviço fiscal.'; msg.style.color = '#c0392b'; return; }
        msg.textContent = 'Testando...'; msg.style.color = '#7f8c8d';
        try {
            const resp = await fetch(`${url}/fiscal/health`, {
                headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}
            });
            if (resp.ok) { msg.textContent = '✅ Conexão OK com o serviço fiscal.'; msg.style.color = '#1e8e4f'; }
            else { msg.textContent = `⚠️ Serviço respondeu ${resp.status}.`; msg.style.color = '#e67e22'; }
        } catch (err) {
            msg.textContent = '❌ Não foi possível conectar (verifique URL/CORS/serviço no ar).';
            msg.style.color = '#c0392b';
        }
    }

    function flash(t) {
        const d = document.createElement('div');
        d.textContent = t;
        d.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#2c3e50;color:#fff;padding:12px 20px;border-radius:10px;z-index:9999;box-shadow:0 4px 14px rgba(0,0,0,.3);';
        document.body.appendChild(d);
        setTimeout(() => d.remove(), 2400);
    }
});
