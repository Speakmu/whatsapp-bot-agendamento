import axios from "axios";
import { randomBytes } from "crypto";
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { clientConfig } from "./clientConfig.js";

initializeApp();
const db = getFirestore();

// Token do Mercado Pago lido de secret (NUNCA hardcoded).
// Configure com: firebase functions:secrets:set MERCADOPAGO_ACCESS_TOKEN
const MERCADOPAGO_ACCESS_TOKEN = defineSecret("MERCADOPAGO_ACCESS_TOKEN");

// A API da Point só libera para aplicação do Mercado Pago criada com o produto
// Point — a do app/PIX (Checkout Transparente) recebe 403. Token próprio das
// maquininhas: firebase functions:secrets:set MERCADOPAGO_POINT_ACCESS_TOKEN
// Sem ele, as functions da Point caem no token geral (comportamento antigo).
const MERCADOPAGO_POINT_ACCESS_TOKEN = defineSecret("MERCADOPAGO_POINT_ACCESS_TOKEN");
function tokenPoint() {
    return String(MERCADOPAGO_POINT_ACCESS_TOKEN.value() || MERCADOPAGO_ACCESS_TOKEN.value() || '').trim();
}

const GESTORCHEF_ADMIN_EMAIL = clientConfig.adminEmail;

async function exigirUsuario(req) {
    const header = String(req.headers.authorization || '');
    if (!header.startsWith('Bearer ')) {
        throw Object.assign(new Error('Autenticacao obrigatoria.'), { status: 401 });
    }
    return getAuth().verifyIdToken(header.slice(7));
}

async function exigirAdmin(req) {
    const token = await exigirUsuario(req);
    if (String(token.email || '').toLowerCase() !== GESTORCHEF_ADMIN_EMAIL) {
        throw Object.assign(new Error('Apenas o administrador pode alterar a integracao Stone.'), { status: 403 });
    }
    return token;
}

// Igual a exigirAdmin, mas sem e-mail fixo: consulta usuarios_admin (mesma
// coleção que a aba Configurações usa pra listar quem é admin), pra não
// depender de um e-mail hardcoded por cliente.
async function exigirAdminGenerico(req) {
    const token = await exigirUsuario(req);
    const email = String(token.email || '').trim().toLowerCase();
    // Suporte (contato.seusuportetec@gmail.com) tem acesso total em todo
    // cliente, mesmo sem doc em usuarios_admin ainda existir (chicken-and-egg
    // no primeiro acesso a um cliente novo) — ver garantirSuporte() em
    // configuracoes.js pro mesmo e-mail sendo tratado como sempre-admin lá.
    if (email === 'contato.seusuportetec@gmail.com') return token;
    const snap = await db.collection('usuarios_admin').doc(email).get();
    if (!snap.exists || (snap.data()?.admin !== true && snap.data()?.suporte !== true)) {
        throw Object.assign(new Error('Apenas administradores podem alterar a integracao iFood.'), { status: 403 });
    }
    return token;
}

// URL da função de webhook abaixo (região padrão us-central1, mesmo projeto).
// O id do projeto vem do próprio ambiente da function — nada a trocar por cliente.
const PROJECT_ID = process.env.GCLOUD_PROJECT || JSON.parse(process.env.FIREBASE_CONFIG || "{}").projectId;
const WEBHOOK_URL = `https://us-central1-${PROJECT_ID}.cloudfunctions.net/mercadoPagoWebhook`;

export const processarPagamentoDireto = onRequest(
    { secrets: [MERCADOPAGO_ACCESS_TOKEN] },
    async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');

    if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', 'POST');
        res.set('Access-Control-Allow-Headers', 'Content-Type, X-Idempotency-Key');
        return res.status(204).send('');
    }

    try {
        // .trim() defensivo: secret configurada via --data-file costuma vir com
        // uma quebra de linha no final, e um header "Authorization" com \n
        // quebra o fetch do Node com "Invalid character in header content".
        const accessToken = String(MERCADOPAGO_ACCESS_TOKEN.value() || '').trim();
        if (!accessToken) {
            console.error("MERCADOPAGO_ACCESS_TOKEN não configurado.");
            return res.status(500).json({ message: "Configuração de pagamento ausente no servidor." });
        }

        const { token, item, email, payment_method_id, nome, cpf } = req.body;
        const idempotencyKey = req.headers['x-idempotency-key'] || randomBytes(16).toString('hex');

        // --- MONTAGEM DO OBJETO DE PAGAMENTO ---
        const paymentData = {
            transaction_amount: parseFloat(item.total),
            description: item.title,
            payer: {
                email: email || clientConfig.emailClienteBalcao, // totem não coleta e-mail
                first_name: nome || "Cliente",
                identification: {
                    type: "CPF",
                    number: cpf ? cpf.replace(/\D/g, '') : "00000000000"
                }
            }
        };

        // LÓGICA HÍBRIDA:
        if (token) {
            // Se enviou TOKEN, é Cartão de Crédito
            paymentData.token = token;
            paymentData.installments = 1;
            paymentData.payment_method_id = payment_method_id; // Ex: 'visa', 'master'
        } else {
            // Se não enviou TOKEN, assume que é PIX
            paymentData.payment_method_id = "pix";
            paymentData.notification_url = WEBHOOK_URL;
        }

        const response = await axios.post(
            "https://api.mercadopago.com/v1/payments",
            paymentData,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'X-Idempotency-Key': idempotencyKey
                }
            }
        );

        return res.status(200).json(response.data);

    } catch (error) {
        console.error("ERRO DETALHADO:", error.response?.data || error.message);
        return res.status(error.status || error.response?.status || 500).json(error.response?.data || { message: error.message });
    }
});

// Terminal Point de cada ponto de venda. pointDeviceId (campo antigo) continua
// valendo como o do caixa para quem já tinha configurado só um terminal.
function deviceIdPoint(cfg, terminal) {
    const id = terminal === 'totem' ? cfg.pointDeviceIdTotem : (cfg.pointDeviceIdCaixa || cfg.pointDeviceId);
    return String(id || '').trim();
}

