// ============================================================
//  Pagamentos de um pedido (conta dividida) — LEITURA UNICA no painel.
//
//  Pedido novo:  pagamentos: [{ forma, valor, recebido? }], conta_dividida, conta_aberta
//  Pedido antigo (sem `pagamentos`): um pagamento so, com forma_pagamento e valor_total.
//  Toda tela que precisa saber "como foi pago" / "quanto falta" usa isto, em vez de ler
//  forma_pagamento direto (que numa conta dividida nao descreve nada).
//  Espelho de app-mobile/fiscal-functions/src/pagamentos-nota.ts (testados com os mesmos casos).
// ============================================================
(function () {
    function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
    function ehDinheiro(forma) { return /dinheiro/i.test(forma); }

    function doPedido(p) {
        var lista = Array.isArray(p && p.pagamentos) ? p.pagamentos : [];
        var validos = lista.map(function (x) {
            return {
                forma: String(x && x.forma != null ? x.forma : ''),
                valor: round2(Number(x && x.valor) || 0),
                recebido: x && x.recebido != null && isFinite(Number(x.recebido)) ? round2(Number(x.recebido)) : null
            };
        }).filter(function (x) { return x.valor > 0; });
        // Conta dividida ainda sem pagamento nao pode "ganhar" um pagamento inventado do forma_pagamento.
        if (validos.length || (p && p.conta_dividida)) return validos;
        var valor = round2(Number(p && p.valor_total) || 0);
        var forma = String(p && p.forma_pagamento != null ? p.forma_pagamento : '');
        return (forma || valor) ? [{ forma: forma, valor: valor, recebido: null }] : [];
    }

    function somenteDinheiro(p) {
        var l = doPedido(p);
        return l.length > 0 && l.every(function (x) { return ehDinheiro(x.forma); });
    }

    function saldo(p) {
        var pago = doPedido(p).reduce(function (s, x) { return s + x.valor; }, 0);
        return round2(Math.max(0, (Number(p && p.valor_total) || 0) - pago));
    }

    function quitada(p) {
        var total = round2(Number(p && p.valor_total) || 0);
        return total > 0 && saldo(p) === 0 && doPedido(p).length > 0;
    }

    // Texto para listas/relatorios: "Cartão" ou "Dinheiro + Cartão" (conta dividida).
    function resumo(p) {
        var formas = [];
        doPedido(p).forEach(function (x) { if (x.forma && formas.indexOf(x.forma) < 0) formas.push(x.forma); });
        return formas.join(' + ');
    }

    window.PagamentosPedido = { doPedido: doPedido, somenteDinheiro: somenteDinheiro, saldo: saldo, quitada: quitada, resumo: resumo };
})();
