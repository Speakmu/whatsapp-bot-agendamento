// ============================================================
//  Mensalidade do sistema — a loja vê e paga via PIX; só o
//  fornecedor (Murilo) lança/edita as cobranças e a chave PIX.
//  Payload EMV montado 100% no cliente (mesma lógica usada no
//  Construline), sem precisar de nenhum backend.
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
    const firebaseConfig = window.__FIREBASE_CONFIG__;
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);

    const db = firebase.firestore();
    const auth = firebase.auth();
    const $ = (id) => document.getElementById(id);

    // Único e-mail que pode lançar/editar mensalidade — é o fornecedor do
    // sistema, não o admin da loja (esse não pode marcar a própria cobrança
    // como paga). A regra real de segurança está no firestore.rules; isso
    // aqui só controla o que aparece na tela.
    const VENDOR_ADMIN_EMAIL = 'contato.seusuportetec@gmail.com';

    const COL_MENSALIDADES = db.collection('mensalidades');
    const DOC_COBRANCA = db.collection('configuracoes').doc('cobranca');

    let souFornecedor = false;
    let cobrancaCfg = { pix_chave: '', pix_recebedor: '', valor_padrao: 0 };
    let mensalidades = [];

    auth.onAuthStateChanged(user => {
        if (!user) { window.location.href = '/login.html'; return; }
        souFornecedor = (user.email || '').toLowerCase() === VENDOR_ADMIN_EMAIL;
        if (souFornecedor) $('admin-box').style.display = '';

        carregarCobrancaCfg().then(carregarMensalidades);

        $('btn-lancar').addEventListener('click', lancarMensalidade);
        $('btn-salvar-cobranca').addEventListener('click', salvarCobrancaCfg);
        $('btn-copiar-pix').addEventListener('click', copiarPix);
    });

    function money(v) {
        return 'R$ ' + (Number(v) || 0).toFixed(2).replace('.', ',');
    }

    function escapeHtml(s) {
        return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    function formatarData(ts) {
        try {
            const d = ts && ts.toDate ? ts.toDate() : new Date(ts);
            if (isNaN(d.getTime())) return '-';
            return d.toLocaleDateString('pt-BR');
        } catch (e) { return '-'; }
    }

    function flash(t) {
        const d = document.createElement('div');
        d.textContent = t;
        d.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#2c3e50;color:#fff;padding:12px 20px;border-radius:10px;z-index:9999;box-shadow:0 4px 14px rgba(0,0,0,.3);';
        document.body.appendChild(d);
        setTimeout(() => d.remove(), 2400);
    }

    // ---------- Config PIX / valor padrão ----------
    async function carregarCobrancaCfg() {
        try {
            const snap = await DOC_COBRANCA.get();
            cobrancaCfg = { pix_chave: '', pix_recebedor: '', valor_padrao: 0, ...(snap.exists ? snap.data() : {}) };
            $('cfg-pix-chave').value = cobrancaCfg.pix_chave || '';
            $('cfg-pix-recebedor').value = cobrancaCfg.pix_recebedor || '';
            $('cfg-valor-padrao').value = cobrancaCfg.valor_padrao || '';
            if (!$('nova-valor').value) $('nova-valor').value = cobrancaCfg.valor_padrao || '';
        } catch (err) {
            console.warn('cobranca cfg:', err.message);
        }
    }

    async function salvarCobrancaCfg() {
        try {
            await DOC_COBRANCA.set({
                pix_chave: $('cfg-pix-chave').value.trim(),
                pix_recebedor: $('cfg-pix-recebedor').value.trim(),
                valor_padrao: parseFloat($('cfg-valor-padrao').value) || 0,
                atualizado_em: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            flash('Configuração de cobrança salva.');
            await carregarCobrancaCfg();
            renderPix();
        } catch (err) {
            alert('Erro ao salvar: ' + err.message);
        }
    }

    // ---------- Lista de mensalidades ----------
    async function carregarMensalidades() {
        const tbody = $('mensalidades-tbody');
        try {
            const snap = await COL_MENSALIDADES.orderBy('vencimento', 'asc').get();
            mensalidades = [];
            snap.forEach(doc => mensalidades.push({ id: doc.id, ...doc.data() }));
            renderMensalidades();
            renderPix();
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="5" class="empty">Erro ao carregar: ${escapeHtml(err.message)}</td></tr>`;
        }
    }

    const STATUS_LABEL = { PAGO: 'PAGO', PENDENTE: 'PENDENTE', ATRASADO: 'ATRASADO', VENCE_HOJE: 'VENCE HOJE' };

    function statusExibicao(m) {
        if (m.status === 'PAGO') return 'PAGO';
        const venc = m.vencimento && m.vencimento.toDate ? m.vencimento.toDate() : null;
        if (!venc) return 'PENDENTE';
        // Compara só a data (dia/mês/ano) — comparar com a hora exata fazia
        // qualquer horário do próprio dia do vencimento já contar como atrasado.
        const hoje = new Date();
        const vencDia = new Date(venc.getFullYear(), venc.getMonth(), venc.getDate());
        const hojeDia = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
        if (vencDia.getTime() === hojeDia.getTime()) return 'VENCE_HOJE';
        if (vencDia < hojeDia) return 'ATRASADO';
        return 'PENDENTE';
    }

    function dataParaInput(ts) {
        const d = ts && ts.toDate ? ts.toDate() : null;
        if (!d) return '';
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${d.getFullYear()}-${mm}-${dd}`;
    }

    function renderMensalidades() {
        const tbody = $('mensalidades-tbody');
        if (!mensalidades.length) {
            tbody.innerHTML = '<tr><td colspan="5" class="empty">Nenhuma mensalidade lançada ainda.</td></tr>';
            return;
        }
        tbody.innerHTML = mensalidades.map(m => {
            const st = statusExibicao(m);
            const cssClass = st.toLowerCase().replace('_', '-');
            const badge = `<span class="badge ${cssClass}">${STATUS_LABEL[st] || st}</span>`;
            const acoes = [];
            if (souFornecedor) {
                if (st !== 'PAGO') acoes.push(`<button class="btn btn-salvar" data-marcar-pago="${m.id}" style="padding:6px 10px;font-size:.8rem">Marcar como paga</button>`);
                acoes.push(`<button class="btn" data-editar-venc="${m.id}" style="padding:6px 10px;font-size:.8rem;background:#eef2f7;color:#2c3e50">Editar vencimento</button>`);
                acoes.push(`<button class="btn" data-excluir="${m.id}" style="padding:6px 10px;font-size:.8rem;background:#fdecea;color:#c0392b">Excluir</button>`);
            }
            return `<tr data-row="${m.id}">
                <td>${escapeHtml(m.referencia || '-')}</td>
                <td>${money(m.valor)}</td>
                <td data-venc-cell>${formatarData(m.vencimento)}</td>
                <td>${badge}</td>
                <td><div style="display:flex;gap:6px;flex-wrap:wrap">${acoes.join('')}</div></td>
            </tr>`;
        }).join('');
        tbody.querySelectorAll('[data-marcar-pago]').forEach(btn => {
            btn.addEventListener('click', () => marcarComoPaga(btn.dataset.marcarPago));
        });
        tbody.querySelectorAll('[data-editar-venc]').forEach(btn => {
            btn.addEventListener('click', () => iniciarEdicaoVencimento(btn.dataset.editarVenc));
        });
        tbody.querySelectorAll('[data-excluir]').forEach(btn => {
            btn.addEventListener('click', () => excluirMensalidade(btn.dataset.excluir));
        });
    }

    function iniciarEdicaoVencimento(id) {
        const m = mensalidades.find(x => x.id === id);
        if (!m) return;
        const linha = $('mensalidades-tbody').querySelector(`tr[data-row="${id}"]`);
        const celula = linha && linha.querySelector('[data-venc-cell]');
        if (!celula) return;
        celula.innerHTML = `
            <input type="date" value="${dataParaInput(m.vencimento)}" style="padding:6px;border:1px solid var(--line);border-radius:6px">
            <button class="btn btn-salvar" style="padding:5px 9px;font-size:.78rem;margin-left:4px">Salvar</button>
            <button class="btn" style="padding:5px 9px;font-size:.78rem;background:#eef2f7;color:#2c3e50">Cancelar</button>
        `;
        const input = celula.querySelector('input');
        const [btnSalvar, btnCancelar] = celula.querySelectorAll('button');
        btnCancelar.addEventListener('click', renderMensalidades);
        btnSalvar.addEventListener('click', () => salvarNovoVencimento(id, input.value));
    }

    async function salvarNovoVencimento(id, dataStr) {
        if (!souFornecedor || !dataStr) return;
        try {
            const novaData = new Date(dataStr + 'T00:00:00');
            await COL_MENSALIDADES.doc(id).update({
                vencimento: firebase.firestore.Timestamp.fromDate(novaData),
                referencia: referenciaDeData(novaData)
            });
            flash('Vencimento atualizado.');
            await carregarMensalidades();
        } catch (err) {
            alert('Erro ao atualizar vencimento: ' + err.message);
        }
    }

    async function excluirMensalidade(id) {
        if (!souFornecedor) return;
        const m = mensalidades.find(x => x.id === id);
        if (!confirm(`Excluir a mensalidade ${m ? m.referencia : ''} (${m ? money(m.valor) : ''})? Isso não pode ser desfeito.`)) return;
        try {
            await COL_MENSALIDADES.doc(id).delete();
            flash('Mensalidade excluída.');
            await carregarMensalidades();
        } catch (err) {
            alert('Erro ao excluir: ' + err.message);
        }
    }

    function referenciaDeData(d) {
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        return `${mm}/${d.getFullYear()}`;
    }

    function somarMeses(data, n) {
        const d = new Date(data);
        d.setMonth(d.getMonth() + n);
        return d;
    }

    async function lancarMensalidade() {
        if (!souFornecedor) return;
        const valor = parseFloat($('nova-valor').value);
        const vencimentoStr = $('nova-vencimento').value;
        const qtd = parseInt($('nova-qtd').value, 10) || 1;
        if (!valor || valor <= 0) return alert('Informe um valor válido.');
        if (!vencimentoStr) return alert('Informe o vencimento inicial.');

        try {
            const dataInicial = new Date(vencimentoStr + 'T00:00:00');
            const batch = db.batch();
            for (let i = 0; i < qtd; i++) {
                const dataCharge = somarMeses(dataInicial, i);
                batch.set(COL_MENSALIDADES.doc(), {
                    referencia: referenciaDeData(dataCharge),
                    valor,
                    vencimento: firebase.firestore.Timestamp.fromDate(dataCharge),
                    status: 'PENDENTE',
                    pago_em: null,
                    criado_em: firebase.firestore.FieldValue.serverTimestamp()
                });
            }
            await batch.commit();
            flash(qtd === 1 ? 'Mensalidade lançada.' : `${qtd} mensalidades lançadas.`);
            $('nova-vencimento').value = '';
            await carregarMensalidades();
        } catch (err) {
            alert('Erro ao lançar mensalidade: ' + err.message);
        }
    }

    async function marcarComoPaga(id) {
        if (!souFornecedor) return;
        try {
            await COL_MENSALIDADES.doc(id).update({
                status: 'PAGO',
                pago_em: firebase.firestore.FieldValue.serverTimestamp()
            });
            flash('Mensalidade marcada como paga.');
            await carregarMensalidades();
        } catch (err) {
            alert('Erro ao atualizar: ' + err.message);
        }
    }

    // ---------- PIX: monta o payload EMV e mostra QR + copia-e-cola ----------
    // Mesma lógica usada no Construline (ContractedPlan.tsx): payload
    // manual, sem nenhuma lib externa, só o CRC16-CCITT que o padrão exige.
    function onlyAsciiUpper(s, max) {
        // Remove marcas de acentuação (código 0x0300-0x036F após normalize
        // NFD) via checagem numérica de code point — evita embutir caractere
        // combinante literal no fonte, que já causou problema de encoding
        // com acento em outra parte do sistema.
        let semAcento = '';
        for (const ch of String(s || '').normalize('NFD')) {
            const code = ch.codePointAt(0);
            if (code >= 0x0300 && code <= 0x036f) continue;
            semAcento += ch;
        }
        const ascii = semAcento.replace(/[^\x20-\x7E]/g, '').toUpperCase();
        return max ? ascii.slice(0, max) : ascii;
    }

    function emvField(id, value) {
        const len = String(value.length).padStart(2, '0');
        return `${id}${len}${value}`;
    }

    function crc16Ccitt(payload) {
        let crc = 0xFFFF;
        for (let i = 0; i < payload.length; i++) {
            crc ^= payload.charCodeAt(i) << 8;
            for (let j = 0; j < 8; j++) {
                crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
                crc &= 0xFFFF;
            }
        }
        return crc.toString(16).toUpperCase().padStart(4, '0');
    }

    function buildPixPayload(chave, valor, nomeRecebedor) {
        const merchantAccount = emvField('00', 'BR.GOV.BCB.PIX') + emvField('01', String(chave).trim());
        const nome = onlyAsciiUpper(nomeRecebedor, 25) || 'GESTORCHEF';
        const cidade = 'BRASIL';
        const semCrc =
            emvField('00', '01') +
            emvField('26', merchantAccount) +
            emvField('52', '0000') +
            emvField('53', '986') +
            emvField('54', Number(valor).toFixed(2)) +
            emvField('58', 'BR') +
            emvField('59', nome) +
            emvField('60', cidade) +
            emvField('62', emvField('05', '***')) +
            '6304';
        return semCrc + crc16Ccitt(semCrc);
    }

    function cobrancaAtual() {
        const abertas = mensalidades.filter(m => statusExibicao(m) !== 'PAGO');
        if (!abertas.length) return null;
        // A mais antiga em aberto (atrasada tem prioridade sobre pendente futura)
        return abertas.sort((a, b) => {
            const da = a.vencimento && a.vencimento.toDate ? a.vencimento.toDate() : 0;
            const dbb = b.vencimento && b.vencimento.toDate ? b.vencimento.toDate() : 0;
            return da - dbb;
        })[0];
    }

    function renderPix() {
        const wrap = $('pix-box-wrap');
        const cobranca = cobrancaAtual();
        if (!cobranca || !cobrancaCfg.pix_chave) {
            wrap.style.display = 'none';
            return;
        }
        wrap.style.display = '';
        const st = statusExibicao(cobranca);
        const sufixo = st === 'ATRASADO' ? ' (atrasada)' : st === 'VENCE_HOJE' ? ' (vence hoje)' : '';
        $('cobranca-atual-desc').textContent =
            `Referência ${cobranca.referencia} — ${money(cobranca.valor)} — vencimento ${formatarData(cobranca.vencimento)}` + sufixo;

        const payload = buildPixPayload(cobrancaCfg.pix_chave, cobranca.valor, cobrancaCfg.pix_recebedor);
        $('pix-copia-cola').value = payload;
        $('pix-qr').src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(payload)}`;
    }

    function copiarPix() {
        const texto = $('pix-copia-cola').value;
        if (!texto) return;
        navigator.clipboard.writeText(texto).then(
            () => flash('Código PIX copiado!'),
            () => { $('pix-copia-cola').select(); document.execCommand('copy'); flash('Código PIX copiado!'); }
        );
    }
});