// Tipo de cartão enviado ao terminal. A API da Point EXIGE payment.type (sem ele:
// "payment: type is required"), então não dá para deixar a máquina perguntar.
// Config 'escolher' = quem cobra escolhe antes (operador no caixa, cliente no totem)
// e manda em "escolhido". Parcelas ficam em 1x (a API não deixa escolher parcelamento).
function pagamentoPoint(cfg, escolhido) {
    let tipo = cfg.pointTipoCartao || 'credito'; // sem config = comportamento antigo (crédito 1x)
    if (tipo === 'escolher') tipo = escolhido === 'debito' ? 'debito' : 'credito';
    if (tipo === 'debito') return { type: 'debit_card' };
    return { type: 'credit_card', installments: 1, installments_cost: 'seller' };
}

function tipoDefaultOrder(cfg, body) {
    if (body.metodo === 'qr') return 'qr';
    const mapa = { credito: 'credit_card', debito: 'debit_card' };
    const fixo = cfg.pointTipoCartao;
    if (fixo === 'credito' || fixo === 'debito') return mapa[fixo];
    if (fixo === 'escolher') return mapa[body.tipoCartao] || null;
    return null;
}

// Cria uma cobrança na maquininha Point (Cartão no balcão/caixa físico).
// Chamada pelo dashboard (caixa.js) quando o operador finaliza uma venda no Cartão.
// O resultado chega depois via webhook (topic=point_integration_ipn, ver abaixo).
export const criarCobrancaPoint = onRequest(
    { secrets: [MERCADOPAGO_ACCESS_TOKEN, MERCADOPAGO_POINT_ACCESS_TOKEN] },
    async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');

    if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', 'POST');
        res.set('Access-Control-Allow-Headers', 'Content-Type');
        return res.status(204).send('');
    }

    try {
        const accessToken = tokenPoint();
        if (!accessToken) {
            console.error("MERCADOPAGO_ACCESS_TOKEN não configurado.");
            return res.status(500).json({ message: "Configuração de pagamento ausente no servidor." });
        }

        const { amount, externalReference, description } = req.body;
        if (!amount || !externalReference) {
            return res.status(400).json({ message: "Informe amount e externalReference." });
        }

        // device_id fica na config (não é segredo, mas evita expor detalhe de infra no client).
        const configSnap = await db.collection('configuracoes').doc('pagamentos').get();
        const cfgPoint = configSnap.exists ? (configSnap.data() || {}) : {};
        if (cfgPoint.maquininhaAtiva === false) {
            return res.status(409).json({ message: "Integração com a maquininha está desativada nas configurações." });
        }
        const terminal = req.body.terminal === 'totem' ? 'totem' : 'caixa';
        const deviceId = deviceIdPoint(cfgPoint, terminal);
        if (!deviceId) {
            return res.status(500).json({ message: `Terminal Point do ${terminal} não configurado (device_id ausente).` });
        }

        // Orders API (pointApi='orders'): a order é enviada ao terminal sozinha, sem toque na
        // máquina. A API antiga (payment-intents) exige o operador tocar para buscar a cobrança.
        if (cfgPoint.pointApi === 'orders') {
            // NÃO enviar config.payment_method.default_type: com ele a order ficava em "created" e a
            // máquina só a pegava com toque; sem ele vira at_terminal em segundos (testado). A máquina
            // pergunta débito/crédito ao cliente.
            const order = await axios.post(
                'https://api.mercadopago.com/v1/orders',
                {
                    type: 'point',
                    external_reference: String(externalReference).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64),
                    description: description || `Pedido ${externalReference}`,
                    expiration_time: 'PT5M', // cobrança esquecida não trava o terminal por 15 min
                    transactions: { payments: [{ amount: Number(amount).toFixed(2) }] },
                    config: {
                        point: { terminal_id: deviceId },
                        // Tipo já enviado à máquina (testado: qr e credit_card chegam sozinhos).
                        // PIX = qr; cartão = tipo fixo da config, ou o escolhido no Caixa quando a
                        // config é "escolher"; sem tipo, a própria máquina pergunta (ex.: totem).
                        ...(tipoDefaultOrder(cfgPoint, req.body) ? { payment_method: { default_type: tipoDefaultOrder(cfgPoint, req.body) } } : {})
                    }
                },
                { headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'X-Idempotency-Key': randomBytes(16).toString('hex')
                } }
            );
            console.log('[Point Orders] order criada:', JSON.stringify(order.data));
            return res.status(200).json({ ...order.data, api: 'orders' });
        }

        // amount em centavos, conforme a API do Point.
        const amountCentavos = Math.round(Number(amount) * 100);

        const response = await axios.post(
            `https://api.mercadopago.com/point/integration-api/devices/${deviceId}/payment-intents`,
            {
                amount: amountCentavos,
                description: description || `Pedido ${externalReference}`,
                payment: pagamentoPoint(cfgPoint, req.body.tipoCartao),
                additional_info: { external_reference: externalReference },
            },
            { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
        );

        return res.status(200).json(response.data);

    } catch (error) {
        console.error("Erro ao criar cobrança Point:", error.response?.data || error.message);
        if ((error.response?.data?.errors || []).some(e => e.code === 'already_queued_order_on_terminal')) {
            return res.status(409).json({ message: "A maquininha já tem uma cobrança pendente. Cancele-a na própria máquina ou aguarde alguns minutos e tente de novo." });
        }
        return res.status(error.response?.status || 500).json(error.response?.data || { message: error.message });
    }
});

