// ============================================================
//  RESTORE PLACEHOLDERS — recria itens do cardápio como "Item N"
//  linkados às fotos que sobreviveram no Storage (cardapio/),
//  após a perda acidental dos dados reais. Uso único.
//  Uso:  node restore-placeholders.js
// ============================================================
const path = require('path');
const crypto = require('crypto');
const admin = require('firebase-admin');

const CRED = path.join(__dirname, '..', 'backend-bot', 'salgadinhos-lileamar-firebase-adminsdk-fbsvc-76d7889ffc.json');
const serviceAccount = require(CRED);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: serviceAccount.project_id,
  storageBucket: 'salgadinhos-lileamar.firebasestorage.app',
});

const db = admin.firestore();
const bucket = admin.storage().bucket();

async function main() {
  const [files] = await bucket.getFiles({ prefix: 'cardapio/' });
  files.sort((a, b) => a.name.localeCompare(b.name));

  console.log(`Encontradas ${files.length} imagens em cardapio/.`);

  let n = 0;
  for (const file of files) {
    n++;
    const [meta] = await file.getMetadata();
    let token = meta.metadata && meta.metadata.firebaseStorageDownloadTokens;
    if (!token) {
      token = crypto.randomUUID();
      await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });
    }
    const imagemUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(file.name)}?alt=media&token=${token}`;

    const nomeExibicao = `Item ${n}`;
    await db.collection('cardapio').doc().set({
      nome: nomeExibicao.toLowerCase(),
      nome_exibicao: nomeExibicao,
      categoria: 'A categorizar',
      preco: 0,
      ingredientes: 'Descrição a definir',
      disponivel: false,
      pontos_fidelidade: 0,
      imagem_url: imagemUrl,
      imagem_origem: file.name,
      ultima_atualizacao: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`  • ${nomeExibicao}  <-  ${file.name}`);
  }

  console.log(`\n✅ ${n} itens placeholder criados no cardápio (marcados como indisponíveis até serem editados).`);
}

main().then(() => process.exit(0)).catch(e => { console.error('ERRO:', e); process.exit(1); });
