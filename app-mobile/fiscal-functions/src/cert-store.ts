// ============================================================
//  Armazenamento do certificado A1 + senha no Firestore.
//  - O .pfx é guardado como base64 (como no Construline).
//  - A SENHA do .pfx é guardada CIFRADA (AES-256-GCM) com uma chave
//    que existe só no serviço (CERT_ENC_KEY, ou API_KEY como fallback).
//    Assim, ler o Firestore sozinho NÃO revela a senha.
//  Doc: fiscal_secrets/certificado { pfx_base64, nome_arquivo, senha_cifrada, atualizado_em }
//
//  Admin SDK: FIREBASE_ADMIN_CREDENTIALS ou GOOGLE_APPLICATION_CREDENTIALS
//  (caminho do JSON da conta de serviço) — ou credenciais padrão do ambiente.
// ============================================================
import * as admin from 'firebase-admin';
import * as crypto from 'crypto';

const ENC_KEY = process.env.CERT_ENC_KEY || process.env.API_KEY || '';

function deriveKey(): Buffer {
  return crypto.createHash('sha256').update(ENC_KEY).digest(); // 32 bytes
}
function encrypt(texto: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(), iv);
  const enc = Buffer.concat([cipher.update(texto, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'enc:' + Buffer.concat([iv, tag, enc]).toString('base64');
}
function decrypt(payload: string): string {
  const raw = Buffer.from(String(payload).replace(/^enc:/, ''), 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

let iniciado = false;
function db(): admin.firestore.Firestore {
  if (!iniciado) {
    if (!admin.apps.length) {
      const credPath = process.env.FIREBASE_ADMIN_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS;
      if (credPath) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const cred = require(credPath);
        admin.initializeApp({ credential: admin.credential.cert(cred) });
      } else {
        admin.initializeApp();
      }
    }
    iniciado = true;
  }
  return admin.firestore();
}
function doc() {
  return db().collection('fiscal_secrets').doc('certificado');
}

// Salva o certificado (base64) + a senha (cifrada).
export async function salvarCertificado(base64: string, nomeArquivo: string, senha: string): Promise<void> {
  await doc().set({
    pfx_base64: base64,
    nome_arquivo: nomeArquivo,
    senha_cifrada: senha ? encrypt(senha) : null,
    atualizado_em: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

// Retorna o certificado (buffer) + a senha (decifrada), ou null se não houver.
export async function carregarCertificado(): Promise<{ buffer: Buffer; senha: string } | null> {
  const snap = await doc().get();
  if (!snap.exists) return null;
  const d = snap.data() as any;
  if (!d || !d.pfx_base64) return null;
  const buffer = Buffer.from(String(d.pfx_base64).replace(/^base64:/, ''), 'base64');
  let senha = '';
  if (d.senha_cifrada) { try { senha = decrypt(d.senha_cifrada); } catch { senha = ''; } }
  return { buffer, senha };
}

export async function existeCertificado(): Promise<boolean> {
  try {
    const snap = await doc().get();
    return !!(snap.exists && (snap.data() as any)?.pfx_base64);
  } catch { return false; }
}
