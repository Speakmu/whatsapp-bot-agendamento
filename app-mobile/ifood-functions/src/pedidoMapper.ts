// ============================================================
//  Converte o payload de pedido do iFood (GET /order/v1.0/orders/{id}) pro
//  formato do doc `pedidos` que os outros canais (app, bot, balcão) já
//  gravam no Firestore — ver backend-bot/app.py (_montar_itens_pedido /
//  registrar_pedido) e dashboard/public/baixa-estoque.js (resolverFicha),
//  que exigem `id` (do cardápio) + `quantidade` em cada item pra baixar
//  o estoque automaticamente.
// ============================================================
import * as admin from 'firebase-admin';

interface ItemCardapio {
  id: string;
  nome: string;
  nomeExibicao: string;
  nomeNormalizado: string;
}

export interface ItemPedido {
  id?: string;
  nome: string;
  nome_exibicao: string;
  quantidade: number;
  preco_unitario: number;
  preco: number;
}

export interface PedidoMapeado {
  origem: string;
  ifood_order_id: string;
  data_formatada: string;
  endereco: string;
  bairro: string | null;
  tipo_entrega: 'ENTREGA' | 'RETIRADA';
  forma_pagamento: string;
  hora_pedido: admin.firestore.FieldValue;
  itens: ItemPedido[];
  nome_cliente: string;
  pagamento_id: string;
  pontos_gerados: number;
  status: string;
  telefone_cliente: string;
  usuario_id: string;
  valor_total: number;
  taxa_entrega: number;
}

function normalizar(texto: string): string {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(new RegExp('[̀-ͯ]', 'g'), '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
}

// Distância de Levenshtein simples, o bastante pra achar o item mais
// parecido do cardápio quando não há match exato de nome.
function similaridade(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const distancia = dp[m][n];
  return 1 - distancia / Math.max(m, n);
}

const LIMIAR_FUZZY = 0.65;

export async function carregarIndiceCardapio(db: admin.firestore.Firestore): Promise<ItemCardapio[]> {
  const snap = await db.collection('cardapio').get();
  return snap.docs.map((doc) => {
    const d = doc.data() as any;
    const nome = String(d.nome || '');
    const nomeExibicao = String(d.nome_exibicao || d.nome || '');
    return { id: doc.id, nome, nomeExibicao, nomeNormalizado: normalizar(nomeExibicao || nome) };
  });
}

function resolverItemCardapio(nomeIfood: string, indice: ItemCardapio[]): ItemCardapio | null {
  const alvo = normalizar(nomeIfood);
  if (!alvo) return null;

  const exato = indice.find((item) => item.nomeNormalizado === alvo);
  if (exato) return exato;

  let melhor: { item: ItemCardapio; score: number } | null = null;
  for (const item of indice) {
    const score = similaridade(alvo, item.nomeNormalizado);
    if (score >= LIMIAR_FUZZY && (!melhor || score > melhor.score)) melhor = { item, score };
  }
  return melhor ? melhor.item : null;
}

function mapearTipoEntrega(orderPayload: any): 'ENTREGA' | 'RETIRADA' {
  const tipo = String(orderPayload?.orderType || '').toUpperCase();
  return tipo === 'TAKEOUT' ? 'RETIRADA' : 'ENTREGA';
}

function mapearFormaPagamento(orderPayload: any): string {
  const metodos = orderPayload?.payments?.methods || [];
  const primeiro = metodos[0]?.method || metodos[0]?.type;
  return String(primeiro || 'IFOOD').toUpperCase();
}

function mapearEndereco(orderPayload: any): { endereco: string; bairro: string | null } {
  const dest = orderPayload?.delivery?.deliveryAddress;
  if (!dest) return { endereco: '', bairro: null };
  const partes = [dest.streetName, dest.streetNumber, dest.complement, dest.reference]
    .filter(Boolean)
    .join(', ');
  return { endereco: partes, bairro: dest.neighborhood || null };
}

export function mapearItens(orderPayload: any, indice: ItemCardapio[]): ItemPedido[] {
  const itens = orderPayload?.items || [];
  return itens.map((item: any) => {
    const nomeIfood = String(item.name || '');
    const resolvido = resolverItemCardapio(nomeIfood, indice);
    const quantidade = Number(item.quantity || 1);
    const precoUnitario = Number(item.unitPrice || item.price || 0);
    const precoTotal = Number(item.totalPrice ?? precoUnitario * quantidade);

    const itemMapeado: ItemPedido = {
      nome: nomeIfood,
      nome_exibicao: resolvido?.nomeExibicao || nomeIfood,
      quantidade,
      preco_unitario: precoUnitario,
      preco: precoTotal,
    };
    if (resolvido) itemMapeado.id = resolvido.id;
    else console.warn(`[ifood] item não encontrado no cardápio, baixa de estoque não vai reconhecer por id: "${nomeIfood}"`);
    return itemMapeado;
  });
}

export function mapearPedido(orderPayload: any, indice: ItemCardapio[]): PedidoMapeado {
  const { endereco, bairro } = mapearEndereco(orderPayload);
  const orderId = String(orderPayload.id);
  const agora = new Date();

  return {
    origem: 'IFOOD',
    ifood_order_id: orderId,
    data_formatada: agora.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
    endereco,
    bairro,
    tipo_entrega: mapearTipoEntrega(orderPayload),
    forma_pagamento: mapearFormaPagamento(orderPayload),
    hora_pedido: admin.firestore.FieldValue.serverTimestamp(),
    itens: mapearItens(orderPayload, indice),
    nome_cliente: String(orderPayload?.customer?.name || 'Cliente iFood'),
    pagamento_id: orderId,
    pontos_gerados: 0,
    status: 'PENDENTE_PREPARO',
    telefone_cliente: String(orderPayload?.customer?.phone?.number || ''),
    usuario_id: `ifood_${orderId}`,
    valor_total: Number(orderPayload?.total?.orderAmount || 0),
    taxa_entrega: Number(orderPayload?.total?.deliveryFee || 0),
  };
}
