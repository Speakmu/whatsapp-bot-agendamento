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

  // Chave PÚBLICA do Mercado Pago usada na tokenização do cartão no app
  // (não é secreta, mas ainda assim é por-cliente). A que está aqui é uma
  // chave de TESTE (prefixo TEST-) — pagamentos de cartão não vão virar
  // cobrança real enquanto não trocar pela chave de produção do Mercado
  // Pago do cliente (Painel MP → Suas integrações → Credenciais de produção).
  mercadoPagoPublicKey: "TEST-568666ff-b126-42c0-9897-92c916f02d14",
};