// Cancela uma cobrança ainda pendente na Point (operador desistiu / cliente saiu).
// Só age sobre pedido AGUARDANDO_CARTAO, então não dá pra usar para estornar venda paga.
export const cancelarCobrancaPoint = onRequest(
    { secrets: [MERCADOPAGO_ACCESS_TOKEN, MERCADOPAGO_POINT_ACCESS_TOKEN] },
    async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', 'POST');
        res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        return res.status(204).send('');
    }
    if (req.method !== 'POST') return res.status(405).json({ message: 'Metodo nao permitido.' });

    try {
        const accessToken = tokenPoint();
        if (!accessToken) return res.status(500).json({ message: "Configuração de pagamento ausente no servidor." });

        const pedidoId = String(req.body?.pedidoId || '').trim();
        if (!pedidoId) return res.status(400).json({ message: "Informe pedidoId." });

        const pedidoRef = db.collection('pedidos').doc(pedidoId);
        const pedidoSnap = await pedidoRef.get();
        if (!pedidoSnap.exists) return res.status(404).json({ message: "Pedido não encontrado." });
        const pedido = pedidoSnap.data();
        // O totem não tem login (cliente cancela sozinho); pedido de balcão exige usuário logado.
        if (pedido.origem !== 'TOTEM') await exigirUsuario(req);
        if (pedido.status !== 'AGUARDANDO_CARTAO' || !pedido.pagamento_id) {
            return res.status(409).json({ message: "Este pedido não está aguardando pagamento no cartão." });
        }

        const cfgSnap = await db.collection('configuracoes').doc('pagamentos').get();
        const deviceId = deviceIdPoint(cfgSnap.exists ? cfgSnap.data() : {}, pedido.origem === 'TOTEM' ? 'totem' : 'caixa');
        if (!deviceId) return res.status(500).json({ message: "Terminal Point não configurado." });

        try {
            if (String(pedido.pagamento_id).startsWith('ORD')) {
                // Cobrança criada pela Orders API.
                await axios.post(
                    `https://api.mercadopago.com/v1/orders/${pedido.pagamento_id}/cancel`,
                    {},
                    { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'X-Idempotency-Key': randomBytes(16).toString('hex') } }
                );
            } else {
                await axios.delete(
                    `https://api.mercadopago.com/point/integration-api/devices/${deviceId}/payment-intents/${pedido.pagamento_id}`,
                    { headers: { Authorization: `Bearer ${accessToken}` } }
                );
            }
        } catch (err) {
            console.warn('Cancelar cobrança Point recusado:', err.response?.status, JSON.stringify(err.response?.data || err.message));
            // 404 = a cobrança já saiu da máquina (expirou/foi cancelada lá). Segue e cancela o pedido.
            const st = err.response?.status;
            // Order já cancelada (na máquina, por expiração...): segue e cancela o pedido aqui também.
            const jaCancelada = (err.response?.data?.errors || []).some(e => e.code === 'order_already_canceled');
            if (jaCancelada) { /* cai no cancelamento do pedido abaixo */ }
            else {
            const orderNaoCancelavel = String(pedido.pagamento_id).startsWith('ORD') && [400, 409, 422].includes(st);
            if (st === 409 || orderNaoCancelavel) {
                // ON_TERMINAL: já está na tela da máquina e a API não deixa retirar de lá.
                // Cancelando na própria máquina, o webhook (CANCELED) cancela o pedido sozinho.
                return res.status(409).json({
                    message: "A cobrança já está na maquininha. Para cancelar, use o botão cancelar/voltar na própria máquina — o pedido será cancelado automaticamente."
                });
            }
            if (err.response?.status !== 404) throw err;
            }
        }

        // Re-confere dentro de transação: o webhook pode ter aprovado nesse meio tempo.
        const cancelou = await db.runTransaction(async tx => {
            const atual = await tx.get(pedidoRef);
            if (atual.data()?.status !== 'AGUARDANDO_CARTAO') return false;
            tx.update(pedidoRef, { status: 'CANCELADO_PAGAMENTO', gateway_state: 'CANCELED_BY_OPERATOR' });
            return true;
        });
        return res.status(200).json({ cancelado: cancelou });
    } catch (error) {
        console.error("Erro ao cancelar cobrança Point:", error.response?.data || error.message);
        return res.status(error.status || error.response?.status || 500).json(error.response?.data || { message: error.message });
    }
});

// Cancela o PIX de um pedido do totem que o cliente abandonou, para o QR code não
// poder mais ser pago depois (dinheiro entrando sem pedido na cozinha).
export const cancelarPixTotem = onRequest(
    { secrets: [MERCADOPAGO_ACCESS_TOKEN] },
    async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', 'POST');
        res.set('Access-Control-Allow-Headers', 'Content-Type');
        return res.status(204).send('');
    }
    if (req.method !== 'POST') return res.status(405).json({ message: 'Metodo nao permitido.' });

    try {
        const accessToken = String(MERCADOPAGO_ACCESS_TOKEN.value() || '').trim();
        if (!accessToken) return res.status(500).json({ message: "Configuração de pagamento ausente no servidor." });

        const pedidoId = String(req.body?.pedidoId || '').trim();
        if (!pedidoId) return res.status(400).json({ message: "Informe pedidoId." });
        const pedidoRef = db.collection('pedidos').doc(pedidoId);
        const pedidoSnap = await pedidoRef.get();
        const pedido = pedidoSnap.data();
        if (!pedido || pedido.origem !== 'TOTEM' || pedido.status !== 'AGUARDANDO_PIX' || !pedido.pagamento_id) {
            return res.status(409).json({ message: "Este pedido não está aguardando PIX no totem." });
        }

        try {
            await axios.put(
                `https://api.mercadopago.com/v1/payments/${pedido.pagamento_id}`,
                { status: 'cancelled' },
                { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
            );
        } catch (err) {
            // Se o MP recusou, o PIX provavelmente foi pago agora — deixa o webhook seguir.
            console.warn('Cancelar PIX do totem recusado:', err.response?.data || err.message);
            return res.status(200).json({ cancelado: false });
        }

        const cancelou = await db.runTransaction(async tx => {
            const atual = await tx.get(pedidoRef);
            if (atual.data()?.status !== 'AGUARDANDO_PIX') return false;
            tx.update(pedidoRef, { status: 'CANCELADO_PAGAMENTO', gateway_state: 'CANCELLED_BY_TOTEM' });
            return true;
        });
        return res.status(200).json({ cancelado: cancelou });
    } catch (error) {
        console.error("Erro ao cancelar PIX do totem:", error.response?.data || error.message);
        return res.status(error.response?.status || 500).json(error.response?.data || { message: error.message });
    }
});

