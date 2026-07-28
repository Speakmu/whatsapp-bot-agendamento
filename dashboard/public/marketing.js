// ============================================================
//  MARKETING & APP — aparência, banner, promoções, cupons, fidelidade
//  Coleções (LEITURA PÚBLICA p/ o app, escrita só logado):
//    app_config/geral  { nomeApp, corPrimaria, corSecundaria,
//                        identidadeTipo ('texto'|'logo'), fontFamily, fontSize, logoUrl,
//                        bannerAtivo, bannerTexto, bannerCor,
//                        vitrineColunas, vitrineImagem,
//                        fidelidadeAtiva, pontosPorReal, valorPorPonto,
//                        minResgate, validadePontosDias }
//    app_config/destaques { grupos: [{ chave, titulo, cor, limite, produtosIds }] }
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

    const FONT_PREVIEW_CSS = {
        italico: "italic 700 1.4rem Georgia, 'Times New Roman', serif",
        classico: "normal 700 1.4rem Georgia, 'Times New Roman', serif",
        moderno: "normal 800 1.4rem 'Segoe UI', Roboto, sans-serif",
        condensado: "normal 700 1.4rem 'Segoe UI', Roboto, sans-serif"
    };
    const FONT_PREVIEW_SIZE = { pequeno: '1.1rem', medio: '1.4rem', grande: '1.8rem' };
    const V_IMG_LISTA = { pequena: 44, media: 60, grande: 82 };
    const V_IMG_GRADE = { pequena: 60, media: 86, grande: 110 };

    let logoFileSelecionado = null; // arquivo novo escolhido, aguardando upload no "Salvar"
    let logoUrlAtual = '';          // logoUrl já salvo no Firestore

    auth.onAuthStateChanged(user => {
        if (!user) { window.location.href = '/login.html'; return; }
        setupTabs();
        carregarApp();
        carregarDestaques();
        ouvirCupons();
        ouvirPromocoes();
        $('a-salvar').addEventListener('click', salvarAparencia);
        $('b-salvar').addEventListener('click', salvarBanner);
        $('f-salvar').addEventListener('click', salvarFidelidade);
        $('d-salvar').addEventListener('click', salvarDestaques);
        $('c-add').addEventListener('click', addCupom);
        $('p-add').addEventListener('click', addPromocao);
        $('a-cor').addEventListener('input', () => { $('a-corhex').value = $('a-cor').value; previewApp(); });
        $('a-corhex').addEventListener('input', () => { if (/^#[0-9a-fA-F]{6}$/.test($('a-corhex').value)) $('a-cor').value = $('a-corhex').value; previewApp(); });
        $('a-cor2').addEventListener('input', () => { $('a-corhex2').value = $('a-cor2').value; });
        $('a-corhex2').addEventListener('input', () => { if (/^#[0-9a-fA-F]{6}$/.test($('a-corhex2').value)) $('a-cor2').value = $('a-corhex2').value; });
        $('a-nome').addEventListener('input', previewApp);
        $('a-fonte').addEventListener('change', previewApp);
        $('a-tamanho').addEventListener('change', previewApp);
        $('a-tipo').addEventListener('change', () => { alternarBlocoIdentidade(); previewApp(); });
        $('a-logo-file').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            logoFileSelecionado = file;
            const urlLocal = URL.createObjectURL(file);
            $('a-logo-preview').src = urlLocal;
            $('a-logo-preview').style.display = 'inline-block';
            $('a-logo-remover').style.display = 'inline-block';
            previewApp();
        });
        $('a-logo-remover').addEventListener('click', () => {
            logoFileSelecionado = null;
            logoUrlAtual = '';
            $('a-logo-file').value = '';
            $('a-logo-preview').src = '';
            $('a-logo-preview').style.display = 'none';
            $('a-logo-remover').style.display = 'none';
            previewApp();
        });
        $('v-salvar').addEventListener('click', salvarLayoutVitrine);
        $('v-colunas').addEventListener('change', previewVitrine);
        $('v-imagem').addEventListener('change', previewVitrine);
        $('hero-file').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            heroFileSelecionado = file;
            $('hero-preview').src = URL.createObjectURL(file);
            $('hero-preview').style.display = 'inline-block';
            $('hero-remover').style.display = 'inline-block';
        });
        $('hero-remover').addEventListener('click', () => {
            heroFileSelecionado = null;
            heroUrlAtual = '';
            $('hero-file').value = '';
            $('hero-preview').src = '';
            $('hero-preview').style.display = 'none';
            $('hero-remover').style.display = 'none';
        });
    });

    function setupTabs() {
        document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
            document.querySelectorAll('.view').forEach(v => v.classList.remove('show'));
            t.classList.add('active');
            $('view-' + t.dataset.tab).classList.add('show');
        }));
    }

    function alternarBlocoIdentidade() {
        const ehLogo = $('a-tipo').value === 'logo';
        $('a-bloco-texto').style.display = ehLogo ? 'none' : 'block';
        $('a-bloco-logo').style.display = ehLogo ? 'block' : 'none';
    }

    // ---------- App config (aparência + banner + fidelidade) ----------
    async function carregarApp() {
        const d = (await APP.get()).data() || {};
        $('a-nome').value = d.nomeApp || '';
        $('a-fonte').value = d.fontFamily || 'italico';
        $('a-tamanho').value = d.fontSize || 'grande';
        $('a-cor').value = d.corPrimaria || '#ff5200';
        $('a-corhex').value = d.corPrimaria || '#ff5200';
        $('a-cor2').value = d.corSecundaria || '#ffffff';
        $('a-corhex2').value = d.corSecundaria || '#ffffff';
        $('a-tipo').value = d.identidadeTipo || 'texto';
        logoUrlAtual = d.logoUrl || '';
        if (logoUrlAtual) {
            $('a-logo-preview').src = logoUrlAtual;
            $('a-logo-preview').style.display = 'inline-block';
            $('a-logo-remover').style.display = 'inline-block';
        }
        alternarBlocoIdentidade();
        $('b-ativo').checked = !!d.bannerAtivo;
        $('b-texto').value = d.bannerTexto || '';
        $('b-cor').value = d.bannerCor || '#ff5200';
        $('f-ativo').checked = d.fidelidadeAtiva !== false;
        $('f-pontosreal').value = d.pontosPorReal != null ? d.pontosPorReal : 1;
        $('f-valorponto').value = d.valorPorPonto != null ? d.valorPorPonto : 0.05;
        $('f-minresgate').value = d.minResgate != null ? d.minResgate : 100;
        $('f-validade').value = d.validadePontosDias != null ? d.validadePontosDias : 0;
        $('v-colunas').value = d.vitrineColunas || 1;
        $('v-imagem').value = d.vitrineImagem || 'media';
        previewApp();
        previewVitrine();
    }

    function previewVitrine() {
        const colunas = parseInt($('v-colunas').value) || 1;
        const imgKey = $('v-imagem').value;
        const box = $('v-preview');
        const poolNomes = ['Pastel de Queijo', 'Coxinha Especial', 'Esfirra de Carne', 'Enroladinho'];
        const poolPrecos = ['R$ 8,50', 'R$ 9,90', 'R$ 7,50', 'R$ 6,90'];
        const qtd = colunas === 1 ? 2 : colunas;

        if (colunas > 1) {
            const alt = V_IMG_GRADE[imgKey] || V_IMG_GRADE.media;
            box.style.display = 'grid';
            box.style.gridTemplateColumns = `repeat(${colunas}, 1fr)`;
            box.style.gap = '10px';
            box.innerHTML = Array.from({ length: qtd }).map((_, i) => `
                <div style="background:#fff;border-radius:10px;padding:8px;box-shadow:0 2px 6px rgba(0,0,0,.08);">
                    <div style="width:100%;height:${alt}px;background:#e0e6ec;border-radius:8px;margin-bottom:6px;"></div>
                    <div style="font-size:.78rem;font-weight:700;color:#1a1a1a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(poolNomes[i % poolNomes.length])}</div>
                    <div style="font-size:.8rem;font-weight:bold;color:#174e2a;margin-top:2px;">${poolPrecos[i % poolPrecos.length]}</div>
                </div>
            `).join('');
        } else {
            const tam = V_IMG_LISTA[imgKey] || V_IMG_LISTA.media;
            box.style.display = 'block';
            box.style.gridTemplateColumns = '';
            box.innerHTML = Array.from({ length: qtd }).map((_, i) => `
                <div style="display:flex;align-items:center;gap:10px;background:#fff;border-radius:10px;padding:8px;box-shadow:0 2px 6px rgba(0,0,0,.08);margin-bottom:8px;">
                    <div style="width:${tam}px;height:${tam}px;background:#e0e6ec;border-radius:8px;flex-shrink:0;"></div>
                    <div style="flex:1;">
                        <div style="font-size:.85rem;font-weight:700;color:#1a1a1a;">${esc(poolNomes[i % poolNomes.length])}</div>
                        <div style="font-size:.8rem;color:#999;margin-top:2px;">Ingredientes de exemplo...</div>
                        <div style="font-size:.85rem;font-weight:bold;color:#174e2a;margin-top:2px;">${poolPrecos[i % poolPrecos.length]}</div>
                    </div>
                    <div style="width:28px;height:28px;border:1px solid #ff5200;border-radius:6px;display:flex;align-items:center;justify-content:center;color:#ff5200;font-weight:bold;">+</div>
                </div>
            `).join('');
        }
    }

    async function salvarLayoutVitrine() {
        try {
            await APP.set({
                vitrineColunas: parseInt($('v-colunas').value) || 1,
                vitrineImagem: $('v-imagem').value
            }, { merge: true });
            flash('Layout da vitrine salvo.');
        } catch (e) { alert('Erro: ' + e.message); }
    }

    function previewApp() {
        const cor = $('a-corhex').value || '#ff5200';
        const nome = $('a-nome').value || 'Seu App';
        const ehLogo = $('a-tipo').value === 'logo';
        const temLogoPreview = $('a-logo-preview').style.display !== 'none' && $('a-logo-preview').src;

        if (ehLogo && temLogoPreview) {
            $('a-preview').innerHTML = `<div style="background:${esc(cor)};padding:14px;border-radius:10px;display:flex;align-items:center;justify-content:center;">
                <img src="${$('a-logo-preview').src}" style="max-height:50px;max-width:220px;">
            </div>`;
            return;
        }
        const font = FONT_PREVIEW_CSS[$('a-fonte').value] || FONT_PREVIEW_CSS.italico;
        const size = FONT_PREVIEW_SIZE[$('a-tamanho').value] || FONT_PREVIEW_SIZE.grande;
        $('a-preview').innerHTML = `<div style="background:${esc(cor)};color:#fff;padding:14px;border-radius:10px;">
            <span style="font:${font};font-size:${size};">${esc(nome)}</span>
        </div>`;
    }

    async function salvarAparencia() {
        const btn = $('a-salvar');
        btn.disabled = true;
        const textoOriginal = btn.textContent;
        try {
            const dados = {
                nomeApp: $('a-nome').value.trim(),
                corPrimaria: ($('a-corhex').value || '#ff5200').trim(),
                corSecundaria: ($('a-corhex2').value || '#ffffff').trim(),
                identidadeTipo: $('a-tipo').value,
                fontFamily: $('a-fonte').value,
                fontSize: $('a-tamanho').value,
                emojiLogo: FieldValue.delete()
            };

            if ($('a-tipo').value === 'logo') {
                if (logoFileSelecionado) {
                    btn.textContent = 'Enviando logotipo...';
                    const storageRef = firebase.storage().ref();
                    const fileName = `marca/${Date.now()}_${logoFileSelecionado.name}`;
                    const fileRef = storageRef.child(fileName);
                    const snapshot = await fileRef.put(logoFileSelecionado);
                    logoUrlAtual = await snapshot.ref.getDownloadURL();
                    logoFileSelecionado = null;
                }
                dados.logoUrl = logoUrlAtual || '';
            } else {
                dados.logoUrl = FieldValue.delete();
            }

            await APP.set(dados, { merge: true });
            flash('Aparência salva.');
        } catch (e) {
            alert('Erro: ' + e.message);
        } finally {
            btn.disabled = false;
            btn.textContent = textoOriginal;
        }
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

    // ---------- Destaques (vitrines Topo / Meio / Fundo) ----------
    const DESTAQUES = db.collection('app_config').doc('destaques');
    const DESTAQUES_GRUPOS = ['topo', 'meio', 'fundo'];
    const DESTAQUES_PADRAO = {
        topo: { titulo: 'Mais pedidos', cor: '#e74c3c' },
        meio: { titulo: 'Promoções', cor: '#f39c12' },
        fundo: { titulo: 'Novidades', cor: '#2ecc71' }
    };
    let produtosCardapio = [];
    let heroFileSelecionado = null; // arquivo novo escolhido, aguardando upload no "Salvar"
    let heroUrlAtual = '';          // heroUrl já salvo no Firestore
    const destaquesState = {
        topo: { titulo: '', cor: '#e74c3c', limite: 6, produtosIds: [] },
        meio: { titulo: '', cor: '#f39c12', limite: 6, produtosIds: [] },
        fundo: { titulo: '', cor: '#2ecc71', limite: 6, produtosIds: [] }
    };

    async function carregarDestaques() {
        const snapProdutos = await db.collection('cardapio').orderBy('categoria').get();
        produtosCardapio = snapProdutos.docs.map(d => ({ id: d.id, ...d.data() }));

        const doc = (await DESTAQUES.get()).data() || {};
        const grupos = Array.isArray(doc.grupos) ? doc.grupos : [];

        heroUrlAtual = doc.heroUrl || '';
        if (heroUrlAtual) {
            $('hero-preview').src = heroUrlAtual;
            $('hero-preview').style.display = 'inline-block';
            $('hero-remover').style.display = 'inline-block';
        }

        const idsValidos = new Set(produtosCardapio.map(p => p.id));

        DESTAQUES_GRUPOS.forEach(chave => {
            const g = grupos.find(x => x.chave === chave) || {};
            const idsSalvos = Array.isArray(g.produtosIds) ? g.produtosIds : [];
            // Remove IDs "fantasma" (produtos excluídos do cardápio depois de virarem destaque)
            const idsLimpos = idsSalvos.filter(id => idsValidos.has(id));
            if (idsLimpos.length !== idsSalvos.length) {
                console.warn(`Destaque "${chave}": removidos ${idsSalvos.length - idsLimpos.length} produto(s) que não existem mais no cardápio.`);
            }
            destaquesState[chave] = {
                titulo: g.titulo || DESTAQUES_PADRAO[chave].titulo,
                cor: g.cor || DESTAQUES_PADRAO[chave].cor,
                limite: g.limite != null ? g.limite : 6,
                produtosIds: idsLimpos
            };
            renderGrupoDestaque(chave);
        });
    }

    function renderGrupoDestaque(chave) {
        const box = document.querySelector(`.box[data-grupo="${chave}"]`);
        const st = destaquesState[chave];
        box.querySelector('.d-titulo').value = st.titulo;
        box.querySelector('.d-cor').value = st.cor;
        box.querySelector('.d-corhex').value = st.cor;
        box.querySelector('.d-limite').value = st.limite;

        box.querySelector('.d-cor').addEventListener('input', () => {
            box.querySelector('.d-corhex').value = box.querySelector('.d-cor').value;
        });
        box.querySelector('.d-corhex').addEventListener('input', () => {
            if (/^#[0-9a-fA-F]{6}$/.test(box.querySelector('.d-corhex').value)) {
                box.querySelector('.d-cor').value = box.querySelector('.d-corhex').value;
            }
        });
        box.querySelector('.d-limite').addEventListener('input', () => atualizarContadorDestaque(chave));
        box.querySelector('.d-busca').addEventListener('input', (e) => renderListaProdutosDestaque(chave, e.target.value));

        renderListaProdutosDestaque(chave, '');
    }

    function renderListaProdutosDestaque(chave, termo) {
        const box = document.querySelector(`.box[data-grupo="${chave}"]`);
        const st = destaquesState[chave];
        const cont = box.querySelector('.d-lista-produtos');
        const t = (termo || '').toLowerCase().trim();
        const filtrados = produtosCardapio.filter(p =>
            !t || String(p.nome_exibicao || p.nome || '').toLowerCase().includes(t)
        );

        cont.innerHTML = filtrados.length ? filtrados.map(p => {
            const marcado = st.produtosIds.includes(p.id);
            return `<label style="display:flex;align-items:center;gap:8px;padding:6px 4px;border-bottom:1px solid var(--line);font-size:.88rem;">
                <input type="checkbox" data-pid="${p.id}" ${marcado ? 'checked' : ''}>
                <span style="flex:1;">${esc(p.nome_exibicao || p.nome)}</span>
                <span style="color:var(--muted)">${money(p.preco)}</span>
            </label>`;
        }).join('') : '<div style="color:var(--muted);padding:8px;">Nenhum produto encontrado.</div>';

        cont.querySelectorAll('input[type=checkbox]').forEach(chk => {
            chk.addEventListener('change', () => {
                const pid = chk.dataset.pid;
                const limiteAtual = parseInt(box.querySelector('.d-limite').value) || st.limite;
                if (chk.checked) {
                    if (st.produtosIds.length >= limiteAtual) {
                        chk.checked = false;
                        alert(`Limite de ${limiteAtual} produtos atingido para este destaque.`);
                        return;
                    }
                    st.produtosIds.push(pid);
                } else {
                    st.produtosIds = st.produtosIds.filter(id => id !== pid);
                }
                atualizarContadorDestaque(chave);
            });
        });

        atualizarContadorDestaque(chave);
    }

    function atualizarContadorDestaque(chave) {
        const box = document.querySelector(`.box[data-grupo="${chave}"]`);
        const st = destaquesState[chave];
        const limite = parseInt(box.querySelector('.d-limite').value) || st.limite;
        box.querySelector('.d-contador').textContent = `${st.produtosIds.length}/${limite} selecionados`;
    }

    async function salvarDestaques() {
        const btn = $('d-salvar');
        btn.disabled = true;
        const textoOriginal = btn.textContent;
        try {
            if (heroFileSelecionado) {
                btn.textContent = 'Enviando banner...';
                const storageRef = firebase.storage().ref();
                const fileName = `marca/${Date.now()}_${heroFileSelecionado.name}`;
                const fileRef = storageRef.child(fileName);
                const snapshot = await fileRef.put(heroFileSelecionado);
                heroUrlAtual = await snapshot.ref.getDownloadURL();
                heroFileSelecionado = null;
            }

            const grupos = DESTAQUES_GRUPOS.map(chave => {
                const box = document.querySelector(`.box[data-grupo="${chave}"]`);
                const st = destaquesState[chave];
                const limite = Math.max(1, parseInt(box.querySelector('.d-limite').value) || 6);
                return {
                    chave,
                    titulo: box.querySelector('.d-titulo').value.trim() || DESTAQUES_PADRAO[chave].titulo,
                    cor: (box.querySelector('.d-corhex').value || DESTAQUES_PADRAO[chave].cor).trim(),
                    limite,
                    produtosIds: st.produtosIds.slice(0, limite)
                };
            });
            await DESTAQUES.set({ heroUrl: heroUrlAtual || '', grupos }, { merge: true });
            flash('Destaques salvos.');
        } catch (e) {
            alert('Erro: ' + e.message);
        } finally {
            btn.disabled = false;
            btn.textContent = textoOriginal;
        }
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
