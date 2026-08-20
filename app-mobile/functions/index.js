import axios from "axios";
import { randomBytes } from "crypto";
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

initializeApp();
const db = getFirestore();

// Token do Mercado Pago lido de secret (NUNCA hardcoded).
// Configure com: firebase functions:secrets:set MERCADOPAGO_ACCESS_TOKEN
const MERCADOPAGO_ACCESS_TOKEN = defineSecret("MERCADOPAGO_ACCESS_TOKEN");

const GESTORCHEF_ADMIN_EMAIL = "lileamarloja04@gmail.com";

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

// URL fixa da função de webhook abaixo (região padrão us-central1, mesmo projeto).
const WEBHOOK_URL = "https://us-central1-salgadinhos-lileamar.cloudfunctions.net/mercadoPagoWebhook";

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
                email: email,
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

// Cria uma cobrança na maquininha Point (Cartão no balcão/caixa físico).
// Chamada pelo dashboard (caixa.js) quando o operador finaliza uma venda no Cartão.
// O resultado chega depois via webhook (topic=point_integration_ipn, ver abaixo).
export const criarCobrancaPoint = onRequest(
    { secrets: [MERCADOPAGO_ACCESS_TOKEN] },
    async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');

    if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', 'POST');
        res.set('Access-Control-Allow-Headers', 'Content-Type');
        return res.status(204).send('');
    }

    try {
        const accessToken = String(MERCADOPAGO_ACCESS_TOKEN.value() || '').trim();
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
        const deviceId = cfgPoint.pointDeviceId;
        if (!deviceId) {
            return res.status(500).json({ message: "Terminal Point não configurado (pointDeviceId ausente)." });
        }

        // amount em centavos, conforme a API do Point.
        const amountCentavos = Math.round(Number(amount) * 100);

        const response = await axios.post(
            `https://api.mercadopago.com/point/integration-api/devices/${deviceId}/payment-intents`,
            {
                amount: amountCentavos,
                description: description || `Pedido ${externalReference}`,
                payment: { installments: 1, type: "credit_card", installments_cost: "seller" },
                additional_info: { external_reference: externalReference },
            },
            { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
        );

        return res.status(200).json(response.data);

    } catch (error) {
        console.error("Erro ao criar cobrança Point:", error.response?.data || error.message);
        return res.status(error.response?.status || 500).json(error.response?.data || { message: error.message });
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
            descricao: `Venda balcão (cartão via ${origemLabel})`,
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
async function tratarNotificacaoPoint(paymentIntentId, accessToken) {
    const { data: intent } = await axios.get(
        `https://api.mercadopago.com/point/integration-api/payment-intents/${paymentIntentId}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    // Loga a resposta crua na primeira vez — os nomes exatos dos campos de status
    // (state/status) serão confirmados no primeiro teste real e ajustados se preciso.
    console.log('[Point IPN] payment-intent recebido:', JSON.stringify(intent));

    const estado = String(intent.state || intent.status || '').toUpperCase();
    const finalizado = estado === 'FINISHED' || estado === 'APPROVED';
    const cancelado = estado === 'CANCELED' || estado === 'CANCELLED' || estado === 'ERROR';

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
                customer: { name: 'Cliente balcão', email: 'balcao@salgadinhoslileamar.com.br' },
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
    { secrets: [MERCADOPAGO_ACCESS_TOKEN] },
    async (req, res) => {
    try {
        const paymentId = req.query['data.id'] || req.body?.data?.id || req.query.id;
        const topic = req.query.topic || req.query.type || req.body?.type;
        const accessToken = String(MERCADOPAGO_ACCESS_TOKEN.value() || '').trim();

        if (topic === 'point_integration_ipn') {
            if (!paymentId) return res.status(200).send('ignorado');
            await tratarNotificacaoPoint(paymentId, accessToken);
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

        const pontosACreditar = Number(pedido.pontos_a_creditar) || 0;
        if (pontosACreditar > 0 && pedido.usuario_id) {
            await db.collection('usuarios_app').doc(pedido.usuario_id)
                .update({ pontos: FieldValue.increment(pontosACreditar) });
        }

        return res.status(200).send('ok');

    } catch (error) {
        console.error("Erro no webhook do Mercado Pago:", error.response?.data || error.message);
        return res.status(500).send('erro');
    }
});
