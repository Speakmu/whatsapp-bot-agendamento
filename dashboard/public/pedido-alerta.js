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

    let alertaSomInterval = null;
    function pararAlertaSom() {
        if (alertaSomInterval) {
            clearInterval(alertaSomInterval);
            alertaSomInterval = null;
        }
    }
    function tocarAlertaSom() {
        somNotificacao.currentTime = 0;
        somNotificacao.play().catch(() => console.log("Aguardando interação do usuário para tocar som."));
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
    db.collection(COLECAO_PEDIDOS)
        .where("status", "in", STATUS_ATIVOS_PEDIDOS)
        .onSnapshot(snapshot => {
            if (!primeiroSnapshotPedidos) {
                const temPedidoNovo = snapshot.docChanges().some(change => change.type === "added");
                if (temPedidoNovo) iniciarAlertaSom();
            }
            primeiroSnapshotPedidos = false;
        }, error => console.warn("Alerta de pedido novo:", error.message));
});
