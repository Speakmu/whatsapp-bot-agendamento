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
    const BOT_BASE_URL = (window.__CLIENT_CONFIG__ || {}).botBaseUrl || "";

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

    const URL_SOM_ALERTA = 'https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3';
    let somAtivo = true;
    let pedidosCache = [];             // últimos docs recebidos (para re-render do timer)
    let idsConhecidosPedidos = new Set(); // ids já vistos (listener + poll de segurança)

    // Navegadores bloqueiam áudio em página que ainda não recebeu nenhum
    // clique/tecla (ex.: tela da cozinha deixada parada). O play() falha em
    // silêncio e o pedido novo chega sem som. Isto avisa na tela e some ao
    // primeiro clique.
    function avisoSomBloqueado(mostrar) {
        let el = document.getElementById('aviso-som-bloqueado');
        if (!mostrar) { if (el) el.remove(); return; }
        if (el) return;
        el = document.createElement('div');
        el.id = 'aviso-som-bloqueado';
        el.textContent = '🔇 Som de pedido novo bloqueado pelo navegador — clique em qualquer lugar da tela para ativar';
        el.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:99999;background:#c0392b;color:#fff;padding:10px 16px;border-radius:8px;font:600 14px sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.4);cursor:pointer;max-width:92vw;text-align:center;';
        document.body.appendChild(el);
    }
    ['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, () => avisoSomBloqueado(false), true));

    // Bipe gerado pelo próprio navegador, usado quando o arquivo de som não
    // carrega (rede caída etc.) — sem isso a tela ficava muda em silêncio.
    function bipeReserva() {
        try {
            const ctx = window.__ctxAlertaSom || (window.__ctxAlertaSom = new (window.AudioContext || window.webkitAudioContext)());
            if (ctx.state === 'suspended') ctx.resume();
            if (ctx.state !== 'running') { avisoSomBloqueado(true); return; }
            [0, 0.35].forEach(atraso => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'square'; osc.frequency.value = 880;
                gain.gain.value = 0.4;
                osc.connect(gain); gain.connect(ctx.destination);
                osc.start(ctx.currentTime + atraso); osc.stop(ctx.currentTime + atraso + 0.25);
            });
        } catch (e) { console.warn('Bipe de reserva falhou (KDS):', e.message); }
    }
    // Um Audio NOVO a cada toque: reaproveitar um único elemento fazia o som
    // "morrer" pra sempre depois de qualquer falha de rede/carregamento (o
    // elemento fica em estado de erro e todo play() seguinte falha em silêncio).
    function tocarAlertaSom() {
        try {
            const audio = new Audio(URL_SOM_ALERTA);
            audio.addEventListener('error', bipeReserva, { once: true });
            const p = audio.play();
            if (p && p.catch) p.catch(err => {
                if (err && err.name === 'NotAllowedError') avisoSomBloqueado(true);
                else { console.warn('Alerta sonoro falhou (KDS), usando bipe:', err && err.message); bipeReserva(); }
            });
        } catch (e) { bipeReserva(); }
    }

    // Pedido chegava com a tela minimizada/em segundo plano (ex.: usando o
    // app do iFood) e o navegador bloqueava o play() (NotAllowedError) por
    // ainda não ter recebido nenhum clique — o som ficava mudo até o próximo
    // pedido novo. Agora repete a tentativa sozinho a cada poucos segundos até
    // alguém interagir com a tela (o que libera o autoplay) — só então para.
    let alertaSomInterval = null;
    function pararAlertaSom() {
        if (alertaSomInterval) { clearInterval(alertaSomInterval); alertaSomInterval = null; }
    }
    // Dentro do painel (iframe), quem toca o alarme é a moldura
    // (pedido-alerta.js em admin.html) — aqui tocaria em dobro.
    const alarmeNaMoldura = window.self !== window.top;
    function iniciarAlertaSom() {
        if (alarmeNaMoldura || !somAtivo) return;
        tocarAlertaSom();
        pararAlertaSom();
        alertaSomInterval = setInterval(() => {
            if (document.visibilityState === 'visible' && document.hasFocus()) {
                pararAlertaSom();
                return;
            }
            tocarAlertaSom();
        }, 4000);
    }
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && document.hasFocus()) pararAlertaSom();
    });
    window.addEventListener('focus', pararAlertaSom);

    // O alarme repete até alguém ver a tela, MAS também para sozinho quando
    // o(s) pedido(s) que o dispararam deixam de estar "novos" (avançaram de
    // status) — senão continuava tocando por um pedido já resolvido.
    const pedidosAlarmando = new Map();
    function conferirAlarme(docs) {
        const atual = new Map(docs.map(d => [d.id, (d.data() || {}).status]));
        pedidosAlarmando.forEach((status, id) => { if (atual.get(id) !== status) pedidosAlarmando.delete(id); });
        if (!pedidosAlarmando.size) pararAlertaSom();
    }

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
        if (alarmeNaMoldura) {
            try { if (window.top.GestorChefAlerta) window.top.GestorChefAlerta.silenciar(!somAtivo); } catch (e) { /* moldura indisponível */ }
            return;
        }
        // tenta destravar o áudio na primeira interação
        if (somAtivo) { const a = new Audio(URL_SOM_ALERTA); a.play().then(() => a.pause()).catch(() => {}); }
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
        // Toca som só a partir do segundo snapshot em diante — o primeiro
        // sempre traz os pedidos já existentes (mesmo sem cache local), e
        // cada um chega como docChange "added" só por ser a primeira vez
        // que o listener os vê.
        let primeiroSnapshot = true;

        // Rede de segurança: se o listener em tempo real travar (aba
        // congelada pelo navegador, conexão caída...), uma consulta simples
        // a cada 30s acha pedido que a tela ainda não conhecia e toca o alerta.
        let pollIniciado = false;
        setInterval(async () => {
            try {
                const snap = await db.collection(COLECAO_PEDIDOS).where("status", "in", STATUS_MONITORADOS).get();
                const novos = snap.docs.filter(d => !idsConhecidosPedidos.has(d.id));
                snap.docs.forEach(d => idsConhecidosPedidos.add(d.id));
                if (pollIniciado && novos.length) {
                    console.log('Alerta pela verificação de segurança (KDS):', novos.length);
                    novos.forEach(d => pedidosAlarmando.set(d.id, (d.data() || {}).status));
                    iniciarAlertaSom();
                }
                conferirAlarme(snap.docs);
                pollIniciado = true;
            } catch (e) { console.warn('Verificação de pedidos novos (KDS):', e.message); }
        }, 30000);

        function ouvirPedidos() {
            db.collection(COLECAO_PEDIDOS)
                .where("status", "in", STATUS_MONITORADOS)
                .onSnapshot(snapshot => {
                    snapshot.forEach(doc => idsConhecidosPedidos.add(doc.id));

                    if (!primeiroSnapshot) {
                        const novosPedidos = snapshot.docChanges().filter(change => change.type === "added");
                        if (novosPedidos.length) {
                            novosPedidos.forEach(c => pedidosAlarmando.set(c.doc.id, (c.doc.data() || {}).status));
                            iniciarAlertaSom();
                        }
                    }
                    conferirAlarme(snapshot.docs);
                    primeiroSnapshot = false;

                    pedidosCache = [];
                    snapshot.forEach(doc => {
                        pedidosCache.push({ id: doc.id, ...doc.data() });
                    });
                    render();
                }, err => {
                    console.error("Erro no Firestore (KDS):", err);
                    // Antes o listener morria aqui e a tela ficava travada pra sempre.
                    primeiroSnapshot = true; // a nova escuta traz tudo como "added" de novo
                    setTimeout(ouvirPedidos, 5000);
                });
        }
        ouvirPedidos();
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
                // Sempre mostra a quantidade, mesmo com 1 unidade; aceita nome
                // com prefixo "Nx " embutido sem duplicar.
                const prefixo = /^(\d+)x\s+(.+)$/i.exec(String(nome));
                const qtd = (typeof item === 'object' && item.quantidade) || (prefixo ? parseInt(prefixo[1], 10) : 1);
                return { nome: `${qtd}x ${prefixo ? prefixo[2] : nome}`, obs };
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
            ${p.observacao ? `<div class="ticket-meta" style="font-weight:700;color:#e67e22;">📝 ${escapeHtml(p.observacao)}</div>` : ''}
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
            if (novoStatus === "CONCLUIDO" && window.GestorChefPedidoConcluido) {
                window.GestorChefPedidoConcluido(db, id).catch(() => {});
            }
            if (novoStatus === "CONCLUIDO" && window.GestorChefEstoque) {
                window.GestorChefEstoque.baixarDoPedido(db, id).then(avisarPratosDesativados).catch(() => {});
            }

            // Emissão fiscal: pedidos do bot/app/totem não têm confirmação de
            // gateway como o balcão — a conclusão aqui É a confirmação. Marca
            // pra fila do backend (fiscalRetryScheduler) processar, sem depender
            // desta aba continuar aberta. Dinheiro nunca emite sozinho.
            if (novoStatus === "CONCLUIDO") {
                const snap = await db.collection(COLECAO_PEDIDOS).doc(id).get();
                const pedido = snap.data() || {};
                const ehDinheiro = String(pedido.forma_pagamento || '').toLowerCase().includes('dinheiro');
                if (!ehDinheiro) {
                    db.collection(COLECAO_PEDIDOS).doc(id).update({ nfce_pendente: true }).catch(() => {});
                }
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
