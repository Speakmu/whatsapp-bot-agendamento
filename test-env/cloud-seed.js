// ============================================================
//  CLOUD SEED — popula o Firebase REAL (pizzain-40973) com a demo.
//  ⚠️ Escreve no projeto de produção. Use o cloud-clean.js para remover.
//  Uso:  npm run cloud:seed
//  Requer o JSON da conta de serviço (firebase-adminsdk) — caminho abaixo.
// ============================================================
const path = require('path');
const admin = require('firebase-admin');

const CRED = path.join(__dirname, '..', 'backend-bot', 'pizzain-40973-firebase-adminsdk-fbsvc-001fd1cfb7.json');
let serviceAccount;
try { serviceAccount = require(CRED); }
catch (e) { console.error('Não encontrei a credencial em:\n  ' + CRED + '\nAjuste o caminho no topo do arquivo.'); process.exit(1); }

admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId: serviceAccount.project_id });

console.log('☁️  Semeando o projeto REAL: ' + serviceAccount.project_id);
require('./seed-core').popular(admin)
  .then(() => {
    console.log('\n✅ Demo publicada na nuvem.');
    console.log('   Painel: https://' + serviceAccount.project_id + '.web.app');
    console.log('   Login:  demo@gestorchef.com / 123456');
    process.exit(0);
  })
  .catch(e => { console.error('ERRO no cloud-seed:', e); process.exit(1); });
