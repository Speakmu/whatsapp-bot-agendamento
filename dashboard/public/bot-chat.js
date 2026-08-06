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

    let conversas = [];
    let conversaAtualId = null;
    let pollConversas = null;
    let pollMensagens = null;

    auth.onAuthStateChanged(user => {
        if (!user) { window.location.href = '/login.html'; return; }
        carregarConversas();
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
            const badge = c.modo_manual ? '<span class="badge-manual">Manual</span>' : '';
            return `<div class="conv-item${ativo}" data-id="${escapeHtml(c.id)}">
                <div class="conv-id">${escapeHtml(c.id)}</div>
                <div class="conv-preview">${preview}</div>
                <div class="conv-meta">
                    <span class="conv-time">${formatarHora(c.ultima_interacao)}</span>
                    ${badge}
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
        } catch (err) {
            $('chat-status').textContent = 'Erro ao carregar mensagens: ' + err.message;
        }
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
