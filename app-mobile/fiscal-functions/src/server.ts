// ============================================================
//  Servidor do microserviço fiscal (independente do Construline).
//  Endpoints:
//    GET  /fiscal/health          -> verificação de conexão / certificado
//    POST /fiscal/certificado     -> upload do .pfx (guarda base64 no Firestore)
//    POST /fiscal/nfce/avulsa     -> emite NFC-e
//    POST /fiscal/nfce/cancelar   -> cancela (evento 110111)
//    POST /fiscal/nfce/inutilizar -> inutiliza faixa de numeração
//    POST /fiscal/nfce/transmitir -> transmite NFC-e de contingência
//  Autenticação: header Authorization: Bearer <API_KEY>
//  Certificado: enviado por /fiscal/certificado (Firestore) OU arquivo CERT_PATH.
//  Senha: SEMPRE via variável de ambiente CERT_PASSWORD.
// ============================================================
import 'reflect-metadata';
import express from 'express';
import Busboy from 'busboy';
import * as fs from 'fs';
import {
  emitirNfceAvulsa, AvulsaRequest,
  gerarPreviaDanfe,
  cancelarNfce, CancelRequest,
  inutilizarNumeracao, InutRequest,
  transmitirNfceContingencia, TransmitirRequest,
  sincronizarDfe, DfeSyncRequest,
  processarXmlAvulso,
  validarCertificado, CertInput,
  obterValidadeCertificado,
} from './nfce';
import { carregarCertificado, salvarCertificado, existeCertificado } from './cert-store';
import { prewarmAliquotas } from './ibpt-store';

const PORT = parseInt(process.env.PORT || '4000', 10);
const API_KEY = process.env.API_KEY || '';
const CERT_PATH = process.env.CERT_PATH || '';
const CERT_PASSWORD = process.env.CERT_PASSWORD || '';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const app = express();
app.use(express.json({ limit: '2mb' }));

// Lê um upload multipart/form-data direto do req.rawBody (em vez de usar multer
// piping sobre `req`). No Cloud Functions/Firebase Functions, o corpo da
// requisição já foi consumido pelo Functions Framework pra popular `req.rawBody`
// antes de chegar no Express — o multer tenta reler o stream original e encontra
// vazio ("Unexpected end of form"). Rodando o busboy direto sobre o rawBody
// (buffer preservado especificamente pra esse cenário) contorna o problema.
function parseCertificadoUpload(req: express.Request, res: express.Response, next: express.NextFunction) {
  const bb = Busboy({ headers: req.headers, limits: { fileSize: 1024 * 1024 } });
  const fields: Record<string, string> = {};
  let file: { buffer: Buffer; originalname: string } | undefined;

  bb.on('field', (name, value) => { fields[name] = value; });
  bb.on('file', (name, stream, info) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      if (name === 'certificado') file = { buffer: Buffer.concat(chunks), originalname: info.filename };
    });
  });
  bb.on('error', (err) => res.status(400).json({ error: 'Falha ao ler o upload: ' + (err as Error).message }));
  bb.on('finish', () => {
    req.body = fields;
    (req as any).file = file;
    next();
  });

  // No Cloud Functions, o Functions Framework já consumiu o stream original
  // pra montar req.rawBody antes do Express — alimenta o busboy com esse buffer.
  // Localmente (ts-node/app.listen), o stream ainda não foi lido: pode ligar
  // direto nele.
  const rawBody: Buffer | undefined = (req as any).rawBody;
  if (rawBody) bb.end(rawBody);
  else req.pipe(bb);
}

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Auth (exceto health)
function auth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!API_KEY) return next(); // sem API_KEY configurada = aberto (apenas dev)
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (token !== API_KEY) return res.status(401).json({ error: 'Não autorizado' });
  next();
}

// Obtém o certificado: prioriza o enviado pelo painel (Firestore, com senha cifrada);
// cai para arquivo CERT_PATH + senha do ambiente (CERT_PASSWORD).
async function obterCert(): Promise<CertInput | null> {
  try {
    const c = await carregarCertificado();
    if (c && c.buffer) return { buffer: c.buffer, password: c.senha || CERT_PASSWORD };
  } catch (e) { /* Firestore indisponível → tenta arquivo local */ }
  if (CERT_PATH && fs.existsSync(CERT_PATH)) return { pfxPath: CERT_PATH, password: CERT_PASSWORD };
  return null;
}

// Garante certificado + senha antes de operar
async function exigirCert(res: express.Response): Promise<CertInput | null> {
  const cert = await obterCert();
  if (!cert) {
    res.status(500).json({ error: 'Certificado A1 não configurado. Envie pelo painel (Configurações → Fiscal).' });
    return null;
  }
  if (!cert.password) {
    res.status(500).json({ error: 'Senha do certificado ausente. Reenvie o certificado informando a senha no painel.' });
    return null;
  }
  return cert;
}

