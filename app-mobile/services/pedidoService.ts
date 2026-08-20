import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';
import { firebaseConfig } from '../firebaseConfig';

if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

// Mesma config que o bot do WhatsApp le em obter_config_bot() (backend-bot/app.py) —
// bairros_entrega e taxa_entrega ficam em configuracoes/bot, um valor unico de taxa
// pra qualquer bairro atendido (sem preco por bairro).
export async function obterConfigEntrega(): Promise<{ bairros: string[]; taxaEntrega: number }> {
    try {
        const snap = await db.collection('configuracoes').doc('bot').get();
        const d: any = snap.exists ? (snap.data() || {}) : {};
        return {
            bairros: Array.isArray(d.bairros_entrega) ? d.bairros_entrega : [],
            taxaEntrega: Number(d.taxa_entrega) || 0,
        };
    } catch (e) {
        console.warn('Falha ao carregar config de entrega:', e);
        return { bairros: [], taxaEntrega: 0 };
    }
}

// Ultima checagem de disponibilidade antes de gravar. O carrinho e montado a
// partir do cardapio carregado quando a tela abriu — se um item esgotar
// (disponivel ou disponivel_online) enquanto o cliente ja estava com ele no
// carrinho, sem isso o pedido seria gravado do mesmo jeito, igual ao bot ja
// corrige mas o app antes nao checava (nem no pagamento PIX/cartao).
export async function checarDisponibilidadeCarrinho(
    carrinho: any[],
    setCarrinho: (c: any[]) => void
): Promise<boolean> {
    const idsUnicos: string[] = [...new Set<string>(carrinho.map((i: any) => i.id).filter(Boolean))];
    const docsAtuais = await Promise.all(idsUnicos.map((id: string) => db.collection('cardapio').doc(id).get()));
    const idsIndisponiveis = new Set<string>();
    docsAtuais.forEach((snap: any) => {
        const d = snap.exists ? (snap.data() || {}) : null;
        if (!d || d.disponivel === false || d.disponivel_online === false) idsIndisponiveis.add(snap.id);
    });
    if (idsIndisponiveis.size > 0) {
        const nomesIndisponiveis = [...new Set(
            carrinho.filter((i: any) => idsIndisponiveis.has(i.id)).map((i: any) => i.nome_exibicao || i.nome)
        )];
        alert(`Esses itens esgotaram e foram removidos do seu carrinho: ${nomesIndisponiveis.join(', ')}. Revise o pedido e finalize novamente.`);
        setCarrinho(carrinho.filter((i: any) => !idsIndisponiveis.has(i.id)));
        return false;
    }
    return true;
}

export const finalizarPedido = async ({
    carrinho,
    usuarioId,
    nome,
    telefone,
    cpf,
    endereco,
    bairro,
    taxaEntrega = 0,
    metodoPagamento,
    tipoEntrega = 'entrega',
    calcularTotal,
    setCarrinho,
    setAbaAtiva,
    pontosResgatados = 0,
}: any) => {
    if (!nome || !telefone) {
        return alert('Preencha nome e telefone');
    }
    if (tipoEntrega === 'entrega' && !endereco) {
        return alert('Preencha o endereço de entrega');
    }

    const ok = await checarDisponibilidadeCarrinho(carrinho, setCarrinho);
    if (!ok) return;

    // Montagem do objeto EXATAMENTE como o seu app.js (painel) espera
    const pedido = {
        origem: "APP",
        usuario_id: usuarioId,
        nome_cliente: nome,
        telefone: telefone,
        tipo_entrega: tipoEntrega === 'retirada' ? 'RETIRADA' : 'ENTREGA',
        endereco: tipoEntrega === 'retirada' ? 'Retirada no balcão' : endereco,
        bairro: tipoEntrega === 'retirada' ? null : (bairro || null),
        taxa_entrega: tipoEntrega === 'retirada' ? 0 : taxaEntrega,

        // 1. RESOLVE O "N/I" DOS ITENS:
        // O seu painel espera 'itens_resumo' para exibir na tabela
        item_pedido: carrinho.map((i: any) => i.nome_exibicao || i.nome).join(', '),

        // 2. RESOLVE O "N/I" DO PAGAMENTO:
        metodo_pagamento: metodoPagamento === 'pix' ? 'PIX' :
                      metodoPagamento === 'cartao' ? 'Cartão' : 'Dinheiro/Entrega',
        // Garanta que o nome do campo é o que o seu app.js lê (ex: metodo_pagamento)
        pagamento: metodoPagamento === 'pix' ? 'PIX' :
               metodoPagamento === 'cartao' ? 'Cartão' : 'Entrega',

        forma_pagamento: metodoPagamento === 'pix' ? 'PIX' :
                     metodoPagamento === 'cartao' ? 'Cartão' : 'Entrega/Dinheiro',

        valor_total: calcularTotal(),
        // CPF do cliente (necessário pra emitir NFC-e não presencial); dinheiro
        // não emite nota automática, mas fica disponível pra emissão manual.
        cpf_cliente: String(cpf || '').replace(/\D/g, '') || null,
        status: 'PENDENTE_PREPARO',
        hora_pedido: firebase.firestore.FieldValue.serverTimestamp(),

        // Mantemos o array original para consultas detalhadas se necessário
        itens: carrinho
    };

    try {
        await db.collection('pedidos').add(pedido);
        // Resgate de fidelidade: debita os pontos utilizados
        if (pontosResgatados > 0 && usuarioId) {
            try {
                await db.collection('usuarios_app').doc(usuarioId)
                    .update({ pontos: firebase.firestore.FieldValue.increment(-pontosResgatados) });
            } catch (e) { console.warn('Falha ao debitar pontos (entrega):', e); }
        }
        setCarrinho([]);
        setAbaAtiva('pedidos');
        alert('Pedido enviado com sucesso!');
    } catch (error) {
        console.error("Erro ao gravar:", error);
        alert('Erro ao processar pedido.');
    }
};
