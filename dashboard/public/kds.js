// ============================================================
//  KDS — Tela de Preparo (Cozinha)
//  Lê a coleção "pedidos" em tempo real e organiza em colunas
//  por status. Reaproveita o mesmo fluxo de status do painel.
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
    const firebaseConfig = window.__FIREBASE_CONFIG__;

    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    const db = firebase.firestore();
    const auth = firebase.auth();

    const COLECAO_PEDIDOS = "pedidos";
    // Base do backend do bot (para avisar o cliente quando o pedido fica pronto).
    // Ajuste aqui se mudar a URL pública do backend.
    const BOT_BASE_URL = "https://whatsapp-bot-agendamento.onrender.com";

    // Limiares de urgência (minutos) para colorir os tickets
    const MIN_ATENCAO = 10;
    const MIN_ATRASO = 20;

    // Mapeamento de status -> coluna
    const COLUNAS = {
        fila:    ["PENDENTE_PREPARO", "PENDENTE_VALIDACAO"],
        preparo: ["EM_PREPARO"],
        pronto:  ["PRONTO_PARA_ENTREGA"]
    };
    const STATUS_MONITORADOS = [
        ...COLUNAS.fila, ...COLUNAS.preparo, ...COLUNAS.pronto
    ];

    // Próximo passo a partir de cada status (ação na cozinha)
    const PROXIMO = {
        "PENDENTE_PREPARO":   { status: "EM_PREPARO",         label: "▶ Iniciar preparo", cls: "btn-iniciar" },
        "PENDENTE_VALIDACAO": { status: "EM_PREPARO",         label: "▶ Iniciar preparo", cls: "btn-iniciar" },
        "EM_PREPARO":         { status: "PRONTO_PARA_ENTREGA", label: "✓ Marcar pronto",   cls: "btn-pronto" },
        "PRONTO_PARA_ENTREGA":{ status: "CONCLUIDO",          label: "🛵 Despachar",       cls: "btn-despachar" }
    };

    const somNotificacao = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
    let somAtivo = true;
    let pedidosCache = [];        // últimos docs recebidos (para re-render do timer)
    let idsConhecidos = new Set(); // controle de "novo pedido" para tocar som

    // ---- Relógio do cabeçalho ----
    const relogio = document.getElementById('relogio');
    setInterval(() => {
        relogio.textContent = new Date().toLocaleTimeString('pt-BR');
    }, 1000);

    // ---- Botão de som ----
    const btnSom = document.getElementById('btn-som');
    btnSom.addEventListener('click', () => {
        somAtivo = !somAtivo;
        btnSom.textContent = somAtivo ? "🔔 Som: ON" : "🔕 Som: OFF";
        // tenta destravar o áudio na primeira interação
        if (somAtivo) somNotificacao.play().then(() => somNotificacao.pause()).catch(() => {});
    });

    // ---- Autenticação ----
    auth.onAuthStateChanged((user) => {
        if (user) {
            iniciarListener();
        } else {
            window.location.href = '/login.html';
        }
    });

    function iniciarListener() {
        db.collection(COLECAO_PEDIDOS)
            .where("status", "in", STATUS_MONITORADOS)
            .onSnapshot(snapshot => {
                // Detecta novos pedidos para tocar som
                snapshot.docChanges().forEach(change => {
                    if (change.type === "added" && !idsConhecidos.has(change.doc.id)) {
                        if (somAtivo && !snapshot.metadata.fromCache) {
                            somNotificacao.currentTime = 0;
                            somNotificacao.play().catch(() => {});
                        }
                    }
                });

                pedidosCache = [];
                idsConhecidos = new Set();
                snapshot.forEach(doc => {
                    idsConhecidos.add(doc.id);
                    pedidosCache.push({ id: doc.id, ...doc.data() });
                });
                render();
            }, err => console.error("Erro no Firestore (KDS):", err));
    }

    // ---- Cálculo de tempo decorrido ----
    function minutosDecorridos(pedido) {
        const ts = pedido.hora_pedido;
        if (!ts || !ts.toDate) return null;
        const ms = Date.now() - ts.toDate().getTime();
        return Math.max(0, Math.floor(ms / 60000));
    }
    function formatTimer(min) {
        if (min === null) return "--";
        const h = Math.floor(min / 60);
        const m = min % 60;
        return h > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${m} min`;
    }
    function urgencia(min) {
        if (min === null) return "";
        if (min >= MIN_ATRASO) return "t-late";
        if (min >= MIN_ATENCAO) return "t-warn";
        return "";
    }

    // ---- Extrai lista de itens (formato blindado, igual ao painel) ----
    function itensDoPedido(pedido) {
        const lista = pedido.itens || pedido.itens_pedido;
        if (Array.isArray(lista)) {
            return lista.map(item => {
                const nome = (typeof item === 'object')
                    ? (item.nome_exibicao || item.nome || 'Item')
                    : item;
                const obs = (typeof item === 'object') ? (item.observacao || item.obs) : null;
                const qtd = (typeof item === 'object' && item.quantidade) ? item.quantidade : null;
                return { nome: qtd ? `${qtd}x ${nome}` : nome, obs };
            });
        }
        const texto = pedido.item_pedido || pedido.itens_pedido || 'Sem detalhes';
        return [{ nome: texto, obs: null }];
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"]/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    // ---- Renderização ----
    function colunaDeStatus(status) {
        if (COLUNAS.fila.includes(status)) return 'fila';
        if (COLUNAS.preparo.includes(status)) return 'preparo';
        if (COLUNAS.pronto.includes(status)) return 'pronto';
        return null;
    }

    function render() {
        const buckets = { fila: [], preparo: [], pronto: [] };
        pedidosCache.forEach(p => {
            const col = colunaDeStatus(p.status);
            if (col) buckets[col].push(p);
        });

        // ordena: mais antigos primeiro (quem espera há mais tempo no topo)
        const porTempo = (a, b) => {
            const ta = a.hora_pedido && a.hora_pedido.toDate ? a.hora_pedido.toDate().getTime() : 0;
            const tb = b.hora_pedido && b.hora_pedido.toDate ? b.hora_pedido.toDate().getTime() : 0;
            return ta - tb;
        };

        Object.keys(buckets).forEach(col => {
            buckets[col].sort(porTempo);
            const body = document.getElementById('col-' + col);
            document.getElementById('count-' + col).textContent = buckets[col].length;
            if (buckets[col].length === 0) {
                body.innerHTML = '<div class="vazio">Nenhum pedido</div>';
                return;
            }
            body.innerHTML = buckets[col].map(ticketHTML).join('');
        });

        // listeners dos botões
        document.querySelectorAll('.ticket-btn').forEach(btn => {
            btn.addEventListener('click', onAvancar);
        });
    }

    function ticketHTML(p) {
        const min = minutosDecorridos(p);
        const urg = urgencia(min);
        const itens = itensDoPedido(p).map(i =>
            `<li>${escapeHtml(i.nome)}${i.obs ? `<span class="obs">↳ ${escapeHtml(i.obs)}</span>` : ''}</li>`
        ).join('');
        const prox = PROXIMO[p.status];
        const botao = prox
            ? `<button class="ticket-btn ${prox.cls}" data-id="${p.id}" data-status="${prox.status}">${prox.label}</button>`
            : '';
        const entrega = (p.endereco && p.endereco !== "Retirada no Balcão")
            ? `🛵 ${escapeHtml(p.endereco)}` : '🏠 Retirada';

        return `
        <div class="ticket ${urg}">
            <div class="ticket-top">
                <span class="ticket-id">#${p.id.substring(0, 5)}</span>
                <span class="ticket-timer ${urg}">⏱ ${formatTimer(min)}</span>
            </div>
            <div class="ticket-cliente">${escapeHtml(p.nome_cliente || p.nome || 'Cliente')}</div>
            <ul class="ticket-itens">${itens}</ul>
            <div class="ticket-meta">${entrega}</div>
            ${botao}
        </div>`;
    }

    async function onAvancar(e) {
        const btn = e.currentTarget;
        const id = btn.dataset.id;
        const novoStatus = btn.dataset.status;
        if (!id) return;

        btn.disabled = true;
        try {
            await db.collection(COLECAO_PEDIDOS).doc(id).update({ status: novoStatus });

            // Baixa de estoque ao concluir (despachar) direto pela cozinha
            if (novoStatus === "CONCLUIDO" && window.GestorChefEstoque) {
                window.GestorChefEstoque.baixarDoPedido(db, id).then(avisarPratosDesativados).catch(() => {});
            }

            // Avisa o cliente via backend do bot quando fica pronto
            if (novoStatus === "PRONTO_PARA_ENTREGA") {
                const doc = await db.collection(COLECAO_PEDIDOS).doc(id).get();
                const pedido = doc.data() || {};
                notificarBot(pedido);
            }
        } catch (err) {
            alert("Erro ao atualizar o pedido: " + err.message);
            btn.disabled = false;
        }
    }

    function notificarBot(pedido) {
        if (!BOT_BASE_URL) return;
        fetch(`${BOT_BASE_URL}/notificar_pronto`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                wa_id: pedido.telefone_cliente || pedido.wa_id || pedido.telefone,
                nome: pedido.nome_cliente || pedido.nome,
                tipo_servico: pedido.endereco === "Retirada no Balcão" ? "RETIRADA" : "ENTREGA"
            })
        }).catch(err => console.warn("Não foi possível avisar o bot:", err));
    }

    // Avisa o operador quando a baixa de estoque desativou algum prato
    // automaticamente (insumo esgotou) — pra não passar batido.
    function avisarPratosDesativados(resultado) {
        const pratos = resultado && resultado.pratos_desativados;
        if (!pratos || !pratos.length) return;
        const d = document.createElement('div');
        d.textContent = `⚠️ Estoque esgotado: ${pratos.join(', ')} ${pratos.length > 1 ? 'foram desativados' : 'foi desativado'} do cardápio.`;
        d.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#2c3e50;color:#fff;padding:12px 20px;border-radius:10px;z-index:9999;box-shadow:0 4px 14px rgba(0,0,0,.3);font-size:.95rem;';
        document.body.appendChild(d);
        setTimeout(() => d.remove(), 4000);
    }

    // Re-render periódico para atualizar timers/urgência sem nova consulta
    setInterval(() => { if (pedidosCache.length) render(); }, 30000);
});
