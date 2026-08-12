// ============================================================
//  Atendimento do Bot — console de chat com controle manual
//  Lê/escreve a coleção "historico_conversas" (mesma que o bot
//  usa) direto pelo client SDK; só o envio real da mensagem pro
//  WhatsApp passa pelo backend (precisa do token de acesso).
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
    const firebaseConfig = window.__FIREBASE_CONFIG__;
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);

    const db = firebase.firestore();
    const auth = firebase.auth();
    const $ = (id) => document.getElementById(id);

    // Base do backend do bot (mesmo endereço usado em kds.js / entrega.js).
    const BOT_BASE_URL = "https://whatsapp-bot-agendamento.onrender.com";
    const COL = db.collection('historico_conversas');
    const COL_BAIRROS_APRENDIZADO = db.collection('bairros_aprendizado');
    const COL_ITENS_APRENDIZADO = db.collection('itens_aprendizado');
    const COL_CARDAPIO = db.collection('cardapio');

    let conversas = [];
    let conversaAtualId = null;
    let pollConversas = null;
    let pollMensagens = null;
    let cardapioCache = [];

    // Mesma normalização usada no backend (minúsculo, sem espaço sobrando,
    // sem acento) — pra bater com a mesma chave que o bot vai consultar.
    // Remove marca de acentuação via checagem numérica de code point (não
    // embute caractere combinante literal no fonte — isso já causou um
    // problema de encoding real em outra parte do sistema).
    function normalizarTermo(s) {
        let semAcento = '';
        for (const ch of String(s || '').normalize('NFD')) {
            const code = ch.codePointAt(0);
            if (code >= 0x0300 && code <= 0x036f) continue;
            semAcento += ch;
        }
        return semAcento.toLowerCase().trim().replace(/\s+/g, ' ');
    }

    auth.onAuthStateChanged(user => {
        if (!user) { window.location.href = '/login.html'; return; }
        carregarConversas();
        carregarCardapioCache();
        $('btn-refresh-conversas').addEventListener('click', carregarConversas);
        $('toggle-manual').addEventListener('change', onToggleManual);
        $('btn-send').addEventListener('click', enviarMensagem);
        $('reply-text').addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviarMensagem(); }
        });
        pollConversas = setInterval(carregarConversas, 20000);
    });

    function formatarHora(ts) {
        try {
            const d = ts && ts.toDate ? ts.toDate() : new Date(ts);
            if (isNaN(d.getTime())) return '';
            return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        } catch (e) { return ''; }
    }

    function escapeHtml(s) {
        return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    async function carregarConversas() {
        const lista = $('conv-list');
        try {
            const snap = await COL.orderBy('ultima_interacao', 'desc').limit(50).get();
            conversas = [];
            snap.forEach(doc => conversas.push({ id: doc.id, ...doc.data() }));
            // Conversas que precisam de atenção sempre no topo, senão a mais recente primeiro.
            conversas.sort((a, b) => (b.precisa_atencao ? 1 : 0) - (a.precisa_atencao ? 1 : 0));
            renderConversas();
        } catch (err) {
            lista.innerHTML = `<div class="empty">Erro ao carregar conversas: ${escapeHtml(err.message)}</div>`;
        }
    }

    function renderConversas() {
        const lista = $('conv-list');
        if (!conversas.length) {
            lista.innerHTML = '<div class="empty">Nenhuma conversa ainda.</div>';
            return;
        }
        lista.innerHTML = conversas.map(c => {
            const msgs = c.mensagens || [];
            const ultima = msgs[msgs.length - 1];
            const preview = ultima ? escapeHtml(ultima.content).slice(0, 80) : 'Sem mensagens';
            const ativo = c.id === conversaAtualId ? ' active' : '';
            const classeAtencao = c.precisa_atencao ? ' precisa-atencao' : '';
            const badgeManual = c.modo_manual ? '<span class="badge-manual">Manual</span>' : '';
            const badgeAtencao = c.precisa_atencao
                ? `<span class="badge-atencao" title="${escapeHtml(c.motivo_atencao || '')}">⚠️ Precisa de atenção</span>`
                : '';
            return `<div class="conv-item${ativo}${classeAtencao}" data-id="${escapeHtml(c.id)}">
                <div class="conv-id">${escapeHtml(c.id)}</div>
                ${badgeAtencao}
                <div class="conv-preview">${preview}</div>
                <div class="conv-meta">
                    <span class="conv-time">${formatarHora(c.ultima_interacao)}</span>
                    ${badgeManual}
                </div>
            </div>`;
        }).join('');
        lista.querySelectorAll('.conv-item').forEach(el => {
            el.addEventListener('click', () => abrirConversa(el.dataset.id));
        });
    }

    async function abrirConversa(id) {
        conversaAtualId = id;
        renderConversas();
        $('chat-id').textContent = id;
        $('chat-status').textContent = '';
        $('reply-text').disabled = false;
        $('btn-send').disabled = false;
        $('toggle-manual').disabled = false;
        if (pollMensagens) clearInterval(pollMensagens);
        await carregarMensagens();
        pollMensagens = setInterval(carregarMensagens, 10000);
    }

    async function carregarMensagens() {
        if (!conversaAtualId) return;
        try {
            const doc = await COL.doc(conversaAtualId).get();
            const dados = doc.exists ? doc.data() : {};
            $('toggle-manual').checked = dados.modo_manual === true;
            renderMensagens(dados.mensagens || []);
            renderAtencaoBox(dados);
        } catch (err) {
            $('chat-status').textContent = 'Erro ao carregar mensagens: ' + err.message;
        }
    }

    async function carregarCardapioCache() {
        try {
            const snap = await COL_CARDAPIO.orderBy('nome').get();
            cardapioCache = [];
            snap.forEach(doc => cardapioCache.push({ id: doc.id, ...doc.data() }));
        } catch (err) {
            console.warn('Erro ao carregar cardápio:', err.message);
        }
    }

    function renderAtencaoBox(dados) {
        const box = $('atencao-box');
        if (!dados.precisa_atencao || !dados.tipo_atencao) {
            box.style.display = 'none';
            box.innerHTML = '';
            return;
        }
        const info = dados.atencao_dados || {};
        box.style.display = '';

        if (dados.tipo_atencao === 'bairro') {
            box.innerHTML = `
                <div class="atencao-titulo">⚠️ Bairro que o bot não reconheceu: "${escapeHtml(info.bairro_cliente || '')}"</div>
                <div class="atencao-acoes">
                    <button class="btn btn-sim" id="btn-bairro-atende">Atendemos esse bairro</button>
                    <button class="btn btn-nao" id="btn-bairro-nao-atende">Não atendemos</button>
                </div>
            `;
            $('btn-bairro-atende').addEventListener('click', () => responderBairro(info.bairro_cliente, true));
            $('btn-bairro-nao-atende').addEventListener('click', () => responderBairro(info.bairro_cliente, false));
        } else if (dados.tipo_atencao === 'item') {
            const opcoes = cardapioCache.map(p =>
                `<option value="${p.id}">${escapeHtml(p.nome_exibicao || p.nome)}</option>`
            ).join('');
            box.innerHTML = `
                <div class="atencao-titulo">⚠️ Item que o bot não reconheceu: "${escapeHtml(info.nome_produto || '')}"</div>
                <div class="atencao-acoes">
                    <select id="select-item-vincular">
                        <option value="">Qual item do cardápio é esse?</option>
                        ${opcoes}
                    </select>
                    <button class="btn btn-vincular" id="btn-vincular-item">Vincular</button>
                </div>
            `;
            $('btn-vincular-item').addEventListener('click', () => {
                const itemId = $('select-item-vincular').value;
                if (!itemId) { alert('Escolha o item correspondente antes de vincular.'); return; }
                vincularItem(info.nome_produto, itemId);
            });
        } else {
            box.style.display = 'none';
            box.innerHTML = '';
        }
    }

    async function limparAtencao(id) {
        await COL.doc(id).set({ precisa_atencao: false }, { merge: true });
        const conversa = conversas.find(c => c.id === id);
        if (conversa) conversa.precisa_atencao = false;
        renderConversas();
    }

    async function enviarMensagemDireta(wa_id, mensagem) {
        try {
            await fetch(`${BOT_BASE_URL}/painel/enviar_mensagem`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // assumir_manual:false — só informa o cliente, o bot continua
                // cuidando do resto da conversa sozinho normalmente.
                body: JSON.stringify({ wa_id, mensagem, assumir_manual: false })
            });
        } catch (err) {
            console.warn('Erro ao enviar aviso pro cliente:', err.message);
        }
    }

    async function responderBairro(bairroCliente, atende) {
        if (!conversaAtualId) return;
        try {
            await COL_BAIRROS_APRENDIZADO.doc(normalizarTermo(bairroCliente)).set({
                bairro_original: bairroCliente,
                atende,
                respondido_por: (auth.currentUser && auth.currentUser.email) || null,
                respondido_em: firebase.firestore.FieldValue.serverTimestamp()
            });
            await enviarMensagemDireta(
                conversaAtualId,
                atende
                    ? `Confirmei aqui: entregamos sim em ${bairroCliente}! Pode seguir com o pedido.`
                    : `Confirmei aqui: infelizmente não entregamos em ${bairroCliente}. Mas você pode fazer a retirada no balcão, se preferir!`
            );
            await limparAtencao(conversaAtualId);
            flashLocal('Resposta salva e enviada ao cliente.');
            await carregarMensagens();
        } catch (err) {
            alert('Erro ao responder bairro: ' + err.message);
        }
    }

    async function vincularItem(nomeProduto, itemId) {
        if (!conversaAtualId) return;
        const item = cardapioCache.find(p => p.id === itemId);
        if (!item) return;
        try {
            await COL_ITENS_APRENDIZADO.doc(normalizarTermo(nomeProduto)).set({
                apelido_original: nomeProduto,
                item_id: itemId,
                item_nome: item.nome_exibicao || item.nome,
                respondido_por: (auth.currentUser && auth.currentUser.email) || null,
                respondido_em: firebase.firestore.FieldValue.serverTimestamp()
            });
            await enviarMensagemDireta(
                conversaAtualId,
                `Encontrei aqui! "${nomeProduto}" é o nosso "${item.nome_exibicao || item.nome}" (${(item.preco != null ? 'R$ ' + Number(item.preco).toFixed(2).replace('.', ',') : '')}). Quer que eu inclua no seu pedido?`
            );
            await limparAtencao(conversaAtualId);
            flashLocal('Item vinculado e cliente avisado.');
            await carregarMensagens();
        } catch (err) {
            alert('Erro ao vincular item: ' + err.message);
        }
    }

    function flashLocal(t) {
        const d = document.createElement('div');
        d.textContent = t;
        d.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#2c3e50;color:#fff;padding:10px 18px;border-radius:10px;z-index:9999;font-size:.85rem;';
        document.body.appendChild(d);
        setTimeout(() => d.remove(), 2400);
    }

    function renderMensagens(mensagens) {
        const box = $('messages');
        if (!mensagens.length) {
            box.innerHTML = '<div class="chat-empty">Sem mensagens nesta conversa.</div>';
            return;
        }
        const estavaNoFim = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
        box.innerHTML = mensagens.map(m => {
            const role = m.role === 'assistant' ? 'assistant' : 'user';
            return `<div class="msg ${role}">${escapeHtml(m.content)}<span class="msg-time">${formatarHora(m.timestamp)}</span></div>`;
        }).join('');
        if (estavaNoFim) box.scrollTop = box.scrollHeight;
    }

    async function onToggleManual() {
        if (!conversaAtualId) return;
        const ativo = $('toggle-manual').checked;
        try {
            await COL.doc(conversaAtualId).set({ modo_manual: ativo }, { merge: true });
            $('chat-status').textContent = ativo
                ? 'Controle manual ativado: o bot não vai responder até você desligar.'
                : 'Controle manual desativado: o bot volta a responder automaticamente.';
        } catch (err) {
            alert('Erro ao atualizar modo manual: ' + err.message);
            $('toggle-manual').checked = !ativo;
        }
    }

    async function enviarMensagem() {
        const textarea = $('reply-text');
        const mensagem = textarea.value.trim();
        if (!conversaAtualId || !mensagem) return;
        const btn = $('btn-send');
        btn.disabled = true;
        try {
            const resp = await fetch(`${BOT_BASE_URL}/painel/enviar_mensagem`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ wa_id: conversaAtualId, mensagem })
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            textarea.value = '';
            $('toggle-manual').checked = true;
            await carregarMensagens();
        } catch (err) {
            alert('Erro ao enviar mensagem: ' + err.message);
        } finally {
            btn.disabled = false;
        }
    }
});
