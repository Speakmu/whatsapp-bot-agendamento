// Alerta sonoro de "pedido novo" — igual ao de painel.html/app.js, mas pra
// telas que NÃO são a de Pedidos (Caixa, KDS, Entregas...). Sem isso, quem
// fica o dia todo numa dessas telas nunca ouvia o som de pedido novo,
// mesmo o painel de Pedidos estando 100% funcionando em outra aba.
//
// Inclua este script em qualquer página que precise do alerta, DEPOIS do
// firebase-app.js/firebase-firestore.js/firebase-config.js e ANTES do </body>.
// NÃO incluir em painel.html — lá o alerta já roda dentro de app.js, e os
// dois juntos tocariam o som em dobro.
document.addEventListener('DOMContentLoaded', async () => {
    if (!window.firebase || !window.__FIREBASE_CONFIG__) return;
    if (!firebase.apps.length) firebase.initializeApp(window.__FIREBASE_CONFIG__);
    const db = firebase.firestore();

    const COLECAO_PEDIDOS = "pedidos";
    const STATUS_ATIVOS_PEDIDOS = ["AGUARDANDO_PIX", "PENDENTE_PREPARO", "PENDENTE_VALIDACAO", "EM_PREPARO", "PRONTO_PARA_ENTREGA", "SAIU_PARA_ENTREGA"];

    // Configurável em Configurações > Alerta sonoro de pedido novo — som,
    // volume e intervalo de repetição, sem precisar mexer em código.
    let cfg = { ativo: true, som_id: '1004', volume: 1.0, intervalo_segundos: 4 };
    try {
        const snap = await db.collection('configuracoes').doc('alerta_som').get();
        if (snap.exists) {
            const d = snap.data() || {};
            cfg = {
                ativo: d.ativo !== false,
                som_id: d.som_id || '1004',
                volume: d.volume != null ? d.volume : 1.0,
                intervalo_segundos: d.intervalo_segundos || 4
            };
        }
    } catch (e) {
        console.warn('Config de alerta sonoro: usando padrão (erro ao ler):', e.message);
    }
    if (!cfg.ativo) return;

    const somNotificacao = new Audio(`https://assets.mixkit.co/active_storage/sfx/${cfg.som_id}/${cfg.som_id}-preview.mp3`);
    somNotificacao.volume = cfg.volume;


    // Navegadores bloqueiam áudio em página que ainda não recebeu nenhum clique/tecla
    // (ex.: aba aberta e deixada parada). O play() falhava em silêncio e o pedido
    // novo chegava sem som. Agora avisa na tela e some ao primeiro clique.
    function avisoSomBloqueado(mostrar) {
        let el = document.getElementById('aviso-som-bloqueado');
        if (!mostrar) { if (el) el.remove(); return; }
        if (el) return;
        el = document.createElement('div');
        el.id = 'aviso-som-bloqueado';
        el.textContent = '🔇 Som dos pedidos bloqueado pelo navegador — clique em qualquer lugar da tela para ativar';
        el.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:99999;background:#c0392b;color:#fff;padding:10px 16px;border-radius:8px;font:600 14px sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.4);cursor:pointer;max-width:92vw;text-align:center;';
        document.body.appendChild(el);
    }
    ['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, () => avisoSomBloqueado(false), true));
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) {
        document.addEventListener('DOMContentLoaded', () => avisoSomBloqueado(true));
    }

    let alertaSomInterval = null;
    function pararAlertaSom() {
        if (alertaSomInterval) {
            clearInterval(alertaSomInterval);
            alertaSomInterval = null;
        }
    }
    // Um Audio NOVO a cada toque: reutilizar um único elemento fazia o som
    // "morrer" pra sempre depois de qualquer falha de rede/carregamento (o
    // elemento fica em estado de erro e todo play() seguinte falha em silêncio).
    // Se o arquivo não carregar, cai num bipe gerado pelo próprio navegador.
    function urlSomAlerta() {
        return `https://assets.mixkit.co/active_storage/sfx/${cfg.som_id}/${cfg.som_id}-preview.mp3`;
    }
    function bipeReserva() {
        try {
            const ctx = window.__ctxAlertaSom || (window.__ctxAlertaSom = new (window.AudioContext || window.webkitAudioContext)());
            if (ctx.state === 'suspended') ctx.resume();
            if (ctx.state !== 'running') { avisoSomBloqueado(true); return; }
            [0, 0.35].forEach(atraso => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'square'; osc.frequency.value = 880;
                gain.gain.value = Math.min(1, Math.max(0.05, cfg.volume)) * 0.4;
                osc.connect(gain); gain.connect(ctx.destination);
                osc.start(ctx.currentTime + atraso); osc.stop(ctx.currentTime + atraso + 0.25);
            });
        } catch (e) { console.warn('Bipe de reserva falhou:', e.message); }
    }
    function tocarAlertaSom() {
        try {
            const audio = new Audio(urlSomAlerta());
            audio.volume = cfg.volume;
            audio.addEventListener('error', bipeReserva, { once: true });
            const p = audio.play();
            if (p && p.catch) p.catch(err => {
                if (err && err.name === 'NotAllowedError') avisoSomBloqueado(true);
                else { console.warn('Alerta sonoro falhou, usando bipe:', err && err.message); bipeReserva(); }
            });
        } catch (e) { bipeReserva(); }
    }
    // O alarme repete até alguém ver a aba, MAS também para sozinho quando o(s)
    // pedido(s) que o dispararam deixam de estar novos (cancelado, aceito,
    // concluído...) — senão continuava tocando por um pedido já resolvido.
    const pedidosAlarmando = new Map();
    function conferirAlarme(docs) {
        const atual = new Map(docs.map(d => [d.id, (d.data() || {}).status]));
        pedidosAlarmando.forEach((status, id) => { if (atual.get(id) !== status) pedidosAlarmando.delete(id); });
        if (!pedidosAlarmando.size) pararAlertaSom();
    }
    function iniciarAlertaSom() {
        tocarAlertaSom();
        pararAlertaSom();
        alertaSomInterval = setInterval(() => {
            if (document.visibilityState === 'visible' && document.hasFocus()) {
                pararAlertaSom();
                return;
            }
            tocarAlertaSom();
        }, cfg.intervalo_segundos * 1000);
    }
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && document.hasFocus()) pararAlertaSom();
    });
    window.addEventListener('focus', pararAlertaSom);

    // Mesma lógica do painel: só toca a partir do segundo snapshot em
    // diante, senão os pedidos já existentes na primeira leitura (aba
    // recém-aberta) disparariam o som como se fossem novos.
    let primeiroSnapshotPedidos = true;
    // Rede de segurança: se o listener em tempo real travar (aba congelada pelo
    // navegador, conexão caída...), uma consulta simples a cada 30s acha pedido
    // que a tela ainda não conhecia e toca o alerta.
    const idsConhecidos = new Set();
    let pollIniciado = false;
    setInterval(async () => {
        try {
            const snap = await db.collection(COLECAO_PEDIDOS).where("status", "in", STATUS_ATIVOS_PEDIDOS).get();
            const novos = snap.docs.filter(d => !idsConhecidos.has(d.id));
            snap.docs.forEach(d => idsConhecidos.add(d.id));
            if (pollIniciado && novos.length) {
                console.log('Alerta pela verificação de segurança:', novos.length);
                novos.forEach(d => pedidosAlarmando.set(d.id, (d.data() || {}).status));
                iniciarAlertaSom();
            }
            conferirAlarme(snap.docs);
            pollIniciado = true;
        } catch (e) { console.warn('Verificação de pedidos novos:', e.message); }
    }, 30000);

    function ouvirPedidos() {
        db.collection(COLECAO_PEDIDOS)
            .where("status", "in", STATUS_ATIVOS_PEDIDOS)
            .onSnapshot(snapshot => {
                snapshot.forEach(doc => idsConhecidos.add(doc.id));
                if (!primeiroSnapshotPedidos) {
                    const novosPedidos = snapshot.docChanges().filter(change => change.type === "added");
                    if (novosPedidos.length) {
                        novosPedidos.forEach(c => pedidosAlarmando.set(c.doc.id, (c.doc.data() || {}).status));
                        iniciarAlertaSom();
                    }
                }
                conferirAlarme(snapshot.docs);
                primeiroSnapshotPedidos = false;
            }, error => {
                console.warn("Alerta de pedido novo:", error.message);
                primeiroSnapshotPedidos = true; // o 1º snapshot da nova escuta traz tudo como "added"
                setTimeout(ouvirPedidos, 5000);
            });
    }
    ouvirPedidos();
});
