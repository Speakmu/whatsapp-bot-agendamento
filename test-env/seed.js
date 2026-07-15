// ============================================================
//  SEED (EMULADOR) — popula o emulador local com dados de demo.
//  Rode com os emuladores LIGADOS:  npm run seed
// ============================================================
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';

const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'pizzain-40973' });

require('./seed-core').popular(admin)
  .then(() => { console.log('Login do painel: demo@gestorchef.com / 123456'); process.exit(0); })
  .catch(e => { console.error('ERRO no seed:', e); process.exit(1); });