app.get('/fiscal/health', async (_req, res) => {
  let temCert = CERT_PATH ? fs.existsSync(CERT_PATH) : false;
  try { if (!temCert) temCert = await existeCertificado(); } catch { /* ignora */ }

  // Validade do certificado — não impede a resposta se falhar (senha errada,
  // certificado ausente, etc.); só reporta o que conseguir.
  let certificadoValidade: { notBefore: string; notAfter: string; diasRestantes: number; vencido: boolean } | null = null;
  try {
    const cert = await obterCert();
    if (cert) {
      const { notBefore, notAfter } = obterValidadeCertificado(cert);
      const diasRestantes = Math.floor((notAfter.getTime() - Date.now()) / 86_400_000);
      certificadoValidade = {
        notBefore: notBefore.toISOString(),
        notAfter: notAfter.toISOString(),
        diasRestantes,
        vencido: diasRestantes < 0,
      };
    }
  } catch { /* ignora — health não deve quebrar por causa disso */ }

  res.json({
    ok: true,
    service: 'pizzaria-fiscal-service',
    certificado: temCert,
    certificado_validade: certificadoValidade,
    time: new Date().toISOString(),
  });
});

// Upload do certificado A1 (.pfx/.p12) — valida e guarda base64 no Firestore.
app.post('/fiscal/certificado', auth, parseCertificadoUpload, async (req, res) => {
  try {
    const file = (req as any).file;
    if (!file || !file.buffer) return res.status(400).json({ error: 'Arquivo .pfx não enviado (campo "certificado").' });
    const nome = file.originalname || 'certificado.pfx';
    if (!/\.(pfx|p12)$/i.test(nome)) return res.status(400).json({ error: 'O arquivo deve ter extensão .pfx ou .p12.' });
    // Senha vem do painel (campo "password"); se não vier, usa CERT_PASSWORD do ambiente.
    const senha = (req.body && req.body.password) ? String(req.body.password) : CERT_PASSWORD;
    if (!senha) return res.status(400).json({ error: 'Informe a senha do certificado.' });
    try {
      validarCertificado(file.buffer, senha);
    } catch (e) {
      return res.status(400).json({ error: 'Certificado inválido ou senha incorreta.' });
    }
    await salvarCertificado('base64:' + file.buffer.toString('base64'), nome, senha);
    res.json({ ok: true, message: 'Certificado enviado e validado.', nome_arquivo: nome, tamanho: file.buffer.length });
  } catch (err: any) {
    console.error('[certificado upload] erro:', err?.message || err);
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post('/fiscal/nfce/avulsa', auth, async (req, res) => {
  try {
    const payload = req.body as AvulsaRequest;
    if (!payload?.emitter?.cnpj) return res.status(400).json({ error: 'Emitente (CNPJ) ausente.' });
    if (!payload.items?.length) return res.status(400).json({ error: 'Nenhum item informado.' });
    const cert = await exigirCert(res); if (!cert) return;
    const result = await emitirNfceAvulsa(payload, cert);
    const httpStatus = (result.status === 'AUTORIZADA' || result.status === 'CONTINGENCIA') ? 200 : 422;
    res.status(httpStatus).json(result);
  } catch (err: any) {
    console.error('[NFC-e avulsa] erro:', err?.message || err);
    res.status(500).json({ status: 'ERRO', error: err?.message || String(err) });
  }
});

// Prévia do layout do DANFE NFC-e (sem assinar/transmitir, não exige certificado).
app.post('/fiscal/nfce/preview', auth, async (req, res) => {
  try {
    const payload = req.body as AvulsaRequest;
    if (!payload?.emitter?.cnpj) return res.status(400).json({ error: 'Emitente (CNPJ) ausente.' });
    if (!payload.items?.length) return res.status(400).json({ error: 'Nenhum item informado.' });
    const pdf = await gerarPreviaDanfe(payload);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="previa-cupom-nfce.pdf"');
    res.send(pdf);
  } catch (err: any) {
    console.error('[NFC-e preview] erro:', err?.message || err);
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// Pré-aquece o cache de alíquotas do IBPT para uma lista de NCMs (ex: cardápio
// inteiro). Dispara em segundo plano e responde na hora — cada consulta nova
// pode levar ~15-20s, então não faz sentido o painel ficar esperando tudo.
app.post('/fiscal/ibpt/prewarm', auth, async (req, res) => {
  try {
    const { uf, cnpj, token, itens } = req.body as { uf: string; cnpj: string; token: string; itens: { ncm: string; ex?: string }[] };
    if (!uf || !cnpj || !token) return res.status(400).json({ error: 'Informe uf, cnpj e token do IBPT.' });
    if (!Array.isArray(itens) || !itens.length) return res.status(400).json({ error: 'Nenhum NCM informado.' });
    const lista = itens.map((it) => ({ ncm: it.ncm, ex: it.ex, uf, cnpj, token }));
    prewarmAliquotas(lista).catch((err) => console.error('[IBPT] pré-aquecimento falhou:', err?.message || err));
    res.json({ ok: true, iniciados: itens.length });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post('/fiscal/nfce/cancelar', auth, async (req, res) => {
  try {
    const payload = req.body as CancelRequest;
    if (!payload?.chave) return res.status(400).json({ error: 'Chave da NFC-e ausente.' });
    if (!payload?.protocolo) return res.status(400).json({ error: 'Protocolo de autorização ausente.' });
    const cert = await exigirCert(res); if (!cert) return;
    const result = await cancelarNfce(payload, cert);
    res.status(result.status === 'CANCELADA' ? 200 : 422).json(result);
  } catch (err: any) {
    console.error('[NFC-e cancelar] erro:', err?.message || err);
    res.status(500).json({ status: 'ERRO', error: err?.message || String(err) });
  }
});

app.post('/fiscal/nfce/inutilizar', auth, async (req, res) => {
  try {
    const payload = req.body as InutRequest;
    if (payload?.nNFIni == null || payload?.nNFFin == null) {
      return res.status(400).json({ error: 'Informe nNFIni e nNFFin.' });
    }
    const cert = await exigirCert(res); if (!cert) return;
    const result = await inutilizarNumeracao(payload, cert);
    res.status(result.status === 'INUTILIZADA' ? 200 : 422).json(result);
  } catch (err: any) {
    console.error('[NFC-e inutilizar] erro:', err?.message || err);
    res.status(500).json({ status: 'ERRO', error: err?.message || String(err) });
  }
});

app.post('/fiscal/nfce/transmitir', auth, async (req, res) => {
  try {
    const payload = req.body as TransmitirRequest;
    if (!payload?.xmlAssinado) return res.status(400).json({ error: 'xmlAssinado ausente.' });
    const cert = await exigirCert(res); if (!cert) return;
    const result = await transmitirNfceContingencia(payload, cert);
    res.status(result.status === 'AUTORIZADA' ? 200 : 422).json(result);
  } catch (err: any) {
    console.error('[NFC-e transmitir] erro:', err?.message || err);
    res.status(500).json({ status: 'ERRO', error: err?.message || String(err) });
  }
});

app.post('/fiscal/dfe/sync', auth, async (req, res) => {
  try {
    const payload = req.body as DfeSyncRequest;
    if (!payload?.cnpj) return res.status(400).json({ error: 'CNPJ ausente.' });
    if (!payload?.uf) return res.status(400).json({ error: 'UF ausente.' });
    const cert = await exigirCert(res); if (!cert) return;
    const result = await sincronizarDfe(payload, cert);
    res.status(result.status === 'REJEITADA' ? 422 : 200).json(result);
  } catch (err: any) {
    console.error('[DFe sync] erro:', err?.message || err);
    res.status(500).json({ status: 'ERRO', error: err?.message || String(err) });
  }
});

// Importa uma NF-e avulsa (upload/colar XML), fora da distribuição da SEFAZ —
// não precisa de certificado, é só leitura/parse do XML enviado.
app.post('/fiscal/dfe/importar', auth, async (req, res) => {
  try {
    const xml = req.body?.xml;
    if (!xml || typeof xml !== 'string') return res.status(400).json({ error: 'Envie o XML no campo "xml".' });
    const documento = processarXmlAvulso(xml);
    res.json({ documento });
  } catch (err: any) {
    console.error('[DFe importar] erro:', err?.message || err);
    res.status(400).json({ error: err?.message || String(err) });
  }
});

// Só sobe um servidor HTTP "solto" quando rodado diretamente (dev local via
// ts-node/node dist/server.js). No Firebase Functions, quem expõe o app é o
// wrapper em functions-entry.ts (onRequest), que só faz `require`/`import`
// deste módulo — não queremos um app.listen() duplicado nesse caso.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Serviço fiscal ouvindo na porta ${PORT}`);
    if (!API_KEY) console.warn('AVISO: API_KEY não definida — endpoints sem autenticação (use só em dev).');
    if (!process.env.CERT_ENC_KEY && !API_KEY) console.warn('AVISO: defina CERT_ENC_KEY para cifrar a senha do certificado no Firestore.');
  });
}

export { app };
