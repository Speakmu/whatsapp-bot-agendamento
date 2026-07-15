// ============================================================
//  BAIXA AUTOMÁTICA DE ESTOQUE (Fase 2A)
//  Ao concluir um pedido, consome os insumos das fichas técnicas
//  dos produtos vendidos. Idempotente: só baixa uma vez por pedido
//  (marca pedido.estoque_baixado). Seguro para chamar em vários
//  pontos de conclusão (entrega, kds, caixa, mesas, painel).
//
//  Uso:
//    window.GestorChefEstoque.baixarDoPedido(db, pedidoId)
//        .then(r => console.log(r))   // {ok, motivo?, itens?}
//
//  Requer Firebase (compat) já inicializado na página.
// ============================================================
(function () {
    const COL_PEDIDOS = "pedidos";
    const COL_INSUMOS = "estoque_insumos";
    const COL_MOVS = "estoque_movimentos";
    const COL_FICHAS = "fichas_tecnicas";

    const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

    // Resolve a ficha de um item do pedido (por id do cardápio ou por nome)
    function resolverFicha(item, fichasPorId, fichasPorNome) {
        if (item && typeof item === 'object') {
            const id = item.id || item.cardapio_id || item.produto_id;
            if (id && fichasPorId[id]) return fichasPorId[id];
            const nome = norm(item.nome_exibicao || item.nome);
            if (nome && fichasPorNome[nome]) return fichasPorNome[nome];
        } else if (typeof item === 'string') {
            const nome = norm(item);
            if (fichasPorNome[nome]) return fichasPorNome[nome];
        }
        return null;
    }

    // Cada linha do carrinho = 1 unidade. Se houver item.quantidade, usa.
    function qtdDoItem(item) {
        if (item && typeof item === 'object' && item.quantidade != null) {
            const q = Number(item.quantidade);
            return isNaN(q) || q <= 0 ? 1 : q;
        }
        return 1;
    }

    async function baixarDoPedido(db, pedidoId) {
        if (!db || !pedidoId) return { ok: false, motivo: "parametros" };
        const FieldValue = firebase.firestore.FieldValue;
        const pedidoRef = db.collection(COL_PEDIDOS).doc(pedidoId);

        // 1) Leitura rápida: pedido já baixado?
        let pedidoSnap;
        try { pedidoSnap = await pedidoRef.get(); } catch (e) { return { ok: false, motivo: e.message }; }
        if (!pedidoSnap.exists) return { ok: false, motivo: "pedido inexistente" };
        const pedido = pedidoSnap.data();
        if (pedido.estoque_baixado) return { ok: false, motivo: "ja baixado" };

        const itens = pedido.itens;
        if (!Array.isArray(itens) || !itens.length) {
            // Sem itens estruturados (formato antigo) — apenas marca para não reprocessar
            try { await pedidoRef.update({ estoque_baixado: true, estoque_baixa_motivo: "sem itens estruturados" }); } catch (e) {}
            return { ok: false, motivo: "sem itens" };
        }

        // 2) Carrega fichas
        const fichasPorId = {}, fichasPorNome = {};
        const fSnap = await db.collection(COL_FICHAS).get();
        fSnap.forEach(d => {
            const f = d.data();
            fichasPorId[d.id] = f;
            if (f.produto_nome) fichasPorNome[norm(f.produto_nome)] = f;
        });

        // 3) Acumula consumo por insumo
        const consumo = {}; // insumoId -> quantidade total
        let itensComFicha = 0;
        itens.forEach(item => {
            const ficha = resolverFicha(item, fichasPorId, fichasPorNome);
            if (!ficha || !Array.isArray(ficha.itens)) return;
            itensComFicha++;
            const mult = qtdDoItem(item);
            ficha.itens.forEach(ins => {
                if (!ins.insumo_id) return;
                consumo[ins.insumo_id] = (consumo[ins.insumo_id] || 0) + (Number(ins.quantidade) || 0) * mult;
            });
        });

        const insumoIds = Object.keys(consumo);
        if (!insumoIds.length) {
            try { await pedidoRef.update({ estoque_baixado: true, estoque_baixa_motivo: "produtos sem ficha" }); } catch (e) {}
            return { ok: false, motivo: "sem ficha nos produtos" };
        }

        // 4) Transação: relê pedido (guarda), decrementa insumos, registra movimentos
        try {
            const resultado = await db.runTransaction(async (txn) => {
                const pSnap = await txn.get(pedidoRef);
                if (pSnap.data().estoque_baixado) return { ok: false, motivo: "corrida: ja baixado" };

                const refs = insumoIds.map(id => db.collection(COL_INSUMOS).doc(id));
                const snaps = await Promise.all(refs.map(r => txn.get(r)));

                const movs = [];
                snaps.forEach((snap, i) => {
                    const id = insumoIds[i];
                    const qUsada = consumo[id];
                    const atual = snap.exists ? (Number(snap.data().quantidade_atual) || 0) : 0;
                    const nome = snap.exists ? (snap.data().nome || id) : id;
                    const saldo = atual - qUsada;
                    if (snap.exists) txn.update(refs[i], { quantidade_atual: saldo, atualizado_em: FieldValue.serverTimestamp() });
                    movs.push({ id, nome, qUsada, saldo });
                });

                movs.forEach(m => {
                    const movRef = db.collection(COL_MOVS).doc();
                    txn.set(movRef, {
                        insumo_id: m.id, insumo_nome: m.nome, tipo: "SAIDA",
                        quantidade: m.qUsada, saldo_resultante: m.saldo,
                        motivo: "Venda pedido #" + pedidoId.substring(0, 6),
                        pedido_id: pedidoId, operador: "sistema (baixa automática)",
                        data: FieldValue.serverTimestamp()
                    });
                });

                txn.update(pedidoRef, {
                    estoque_baixado: true,
                    estoque_baixado_em: FieldValue.serverTimestamp(),
                    estoque_baixa_itens: movs.length
                });
                return { ok: true, itens: movs.length };
            });
            return resultado;
        } catch (e) {
            return { ok: false, motivo: e.message };
        }
    }

    window.GestorChefEstoque = { baixarDoPedido };
})();