// Administração dos terminais Point: lista os terminais da conta (para preencher o
// device_id sozinho) e coloca um terminal em modo PDV (exigido pela API de integração).
export const terminaisPoint = onRequest(
    { secrets: [MERCADOPAGO_ACCESS_TOKEN, MERCADOPAGO_POINT_ACCESS_TOKEN], timeoutSeconds: 120 },
    async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', 'POST');
        res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        return res.status(204).send('');
    }
    if (req.method !== 'POST') return res.status(405).json({ message: 'Metodo nao permitido.' });

    try {
        await exigirAdminGenerico(req);
        const accessToken = tokenPoint();
        if (!accessToken) return res.status(500).json({ message: "Configuração de pagamento ausente no servidor." });
        const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

        // Teste de entrega da Orders API: cria uma order de R$ 1,00 no terminal e consulta o status
        // por ~40s SEM ninguém tocar na máquina, para ver se vira at_terminal sozinha.
        if (req.body?.acao === 'testeOrder') {
            const deviceId = String(req.body.deviceId || '').trim();
            if (!deviceId) return res.status(400).json({ message: "Informe deviceId." });
            const criada = await axios.post(
                'https://api.mercadopago.com/v1/orders',
                {
                    type: 'point',
                    external_reference: 'teste-entrega-' + Date.now(),
                    description: 'Teste de entrega automatica',
                    expiration_time: 'PT2M',
                    transactions: { payments: [{ amount: '1.00' }] },
                    config: {
                        point: { terminal_id: deviceId },
                        // Teste opcional de tipo pré-escolhido (credit_card | debit_card | qr):
                        // serve para ver se a entrega automática continua com o tipo definido.
                        ...(['credit_card', 'debit_card', 'qr'].includes(req.body.tipo)
                            ? { payment_method: { default_type: req.body.tipo } } : {})
                    }
                },
                { headers: { ...headers, 'X-Idempotency-Key': randomBytes(16).toString('hex') } }
            );
            const orderId = criada.data.id;
            console.log('[Point teste] order de teste criada:', orderId, 'tipo:', req.body.tipo || 'nenhum', 'terminal:', deviceId);
            const linha = [{ segundos: 0, status: criada.data.status, detalhe: criada.data.status_detail }];
            const inicio = Date.now();
            for (let i = 0; i < 10; i++) {
                await new Promise(r => setTimeout(r, 4000));
                const o = (await axios.get(`https://api.mercadopago.com/v1/orders/${orderId}`, { headers })).data;
                linha.push({ segundos: Math.round((Date.now() - inicio) / 1000), status: o.status, detalhe: o.status_detail });
                if (o.status !== 'created') break;
            }
            return res.status(200).json({ orderId, linhaDoTempo: linha });
        }
        if (req.body?.acao === 'consultarOrder' || req.body?.acao === 'cancelarOrder') {
            const orderId = String(req.body.orderId || '').trim();
            if (!orderId.startsWith('ORD')) return res.status(400).json({ message: "Informe orderId (ORD...)." });
            const r = req.body.acao === 'consultarOrder'
                ? await axios.get(`https://api.mercadopago.com/v1/orders/${orderId}`, { headers })
                : await axios.post(`https://api.mercadopago.com/v1/orders/${orderId}/cancel`, {}, { headers: { ...headers, 'X-Idempotency-Key': randomBytes(16).toString('hex') } });
            return res.status(200).json({ id: r.data.id, status: r.data.status, detalhe: r.data.status_detail, ultimaAtualizacao: r.data.last_updated_date });
        }

        // API nova (Orders): lista com loja/caixa/modo como a Orders API enxerga, e troca de modo
        // pelo endpoint dela (/terminals/v1/setup). Cada caixa (pos_id) só pode ter um terminal.
        if (req.body?.acao === 'listarV2') {
            const r = await axios.get('https://api.mercadopago.com/terminals/v1/list?limit=50&offset=0', { headers });
            return res.status(200).json(r.data);
        }
        if (req.body?.acao === 'modoV2') {
            const deviceId = String(req.body.deviceId || '').trim();
            const modo = req.body.modo === 'STANDALONE' ? 'STANDALONE' : 'PDV';
            if (!deviceId) return res.status(400).json({ message: "Informe deviceId." });
            const r = await axios.patch(
                'https://api.mercadopago.com/terminals/v1/setup',
                { terminals: [{ id: deviceId, operating_mode: modo }] },
                { headers }
            );
            return res.status(200).json(r.data);
        }

        // 'pdv' liga o modo de integração; 'standalone' devolve a máquina ao modo normal
        // (aceita valor digitado nela). Em PDV a máquina NÃO aceita venda digitada.
        if (req.body?.acao === 'pdv' || req.body?.acao === 'standalone') {
            const deviceId = String(req.body.deviceId || '').trim();
            if (!deviceId) return res.status(400).json({ message: "Informe deviceId." });
            const r = await axios.patch(
                `https://api.mercadopago.com/point/integration-api/devices/${deviceId}`,
                { operating_mode: req.body.acao === 'pdv' ? 'PDV' : 'STANDALONE' },
                { headers }
            );
            return res.status(200).json(r.data);
        }

        const r = await axios.get('https://api.mercadopago.com/point/integration-api/devices', { headers });
        return res.status(200).json(r.data);
    } catch (error) {
        console.error("Erro nos terminais Point:", error.response?.data || error.message);
        const e0 = (error.response?.data?.errors || [])[0];
        if (e0) return res.status(error.response?.status || 500).json({ message: `${e0.code}: ${e0.message}` });
        return res.status(error.status || error.response?.status || 500).json(error.response?.data || { message: error.message });
    }
});

