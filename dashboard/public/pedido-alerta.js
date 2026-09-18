// Alerta sonoro de "pedido novo" — igual ao de painel.html/app.js, mas pra
// telas que NÃO são a de Pedidos (Caixa, KDS, Entregas...). Sem isso, quem
// fica o dia todo numa dessas telas nunca ouvia o som de pedido novo,
// mesmo o painel de Pedidos estando 100% funcionando em outra aba.
//
// Inclua este script em qualquer página que precise do alerta, DEPOIS do
// firebase-app.js/firebase-firestore.js/firebase-config.js e ANTES do </body>.
// NÃO incluir em painel.html — lá o alerta já roda dentro de app.js, e os
// dois juntos tocariam o som em dobro.
document.addEventListener('DOMContentLoaded', () => {
    if (!window.firebase || !window.__FIREBASE_CONFIG__) return;
    if (!firebase.apps.length) firebase.initializeApp(window.__FIREBASE_CONFIG__);
    const db = firebase.firestore();

    const COLECAO_PEDIDOS = "pedidos";
    const STATUS_ATIVOS_PEDIDOS = ["AGUARDANDO_PIX", "PENDENTE_PREPARO", "PENDENTE_VALIDACAO", "EM_PREPARO", "PRONTO_PARA_ENTREGA", "SAIU_PARA_ENTREGA"];

    const somNotificacao = new Audio('https://assets.mixkit.co/active_storage/sfx/1004/1004-preview.mp3');
    somNotificacao.volume = 1.0;

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
        }, 4000);
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
