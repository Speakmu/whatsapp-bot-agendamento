// ============================================================
//  BACKUP CARDÁPIO — exporta a coleção 'cardapio' (nomes, preços,
//  descrições, categorias, fotos) do Firebase REAL para um arquivo
//  JSON local, com timestamp. Rode antes de qualquer alteração
//  arriscada, ou periodicamente, para nunca perder o trabalho de
//  cadastro de novo.
//  Uso:  npm run backup:cardapio
// ============================================================
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const CRED = path.join(__dirname, '..', 'backend-bot', 'salgadinhos-lileamar-firebase-adminsdk-fbsvc-76d7889ffc.json');
const serviceAccount = require(CRED);

admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId: serviceAccount.project_id });
const db = admin.firestore();

const BACKUP_DIR = path.join(__dirname, 'backups');

async function main() {
  const snap = await db.collection('cardapio').get();
  const itens = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const carimbo = new Date().toISOString().replace(/[:.]/g, '-');
  const arquivo = path.join(BACKUP_DIR, `cardapio-${carimbo}.json`);
  fs.writeFileSync(arquivo, JSON.stringify(itens, null, 2), 'utf-8');

  console.log(`✅ Backup de ${itens.length} itens salvo em:\n   ${arquivo}`);
}

main().then(() => process.exit(0)).catch(e => { console.error('ERRO no backup:', e); process.exit(1); });
