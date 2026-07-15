// ============================================================
//  MARKETING & APP — aparência, banner, promoções, cupons, fidelidade
//  Coleções (LEITURA PÚBLICA p/ o app, escrita só logado):
//    app_config/geral  { nomeApp, emojiLogo, corPrimaria,
//                        bannerAtivo, bannerTexto, bannerCor,
//                        fidelidadeAtiva, pontosPorReal, valorPorPonto,
//                        minResgate, validadePontosDias }
//    cupons     { codigo, tipo, valor, minimo, validade, ativo }
//    promocoes  { titulo, descricao, ativo, criado_em }
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    const firebaseConfig = window.__FIREBASE_CONFIG__;
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    const db = firebase.firestore();
    const auth = firebase.auth();
    const FieldValue = firebase.firestore.FieldValue;
    const Timestamp = firebase.firestore.Timestamp;

    const $ = (id) => document.getElementById(id);
    const money = (v) => "R$ " + (Number(v) || 0).toFixed(2).replace('.', ',');
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    const APP = db.collection('app_config').doc('geral');

    auth.onAuthStateChanged(user => {
        if (!user) { window.location.href = '/login.html'; return; }
        setupTabs();
        carregarApp();
        ouvirCupons();
        ouvirPromocoes();
        $('a-salvar').addEventListener('click', salvarAparencia);
        $('b-salvar').addEventListener('click', salvarBanner);
        $('f-salvar').addEventListener('click', salvarFidelidade);
        $('c-add').addEventListener('click', addCupom);
        $('p-add').addEventListener('click', addPromocao);
        $('a-cor').addEventListener('input', () => { $('a-corhex').value = $('a-cor').value; previewApp(); });
        $('a-corhex').addEventListener('input', () => { if (/^#[0-9a-fA-F]{6}$/.test($('a-corhex').value)) $('a-cor').value = $('a-corhex').value; previewApp(); });
        $('a-nome').addEventListener('input', previewApp);
        $('a-emoji').addEventListener('input', previewApp);
    });

    function setupTabs() {
        document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
            document.querySelectorAll('.view').forEach(v => v.classList.remove('show'));
            t.classList.add('active');
            $('view-' + t.dataset.tab).classList.add('show');
        }));
    }

    // ---------- App config (aparência + banner + fidelidade) ----------
    async function carregarApp() {
        const d = (await APP.get()).data() || {};
        $('a-nome').value = d.nomeApp || '';
        $('a-emoji').value = d.emojiLogo || '🍕';
        $('a-cor').value = d.corPrimaria || '#ff5200';
        $('a-corhex').value = d.corPrimaria || '#ff5200';
        $('b-ativo').checked = !!d.bannerAtivo;
        $('b-texto').value = d.bannerTexto || '';
        $('b-cor').value = d.bannerCor || '#ff5200';
        $('f-ativo').checked = d.fidelidadeAtiva !== false;
        $('f-pontosreal').value = d.pontosPorReal != null ? d.pontosPorReal : 1;
        $('f-valorponto').value = d.valorPorPonto != null ? d.valorPorPonto : 0.05;
        $('f-minresgate').value = d.minResgate != null ? d.minResgate : 100;
        $('f-validade').value = d.validadePontosDias != null ? d.validadePontosDias : 0;
        previewApp();
    }

    function previewApp() {
        const cor = $('a-corhex').value || '#ff5200';
        const nome = $('a-nome').value || 'Seu App';
        const emoji = $('a-emoji').value || '🍕';
        $('a-preview').innerHTML = `<div style="background:${esc(cor)};color:#fff;padding:14px;border-radius:10px;font-weight:800;font-size:1.1rem;">${esc(emoji)} ${esc(nome)}</div>`;
    }

    async function salvarAparencia() {
        try {
            await APP.set({
                nomeApp: $('a-nome').value.trim(),
                emojiLogo: $('a-emoji').value.trim() || '🍕',
                corPrimaria: ($('a-corhex').value || '#ff5200').trim()
            }, { merge: true });
            flash('Aparência salva.');
        } catch (e) { alert('Erro: ' + e.message); }
    }

    async function salvarBanner() {
        try {
            await APP.set({
                bannerAtivo: $('b-ativo').checked,
                bannerTexto: $('b-texto').value.trim(),
                bannerCor: $('b-cor').value
            }, { merge: true });
            flash('Banner salvo.');
        } catch (e) { alert('Erro: ' + e.message); }
    }

    async function salvarFidelidade() {
        try {
            await APP.set({
                fidelidadeAtiva: $('f-ativo').checked,
                pontosPorReal: parseFloat($('f-pontosreal').value) || 0,
                valorPorPonto: parseFloat($('f-valorponto').value) || 0,
                minResgate: parseInt($('f-minresgate').value) || 0,
                validadePontosDias: parseInt($('f-validade').value) || 0
            }, { merge: true });
            flash('Fidelidade salva.');
        } catch (e) { alert('Erro: ' + e.message); }
    }

    // ---------- Cupons ----------
    function ouvirCupons() {
        db.collection('cupons').onSnapshot(snap => {
            const arr = []; snap.forEach(d => arr.push({ id: d.id, ...d.data() }));
            arr.sort((a, b) => (a.codigo || '').localeCompare(b.codigo || ''));
            const tb = $('c-lista');
            if (!arr.length) { tb.innerHTML = '<tr><td colspan="6" style="color:#7f8c8d">Nenhum cupom.</td></tr>'; return; }
            tb.innerHTML = arr.map(c => {
                const desc = c.tipo === 'percentual' ? `${c.valor}%` : money(c.valor);
                const val = c.validade?.toDate ? c.validade.toDate().toLocaleDateString('pt-BR') : 'sem validade';
                const badge = c.ativo !== false ? '<span class="badge b-on">ativo</span>' : '<span class="badge b-off">inativo</span>';
                return `<tr>
                    <td><strong>${esc(c.codigo)}</strong></td><td>${desc}</td><td>${money(c.minimo)}</td>
                    <td>${val}</td><td>${badge}</td>
                    <td style="text-align:right">
                        <button class="btn btn-add" data-toggle="${c.id}" data-ativo="${c.ativo !== false}">${c.ativo !== false ? 'Desativar' : 'Ativar'}</button>
                        <button class="btn btn-rm" data-del="${c.id}">×</button>
                    </td></tr>`;
            }).join('');
            tb.querySelectorAll('[data-del]').forEach(b => b.onclick = () => db.collection('cupons').doc(b.dataset.del).delete());
            tb.querySelectorAll('[data-toggle]').forEach(b => b.onclick = () =>
                db.collection('cupons').doc(b.dataset.toggle).update({ ativo: b.dataset.ativo !== 'true' }));
        });
    }

    async function addCupom() {
        const codigo = ($('c-codigo').value || '').trim().toUpperCase();
        const valor = parseFloat($('c-valor').value);
        if (!codigo || isNaN(valor) || valor <= 0) { alert('Informe código e valor válidos.'); return; }
        const valStr = $('c-val').value;
        try {
            await db.collection('cupons').add({
                codigo, tipo: $('c-tipo').value, valor,
                minimo: parseFloat($('c-min').value) || 0,
                validade: valStr ? Timestamp.fromDate(new Date(valStr + 'T23:59:59')) : null,
                ativo: true, criado_em: FieldValue.serverTimestamp()
            });
            $('c-codigo').value = ''; $('c-valor').value = ''; $('c-min').value = '0'; $('c-val').value = '';
            flash('Cupom criado.');
        } catch (e) { alert('Erro: ' + e.message); }
    }

    // ---------- Promoções ----------
    function ouvirPromocoes() {
        db.collection('promocoes').onSnapshot(snap => {
            const arr = []; snap.forEach(d => arr.push({ id: d.id, ...d.data() }));
            const tb = $('p-lista');
            if (!arr.length) { tb.innerHTML = '<tr><td colspan="3" style="color:#7f8c8d">Nenhuma promoção.</td></tr>'; return; }
            tb.innerHTML = arr.map(p => {
                const badge = p.ativo !== false ? '<span class="badge b-on">ativa</span>' : '<span class="badge b-off">inativa</span>';
                return `<tr>
                    <td><strong>${esc(p.titulo)}</strong><br><span style="color:#7f8c8d;font-size:.82rem">${esc(p.descricao)}</span></td>
                    <td>${badge}</td>
                    <td style="text-align:right">
                        <button class="btn btn-add" data-toggle="${p.id}" data-ativo="${p.ativo !== false}">${p.ativo !== false ? 'Desativar' : 'Ativar'}</button>
                        <button class="btn btn-rm" data-del="${p.id}">×</button>
                    </td></tr>`;
            }).join('');
            tb.querySelectorAll('[data-del]').forEach(b => b.onclick = () => db.collection('promocoes').doc(b.dataset.del).delete());
            tb.querySelectorAll('[data-toggle]').forEach(b => b.onclick = () =>
                db.collection('promocoes').doc(b.dataset.toggle).update({ ativo: b.dataset.ativo !== 'true' }));
        });
    }

    async function addPromocao() {
        const titulo = ($('p-titulo').value || '').trim();
        if (!titulo) { alert('Informe o título.'); return; }
        try {
            await db.collection('promocoes').add({
                titulo, descricao: $('p-desc').value.trim(), ativo: true, criado_em: FieldValue.serverTimestamp()
            });
            $('p-titulo').value = ''; $('p-desc').value = '';
            flash('Promoção adicionada.');
        } catch (e) { alert('Erro: ' + e.message); }
    }

    function flash(t) {
        const d = document.createElement('div');
        d.textContent = t;
        d.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#2c3e50;color:#fff;padding:12px 20px;border-radius:10px;z-index:9999;box-shadow:0 4px 14px rgba(0,0,0,.3);';
        document.body.appendChild(d);
        setTimeout(() => d.remove(), 2400);
    }
});
