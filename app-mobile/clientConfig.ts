// ============================================================
//  VALORES ESPECÍFICOS DO CLIENTE — junto com firebaseConfig.ts,
//  é o outro lugar a revisar ao clonar este projeto pra um cliente novo.
//  Tudo aqui era hardcoded espalhado pelo index.tsx (sobras do projeto-
//  modelo "pizzain") — centralizado aqui pra não vazar de novo.
// ============================================================
export const clientConfig = {
  // Mercado Pago exige um e-mail no pagamento, mas o app não coleta e-mail
  // do cliente hoje (só nome/telefone/CPF) — por isso um valor fixo.
  // Troque pelo e-mail real da loja se o Mercado Pago passar a exigir
  // validação, ou implemente coleta de e-mail no cadastro.
  emailPagamentoPadrao: "pagamentos@salgadinhos-lileamar.com.br",

  // Chave PÚBLICA de produção do Mercado Pago (prefixo APP_USR-), usada na
  // tokenização do cartão no app — não é secreta, mas ainda assim é
  // por-cliente (Painel MP → Suas integrações → Credenciais de produção).
  mercadoPagoPublicKey: "APP_USR-92f3bdaa-09b4-4e5c-a86f-3c9a2bdc66cf",
};