// Confirma no Firestore um pedido AGUARDANDO_CARTAO que teve o pagamento aprovado
// na maquininha (Point ou Stone) — grava o movimento de caixa e os totais da sessão.
// Compartilhado pelos dois provedores para não duplicar a lógica de fechamento.
async function confirmarCartaoAprovado(pedidoDoc, pedido, origemLabel, estadoBruto) {
    const statusFinal = pedido.status_pos_pagamento || 'CONCLUIDO';
    // nfce_pendente entra na fila do fiscalRetryScheduler (roda a cada 20min,
    // sem depender de nenhuma aba do dashboard aberta) — cobre tanto cartão do
    // app do cliente quanto cartão de balcão aprovado com o caixa fechado. Só
    // marca quando o pedido já está CONCLUIDO — se foi mandado pra cozinha
    // (status_pos_pagamento = PENDENTE_PREPARO), a emissão fica pro momento em
    // que o pedido realmente for concluído (mesmo padrão do resto do sistema).
    const ehDinheiro = String(pedido.forma_pagamento || '').toLowerCase().includes('dinheiro');
    await pedidoDoc.ref.update({
        status: statusFinal,
        gateway_state: estadoBruto,
        ...(!ehDinheiro && statusFinal === 'CONCLUIDO' ? { nfce_pendente: true } : {}),
    });

    if (pedido.caixa_sessao_id) {
        const chave = { "Dinheiro": "Dinheiro", "PIX": "PIX", "Cartão": "Cartao" }[pedido.forma_pagamento] || "Cartao";
        const batch = db.batch();
        batch.set(db.collection('caixa_movimentos').doc(), {
            sessao_id: pedido.caixa_sessao_id,
            tipo: 'VENDA',
            valor: pedido.valor_total,
            forma_pagamento: pedido.forma_pagamento,
            descricao: `Venda balcão (${pedido.forma_pagamento === 'PIX' ? 'PIX' : 'cartão'} via ${origemLabel})`,
            pedido_id: pedidoDoc.id,
            operador: pedido.operador || null,
            hora: FieldValue.serverTimestamp(),
        });
        batch.update(db.collection('caixa_sessoes').doc(pedido.caixa_sessao_id), {
            total_vendas: FieldValue.increment(pedido.valor_total),
            qtd_vendas: FieldValue.increment(1),
            ["totais." + chave]: FieldValue.increment(pedido.valor_total),
        });
        await batch.commit();
    }
}

// Trata a notificação de cobrança da maquininha Point (topic=point_integration_ipn).
// O "id" aqui é o payment_intent, não um payment normal — endpoint de consulta é outro.
// Atualiza pedido + movimento de caixa + totais da sessão diretamente (sem depender
// do navegador do caixa continuar aberto).
// Notificação da Orders API (tópico "order"): aprova só se a CONSULTA à order confirmar
// (status processed + accredited); cancelamento pode vir só do aviso se a consulta atrasar.
async function tratarNotificacaoOrder(orderId, accessToken, acao) {
    const consultar = async () => (await axios.get(
        `https://api.mercadopago.com/v1/orders/${orderId}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
    )).data;
    const CANC = ['canceled', 'expired', 'failed'];
    const stDe = o => String(o.status || '').toLowerCase();

    let order = await consultar();
    let st = stDe(order);
    const avisoCancelado = ['order.canceled', 'order.expired', 'order.failed'].includes(acao);
    for (let i = 0; i < 3 && avisoCancelado && !CANC.includes(st) && st !== 'processed'; i++) {
        await new Promise(r => setTimeout(r, 1500));
        order = await consultar();
        st = stDe(order);
    }
    if (avisoCancelado && !CANC.includes(st) && st !== 'processed') {
        console.warn('[Point Orders] consulta ainda em', st, '— aceitando cancelamento notificado:', acao);
        st = 'canceled';
    }
    console.log('[Point Orders] order consultada:', JSON.stringify(order), '| status considerado:', st);

    const aprovado = st === 'processed' && String(order.status_detail || '').toLowerCase() === 'accredited';
    const cancelado = CANC.includes(st);
    if (!aprovado && !cancelado) return; // created / at_terminal / action_required: aguarda

    const snap = await db.collection('pedidos').where('pagamento_id', '==', orderId).limit(1).get();
    if (snap.empty) {
        console.warn('Webhook Point Orders: pedido não encontrado para order', orderId);
        return;
    }
    const pedidoDoc = snap.docs[0];
    const pedido = pedidoDoc.data();
    if (pedido.status !== 'AGUARDANDO_CARTAO') return; // já processado

    if (cancelado) {
        await pedidoDoc.ref.update({ status: 'CANCELADO_PAGAMENTO', gateway_state: st.toUpperCase() });
        return;
    }
    await confirmarCartaoAprovado(pedidoDoc, pedido, 'Point', 'ORDER_PROCESSED');
    const pag = (order.transactions && order.transactions.payments && order.transactions.payments[0]) || {};
    const tipo = pag.payment_method && pag.payment_method.type;
    await pedidoDoc.ref.update({
        ...(pag.id ? { point_payment_id: String(pag.id) } : {}),
        ...(tipo ? { point_payment_type: String(tipo) } : {}),
    });
}

const ESTADOS_POINT_CANCELADOS =['CANCELED', 'CANCELLED', 'ERROR', 'FAILED', 'ABANDONED', 'EXPIRED'];

async function tratarNotificacaoPoint(paymentIntentId, accessToken, estadoNotificado) {
    const consultar = async () => (await axios.get(
        `https://api.mercadopago.com/point/integration-api/payment-intents/${paymentIntentId}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
    )).data;
    const estadoDe = it => String(it.state || it.status || '').toUpperCase();

    let intent = await consultar();
    let estado = estadoDe(intent);

    // A consulta logo após a notificação pode devolver o estado ANTERIOR (ex.: aviso de CANCELED
    // e a consulta ainda ON_TERMINAL). Para cancelamento, espera a consulta alcançar o aviso;
    // se não alcançar, aceita o aviso só nessa direção (cancelar), nunca para aprovar.
    const avisoCancelado = ESTADOS_POINT_CANCELADOS.includes(String(estadoNotificado || '').toUpperCase());
    for (let i = 0; i < 3 && avisoCancelado && !ESTADOS_POINT_CANCELADOS.includes(estado) && estado !== 'FINISHED'; i++) {
        await new Promise(r => setTimeout(r, 1500));
        intent = await consultar();
        estado = estadoDe(intent);
    }
    if (avisoCancelado && !ESTADOS_POINT_CANCELADOS.includes(estado) && estado !== 'FINISHED') {
        console.warn('[Point IPN] consulta ainda em', estado, '— aceitando cancelamento notificado:', estadoNotificado);
        estado = String(estadoNotificado).toUpperCase();
    }
    console.log('[Point IPN] payment-intent recebido:', JSON.stringify(intent), '| estado considerado:', estado);

    const finalizado = estado === 'FINISHED' || estado === 'APPROVED';
    const cancelado = ESTADOS_POINT_CANCELADOS.includes(estado);

    const snap = await db.collection('pedidos')
        .where('pagamento_id', '==', paymentIntentId)
        .limit(1)
        .get();
    if (snap.empty) {
        console.warn('Webhook Point: pedido não encontrado para payment_intent', paymentIntentId);
        return;
    }

    const pedidoDoc = snap.docs[0];
    const pedido = pedidoDoc.data();
    if (pedido.status !== 'AGUARDANDO_CARTAO') return; // já processado

    if (cancelado) {
        await pedidoDoc.ref.update({ status: 'CANCELADO_PAGAMENTO', gateway_state: estado });
        return;
    }
    if (!finalizado) return; // ainda em andamento, aguarda proxima notificacao

    await confirmarCartaoAprovado(pedidoDoc, pedido, 'Point', estado);

    // Guarda o id/tipo do pagamento real (para conciliação e consulta de bandeira/NSU).
    const pag = intent.payment || {};
    if (pag.id || pag.type) {
        await pedidoDoc.ref.update({
            ...(pag.id ? { point_payment_id: String(pag.id) } : {}),
            ...(pag.type ? { point_payment_type: String(pag.type) } : {}),
        });
    }
}

