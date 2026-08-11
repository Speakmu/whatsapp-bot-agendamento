// ============================================================
//  RESTORE CARDÁPIO — restaura a coleção 'cardapio' a partir de um
//  arquivo gerado pelo backup-cardapio.js. NÃO apaga itens
//  existentes; usa o mesmo id do backup (merge). Confira o arquivo
//  antes de rodar.
//  Uso:  node restore-cardapio.js backups/cardapio-2026-07-21T12-00-00-000Z.json
// ============================================================
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const CRED = path.join(__dirname, '..', 'backend-bot', 'salgadinhos-lileamar-firebase-adminsdk-fbsvc-76d7889ffc.json');
const serviceAccount = require(CRED);

const arquivo = process.argv[2];
if (!arquivo) { console.error('Uso: node restore-cardapio.js <caminho-do-backup.json>'); process.exit(1); }

admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId: serviceAccount.project_id });
const db = admin.firestore();

async function main() {
  const itens = JSON.parse(fs.readFileSync(path.resolve(arquivo), 'utf-8'));
  console.log(`Restaurando ${itens.length} itens de: ${arquivo}`);

  let batch = db.batch(), n = 0;
  for (const item of itens) {
    const { id, ...dados } = item;
    batch.set(db.collection('cardapio').doc(id), dados, { merge: true });
    if (++n % 400 === 0) { await batch.commit(); batch = db.batch(); }
  }
  if (n % 400 !== 0) await batch.commit();

  console.log(`✅ ${n} itens restaurados (merge, nada foi apagado).`);
}

main().then(() => process.exit(0)).catch(e => { console.error('ERRO na restauração:', e); process.exit(1); });
