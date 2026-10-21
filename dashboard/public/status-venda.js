// ============================================================
//  O que conta como VENDA, em um lugar só.
//
//  Cada tela (Início, Pedidos de hoje, BI, Financeiro) tinha a sua própria lista de status
//  que "não são venda", e todas estavam incompletas de formas diferentes: ficavam de fora
//  CANCELADO_PAGAMENTO (cartão não aprovado) e AGUARDANDO_CARTAO (cartão ainda pendente),
//  então pagamento recusado entrava no faturamento e derrubava o ticket médio.
//  Venda = pedido cujo pagamento foi aceito (qualquer outro status, em preparo, entrega,
//  concluído...). Não é venda: cancelado, pagamento recusado ou ainda aguardando pagamento.
//  Ao criar um status novo de pedido, decida aqui se ele fatura.
// ============================================================
(function () {
    var NAO_VENDA = new Set([
        'CANCELADO',
        'CANCELADO_PAGAMENTO',   // cartão não aprovado
        'AGUARDANDO_PAGAMENTO',
        'AGUARDANDO_PIX',
        'AGUARDANDO_CARTAO'      // cartão ainda na maquininha
    ]);
    var CANCELADOS = new Set(['CANCELADO', 'CANCELADO_PAGAMENTO']);

    window.StatusVenda = {
        NAO_VENDA: NAO_VENDA,
        eVenda: function (status) { return !NAO_VENDA.has(status); },
        naoEVenda: function (status) { return NAO_VENDA.has(status); },
        cancelado: function (status) { return CANCELADOS.has(status); }
    };
})();