// Salva a credencial do Connect em uma coleção sem acesso pelo navegador.
export const configurarStoneConnect = onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', 'POST');
        res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        return res.status(204).send('');
    }
    if (req.method !== 'POST') return res.status(405).json({ message: 'Metodo nao permitido.' });

    try {
        await exigirAdmin(req);
        const stoneCode = String(req.body?.stoneCode || '').trim();
        const serial = String(req.body?.stoneDeviceSerial || '').trim();
        const serviceRefererName = String(req.body?.stoneServiceRefererName || '').trim();
        const secretKey = String(req.body?.stoneSecretKey || '').trim();

        if (!/^\d{1,9}$/.test(stoneCode)) {
            return res.status(400).json({ message: 'Informe um StoneCode valido, com ate 9 digitos.' });
        }
        if (!serial) return res.status(400).json({ message: 'Informe o numero de serie da POS Stone.' });
        if (!serviceRefererName) {
            return res.status(400).json({ message: 'Informe o ServiceRefererName fornecido na homologacao do Connect 2.0.' });
        }

        const secretRef = db.collection('integracao_secrets').doc('stone_connect');
        const atual = await secretRef.get();
        if (!secretKey && !atual.exists) {
            await db.collection('configuracoes').doc('pagamentos').set({
                stoneSecretKey: FieldValue.delete()
            }, { merge: true });
            return res.status(400).json({ message: 'Informe a Secret Key do Connect 2.0. A chave TEF nao e compativel.' });
        }
        if (secretKey && !secretKey.startsWith('sk_')) {
            await db.collection('configuracoes').doc('pagamentos').set({
                stoneSecretKey: FieldValue.delete()
            }, { merge: true });
            return res.status(400).json({ message: 'A chave informada nao e uma Secret Key do Connect 2.0 (prefixo sk_). Solicite a credencial do Connect a Stone.' });
        }

        const batch = db.batch();
        batch.set(db.collection('configuracoes').doc('pagamentos'), {
            provedorCartao: 'stone',
            stoneCode,
            stoneDeviceSerial: serial,
            stoneServiceRefererName: serviceRefererName,
            stoneSecretConfigured: true,
            stoneSecretKey: FieldValue.delete(),
            atualizado_em: FieldValue.serverTimestamp()
        }, { merge: true });
        if (secretKey) {
            batch.set(secretRef, { secretKey, atualizado_em: FieldValue.serverTimestamp() }, { merge: true });
        }
        await batch.commit();
        return res.status(200).json({ configured: true });
    } catch (error) {
        console.error('Erro ao configurar Stone Connect:', error.message);
        return res.status(error.status || 500).json({ message: error.message });
    }
});

// Salva a configuração da integração iFood: merchantId/clientId ficam em
// configuracoes/ifood (o dashboard lê pra mostrar o status); clientSecret e
// signatureSecret ficam em integracao_secrets/ifood, coleção sem acesso pelo
// navegador (regras do Firestore), lida só pelo webhook (ifood-functions).
export const configurarIfood = onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', 'POST');
        res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        return res.status(204).send('');
    }
    if (req.method !== 'POST') return res.status(405).json({ message: 'Metodo nao permitido.' });

    try {
        await exigirAdminGenerico(req);
        const ativo = req.body?.ativo !== false;
        const merchantId = String(req.body?.merchantId || '').trim();
        const clientId = String(req.body?.clientId || '').trim();
        const clientSecret = String(req.body?.clientSecret || '').trim();
        const signatureSecret = String(req.body?.signatureSecret || '').trim();

        if (!merchantId) return res.status(400).json({ message: 'Informe o Merchant ID (loja) do iFood.' });
        if (!clientId) return res.status(400).json({ message: 'Informe o Client ID do aplicativo cadastrado no Portal do Parceiro.' });

        const secretRef = db.collection('integracao_secrets').doc('ifood');
        const atual = await secretRef.get();
        const clientSecretConfigured = !!clientSecret || !!atual.data()?.clientSecret;
        const signatureSecretConfigured = !!signatureSecret || !!atual.data()?.signatureSecret;

        const batch = db.batch();
        batch.set(db.collection('configuracoes').doc('ifood'), {
            ativo,
            merchantId,
            clientId,
            clientSecretConfigured,
            signatureSecretConfigured,
            atualizado_em: FieldValue.serverTimestamp()
        }, { merge: true });
        if (clientSecret || signatureSecret) {
            batch.set(secretRef, {
                ...(clientSecret ? { clientSecret } : {}),
                ...(signatureSecret ? { signatureSecret } : {}),
                atualizado_em: FieldValue.serverTimestamp()
            }, { merge: true });
        }
        await batch.commit();
        return res.status(200).json({ configured: true });
    } catch (error) {
        console.error('Erro ao configurar iFood:', error.message);
        return res.status(error.status || 500).json({ message: error.message });
    }
});

