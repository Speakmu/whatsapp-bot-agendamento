// ============================================================
//  CLOUD SEED — popula o Firebase REAL (salgadinhos-lileamar) com a demo.
//  ⚠️ Escreve no projeto de produção. Use o cloud-clean.js para remover.
//  Uso:  npm run cloud:seed
//  Requer o JSON da conta de serviço (firebase-adminsdk) — caminho abaixo.
// ============================================================
const path = require('path');
const admin = require('firebase-admin');

if (process.env.CONFIRM_CLOUD_SEED !== 'yes') {
  console.error(
    '\n🛑 ESTE SCRIPT APAGA E SUBSTITUI dados REAIS de produção (cardápio, clientes,\n' +
    '   configurações, cupons, pedidos...) por dados fictícios de demonstração.\n' +
    '   Só rode isso em um projeto que NÃO tem dados reais cadastrados.\n\n' +
    '   Se tem certeza, rode novamente com:\n' +
    '     CONFIRM_CLOUD_SEED=yes npm run cloud:seed\n'
  );
  process.exit(1);
}

const CRED = path.join(__dirname, '..', 'backend-bot', 'salgadinhos-lileamar-firebase-adminsdk-fbsvc-76d7889ffc.json');
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
