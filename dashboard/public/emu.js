// ============================================================
//  emu.js — conecta o front aos Emuladores do Firebase
//  APENAS quando rodando em localhost (produção fica intacta).
//  Faz isso "embrulhando" o firebase.initializeApp, então
//  funciona em qualquer página sem mudar o código dela.
//  Inclua DEPOIS dos SDKs do Firebase e ANTES do script da página.
// ============================================================
(function () {
  var host = location.hostname;
  var ehLocal = host === 'localhost' || host === '127.0.0.1';
  if (!ehLocal || !window.firebase || !firebase.initializeApp) return;

  var orig = firebase.initializeApp;
  firebase.initializeApp = function () {
    var app = orig.apply(firebase, arguments);
    try { if (firebase.firestore) firebase.firestore().useEmulator(host, 8080); } catch (e) { }
    try { if (firebase.auth) firebase.auth().useEmulator('http://' + host + ':9099', { disableWarnings: true }); } catch (e) { }
    console.log('%c[EMULADOR] Conectado ao Firebase local (Firestore:8080 / Auth:9099)', 'color:#ff5200;font-weight:bold');
    return app;
  };
})();