// Cria (ou atualiza a senha de) o login do Firebase Authentication de um
// usuário do dashboard. A tela de Configurações (configuracoes.js) só grava
// o documento de permissões em usuarios_admin — sem isso, alguém sempre
// precisava criar o login manualmente no Console do Firebase depois. Não dá
// pra fazer isso direto do navegador com createUserWithEmailAndPassword
// porque essa chamada desloga o admin atual e loga como o usuário recém-criado;
// por isso passa pelo Admin SDK aqui no servidor.
export const criarUsuarioAdmin = onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', 'POST');
        res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        return res.status(204).send('');
    }
    if (req.method !== 'POST') return res.status(405).json({ message: 'Metodo nao permitido.' });

    try {
        await exigirAdminGenerico(req);
        const email = String(req.body?.email || '').trim().toLowerCase();
        const senha = String(req.body?.senha || '');
        const nome = String(req.body?.nome || '').trim();

        if (!email || !email.includes('@')) {
            return res.status(400).json({ message: 'Informe um e-mail valido.' });
        }

        let usuarioExistente = null;
        try {
            usuarioExistente = await getAuth().getUserByEmail(email);
        } catch (err) {
            if (err.code !== 'auth/user-not-found') throw err;
        }

        if (!usuarioExistente) {
            if (!senha || senha.length < 6) {
                return res.status(400).json({ message: 'Defina uma senha de pelo menos 6 caracteres pra criar o login deste usuario.' });
            }
            await getAuth().createUser({
                email,
                password: senha,
                emailVerified: true,
                ...(nome ? { displayName: nome } : {})
            });
            return res.status(200).json({ ok: true, existia: false, senhaAlterada: true });
        }

        if (senha) {
            if (senha.length < 6) {
                return res.status(400).json({ message: 'A senha precisa ter pelo menos 6 caracteres.' });
            }
            await getAuth().updateUser(usuarioExistente.uid, {
                password: senha,
                ...(nome ? { displayName: nome } : {})
            });
        }
        return res.status(200).json({ ok: true, existia: true, senhaAlterada: !!senha });
    } catch (error) {
        console.error('Erro ao criar/atualizar login do usuario:', error.message);
        return res.status(error.status || 500).json({ message: error.message });
    }
});

// Cria uma cobrança na maquininha Stone (Connect 2.0 / Pagar.me Orders API) — mesmo papel do
// criarCobrancaPoint acima, mas para o terminal físico Stone do cliente.
// Chamada pelo dashboard (caixa.js) quando o provedor configurado é "stone".
export const criarCobrancaStone = onRequest(
    async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');

    if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', 'POST');
        res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        return res.status(204).send('');
    }
    if (req.method !== 'POST') return res.status(405).json({ message: 'Metodo nao permitido.' });

    try {
        await exigirUsuario(req);
        const { amount, externalReference, description } = req.body;
        if (!Number.isFinite(Number(amount)) || Number(amount) <= 0 || !externalReference) {
            return res.status(400).json({ message: "Informe amount e externalReference." });
        }

        const configSnap = await db.collection('configuracoes').doc('pagamentos').get();
        const cfg = configSnap.exists ? (configSnap.data() || {}) : {};
        if (cfg.maquininhaAtiva === false) {
            return res.status(409).json({ message: "Integração com a maquininha está desativada nas configurações." });
        }
        const serial = cfg.stoneDeviceSerial || null;
        if (!serial) {
            return res.status(500).json({ message: "Terminal Stone não configurado (número de série ausente)." });
        }

        const refererName = String(cfg.stoneServiceRefererName || '').trim();
        if (!refererName) {
            return res.status(500).json({ message: "Stone Connect nao homologado (ServiceRefererName ausente)." });
        }

        const secretSnap = await db.collection('integracao_secrets').doc('stone_connect').get();
        const secretKey = secretSnap.exists ? String(secretSnap.data()?.secretKey || '').trim() : '';
        if (!secretKey) {
            return res.status(500).json({ message: "Secret Key do Stone Connect nao configurada no servidor." });
        }

        const amountCentavos = Math.round(Number(amount) * 100);
        const authHeader = 'Basic ' + Buffer.from(`${secretKey}:`).toString('base64');

        const response = await axios.post(
            'https://api.pagar.me/core/v5/orders/',
            {
                code: externalReference,
                closed: false,
                items: [{
                    amount: amountCentavos,
                    description: description || `Pedido ${externalReference}`,
                    quantity: 1,
                    code: externalReference,
                }],
                customer: { name: 'Cliente balcão', email: clientConfig.emailClienteBalcao },
                poi_payment_settings: {
                    payment_setup: { type: 'credit_card', installments: 1, installment_type: 'merchant' },
                    devices_serial_number: [serial],
                    display_name: description || `Pedido ${externalReference}`,
                    print_order_receipt: false,
                },
            },
            { headers: { Authorization: authHeader, ServiceRefererName: refererName, 'Content-Type': 'application/json' } }
        );

        return res.status(200).json(response.data);

    } catch (error) {
        console.error("Erro ao criar cobrança Stone:", error.response?.data || error.message);
        return res.status(error.status || error.response?.status || 500).json(error.response?.data || { message: error.message });
    }
});

