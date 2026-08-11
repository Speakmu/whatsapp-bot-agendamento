import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';
import { firebaseConfig } from '../firebaseConfig';

if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
export const finalizarPedido = async ({
    carrinho,
    usuarioId,
    nome,
    telefone,
    endereco,
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

    // Última checagem de disponibilidade antes de gravar. O carrinho é
    // montado a partir do cardápio carregado quando a tela abriu — se um
    // item esgotar (disponivel ou disponivel_online) enquanto o cliente já
    // estava com ele no carrinho, sem isso o pedido seria gravado do mesmo
    // jeito, igual ao bot corrigia mas o app ainda não.
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
        return;
    }

    // Montagem do objeto EXATAMENTE como o seu app.js (painel) espera
    const pedido = {
        origem: "APP",
        usuario_id: usuarioId,
        nome_cliente: nome,
        telefone: telefone,
        tipo_entrega: tipoEntrega === 'retirada' ? 'RETIRADA' : 'ENTREGA',
        endereco: tipoEntrega === 'retirada' ? 'Retirada no balcão' : endereco,

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