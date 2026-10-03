// ============================================================
//  VALORES ESPECÍFICOS DO CLIENTE NAS CLOUD FUNCTIONS — único lugar a
//  trocar aqui ao implantar um cliente novo. O id do projeto não entra:
//  as functions descobrem sozinhas em qual projeto estão rodando.
// ============================================================
export const clientConfig = {
    // Admin principal da loja — o mesmo e-mail de adminEmail em
    // dashboard/public/firebase-config.js e de emailAdminCliente() em
    // dashboard/firestore.rules. Sempre em minúsculas.
    adminEmail: "lileamarloja04@gmail.com",

    // A Stone exige um e-mail do comprador na cobrança da maquininha, e a
    // venda de balcão não tem cliente identificado — por isso um valor fixo.
    emailClienteBalcao: "balcao@salgadinhoslileamar.com.br",
};