// Recebe o webhook da Stone/Pagar.me quando o pagamento no terminal é confirmado
// (evento charge.paid) ou falha (charge.payment_failed / order.canceled).
// Configurar a URL desta function no portal Pagar.me/Stone Connect como webhook.
export const stoneWebhook = onRequest(async (req, res) => {
    try {
        const evento = req.body?.type;
        const dados = req.body?.data;
        // O "code" do item é o externalReference (pedidoRef.id) que enviamos na criação.
        const externalReference = dados?.order?.code || dados?.code
            || dados?.items?.[0]?.code || null;

        if (!evento || !externalReference) {
            console.warn('Webhook Stone: payload sem type/code reconhecível', JSON.stringify(req.body));
            return res.status(200).send('ignorado');
        }

        const snap = await db.collection('pedidos').doc(externalReference).get();
        if (!snap.exists) {
            console.warn('Webhook Stone: pedido não encontrado para code', externalReference);
            return res.status(200).send('pedido nao encontrado');
        }

        const pedido = snap.data();
        if (pedido.status !== 'AGUARDANDO_CARTAO') {
            return res.status(200).send('pedido ja processado');
        }

        const aprovado = evento === 'charge.paid' || evento === 'order.paid';
        const falhou = evento === 'charge.payment_failed' || evento === 'order.canceled' || evento === 'order.closed_failed';

        if (falhou) {
            await snap.ref.update({ status: 'CANCELADO_PAGAMENTO', gateway_state: evento });
            return res.status(200).send('ok');
        }
        if (!aprovado) {
            return res.status(200).send('evento ignorado');
        }

        await confirmarCartaoAprovado(snap, pedido, 'Stone', evento);
        return res.status(200).send('ok');

    } catch (error) {
        console.error("Erro no webhook da Stone:", error.response?.data || error.message);
        return res.status(500).send('erro');
    }
});

// Recebe a notificação (IPN) do Mercado Pago quando um pagamento muda de status.
// Configurado como notification_url na criação do PIX (ver acima). Confirma o
// pagamento, avança o pedido de AGUARDANDO_PIX -> PENDENTE_PREPARO e credita os
// pontos de fidelidade que ficaram pendentes no pedido.
// Também recebe notificações da maquininha Point (topic=point_integration_ipn).
export const mercadoPagoWebhook = onRequest(
    { secrets: [MERCADOPAGO_ACCESS_TOKEN, MERCADOPAGO_POINT_ACCESS_TOKEN] },
    async (req, res) => {
    try {
        const paymentId = req.query['data.id'] || req.body?.data?.id || req.query.id;
        const topic = req.query.topic || req.query.type || req.body?.type;
        const accessToken = String(MERCADOPAGO_ACCESS_TOKEN.value() || '').trim();

        // Orders API (Point): tópico "order", ação em req.body.action (order.processed, order.canceled...)
        if (topic === 'order') {
            console.log('[Point Orders notificação] query:', JSON.stringify(req.query), 'body:', JSON.stringify(req.body));
            if (!paymentId) return res.status(200).send('ignorado');
            try {
                await tratarNotificacaoOrder(paymentId, tokenPoint(), req.body?.action);
            } catch (err) {
                const st = err.response?.status;
                if (st === 400 || st === 404) {
                    console.warn('[Point Orders] order inválida, ignorando:', paymentId, err.response?.data);
                    return res.status(200).send('ignorado');
                }
                throw err;
            }
            return res.status(200).send('ok');
        }

        // Webhook da Point (painel de integrações) manda point_integration_wh; o IPN antigo,
        // point_integration_ipn. Os dois trazem o id do payment_intent.
        if (topic === 'point_integration_ipn' || topic === 'point_integration_wh') {
            console.log('[Point notificação] topic:', topic, 'query:', JSON.stringify(req.query), 'body:', JSON.stringify(req.body));
            if (!paymentId) return res.status(200).send('ignorado');
            try {
                await tratarNotificacaoPoint(paymentId, tokenPoint(), req.body?.state);
            } catch (err) {
                // Intent inexistente/inválido (ex.: botão "Simular" do painel): não adianta o MP reenviar.
                const st = err.response?.status;
                if (st === 400 || st === 404) {
                    console.warn('[Point notificação] intent inválido, ignorando:', paymentId, err.response?.data);
                    return res.status(200).send('ignorado');
                }
                throw err;
            }
            return res.status(200).send('ok');
        }

        if (!paymentId || (topic && topic !== 'payment')) {
            return res.status(200).send('ignorado');
        }

        const { data: payment } = await axios.get(
            `https://api.mercadopago.com/v1/payments/${paymentId}`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        if (payment.status !== 'approved') {
            return res.status(200).send('pagamento ainda nao aprovado');
        }

        const snap = await db.collection('pedidos')
            .where('pagamento_id', '==', payment.id)
            .limit(1)
            .get();

        if (snap.empty) {
            console.warn('Webhook MP: pedido não encontrado para pagamento', payment.id);
            return res.status(200).send('pedido nao encontrado');
        }

        const pedidoDoc = snap.docs[0];
        const pedido = pedidoDoc.data();

        if (pedido.status !== 'AGUARDANDO_PIX') {
            return res.status(200).send('pedido ja processado');
        }

        await pedidoDoc.ref.update({
            status: 'PENDENTE_PREPARO',
            pontos_creditados: true
        });

        // Ganho e resgate são aplicados juntos, só aqui na confirmação — o app
        // não debita os pontos resgatados na hora de gerar o PIX (pedido ainda
        // podia nunca ser pago/ser cancelado, e o cliente perdia os pontos sem
        // reembolso nenhum).
        const pontosACreditar = Number(pedido.pontos_a_creditar) || 0;
        const pontosResgatados = Number(pedido.pontos_resgatados) || 0;
        const saldoPontos = pontosACreditar - pontosResgatados;
        if (saldoPontos !== 0 && pedido.usuario_id) {
            await db.collection('usuarios_app').doc(pedido.usuario_id)
                .update({ pontos: FieldValue.increment(saldoPontos) });
        }

        return res.status(200).send('ok');

    } catch (error) {
        console.error("Erro no webhook do Mercado Pago:", error.response?.data || error.message);
        return res.status(500).send('erro');
    }
});
