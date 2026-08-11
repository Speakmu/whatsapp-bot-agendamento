// ============================================================
//  CLOUD CLEAN — remove os dados de DEMO do Firebase real.
//  Uso:  npm run cloud:clean
//  Remove as coleções de demonstração (NÃO mexe em Auth/usuário demo).
// ============================================================
const path = require('path');
const admin = require('firebase-admin');

const CRED = path.join(__dirname, '..', 'backend-bot', 'salgadinhos-lileamar-firebase-adminsdk-fbsvc-76d7889ffc.json');
let serviceAccount;
try { serviceAccount = require(CRED); }
catch (e) { console.error('Credencial não encontrada: ' + CRED); process.exit(1); }

admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId: serviceAccount.project_id });

console.log('🧹 Removendo dados de demo de: ' + serviceAccount.project_id);
require('./seed-core').limpar(admin)
  .then(async () => {
    try { await admin.auth().deleteUser('demo'); console.log('  • usuário demo removido'); } catch (e) { }
    console.log('✅ Demo removida.');
    process.exit(0);
  })
  .catch(e => { console.error('ERRO no cloud-clean:', e); process.exit(1); });
