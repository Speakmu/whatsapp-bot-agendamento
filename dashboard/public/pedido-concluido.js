// Ações de "pedido concluído" que valem em QUALQUER tela que conclui pedido
// (Pedidos, Cozinha/KDS, Entregas). Chame depois de gravar status CONCLUIDO:
//   window.GestorChefPedidoConcluido(db, pedidoId)
//
// 1. Pontos de fidelidade: SÓ pelo app (decisão do negócio — bot do WhatsApp
//    não pontua). É AQUI, na conclusão manual, que fica o crédito (e o débito
//    de um eventual resgate) do pedido do APP pago na entrega/dinheiro — PIX
//    e cartão do app já creditam pelo webhook/no ato da aprovação, não passam
//    por aqui (senão duplicava). Debitar/creditar só na conclusão (em vez de
//    na criação do pedido) evita ficar com saldo errado se o pedido for
//    cancelado depois. pontos_creditados evita fazer isso duas vezes.
// 2. Bairro novo: o bot deixa em configuracoes/bot.bairros_pendentes_bot o bairro
//    que o cliente confirmou ser da cidade. Só quando um pedido pra ele é
//    concluído (entregue de verdade) ele entra na lista oficial de entrega.
(function () {
    function normalizar(t) {
        return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/\s+/).filter(Boolean).join(' ');
    }

    async function creditarPontos(db, ref, p) {
        const origem = String(p.origem || '').toUpperCase();
        const pagoNaEntrega = /entrega|dinheiro/i.test(String(p.forma_pagamento || ''));
        const elegivel = origem === 'APP' && pagoNaEntrega;
        if (!elegivel || p.pontos_creditados || !p.usuario_id) return;

        const ganho = Number(p.pontos_a_creditar) || 0;
        const resgatado = Number(p.pontos_resgatados) || 0;
        if (ganho <= 0 && resgatado <= 0) return;

        const saldo = ganho - resgatado;
        const batch = db.batch();
        if (saldo !== 0) {
            batch.update(db.collection('usuarios_app').doc(p.usuario_id), { pontos: firebase.firestore.FieldValue.increment(saldo) });
        }
        batch.update(ref, { pontos_creditados: true, pontos_gerados: ganho });
        await batch.commit();
    }

    async function promoverBairroNovo(db, ref, p) {
        if (!p.bairro_novo_pelo_bot || !p.bairro || p.bairro_promovido) return;
        const docBot = db.collection('configuracoes').doc('bot');
        const snap = await docBot.get();
        const d = snap.exists ? (snap.data() || {}) : {};
        const alvo = normalizar(p.bairro);
        const lista = Array.isArray(d.bairros_entrega) ? d.bairros_entrega.slice() : [];
        if (!lista.some(b => normalizar(b) === alvo)) lista.push(String(p.bairro).trim());
        const pendentes = (Array.isArray(d.bairros_pendentes_bot) ? d.bairros_pendentes_bot : [])
            .filter(x => normalizar(x && x.bairro) !== alvo);
        await docBot.set({ bairros_entrega: lista, bairros_pendentes_bot: pendentes }, { merge: true });
        await db.collection('bairros_aprendizado').doc(alvo).set({
            bairro_original: String(p.bairro).trim(), atende: true, origem: 'pedido_entregue',
            respondido_por: 'pedido entregue #' + ref.id.substring(0, 5),
            respondido_em: firebase.firestore.FieldValue.serverTimestamp()
        });
        await ref.update({ bairro_promovido: true });
    }

    window.GestorChefPedidoConcluido = async function (db, pedidoId) {
        const ref = db.collection('pedidos').doc(pedidoId);
        const snap = await ref.get();
        const p = snap.data() || {};
        await creditarPontos(db, ref, p).catch(err => console.warn('Pontos do pedido:', err.message));
        await promoverBairroNovo(db, ref, p).catch(err => console.warn('Bairro novo:', err.message));
    };
})();
