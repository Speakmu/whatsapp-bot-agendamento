// ============================================================
//  CONFIGURAÇÃO DO FIREBASE — ÚNICO LUGAR A TROCAR POR CLIENTE
//  Ao implantar um cliente novo, cole aqui o firebaseConfig do
//  projeto Firebase DELE (Console → Configurações → Seus apps → Web).
//  Todas as telas do painel leem window.__FIREBASE_CONFIG__.
//  Incluir DEPOIS dos SDKs do Firebase e ANTES de /emu.js.
// ============================================================
window.__FIREBASE_CONFIG__ = {
    apiKey: "AIzaSyCZjF31VggNiBpwwWZKcgZ3MWTWQ5Y5pE0",
    authDomain: "salgadinhos-lileamar.firebaseapp.com",
    projectId: "salgadinhos-lileamar",
    storageBucket: "salgadinhos-lileamar.firebasestorage.app",
    messagingSenderId: "353057562610",
    appId: "1:353057562610:web:daf64e902b3b979cb3d56b",
    measurementId: "G-XS5PX8C5NX"
};

// ============================================================
//  DADOS DO CLIENTE — o resto do que muda de um cliente pra outro.
//  Nenhuma tela do painel deve ter e-mail, URL ou nome de loja fixo:
//  tudo lê window.__CLIENT_CONFIG__.
//  O e-mail do admin também precisa ser trocado em firestore.rules
//  (função emailAdminCliente) e em app-mobile/functions/clientConfig.js —
//  regras e functions não enxergam este arquivo.
// ============================================================
window.__CLIENT_CONFIG__ = {
    // Admin principal da loja: acesso total ao painel e dono da tela de Usuários.
    adminEmail: "lileamarloja04@gmail.com",
    // Serviço do bot do WhatsApp (Cloud Run) deste cliente. Vazio = sem bot:
    // o painel só deixa de avisar o cliente pelo WhatsApp.
    botBaseUrl: "https://whatsapp-bot-agendamento-353057562610.us-central1.run.app",
    // Só exemplos/padrões das telas (o valor de verdade é salvo em configuracoes/bot).
    nomeEmpresa: "Lileamar Salgados",
    linkAppWeb: "https://lileamar-app-web.web.app",
    // Cloud Functions do mesmo projeto — sai do projectId, não precisa editar.
    functionsBaseUrl: "https://us-central1-" + window.__FIREBASE_CONFIG__.projectId + ".cloudfunctions.net"
};
