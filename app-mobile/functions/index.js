import axios from "axios";
import { randomBytes } from "crypto";
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

initializeApp();
const db = getFirestore();

// Token do Mercado Pago lido de secret (NUNCA hardcoded).
// Configure com: firebase functions:secrets:set MERCADOPAGO_ACCESS_TOKEN
const MERCADOPAGO_ACCESS_TOKEN = defineSecret("MERCADOPAGO_ACCESS_TOKEN");

// URL fixa da função de webhook abaixo (região padrão us-central1, mesmo projeto).
const WEBHOOK_URL = "https://us-central1-pizzain-40973.cloudfunctions.net/mercadoPagoWebhook";

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
        const accessToken = MERCADOPAGO_ACCESS_TOKEN.value();
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
        return res.status(error.response?.status || 500).json(error.response?.data || { message: error.message });
    }
});

// Recebe a notificação (IPN) do Mercado Pago quando um pagamento muda de status.
// Configurado como notification_url na criação do PIX (ver acima). Confirma o
// pagamento, avança o pedido de AGUARDANDO_PIX -> PENDENTE_PREPARO e credita os
// pontos de fidelidade que ficaram pendentes no pedido.
export const mercadoPagoWebhook = onRequest(
    { secrets: [MERCADOPAGO_ACCESS_TOKEN] },
    async (req, res) => {
    try {
        const paymentId = req.query['data.id'] || req.body?.data?.id || req.query.id;
        const topic = req.query.topic || req.query.type || req.body?.type;

        if (!paymentId || (topic && topic !== 'payment')) {
            return res.status(200).send('ignorado');
        }

        const accessToken = MERCADOPAGO_ACCESS_TOKEN.value();
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