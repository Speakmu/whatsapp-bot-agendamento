import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import { Image } from 'expo-image';
import * as SecureStore from 'expo-secure-store';
import firebase from 'firebase/compat/app';
import 'firebase/compat/auth';
import 'firebase/compat/firestore';
import {
  addDoc,
  collection,
  doc,
  getDocs,
  getFirestore,
  increment,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where
} from 'firebase/firestore';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert, FlatList, Keyboard, KeyboardAvoidingView, Modal, Platform,
  ScrollView,
  StatusBar, StyleSheet, Text, TextInput, TouchableOpacity,
  View
} from 'react-native';
import {
  SafeAreaProvider,
  useSafeAreaInsets
} from 'react-native-safe-area-context';
import { finalizarPedido, checarDisponibilidadeCarrinho } from '../services/pedidoService';
import { firebaseConfig } from '../firebaseConfig';
import { clientConfig } from '../clientConfig';

// --- CONFIGURAÇÃO FIREBASE (centralizada em firebaseConfig.ts) ---
if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const dbModular = getFirestore(firebase.app() as any); // <--- ADICIONE ISTO PARA O CÓDIGO NOVO
const BRAND_GREEN = '#174e2a';
const BRAND_WHITE = '#ffffff';
const BRAND_NAME = 'Lileamar Salgados';
const BRAND_LOGO = require('../assets/images/lileamar-logo.jpeg');

// Identifica o payment_method_id (visa/master/...) pelo prefixo do número —
// o endpoint payment_methods/search?bin= do Mercado Pago não filtra de
// verdade com essa credencial (testado: devolve o catálogo inteiro, sempre
// os mesmos 79 resultados, com ou sem o parâmetro bin), então a bandeira
// tem que ser detectada localmente antes de cobrar via API direta.
function detectarPaymentMethodId(numero: string): string | null {
  const n = numero.replace(/\D/g, '');
  if (/^4/.test(n)) return 'visa';
  if (/^5[1-5]/.test(n) || /^2(2[2-9]|[3-6]\d|7[01])/.test(n)) return 'master';
  if (/^3[47]/.test(n)) return 'amex';
  if (/^(4011|4312|4389|4514|4573|6277|6362|6363|650[35]|6516|6550)/.test(n)) return 'elo';
  if (/^(606282|3841|637)/.test(n)) return 'hipercard';
  return null;
}

// Estilos de identidade configuráveis no GestorChef (Marketing & App)
const FONT_STYLE_MAP: Record<string, { fontFamily?: string; fontWeight?: any; fontStyle?: any }> = {
  italico: { fontFamily: Platform.OS === 'ios' ? 'Snell Roundhand' : 'serif', fontStyle: 'italic', fontWeight: '700' },
  classico: { fontFamily: 'serif', fontWeight: '700' },
  moderno: { fontFamily: Platform.OS === 'ios' ? 'System' : 'sans-serif', fontWeight: '800' },
  condensado: { fontFamily: Platform.OS === 'ios' ? 'System' : 'sans-serif-condensed', fontWeight: '700' },
};
const FONT_SIZE_MAP: Record<string, number> = { pequeno: 22, medio: 28, grande: 34 };

// --- Horário de funcionamento (configurado em configuracoes/bot no GestorChef) ---
// Mesma lógica do backend-bot/app.py (verificar_horario_funcionamento), pra
// app e bot do WhatsApp sempre concordarem se a loja está aberta ou não.
const NOMES_DIAS_SEMANA: Record<string, string> = { seg: 'Segunda', ter: 'Terça', qua: 'Quarta', qui: 'Quinta', sex: 'Sexta', sab: 'Sábado', dom: 'Domingo' };
const ORDEM_DIAS_SEMANA_JS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab']; // Date.getDay(): 0 = domingo

function calcularHorarioFuncionamento(horarioCfg: any): { aberto: boolean; texto: string } {
  const dias = (horarioCfg && horarioCfg.dias) || {};
  const partes: string[] = [];
  ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'].forEach(chave => {
    const d = dias[chave];
    if (d && d.aberto && d.abre && d.fecha) partes.push(`${NOMES_DIAS_SEMANA[chave]} ${d.abre}-${d.fecha}`);
  });
  const texto = partes.length ? partes.join('; ') : 'horário a confirmar';

  if (!horarioCfg || !horarioCfg.ativo) return { aberto: true, texto };

  const agora = new Date();
  const diaCfg = dias[ORDEM_DIAS_SEMANA_JS[agora.getDay()]];
  if (!diaCfg || !diaCfg.aberto) return { aberto: false, texto };

  const abre = diaCfg.abre, fecha = diaCfg.fecha;
  if (!abre || !fecha) return { aberto: true, texto };

  const [h1, m1] = abre.split(':').map(Number);
  const [h2, m2] = fecha.split(':').map(Number);
  const minutosAgora = agora.getHours() * 60 + agora.getMinutes();
  const minutosAbre = h1 * 60 + m1;
  const minutosFecha = h2 * 60 + m2;
  const dentro = minutosFecha <= minutosAbre
    ? (minutosAgora >= minutosAbre || minutosAgora < minutosFecha) // fecha depois da meia-noite
    : (minutosAgora >= minutosAbre && minutosAgora < minutosFecha);
  return { aberto: dentro, texto };
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppCliente />
    </SafeAreaProvider>
  );
}
interface Produto {
  id: string;
  nome: string;
  nome_exibicao?: string;
  preco: number | string;
  imagem_url?: string;
  ingredientes?: string;
}
interface SacolaProps {
  carrinho: any[];
  setCarrinho: React.Dispatch<React.SetStateAction<any[]>>;
  nome: string;
  setNome: (t: string) => void;
  telefone: string;
  setTelefone: (t: string) => void;
  endereco: string;
  setEndereco: (t: string) => void;
  bairro: string;
  setBairro: (t: string) => void;
  bairrosEntrega: string[];
  taxaEntrega: number;
  metodoPagamento: string;
  setMetodoPagamento: (t: string) => void;
  tipoEntrega: string;
  setTipoEntrega: (t: string) => void;
  calcularTotal: () => string;
  verificarOuCadastrar: () => void;
  carregandoLogin: boolean;
  insets: any;
  styles: any;
  usuarioId: string | undefined;
  setAbaAtiva: (aba: string) => void;
  finalizarPedido: (dados: any) => void;
  iniciarPagamentoMercadoPago: () => void;
  processarPagamentoAPI: (dados: any) => void;
  setModalCartaoVisivel: (v: boolean) => void;
  processarPagamentoPix: () => void;
  tecladoVisivel: boolean;
  cupom?: string;
  setCupom?: (t: string) => void;
  aplicarCupom?: () => void;
  cupomAplicado?: any;
  lojaFechada?: boolean;
  horarioTexto?: string;
  calcularSubtotal?: () => number;
  calcularDesconto?: () => number;
  corMarca?: string;
  usarPontos?: boolean;
  setUsarPontos?: (v: boolean) => void;
  podeResgatar?: boolean;
  pontosPerfil?: number;
  calcularDescontoResgate?: () => number;
  pontosResgatados?: number;
}

interface PedidosProps {
  meusPedidos: any[];
  insets: any;
  styles: any;
  getCorStatus: (status: string) => string;
}
const SecaoPedidos = ({ meusPedidos, insets, styles, getCorStatus }: PedidosProps) => {
  return (
    <View style={{ flex: 1, backgroundColor: '#f9f9f9', paddingTop: insets.top }}>
      <Text style={[styles.tituloSecao, { margin: 15 }]}>Meus Pedidos 📋</Text>

      <FlatList
        data={meusPedidos}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => {
          // --- LÓGICA DE RECUPERAÇÃO DE DADOS ---
          // Tentamos pegar o array novo 'itens' ou o antigo 'itens_pedido'
          const listaItens = item.itens || item.itens_pedido;
          const valorExibicao = item.valor_total || item.total;
          // --------------------------------------

          return (
            <View style={styles.cardPedido}>
              <View style={styles.linhaPedido}>
                <Text style={styles.idPedido}>Pedido #{item.id.slice(-4)}</Text>
                <Text style={[styles.statusBadge, { backgroundColor: getCorStatus(item.status) }]}>
                  {typeof item.status === 'string' ? item.status.replace(/_/g, ' ') : 'PENDENTE'}
                </Text>
              </View>

              <View style={{ marginVertical: 8 }}>
                {Array.isArray(listaItens) ? (
                  // Caso seja um ARRAY (Novo formato: [{nome: 'Pizza', preco: 10}])
                  listaItens.map((subItem: any, index: number) => {
                    const nomeExibicao = typeof subItem === 'object' && subItem !== null
                      ? (subItem.nome || subItem.nome_exibicao)
                      : String(subItem);

                    return (
                      <Text key={index} style={styles.itensPedido}>
                        • {nomeExibicao}
                      </Text>
                    );
                  })
                ) : (
                  // Caso seja uma STRING (Formato antigo: "1x Pizza, 2x Coca")
                  <Text style={styles.itensPedido}>
                    {typeof listaItens === 'string'
                      ? listaItens
                      : 'Itens em processamento...'}
                  </Text>
                )}
              </View>

              <Text style={styles.totalPedido}>
                Total: R$ {typeof valorExibicao === 'number' ? valorExibicao.toFixed(2) : valorExibicao}
              </Text>
            </View>
          );
        }}
        ListEmptyComponent={
          <View style={{ marginTop: 50, alignItems: 'center' }}>
            <Text style={{ color: '#999' }}>Você ainda não fez pedidos.</Text>
          </View>
        }
      />
    </View>
  );
};
// --- COMPONENTE SEÇÃO SACOLA (MEMORIZADO) ---
const SecaoSacola = ({
  carrinho, setCarrinho, nome, setNome, telefone, setTelefone,
  endereco, setEndereco, bairro, setBairro, bairrosEntrega = [], taxaEntrega = 0,
  metodoPagamento, setMetodoPagamento,
  tipoEntrega, setTipoEntrega,
  calcularTotal, carregandoLogin, insets, styles, usuarioId,
  setAbaAtiva, finalizarPedido,
  processarPagamentoAPI,
  setModalCartaoVisivel,
  processarPagamentoPix,
  tecladoVisivel,
  cupom, setCupom, aplicarCupom, cupomAplicado,
  calcularSubtotal, calcularDesconto, corMarca = BRAND_GREEN,
  usarPontos, setUsarPontos, podeResgatar, pontosPerfil, calcularDescontoResgate, pontosResgatados = 0,
  lojaFechada = false, horarioTexto = ''
}: SacolaProps) => {

  // ESTADO LOCAL PARA OS DADOS DO CARTÃO
  const [dadosCartao, setDadosCartao] = useState({
    numero: '',
    validade: '',
    cvv: '',
    nomeTitular: '',
    cpf: ''
  });

  // Seletor de bairro (modal com busca) — lista pode ter dezenas de bairros,
  // então em vez de chips preenchendo a tela toda, mostra um campo tipo
  // dropdown que abre uma lista pesquisável.
  const [modalBairroVisivel, setModalBairroVisivel] = useState(false);
  const [buscaBairro, setBuscaBairro] = useState('');
  const bairrosFiltrados = bairrosEntrega.filter((b: string) =>
    b.toLowerCase().includes(buscaBairro.trim().toLowerCase())
  );

  return (

    <View style={{ flex: 1 }}>
      {/* HEADER */}
      <View style={[{ paddingTop: insets.top }]}>
        <Text style={[styles.tituloSecao, { margin: 15 }]}>Minha Sacola 🛍️</Text>
      </View>

      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 15, paddingBottom: 220 }}
      >
        {/* LISTA DE ITENS */}
        {carrinho.map(item => (
          <View key={item.id_carrinho} style={styles.cardItemCarrinho}>
            <View style={{ flex: 1 }}>
              <Text style={styles.nomeItemCarrinho}>{item.nome_exibicao || item.nome}</Text>
              <Text style={styles.precoItemCarrinho}>R$ {Number(item.preco).toFixed(2)}</Text>
            </View>
            <TouchableOpacity
              onPress={() => setCarrinho(carrinho.filter(i => i.id_carrinho !== item.id_carrinho))}
              style={styles.btnRemover}
            >
              <Text style={{ color: BRAND_GREEN, fontWeight: 'bold' }}>Remover</Text>
            </TouchableOpacity>
          </View>
        ))}

        {carrinho.length > 0 && (
          <View style={styles.secaoCheckout}>
            <Text style={styles.tituloCheckout}>Confirme seus Dados</Text>

            <Text style={styles.labelInput}>Seu Nome</Text>
            <TextInput style={styles.inputCheckout} value={nome} onChangeText={setNome} placeholder="Nome do cliente" />

            <Text style={styles.labelInput}>Telefone</Text>
            <TextInput
              style={styles.inputCheckout}
              value={telefone}
              onChangeText={setTelefone}
              keyboardType="phone-pad"
              placeholder="(00) 00000-0000"
            />

            {/* TIPO DE PEDIDO: RETIRADA x ENTREGA */}
            <Text style={[styles.tituloCheckout, { marginTop: 20 }]}>Tipo de pedido</Text>
            <View style={styles.gridPagamento}>
              {['entrega', 'retirada'].map(tipo => (
                <TouchableOpacity
                  key={tipo}
                  style={[styles.btnPagamento, tipoEntrega === tipo && styles.btnPagamentoAtivo]}
                  onPress={() => setTipoEntrega(tipo)}
                >
                  <Text style={[styles.txtPagamento, tipoEntrega === tipo && styles.txtPagamentoAtivo]}>
                    {tipo === 'entrega' ? '🛵 Entrega' : '🏪 Retirada'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {tipoEntrega === 'entrega' && (
              <>
                {bairrosEntrega.length > 0 && (
                  <>
                    <Text style={[styles.labelInput, { marginTop: 16 }]}>Bairro</Text>
                    <TouchableOpacity
                      onPress={() => { setBuscaBairro(''); setModalBairroVisivel(true); }}
                      style={[styles.inputCheckout, { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }]}
                    >
                      <Text style={{ color: bairro ? '#2d3436' : '#999', fontSize: 15 }}>
                        {bairro || 'Selecione o bairro'}
                      </Text>
                      <Text style={{ color: '#999' }}>▾</Text>
                    </TouchableOpacity>
                    {taxaEntrega > 0 && (
                      <Text style={{ fontSize: 12, color: '#888', marginTop: 6 }}>
                        Taxa de entrega: R$ {taxaEntrega.toFixed(2)}
                      </Text>
                    )}
                  </>
                )}
                <Text style={[styles.labelInput, { marginTop: 16 }]}>Rua e número</Text>
                <TextInput
                  style={[styles.inputCheckout, { height: 60 }]}
                  value={endereco}
                  onChangeText={setEndereco}
                  multiline
                  placeholder="Rua, número, complemento..."
                />
              </>
            )}

            {/* SELEÇÃO DE PAGAMENTO */}
            <Text style={[styles.tituloCheckout, { marginTop: 20 }]}>Pagamento</Text>
            <View style={styles.gridPagamento}>
              {['entrega', 'pix', 'cartao'].map(tipo => (
                <TouchableOpacity
                  key={tipo}
                  style={[styles.btnPagamento, metodoPagamento === tipo && styles.btnPagamentoAtivo]}
                  onPress={() => setMetodoPagamento(tipo)}
                >
                  <Text style={[styles.txtPagamento, metodoPagamento === tipo && styles.txtPagamentoAtivo]}>
                    {tipo === 'entrega'
                      ? (tipoEntrega === 'retirada' ? '💵 Na retirada' : '💵 Na entrega')
                      : tipo === 'pix' ? '⚡ PIX' : '💳 Cartão'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* CUPOM DE DESCONTO */}
            <Text style={[styles.tituloCheckout, { marginTop: 20 }]}>Cupom de desconto</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TextInput
                style={[styles.inputCheckout, { flex: 1, textTransform: 'uppercase' }]}
                value={cupom}
                onChangeText={setCupom}
                autoCapitalize="characters"
                placeholder="Digite o código"
                editable={!cupomAplicado}
              />
              <TouchableOpacity
                onPress={aplicarCupom}
                style={{ backgroundColor: corMarca, paddingHorizontal: 18, borderRadius: 8, justifyContent: 'center' }}
              >
                <Text style={{ color: '#fff', fontWeight: 'bold' }}>{cupomAplicado ? '✓' : 'Aplicar'}</Text>
              </TouchableOpacity>
            </View>
            {cupomAplicado && (
              <Text style={{ color: BRAND_GREEN, marginTop: 6, fontWeight: '600' }}>
                Cupom {cupomAplicado.codigo} aplicado!
              </Text>
            )}

            {/* RESGATE DE PONTOS (fidelidade) */}
            {podeResgatar && (
              <TouchableOpacity
                onPress={() => setUsarPontos && setUsarPontos(!usarPontos)}
                style={{
                  marginTop: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                  padding: 12, borderWidth: 1, borderColor: usarPontos ? BRAND_GREEN : '#ddd',
                  borderRadius: 8, backgroundColor: usarPontos ? '#eafaf1' : '#fff'
                }}
              >
                <Text style={{ fontWeight: '600', color: '#2d3436' }}>⭐ Usar meus {pontosPerfil} pontos</Text>
                <Text style={{ fontWeight: 'bold', color: usarPontos ? BRAND_GREEN : '#999' }}>
                  {usarPontos ? 'Ativado ✓' : 'Ativar'}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </ScrollView>

      {/* RESUMO FIXO COM BOTÃO DINÂMICO */}
      {carrinho.length > 0 && (
        <View style={[
          styles.resumoPedido,
          {
            // Se houver insets (entalhe inferior), usamos ele. 
            // Se não, usamos apenas 10 de respiro.
            paddingBottom: insets.bottom > 0 ? insets.bottom : 10
          }
        ]}>
          {cupomAplicado && calcularDesconto && calcularDesconto() > 0 && (
            <View style={[styles.linhaTotal, { marginBottom: 4 }]}>
              <Text style={{ fontSize: 14, color: BRAND_GREEN }}>Desconto ({cupomAplicado.codigo})</Text>
              <Text style={{ fontSize: 14, color: BRAND_GREEN, fontWeight: '600' }}>
                - R$ {calcularDesconto().toFixed(2)}
              </Text>
            </View>
          )}
          {usarPontos && calcularDescontoResgate && calcularDescontoResgate() > 0 && (
            <View style={[styles.linhaTotal, { marginBottom: 4 }]}>
              <Text style={{ fontSize: 14, color: BRAND_GREEN }}>Pontos resgatados ({pontosResgatados})</Text>
              <Text style={{ fontSize: 14, color: BRAND_GREEN, fontWeight: '600' }}>
                - R$ {calcularDescontoResgate().toFixed(2)}
              </Text>
            </View>
          )}
          {tipoEntrega === 'entrega' && taxaEntrega > 0 && (
            <View style={[styles.linhaTotal, { marginBottom: 4 }]}>
              <Text style={{ fontSize: 14, color: '#888' }}>Taxa de entrega</Text>
              <Text style={{ fontSize: 14, color: '#888', fontWeight: '600' }}>
                + R$ {taxaEntrega.toFixed(2)}
              </Text>
            </View>
          )}
          <View style={styles.linhaTotal}>
            <Text style={{ fontSize: 16 }}>Total do pedido</Text>
            <Text style={{ fontSize: 22, fontWeight: 'bold', color: '#2d3436' }}>
              R$ {calcularTotal()}
            </Text>
          </View>

          {!tecladoVisivel && (
            <TouchableOpacity
              style={[
                styles.btnFinalizarPedido,
                {
                  backgroundColor: metodoPagamento === 'cartao' ? '#197ddb' : corMarca,
                  // 🔥 REMOVA ou reduza drasticamente o marginBottom
                  marginBottom: 0
                }
              ]}
              disabled={carregandoLogin || lojaFechada}
              onPress={() => {
                if (lojaFechada) {
                  Alert.alert(
                    'Estamos fechados',
                    `No momento não estamos recebendo pedidos.${horarioTexto ? `\n\nHorário de funcionamento: ${horarioTexto}` : ''}`
                  );
                  return;
                }
                if (tipoEntrega === 'entrega' && bairrosEntrega.length > 0 && !bairro) {
                  Alert.alert('Bairro', 'Selecione o bairro da entrega.');
                  return;
                }
                if (metodoPagamento === 'cartao') {
                  setModalCartaoVisivel(true);
                } else if (metodoPagamento === 'pix') {
                  processarPagamentoPix();
                } else {
                  finalizarPedido({ carrinho, usuarioId, nome, telefone, endereco, bairro, taxaEntrega, metodoPagamento, tipoEntrega, calcularTotal, setCarrinho, setAbaAtiva, pontosResgatados });
                }
              }}
            >
              {carregandoLogin ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.btnFinalizarTxt}>
                  {metodoPagamento === 'cartao' ? 'Confirmar e Pagar Agora' :
                    metodoPagamento === 'pix' ? 'Gerar Código PIX' : 'Finalizar Pedido'}
                </Text>
              )}
            </TouchableOpacity>
          )}
        </View>
      )}

      <Modal
        visible={modalBairroVisivel}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setModalBairroVisivel(false)}
      >
        <View style={styles.overlayModal}>
          <View style={[styles.cardModal, { maxHeight: '75%', padding: 16 }]}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <Text style={styles.tituloCheckout}>Selecione o bairro</Text>
              <TouchableOpacity onPress={() => setModalBairroVisivel(false)}>
                <Text style={{ fontSize: 16, fontWeight: 'bold', color: '#2d3436' }}>✕</Text>
              </TouchableOpacity>
            </View>
            <TextInput
              style={styles.inputCheckout}
              value={buscaBairro}
              onChangeText={setBuscaBairro}
              placeholder="Buscar bairro..."
              autoFocus
            />
            <FlatList
              data={bairrosFiltrados}
              keyExtractor={(item) => item}
              style={{ marginTop: 8 }}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={
                <Text style={{ color: '#999', textAlign: 'center', padding: 16 }}>Nenhum bairro encontrado.</Text>
              }
              renderItem={({ item }) => (
                <TouchableOpacity
                  onPress={() => { setBairro(item); setModalBairroVisivel(false); }}
                  style={{
                    paddingVertical: 12, paddingHorizontal: 4,
                    borderBottomWidth: 1, borderBottomColor: '#eee',
                    backgroundColor: bairro === item ? '#f5f5f5' : 'transparent'
                  }}
                >
                  <Text style={{ fontSize: 15, color: bairro === item ? corMarca : '#2d3436', fontWeight: bairro === item ? '700' : '400' }}>
                    {item}
                  </Text>
                </TouchableOpacity>
              )}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
};
interface HomeProps {
  produtosFiltrados: any[];
  nome: string;
  busca: string;
  setBusca: (t: string) => void;
  executarBusca: () => void;
  adicionarAoCarrinho: (p: any) => void;
  insets: any;
  styles: any;
  pontosPorReal?: number;
  fidelidadeAtiva?: boolean;
  nomeApp?: string;
  corMarca?: string;
  categorias?: string[];
  categoriaAtiva?: string;
  setCategoriaAtiva?: (c: string) => void;
  usaLogotipo?: boolean;
  logoUrl?: string;
  estiloFonteMarca?: any;
  tamanhoFonteMarca?: number;
  bannerAtivo?: boolean;
  bannerTexto?: string;
  bannerCor?: string;
  destaques?: any[];
  heroUrl?: string;
  corFundo?: string;
  colunasVitrine?: number;
  tamanhoImagemVitrine?: string;
  lojaFechada?: boolean;
  horarioTexto?: string;
}

// --- COMPONENTE DE IMAGEM COM FALLBACK ---
// cachePolicy="memory-disk": evita rebaixar da rede fotos já vistas ao trocar
// de categoria/voltar pra "Todos" — crítico em Android, que não cacheia em
// disco por padrão como o Image nativo faz no iOS.
const ProdutoImagem = React.memo(({ uri, style }: { uri?: string; style: any }) => {
  const [erro, setErro] = React.useState(false);
  const temUri = uri && uri.trim() !== '' && !erro;
  if (temUri) {
    return (
      <Image
        source={{ uri }}
        style={style}
        cachePolicy="memory-disk"
        transition={150}
        onError={() => setErro(true)}
      />
    );
  }
  return (
    <View style={[style, { backgroundColor: '#f0f0f0', justifyContent: 'center', alignItems: 'center' }]}>
      <Text style={{ fontSize: 32 }}>🍕</Text>
    </View>
  );
});
ProdutoImagem.displayName = 'ProdutoImagem';

// Tamanhos de imagem configuráveis no GestorChef (Marketing & App → Layout da vitrine)
const IMG_TAMANHO_LISTA: Record<string, number> = { pequena: 64, media: 88, grande: 120 };
const IMG_TAMANHO_GRADE: Record<string, number> = { pequena: 90, media: 130, grande: 170 };
// Largura do card por quantidade de itens por linha (grade)
const COL_LARGURA: Record<number, string> = { 2: '48%', 3: '31%', 4: '23%' };

// --- CARTÃO DE PRODUTO (usado na lista de resultados e nas vitrines de destaque) ---
// React.memo + onAbrir/onAdicionar recebendo o item (em vez de closures novas por
// render no chamador) — evita re-render de todos os cards a cada troca de categoria.
const CartaoProduto = React.memo(({ item, styles, corMarca, pontos, onAbrir, onAdicionar, colunas = 1, tamanhoImagem = 'media' }: {
  item: any; styles: any; corMarca: string; pontos: number; onAbrir: (item: any) => void; onAdicionar: (item: any) => void;
  colunas?: number; tamanhoImagem?: string;
}) => {
  const abrir = () => onAbrir(item);
  const adicionar = () => onAdicionar(item);

  if (colunas > 1) {
    const altura = IMG_TAMANHO_GRADE[tamanhoImagem] || IMG_TAMANHO_GRADE.media;
    const largura = COL_LARGURA[colunas] || COL_LARGURA[2];
    return (
      <TouchableOpacity activeOpacity={0.85} style={[styles.cardGrade, { width: largura }]} onPress={abrir}>
        <ProdutoImagem uri={item.imagem_url} style={[styles.fotoGrade, { height: altura }]} />
        <Text style={styles.nomeGrade} numberOfLines={1}>{item.nome_exibicao || item.nome}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
          <Text style={styles.precoGrade}>R$ {Number(item.preco).toFixed(2)}</Text>
          <TouchableOpacity style={[styles.btnAdicionarGrade, { borderColor: corMarca }]} onPress={adicionar}>
            <Text style={[styles.btnAdicionarTxt, { color: corMarca, fontSize: 15 }]}>+</Text>
          </TouchableOpacity>
        </View>
        {pontos > 0 && (
          <View style={[styles.seloPontos, { marginTop: 4, alignSelf: 'flex-start' }]}>
            <Text style={styles.seloPontosTxt}>⭐ +{pontos} pts</Text>
          </View>
        )}
      </TouchableOpacity>
    );
  }

  const tamanho = IMG_TAMANHO_LISTA[tamanhoImagem] || IMG_TAMANHO_LISTA.media;
  return (
    <TouchableOpacity activeOpacity={0.85} style={styles.cardProdutoHorizontal} onPress={abrir}>
      <ProdutoImagem uri={item.imagem_url} style={[styles.fotoProdutoEsquerda, { width: tamanho, height: tamanho }]} />
      <View style={styles.infoProduto}>
        <Text style={styles.nomeProduto}>{item.nome_exibicao || item.nome}</Text>
        <Text style={styles.descricaoProduto} numberOfLines={2}>
          {item.descricao || item.ingredientes}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 5, flexWrap: 'wrap', gap: 6 }}>
          <Text style={styles.precoProduto}>R$ {Number(item.preco).toFixed(2)}</Text>
          {pontos > 0 && (
            <View style={styles.seloPontos}>
              <Text style={styles.seloPontosTxt}>⭐ +{pontos} pts</Text>
            </View>
          )}
        </View>
      </View>
      <TouchableOpacity style={[styles.btnAdicionar, { borderColor: corMarca }]} onPress={adicionar}>
        <Text style={[styles.btnAdicionarTxt, { color: corMarca }]}>+</Text>
      </TouchableOpacity>
    </TouchableOpacity>
  );
});
CartaoProduto.displayName = 'CartaoProduto';

// --- COMPONENTE SEÇÃO HOME ---
const SecaoHome = React.memo(({
  produtosFiltrados, nome, busca, setBusca,
  executarBusca, adicionarAoCarrinho, insets, styles,
  pontosPorReal = 0, fidelidadeAtiva = true,
  nomeApp = BRAND_NAME, corMarca = BRAND_GREEN,
  categorias = ['Todos'], categoriaAtiva = 'Todos', setCategoriaAtiva,
  usaLogotipo = false, logoUrl, estiloFonteMarca = FONT_STYLE_MAP.italico, tamanhoFonteMarca = FONT_SIZE_MAP.grande,
  bannerAtivo = true, bannerTexto = 'Peça agora e ganhe pontos de fidelidade!', bannerCor = '#0f3d1e',
  destaques = [], heroUrl, corFundo = '#ffffff',
  colunasVitrine = 1, tamanhoImagemVitrine = 'media',
  lojaFechada = false, horarioTexto = ''
}: HomeProps) => {
  const [produtoDetalhe, setProdutoDetalhe] = useState<any>(null);

  const calcularPontosItem = useCallback((item: any) => {
    if (fidelidadeAtiva === false) return 0;
    const temPontosProprios = item.pontos_fidelidade !== undefined && item.pontos_fidelidade !== null;
    return temPontosProprios
      ? Number(item.pontos_fidelidade) || 0
      : Math.floor((Number(item.preco) || 0) * pontosPorReal);
  }, [fidelidadeAtiva, pontosPorReal]);

  // Identidade estável pro renderItem da FlatList: evita recriar a função (e o
  // efeito cascata de perder o React.memo dos cards) a cada troca de categoria.
  const renderCartaoProduto = useCallback(({ item }: { item: any }) => (
    <CartaoProduto
      item={item}
      styles={styles}
      corMarca={corMarca}
      pontos={calcularPontosItem(item)}
      onAbrir={setProdutoDetalhe}
      onAdicionar={adicionarAoCarrinho}
      colunas={colunasVitrine}
      tamanhoImagem={tamanhoImagemVitrine}
    />
  ), [styles, corMarca, calcularPontosItem, adicionarAoCarrinho, colunasVitrine, tamanhoImagemVitrine]);

  const mostrarVitrine = busca.trim() === '' && categoriaAtiva === 'Todos';

  return (
    <>
    <FlatList
      key={colunasVitrine}
      numColumns={colunasVitrine}
      columnWrapperStyle={colunasVitrine > 1 ? { justifyContent: 'space-between', paddingHorizontal: 10 } : undefined}
      style={{ flex: 1, backgroundColor: corFundo }}
      data={mostrarVitrine ? [] : produtosFiltrados}
      keyExtractor={(item) => item.id}
      ListHeaderComponent={
        <View>
          {/* ÁREA COLORIDA DO HEADER */}
          <View style={[styles.topoHome, { backgroundColor: corMarca, paddingTop: insets.top > 0 ? insets.top : 20 }]}>
            {/* Aviso de loja fechada (horário de funcionamento) — tem prioridade sobre o banner promocional */}
            {lojaFechada && (
              <View style={{ backgroundColor: '#c0392b', paddingVertical: 8, paddingHorizontal: 14 }}>
                <Text style={{ color: '#fff', fontWeight: 'bold', textAlign: 'center' }}>
                  Estamos fechados no momento{horarioTexto ? ` • ${horarioTexto}` : ''}
                </Text>
              </View>
            )}

            {/* Banner Promo */}
            {bannerAtivo && !!bannerTexto && (
              <View style={[styles.promoBanner, { backgroundColor: bannerCor }]}>
                <Text style={styles.promoBannerTxt}>{bannerTexto}</Text>
              </View>
            )}

            {/* Saudação + Logo + Notificação */}
            <View style={[styles.headerHome, { backgroundColor: corMarca }]}>
              {usaLogotipo && logoUrl ? (
                <Image source={{ uri: logoUrl }} style={styles.marcaLogoHeader} contentFit="contain" />
              ) : (
                <Text style={[styles.logoTexto, estiloFonteMarca, { fontSize: tamanhoFonteMarca }]}>{nomeApp}</Text>
              )}
              <View style={{ alignItems: 'center' }}>
                <TouchableOpacity style={styles.btnNotificacao}>
                  <Text style={{ fontSize: 20 }}>🔔</Text>
                </TouchableOpacity>
                <Text style={styles.saudacao}>Olá, {nome.split(' ')[0] || 'Cliente'}! 👋</Text>
              </View>
            </View>

            {/* Search Bar (branca sobre verde) */}
            <View style={styles.searchContainer}>
              <View style={styles.searchBarInterna}>
                <Text style={{ fontSize: 18, marginLeft: 14, marginRight: 8, color: '#999' }}>🔍</Text>
                <TextInput
                  placeholder="Pesquisar no cardápio..."
                  placeholderTextColor="#aaa"
                  style={{ flex: 1, height: 45, fontSize: 15, color: '#2d3436' }}
                  value={busca}
                  onChangeText={setBusca}
                  onSubmitEditing={executarBusca}
                  returnKeyType="search"
                  clearButtonMode="while-editing"
                />
              </View>
            </View>
          </View>

          {/* Chips de categoria */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipsContainer}
          >
            {categorias.map(cat => {
              const ativo = cat === categoriaAtiva;
              return (
                <TouchableOpacity
                  key={cat}
                  style={[styles.chip, ativo && { backgroundColor: corMarca, borderColor: corMarca }]}
                  onPress={() => setCategoriaAtiva && setCategoriaAtiva(cat)}
                >
                  <Text style={[styles.chipTxt, ativo && { color: '#fff' }]}>{cat === 'Todos' ? 'Início' : cat}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          {/* Banner principal (imagem) — primeiro bloco da vitrine */}
          {mostrarVitrine && !!heroUrl && (
            <Image source={{ uri: heroUrl }} style={styles.heroBanner} contentFit="cover" />
          )}

          {/* Vitrines de Destaques (Topo / Meio / Fundo) — só na home, sem busca/filtro */}
          {mostrarVitrine && destaques.map((grupo: any) => (
            <View key={grupo.chave}>
              <View style={[styles.faixaDestaque, { backgroundColor: grupo.cor || corMarca }]}>
                <Text style={styles.faixaDestaqueTxt}>{grupo.titulo}</Text>
              </View>
              <View style={colunasVitrine > 1
                ? { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', paddingHorizontal: 10, paddingTop: 10 }
                : { paddingTop: 10 }
              }>
                {grupo.produtos.map((p: any) => (
                  <CartaoProduto
                    key={p.id}
                    item={p}
                    styles={styles}
                    corMarca={corMarca}
                    pontos={calcularPontosItem(p)}
                    onAbrir={setProdutoDetalhe}
                    onAdicionar={adicionarAoCarrinho}
                    colunas={colunasVitrine}
                    tamanhoImagem={tamanhoImagemVitrine}
                  />
                ))}
              </View>
            </View>
          ))}

          {/* Título da seção — só aparece ao buscar ou filtrar por categoria */}
          {!mostrarVitrine && (
            <Text style={styles.secaoTitulo}>
              {busca.trim() !== '' ? `Resultados para "${busca}"` : categoriaAtiva}
            </Text>
          )}
        </View>
      }
      renderItem={renderCartaoProduto}
      contentContainerStyle={{ paddingBottom: 20, flexGrow: 1 }}
      removeClippedSubviews={true}
      initialNumToRender={8}
      maxToRenderPerBatch={8}
      windowSize={7}
    />

    <Modal
      visible={!!produtoDetalhe}
      transparent={true}
      animationType="slide"
      onRequestClose={() => setProdutoDetalhe(null)}
    >
      <View style={styles.overlayModal}>
        <View style={[styles.cardModal, { padding: 0, overflow: 'hidden' }]}>
          {produtoDetalhe && (
            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ paddingBottom: 20 + (insets.bottom > 0 ? insets.bottom : 12) }}
            >
              <View>
                <ProdutoImagem uri={produtoDetalhe.imagem_url} style={styles.fotoDetalheProduto} />
                <TouchableOpacity
                  style={styles.btnFecharDetalhe}
                  onPress={() => setProdutoDetalhe(null)}
                >
                  <Text style={{ fontSize: 16, fontWeight: 'bold', color: '#2d3436' }}>✕</Text>
                </TouchableOpacity>
              </View>

              <View style={{ padding: 20 }}>
                <Text style={styles.nomeDetalheProduto}>
                  {produtoDetalhe.nome_exibicao || produtoDetalhe.nome}
                </Text>

                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8, flexWrap: 'wrap', gap: 8 }}>
                  <Text style={[styles.precoProduto, { fontSize: 20 }]}>
                    R$ {Number(produtoDetalhe.preco).toFixed(2)}
                  </Text>
                  {(() => {
                    const ptsItem = calcularPontosItem(produtoDetalhe);
                    if (ptsItem <= 0) return null;
                    return (
                      <View style={styles.seloPontos}>
                        <Text style={styles.seloPontosTxt}>⭐ +{ptsItem} pts</Text>
                      </View>
                    );
                  })()}
                </View>

                <Text style={styles.descricaoDetalheProduto}>
                  {produtoDetalhe.descricao || produtoDetalhe.ingredientes || 'Sem descrição cadastrada.'}
                </Text>

                <TouchableOpacity
                  style={[styles.btnCadastroLargo, { backgroundColor: corMarca, marginTop: 25 }]}
                  onPress={() => {
                    adicionarAoCarrinho(produtoDetalhe);
                    setProdutoDetalhe(null);
                  }}
                >
                  <Text style={styles.btnTxtBranco}>Adicionar à sacola</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
    </>
  );
});
SecaoHome.displayName = 'SecaoHome';
interface PerfilProps {
  nome: string;
  telefone: string;
  usuarioId?: string;
  styles: any;
  onSair: () => void;
  setNome: (nome: string) => void;
  setTelefone: (tel: string) => void;
}

const SecaoPerfil = ({ nome, telefone, endereco, usuarioId, onSair, setNome, setTelefone, cpf, setCpf, pontosPerfil }: any) => {
  const [editando, setEditando] = useState(false);
  const [novoNome, setNovoNome] = useState(nome);
  const [novoTelefone, setNovoTelefone] = useState(telefone);
  const [novoCpf, setNovoCpf] = useState(cpf);

  // Sincroniza os campos se o nome mudar no banco de dados
  useEffect(() => {
    setNovoNome(nome);
    setNovoTelefone(telefone);
    setNovoCpf(cpf);
  }, [nome, telefone, cpf]);

  // Função para formatar enquanto digita
  const formatarTelefone = (txt: string) => {
    let num = txt.replace(/\D/g, '');

    // Evita erro se o usuário apagar tudo
    if (!num) return '';

    // Formato (11) 99999-9999
    if (num.length > 10) {
      return num.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
    }
    // Formato (11) 9999-9999 (Fixo)
    else if (num.length > 6) {
      return num.replace(/(\d{2})(\d{4})/, '($1) $2');
    }

    return txt;
  };

  const salvarDadosLocalmente = async (dados: any) => {
    try {
      await SecureStore.setItemAsync('dados_usuario', JSON.stringify(dados));
    } catch (e) {
      console.error("Erro ao salvar cache local", e);
    }
  };

  // Remove os dados (usado no Sair da Conta)

  const salvarAlteracoes = async () => {
    try {
      let numeroLimpo = novoTelefone.replace(/\D/g, '');
      if (numeroLimpo.length > 0 && !numeroLimpo.startsWith('55')) {
        numeroLimpo = '55' + numeroLimpo;
      }

      // 1. Atualiza no Firebase (Coleção usuários_app)
      await db.collection('usuarios_app').doc(usuarioId).update({
        nome: novoNome,
        telefone: numeroLimpo,
        cpf: novoCpf // <--- Salvando no banco
      });

      // 2. Atualiza no Cache Local (IMPORTANTE PARA O CPF APARECER)
      const novosDados = {
        nome: novoNome,
        telefone: numeroLimpo,
        endereco: endereco,
        cpf: novoCpf // <--- ADICIONE ESTA LINHA AQUI
      };

      await SecureStore.setItemAsync('dados_usuario', JSON.stringify(novosDados));

      // 3. Atualiza os estados globais para refletir na UI imediatamente
      setNome(novoNome);
      setTelefone(numeroLimpo);
      setCpf(novoCpf); // <--- Isso faz o CPF aparecer na tela na hora
      setEditando(false);

      alert("Cadastro atualizado com sucesso! ✅");
    } catch (error) {
      console.error(error);
      alert("Erro ao salvar.");
    }
  }

  return (
    <ScrollView
      contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}
      style={{ flex: 1, backgroundColor: '#f8f9fa' }}
    >
      <View style={[styles.containerPerfil, { paddingVertical: 40 }]}>

        {/* 1. CARTÃO FIDELIDADE NO TOPO DO BLOCO CENTRAL */}
        <View style={styles.containerFidelidade}>
          <View style={styles.cartaoFidelidade}>
            <View style={styles.cartaoTopo}>
              <Text style={styles.cartaoTitulo}>CLIENTE FIDELIDADE</Text>
            </View>
            <View style={styles.cartaoConteudo}>
              <Text style={styles.labelSaldo}>Seu Saldo</Text>
              <View style={styles.rowPontos}>
                <Text style={styles.valorPontosGrandes}>{pontosPerfil}</Text>
                <Text style={styles.labelPontosTexto}> pontos</Text>
              </View>
            </View>
          </View>
        </View>

        {/* 2. CARD DE IDENTIDADE (DADOS DA CONTA) */}
        <View style={[styles.cardInfo, { marginTop: 20 }]}>
          <Text style={[styles.labelPerfil, { marginBottom: 15, textAlign: 'center', letterSpacing: 1 }]}>
            IDENTIDADE DIGITAL
          </Text>

          <View style={styles.secaoIdentidade}>
            <View style={styles.avatarMini}>
              <Text style={{ fontSize: 25 }}>👤</Text>
            </View>

            <View style={styles.dadosPrincipais}>
              {editando ? (
                <TextInput
                  style={styles.inputEdicaoIdentidade}
                  value={novoNome}
                  onChangeText={setNovoNome}
                  placeholder="Nome Completo"
                />
              ) : (
                <Text style={styles.nomeIdentidade}>{nome || "Cliente"}</Text>
              )}

              <Text style={styles.sublabelIdentidade}>WhatsApp</Text>
              {editando ? (
                <TextInput
                  style={styles.inputEdicaoIdentidade}
                  value={novoTelefone}
                  onChangeText={(txt) => setNovoTelefone(formatarTelefone(txt))}
                  keyboardType="phone-pad"
                />
              ) : (
                <Text style={styles.infoIdentidade}>{telefone || "Não cadastrado"}</Text>
              )}
            </View>
          </View>

          <View style={styles.divisor} />

          <Text style={styles.sublabelIdentidade}>CPF</Text>
          {editando ? (
            <TextInput
              style={styles.inputEdicaoIdentidade}
              value={novoCpf}
              onChangeText={(txt) => setNovoCpf(txt.replace(/\D/g, ''))}
              keyboardType="numeric"
              maxLength={11}
            />
          ) : (
            <Text style={styles.valorPerfil}>
              {cpf ? cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4") : "Não informado"}
            </Text>
          )}

          {/* CONTAINER DE BOTÕES LADO A LADO */}
          <View style={{ flexDirection: 'row', marginTop: 25, gap: 10 }}>
            <TouchableOpacity
              style={[styles.btnAlterar, { flex: 1, marginTop: 0, height: 45, justifyContent: 'center' }]}
              onPress={editando ? salvarAlteracoes : () => {
                setNovoNome(nome); setNovoTelefone(telefone); setNovoCpf(cpf);
                setEditando(true);
              }}
            >
              <Text style={{ color: editando ? BRAND_GREEN : '#2980b9', fontWeight: 'bold', textAlign: 'center' }}>
                {editando ? "💾 Gravar" : "✏️ Editar"}
              </Text>
            </TouchableOpacity>

            {editando && (
              <TouchableOpacity
                style={[styles.btnAcaoIdentidade, styles.btnCancelarEdicao, { flex: 1, height: 45, justifyContent: 'center' }]}
                onPress={() => setEditando(false)}
              >
                <Text style={{ color: BRAND_GREEN, fontWeight: 'bold', textAlign: 'center' }}>
                  ✖ Cancelar
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* BOTÃO SAIR NO RODAPÉ DO CONTEÚDO */}
        <TouchableOpacity style={{ marginTop: 30 }} onPress={onSair}>
          <Text style={{ color: BRAND_GREEN, textAlign: 'center', fontWeight: '500' }}>Sair da Conta</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
};
function AppCliente() {
  // Estados de Fluxo e Navegação
  const [estaCadastrado, setEstaCadastrado] = useState(false);
  const [abaAtiva, setAbaAtiva] = useState('home'); // 'home', 'chat', 'pedidos'
  const [carregando, setCarregando] = useState(true);
  const [meusPedidos, setMeusPedidos] = useState<any[]>([]);
  const [carrinho, setCarrinho] = useState<any[]>([]);
  const insets = useSafeAreaInsets();
  const [busca, setBusca] = useState('');
  const [produtosFiltrados, setProdutosFiltrados] = useState<any[]>([]);
  const [categoriaAtiva, setCategoriaAtiva] = useState('Todos');
  const [metodoPagamento, setMetodoPagamento] = useState('entrega');
  const [tipoEntrega, setTipoEntrega] = useState('entrega'); // 'entrega' | 'retirada'
  const [carregandoLogin, setCarregandoLogin] = useState(false);
  // Dados
  const [nome, setNome] = useState('');
  const [telefone, setTelefone] = useState('');
  const [produtos, setProdutos] = useState<any[]>([]);
  const [mensagens, setMensagens] = useState<any[]>([]);
  const [input, setInput] = useState('');
  const [usuarioId, setUsuarioId] = useState<string | undefined>(undefined);
  const [endereco, setEndereco] = useState('');
  //const [mostrarCadastro, setMostrarCadastro] = useState(false); // Para controlar o modal de dados

  //const [editando, setEditando] = useState(false);
  const [modoAcesso, setModoAcesso] = useState('selecao'); // 'selecao', 'login', 'cadastro'
  const [modalVisivel, setModalVisivel] = useState(false);
  const [statusPagamento, setStatusPagamento] = useState<'sucesso' | 'erro'>('sucesso');
  const flatListRef = useRef<FlatList>(null);
  const [modalPixVisivel, setModalPixVisivel] = useState(false);
  const [pixCopiaECola, setPixCopiaECola] = useState('');
  const [modalCartaoVisivel, setModalCartaoVisivel] = useState(false);
  const [tecladoVisivel, setTecladoVisivel] = useState(false);
  const [novoCpf, setNovoCpf] = useState(""); // Valor que está sendo digitado
  const [cpf, setCpf] = useState('');
  const [pontosPerfil, setPontosPerfil] = useState(0);

  // --- Configuração vinda do GestorChef (marca, banner, fidelidade) ---
  const [appCfg, setAppCfg] = useState<any>({});
  const [cupom, setCupom] = useState('');
  const [cupomAplicado, setCupomAplicado] = useState<any>(null);
  const [usarPontos, setUsarPontos] = useState(false);
  const corMarca = appCfg.corPrimaria || BRAND_GREEN;
  const nomeAppExibicao = appCfg.nomeApp || BRAND_NAME;
  const usaLogotipo = appCfg.identidadeTipo === 'logo' && !!appCfg.logoUrl;
  const estiloFonteMarca = FONT_STYLE_MAP[appCfg.fontFamily as string] || FONT_STYLE_MAP.italico;
  const tamanhoFonteMarca = FONT_SIZE_MAP[appCfg.fontSize as string] || FONT_SIZE_MAP.grande;

  useEffect(() => {
    const unsub = onSnapshot(doc(dbModular, 'app_config', 'geral'), (s: any) => {
      setAppCfg(s && s.exists() ? (s.data() || {}) : {});
    }, () => { });
    return () => unsub();
  }, []);

  // Cardápio em tempo real — antes era uma leitura única no login, então um
  // item esgotado (disponivel/disponivel_online) enquanto o app já estava
  // aberto continuava aparecendo pro cliente até ele fechar e reabrir o app.
  useEffect(() => {
    const q = query(collection(dbModular, 'cardapio'), where('disponivel', '==', true));
    const unsub = onSnapshot(q, (snapshot: any) => {
      const listaProd = snapshot.docs
        .map((d: any) => ({ id: d.id, ...d.data() }))
        .filter((p: any) => p.disponivel_online !== false);
      setProdutos(listaProd);
    }, () => { });
    return () => unsub();
  }, []);

  // --- Horário de funcionamento + bairros/taxa de entrega (mesma config do bot do WhatsApp) ---
  const [horarioCfg, setHorarioCfg] = useState<any>(null);
  const [lojaFechada, setLojaFechada] = useState(false);
  const [horarioTexto, setHorarioTexto] = useState('');
  const [bairro, setBairro] = useState('');
  const [bairrosEntrega, setBairrosEntrega] = useState<string[]>([]);
  const [taxaEntrega, setTaxaEntrega] = useState(0);
  useEffect(() => {
    const unsub = onSnapshot(doc(dbModular, 'configuracoes', 'bot'), (s: any) => {
      const d = s && s.exists() ? (s.data() || {}) : {};
      setHorarioCfg(d.horario_funcionamento || null);
      setBairrosEntrega(Array.isArray(d.bairros_entrega) ? d.bairros_entrega : []);
      setTaxaEntrega(Number(d.taxa_entrega) || 0);
    }, () => { });
    return () => unsub();
  }, []);
  useEffect(() => {
    function recalcular() {
      const { aberto, texto } = calcularHorarioFuncionamento(horarioCfg);
      setLojaFechada(!aberto);
      setHorarioTexto(texto);
    }
    recalcular();
    const intervalo = setInterval(recalcular, 60000);
    return () => clearInterval(intervalo);
  }, [horarioCfg]);

  const [destaquesGrupos, setDestaquesGrupos] = useState<any[]>([]);
  const [heroUrl, setHeroUrl] = useState('');
  useEffect(() => {
    const unsub = onSnapshot(doc(dbModular, 'app_config', 'destaques'), (s: any) => {
      const d = s && s.exists() ? (s.data() || {}) : {};
      setDestaquesGrupos(Array.isArray(d.grupos) ? d.grupos : []);
      setHeroUrl(d.heroUrl || '');
    }, () => { });
    return () => unsub();
  }, []);

  const corFundoVitrine = appCfg.corSecundaria || '#ffffff';

  const destaquesResolvidos = React.useMemo(() => {
    return destaquesGrupos
      .map((g: any) => ({
        ...g,
        produtos: (g.produtosIds || [])
          .map((id: string) => produtos.find(p => p.id === id))
          .filter(Boolean)
      }))
      .filter((g: any) => g.produtos.length > 0);
  }, [destaquesGrupos, produtos]);

  const [dadosCartao, setDadosCartao] = useState({
    numero: '',
    nomeTitular: '',
    cpf: '',
    validade: '',
    cvv: ''
  });
  // Opt-in explícito pra guardar os dados do cartão no aparelho (SecureStore)
  // e pré-preencher da próxima vez — antes salvava sempre, sem perguntar.
  const [salvarCartao, setSalvarCartao] = useState(true);

  const calcularSubtotal = () =>
    carrinho.reduce((acc, item) => acc + (Number(item.preco) || 0), 0);

  const calcularDesconto = () => {
    if (!cupomAplicado) return 0;
    const sub = calcularSubtotal();
    if (sub < (Number(cupomAplicado.minimo) || 0)) return 0;
    const d = cupomAplicado.tipo === 'percentual'
      ? sub * (Number(cupomAplicado.valor) / 100)
      : Number(cupomAplicado.valor) || 0;
    return Math.min(d, sub);
  };

  // --- Resgate de pontos (regras do GestorChef) ---
  const valorPorPonto = Number(appCfg.valorPorPonto) || 0;
  const minResgate = Number(appCfg.minResgate) || 0;
  const podeResgatar =
    appCfg.fidelidadeAtiva !== false && valorPorPonto > 0 &&
    pontosPerfil > 0 && pontosPerfil >= minResgate;

  const calcularDescontoResgate = () => {
    if (!usarPontos || !podeResgatar) return 0;
    const restante = Math.max(0, calcularSubtotal() - calcularDesconto());
    return Math.min(pontosPerfil * valorPorPonto, restante);
  };
  const pontosUsados = () =>
    valorPorPonto > 0 ? Math.round(calcularDescontoResgate() / valorPorPonto) : 0;

  // Taxa de entrega soma no total pago de verdade (inclusive PIX/cartão) —
  // igual ao bot, que sempre inclui taxa_entrega no valor_total do pedido.
  const calcularTotal = () =>
    Math.max(0, calcularSubtotal() - calcularDesconto() - calcularDescontoResgate()
      + (tipoEntrega === 'entrega' ? taxaEntrega : 0)).toFixed(2);

  const aplicarCupom = async () => {
    const code = (cupom || '').trim().toUpperCase();
    if (!code) return;
    try {
      const snap = await getDocs(query(
        collection(dbModular, 'cupons'),
        where('codigo', '==', code),
        where('ativo', '==', true)
      ));
      if (snap.empty) { Alert.alert('Cupom', 'Cupom inválido ou inativo.'); setCupomAplicado(null); return; }
      const c: any = snap.docs[0].data();
      if (c.validade && c.validade.toDate && c.validade.toDate() < new Date()) {
        Alert.alert('Cupom', 'Este cupom está expirado.'); setCupomAplicado(null); return;
      }
      setCupomAplicado(c);
      Alert.alert('Cupom', 'Cupom aplicado com sucesso! 🎉');
    } catch (e: any) {
      Alert.alert('Cupom', 'Não foi possível validar: ' + (e?.message || e));
    }
  };

  // Pontos de fidelidade: soma o pontos_fidelidade cadastrado de cada item do carrinho;
  // só usa a regra global (valor × pontos por R$) para itens sem pontos próprios definidos.
  const pontosDoPedido = (itensCarrinho: any[]) => {
    if (appCfg.fidelidadeAtiva === false) return 0;
    const ppr = Number(appCfg.pontosPorReal) || 0;
    return itensCarrinho.reduce((total, item) => {
      const temPontosProprios = item.pontos_fidelidade !== undefined && item.pontos_fidelidade !== null;
      const ptsItem = temPontosProprios
        ? Number(item.pontos_fidelidade) || 0
        : Math.floor((Number(item.preco) || 0) * ppr);
      return total + ptsItem;
    }, 0);
  };
  useEffect(() => {
    const showSubscription = Keyboard.addListener('keyboardDidShow', () => setTecladoVisivel(true));
    const hideSubscription = Keyboard.addListener('keyboardDidHide', () => setTecladoVisivel(false));

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);
  useEffect(() => {
    const tratarLink = async () => {
      // Captura a URL se o app estava fechado e abriu pelo link
      const urlInicial = await Linking.getInitialURL();
      if (urlInicial) console.log("App abriu com esta URL:", urlInicial);
    };

    const assinatura = Linking.addEventListener('url', (event) => {
      console.log("URL recebida com app aberto:", event.url);

      // Teste forçar a navegação manual se a tela ficar preta
      if (event.url.includes('approved')) {
        // Se estiver usando o router do Expo:
        // router.push('/pedidos'); 
        setModalVisivel(true);
        setStatusPagamento('sucesso');
      }
    });

    tratarLink();
    return () => assinatura.remove();
  }, []);
  useEffect(() => {
    if (!usuarioId || abaAtiva !== 'perfil') return;

    // Escuta o documento do usuário em tempo real
    const userRef = doc(dbModular, "usuarios_app", usuarioId);

    const unsubscribe = onSnapshot(userRef, (docSnap) => {
      if (docSnap.exists()) {
        setPontosPerfil(docSnap.data().pontos || 0);
      }
    });

    return () => unsubscribe();
  }, [usuarioId, abaAtiva]);
  const iniciarPagamentoMercadoPago = async () => {
    if (!endereco || endereco.trim() === '') {
      Alert.alert("Atenção", "Por favor, preencha o endereço de entrega antes de pagar.");
      setAbaAtiva('sacola'); // Garante que ele veja o erro no campo
      return;
    }

    setCarregandoLogin(true);

    try {
      const response = await fetch(`https://us-central1-${firebaseConfig.projectId}.cloudfunctions.net/criarPreferencia`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          itens: carrinho.map(item => ({
            id: String(item.id_carrinho || item.id),
            // Use 'nome' em vez de 'title', pois sua function mapeia item.nome
            nome: item.nome_exibicao || item.nome,
            preco: parseFloat(Number(item.preco).toFixed(2))
          })),
          usuarioEmail: clientConfig.emailPagamentoPadrao
        })
      });

      const resData = await response.json();
      const urlPagamento = resData.data?.sandbox_init_point || resData.data?.init_point;

      if (urlPagamento) {
        Linking.openURL(urlPagamento);
      } else {
        Alert.alert("Erro", "Não foi possível gerar o link de pagamento.");
      }
    } catch (error) {
      console.error(error);
      Alert.alert("Erro", "Falha ao conectar com o servidor.");
    } finally {
      setCarregandoLogin(false);
    }
  };

  const processarPagamentoPix = async () => {
    // 0. Endereço/bairro obrigatórios apenas em entrega
    if (tipoEntrega === 'entrega' && (!endereco || endereco.trim() === '')) {
      Alert.alert("Atenção", "Preencha o endereço de entrega antes de pagar.");
      setAbaAtiva('sacola');
      return;
    }
    if (tipoEntrega === 'entrega' && bairrosEntrega.length > 0 && !bairro) {
      Alert.alert("Atenção", "Selecione o bairro da entrega.");
      setAbaAtiva('sacola');
      return;
    }

    // 1. Validação de CPF
    const cpfLimpo = cpf.replace(/\D/g, '');
    if (cpfLimpo.length !== 11) {
      Alert.alert("Erro", "Por favor, preencha seu CPF corretamente na aba Perfil.");
      return;
    }

    if (carrinho.length === 0) return;

    const disponivelOk = await checarDisponibilidadeCarrinho(carrinho, setCarrinho);
    if (!disponivelOk) return;

    setCarregandoLogin(true);

    // 2. GERAÇÃO DA CHAVE DE IDEMPOTÊNCIA (Evita o erro de Header Null)
    const idempotencyKey = Math.random().toString(36).substring(2, 15);

    try {
      // Gere a chave aqui fora
      const idempotencyKey = "key-" + Date.now() + "-" + Math.random().toString(36).substring(7);

      const response = await fetch(`https://us-central1-${firebaseConfig.projectId}.cloudfunctions.net/processarPagamentoDireto`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-Idempotency-Key': idempotencyKey
        },
        body: JSON.stringify({
          payment_method_id: "pix",
          idempotency_key: idempotencyKey,
          item: {
            title: `Pedido ${nomeAppExibicao}`,
            total: parseFloat(calcularTotal())
          },
          email: clientConfig.emailPagamentoPadrao,
          nome: nome,
          cpf: cpfLimpo
        })
      });

      const resultado = await response.json();

      if (resultado.status === 'pending') {
        const codigoPix = resultado.point_of_interaction.transaction_data.qr_code;
        setPixCopiaECola(codigoPix);

        // --- AGRUPAMENTO DE ITENS (Igual ao Cartão para a Cozinha ler certo) ---
        const acumulador: Record<string, any> = {};
        carrinho.forEach((item: any) => {
          const nomeItem = item.nome_exibicao || item.nome;
          if (!acumulador[nomeItem]) {
            acumulador[nomeItem] = { nome: nomeItem, qtd: 0, preco: item.preco };
          }
          acumulador[nomeItem].qtd += 1;
        });

        const itensFormatados = Object.values(acumulador).map((item: any) => ({
          nome: item.qtd > 1 ? `${item.qtd}x ${item.nome}` : item.nome,
          preco: item.preco
        }));

        // 3. Salvar no Firestore
        await addDoc(collection(db, "pedidos"), {
          origem: "APP",
          usuario_id: usuarioId,
          nome_cliente: nome,
          telefone_cliente: telefone,
          tipo_entrega: tipoEntrega === 'retirada' ? 'RETIRADA' : 'ENTREGA',
          endereco: tipoEntrega === 'retirada' ? 'Retirada no balcão' : endereco,
          bairro: tipoEntrega === 'retirada' ? null : (bairro || null),
          taxa_entrega: tipoEntrega === 'entrega' ? taxaEntrega : 0,
          itens: itensFormatados, // 🔥 Lista agrupada e formatada
          valor_total: calcularTotal(),
          forma_pagamento: 'PIX', // 🔥 CORREÇÃO: Mudado de CARTAO para PIX
          pagamento_id: resultado.id,
          status: 'AGUARDANDO_PIX', // 🔥 CORREÇÃO: Começa como aguardando o pagamento
          pontos_a_creditar: pontosDoPedido(carrinho), // creditado pelo webhook quando o MP confirmar o pagamento
          hora_pedido: serverTimestamp(),
          data_formatada: new Date().toLocaleString('pt-BR')
        });

        // Resgate de fidelidade: debita os pontos usados (PIX credita o ganho na confirmação do pagamento)
        if (usarPontos && pontosUsados() > 0 && usuarioId) {
          try {
            await updateDoc(doc(dbModular, 'usuarios_app', usuarioId), { pontos: increment(-pontosUsados()) });
          } catch (e) { console.warn('Falha ao debitar pontos (PIX):', e); }
        }

        setModalPixVisivel(true);
        setCarrinho([]);
        setUsarPontos(false);

      } else {
        Alert.alert("Erro no PIX", resultado.message || "Não foi possível gerar o código.");
      }
    } catch (error) {
      console.error("Erro ao processar PIX:", error);
      Alert.alert("Erro de Conexão", "Não conseguimos falar com o servidor.");
    } finally {
      setCarregandoLogin(false);
    }
  };
  const processarPagamentoAPI = async (dadosCartaoEnviados: any) => {
    // CPF: usa o do cartão se preenchido, senão puxa o do perfil (igual ao PIX)
    const cpfFinal = (dadosCartaoEnviados?.cpf || cpf || '').replace(/\D/g, '');

    // 1. Verificação inicial "blindada" contra campos vazios ou nulos
    if (!dadosCartaoEnviados?.numero || !dadosCartaoEnviados?.cvv || !dadosCartaoEnviados?.validade) {
      Alert.alert("Erro", "Preencha todos os dados do cartão.");
      return;
    }
    if (cpfFinal.length !== 11) {
      Alert.alert("Erro", "Preencha seu CPF corretamente na aba Perfil.");
      return;
    }
    if (tipoEntrega === 'entrega' && (!endereco || endereco.trim() === '')) {
      Alert.alert("Atenção", "Preencha o endereço de entrega antes de pagar.");
      setAbaAtiva('sacola');
      return;
    }
    if (tipoEntrega === 'entrega' && bairrosEntrega.length > 0 && !bairro) {
      Alert.alert("Atenção", "Selecione o bairro da entrega.");
      setAbaAtiva('sacola');
      return;
    }
    const disponivelOk = await checarDisponibilidadeCarrinho(carrinho, setCarrinho);
    if (!disponivelOk) return;

    setCarregandoLogin(true);
    try {
      // 2. Validade tolerante: aceita "MM/AA" ou "MMAA" (ex.: 11/30 ou 1130)
      const validadeNum = String(dadosCartaoEnviados.validade).replace(/\D/g, '');
      if (validadeNum.length !== 4) {
        throw new Error("Validade inválida. Use MM/AA (ex.: 11/30).");
      }

      const mesLimpo = parseInt(validadeNum.slice(0, 2), 10);
      const anoCompleto = parseInt(`20${validadeNum.slice(2, 4)}`, 10);

      if (!(mesLimpo >= 1 && mesLimpo <= 12)) {
        throw new Error("Mês da validade inválido.");
      }

      // --- PASSO A0: Identificar a bandeira pelo número do cartão ---
      // O Mercado Pago exige payment_method_id (visa/master/...) pra cobrar
      // via API direta — sem isso o pagamento é recusado com um erro sem
      // status_detail, que aparecia como "Motivo: undefined" pro cliente.
      const numeroLimpo = dadosCartaoEnviados.numero.replace(/\s/g, '');
      const paymentMethodId = detectarPaymentMethodId(numeroLimpo);
      if (!paymentMethodId) {
        throw new Error("Não foi possível identificar a bandeira do cartão pelo número informado.");
      }

      // --- PASSO A: Gerar Token do Cartão ---
      const responseToken = await fetch(`https://api.mercadopago.com/v1/card_tokens?public_key=${clientConfig.mercadoPagoPublicKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          card_number: dadosCartaoEnviados.numero.replace(/\s/g, ''),
          expiration_month: mesLimpo,
          expiration_year: anoCompleto,
          security_code: dadosCartaoEnviados.cvv,
          cardholder: {
            name: dadosCartaoEnviados.nomeTitular || "Titular",
            identification: {
              type: "CPF",
              number: cpfFinal
            }
          }
        })
      });

      const tokenData = await responseToken.json();

      if (!tokenData.id) {
        console.error("Erro MP Token:", JSON.stringify(tokenData));
        const msgToken = tokenData?.message || tokenData?.cause?.[0]?.description || 'dados do cartão recusados.';
        throw new Error(`Cartão recusado pelo Mercado Pago: ${msgToken}`);
      }

      // --- PASSO B: Processar Pagamento na Cloud Function ---
      const responsePagamento = await fetch(`https://us-central1-${firebaseConfig.projectId}.cloudfunctions.net/processarPagamentoDireto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: tokenData.id,
          payment_method_id: paymentMethodId,
          item: {
            title: `Pedido ${nomeAppExibicao}`,
            total: parseFloat(calcularTotal()),
          },
          email: clientConfig.emailPagamentoPadrao
        })
      });

      const resultado = await responsePagamento.json();

      // --- LÓGICA DE AGRUPAMENTO DE ITENS ---
      interface ItemAgrupado {
        nome: string;
        qtd: number;
        preco: number;
      }

      const acumulador: Record<string, ItemAgrupado> = {};

      carrinho.forEach((item: any) => {
        const nome = item.nome_exibicao || item.nome;
        if (!acumulador[nome]) {
          acumulador[nome] = { nome: nome, qtd: 0, preco: Number(item.preco) };
        }
        acumulador[nome].qtd += 1;
      });

      const itensFormatados = Object.values(acumulador).map((item) => ({
        nome: item.qtd > 1 ? `${item.qtd}x ${item.nome}` : item.nome,
        preco: item.preco
      }));

      // --- PASSO C: Se aprovado, ATUALIZAR PONTOS E SALVAR PEDIDO ---
      if (resultado.status === 'approved' || resultado.status === 'in_process') {

        // Validação de Segurança do TypeScript
        if (!usuarioId) {
          console.error("ERRO CRÍTICO: Usuário ID indefinido ao processar pagamento.");
          Alert.alert("Erro", "Não foi possível identificar o usuário para creditar pontos.");
          return;
        }

        // 1. Calcula os pontos somando o pontos_fidelidade cadastrado de cada item do carrinho
        const totalPontosGanhos = pontosDoPedido(carrinho);
        console.log("Total de pontos calculados (regra):", totalPontosGanhos);

        // 2. ATUALIZAÇÃO DOS PONTOS
        try {
          // 'usuarioId' agora é garantido como string devido ao if(!usuarioId) acima
          const clienteRef = doc(dbModular, "usuarios_app", usuarioId);

          await updateDoc(clienteRef, {
            pontos: increment(totalPontosGanhos - pontosUsados())
          });
          Alert.alert(
            "🎉 Parabéns!",
            `Pagamento aprovado!\n\nVocê acaba de ganhar +${totalPontosGanhos} pontos fidelidade. Continue assim para trocar por pizzas grátis! 🍕`,
            [{ text: "Sensacional!", onPress: () => console.log("Feedback fechado") }]
          );
          console.log("✅ Pontos creditados com sucesso no ID:", usuarioId);
        } catch (err: any) {
          console.error("⚠️ Erro ao atualizar pontos, tentando criar...", err);

          // Se der erro (ex: documento não existe), cria um novo
          if (err.code === 'not-found' || String(err).includes('not found')) {
            const clienteRef = doc(dbModular, "usuarios_app", usuarioId);
            await setDoc(clienteRef, { pontos: totalPontosGanhos - pontosUsados() }, { merge: true });
            console.log("✅ Documento criado e pontos creditados!");
          }
        }
        // 3. Salva os dados locais (Segurança e Cache)
        await SecureStore.setItemAsync('endereco_salvo', endereco);
        // Cartão só é salvo se o cliente marcou a opção no modal — antes
        // salvava sempre, sem pedir permissão.
        if (salvarCartao) {
          const dadosParaSalvar = {
            numero: dadosCartaoEnviados.numero,
            nomeTitular: dadosCartaoEnviados.nomeTitular,
            cpf: dadosCartaoEnviados.cpf,
            validade: dadosCartaoEnviados.validade
          };
          await SecureStore.setItemAsync('dados_cartao', JSON.stringify(dadosParaSalvar));
        } else {
          await SecureStore.deleteItemAsync('dados_cartao');
        }

        // 4. Registra o pedido no Firestore
        try {
          await addDoc(collection(db, "pedidos"), {
            origem: "APP",
            usuario_id: usuarioId,
            nome_cliente: nome,
            telefone_cliente: telefone,
            tipo_entrega: tipoEntrega === 'retirada' ? 'RETIRADA' : 'ENTREGA',
            endereco: tipoEntrega === 'retirada' ? 'Retirada no balcão' : endereco,
            bairro: tipoEntrega === 'retirada' ? null : (bairro || null),
            taxa_entrega: tipoEntrega === 'entrega' ? taxaEntrega : 0,
            itens: itensFormatados,
            valor_total: calcularTotal(),
            pontos_gerados: totalPontosGanhos,
            forma_pagamento: 'CARTAO',
            pagamento_id: resultado.id,
            status: 'PENDENTE_PREPARO',
            hora_pedido: serverTimestamp(),
            data_formatada: new Date().toLocaleString('pt-BR')
          });

          await SecureStore.setItemAsync('dados_usuario', JSON.stringify({ nome, telefone, endereco }));

          // Sucesso Final
          setStatusPagamento('sucesso');
          setModalVisivel(true);
          setCarrinho([]);
          setAbaAtiva('pedidos');

        } catch (dbError) {
          console.error("Erro ao salvar pedido:", dbError);
          Alert.alert("Aviso", "Pagamento aprovado, mas o registro falhou. Fale com a loja.");
        }

      } else {
        Alert.alert("Pagamento Recusado", `Motivo: ${resultado.status_detail || resultado.status || resultado.message || 'não foi possível processar o cartão.'}`);
      }

    } catch (error: any) {
      console.error("Erro geral na função:", error);
      Alert.alert("Erro no Pagamento", error.message);
    } finally {
      setCarregandoLogin(false);
    }
  };

  const aplicarMascaraTelefone = (valor: string) => {
    let v = valor.replace(/\D/g, ""); // Remove tudo que não é número
    if (v.length > 11) v = v.substring(0, 11);

    if (v.length > 10) {
      return `(${v.substring(0, 2)}) ${v.substring(2, 7)}-${v.substring(7, 11)}`;
    } else if (v.length > 6) {
      return `(${v.substring(0, 2)}) ${v.substring(2, 6)}-${v.substring(6, 10)}`;
    } else if (v.length > 2) {
      return `(${v.substring(0, 2)}) ${v.substring(2)}`;
    }
    return v;
  };
  const salvarCacheLocal = async (dados: any) => {
    try {
      await SecureStore.setItemAsync('dados_usuario', JSON.stringify(dados));
    } catch (e) { console.error("Erro ao salvar cache", e); }
  };


  //  USEEFFECT GLOBAL ---
  useEffect(() => {
    if (!usuarioId || typeof usuarioId !== 'string' || !estaCadastrado) {
      console.log("Aguardando credenciais válidas...");
      return;
    }

    console.log("Iniciando escuta modular de pedidos para:", usuarioId);

    // Criando a query da forma correta para o SDK moderno
    const q = query(
      collection(db, "pedidos"),
      where("usuario_id", "==", usuarioId),
      orderBy("hora_pedido", "desc")
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const lista = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setMeusPedidos(lista);
    }, (error) => {
      // 🔥 SE O ERRO APARECER AQUI: Procure um link no terminal/console
      console.error("Erro na escuta de pedidos:", error);
    });

    return () => unsubscribe();
  }, [usuarioId, estaCadastrado]);
  // Função para adicionar itens (useCallback: identidade estável entre re-renders,
  // necessário pra CartaoProduto memoizado não perder o memo por causa de uma prop nova)
  const adicionarAoCarrinho = useCallback((produto: any) => {
    const novoItem = {
      ...produto,
      // Garante um ID único para cada clique, mesmo que seja o mesmo produto
      id_carrinho: Math.random().toString(36).slice(2, 9) + Date.now()
    };
    setCarrinho(prevCarrinho => [...prevCarrinho, novoItem]);
  }, []);

  const aplicarFiltros = (lista: any[], termoBusca: string, categoria: string) => {
    let resultado = lista;

    if (categoria && categoria !== 'Todos') {
      resultado = resultado.filter(p =>
        String(p.categoria || 'Outros').trim().toLowerCase() === categoria.toLowerCase()
      );
    }

    const termo = termoBusca.toLowerCase().trim();
    if (termo !== '') {
      resultado = resultado.filter(p => {
        const nomeProd = String(p.nome_exibicao || p.nome || "").toLowerCase();
        const ingrProd = String(p.ingredientes || "").toLowerCase();
        return nomeProd.includes(termo) || ingrProd.includes(termo);
      });
    }

    return resultado;
  };

  const executarBusca = () => {
    setProdutosFiltrados(aplicarFiltros(produtos, busca, categoriaAtiva));
  };

  useEffect(() => {
    async function inicializar() {
      try {
        // 1. Tenta carregar ID e Dados do Cache Local
        const idSalvo = await SecureStore.getItemAsync('user_id');
        const cacheDados = await SecureStore.getItemAsync('dados_usuario');
        const cartaoSalvo = await SecureStore.getItemAsync('dados_cartao');

        if (idSalvo) {
          setUsuarioId(idSalvo);

          if (cacheDados) {
            const user = JSON.parse(cacheDados);
            setNome(user.nome || '');
            setTelefone(user.telefone || '');
            setEndereco(user.endereco || '');

            // Carregar CPF do Cache
            if (user.cpf) setCpf(user.cpf);

            setEstaCadastrado(true);
            console.log("🚀 Login rápido via cache local");
          }

          if (cartaoSalvo) {
            const c = JSON.parse(cartaoSalvo);
            setDadosCartao({
              numero: c.numero || '',
              nomeTitular: c.nomeTitular || '',
              cpf: c.cpf || '',
              validade: c.validade || '',
              cvv: ''
            });
          }

          // Se tem ID mas não tem cache, busca no banco
          const userDoc = await db.collection('usuarios_app').doc(idSalvo).get();
          if (userDoc.exists) {
            const d = userDoc.data();
            setNome(d?.nome || '');
            setTelefone(d?.telefone || '');

            // 🔥 CORREÇÃO 2: Carregar CPF do Firebase
            if (d?.cpf) setCpf(d.cpf);

            setEstaCadastrado(true);

            // Importante: salvarCacheLocal deve incluir o CPF agora
            salvarCacheLocal({
              nome: d?.nome,
              telefone: d?.telefone,
              endereco: d?.endereco,
              cpf: d?.cpf // Garante que o CPF vá para o cache também
            });
          }
        }

      } catch (error) {
        console.error("Erro ao carregar dados:", error);
      } finally {
        setCarregando(false);
      }
    }
    inicializar();
  }, []);
  useEffect(() => {
    setProdutosFiltrados(aplicarFiltros(produtos, busca, categoriaAtiva));
  }, [busca, produtos, categoriaAtiva]);

  const categoriasDisponiveis = React.useMemo(() => {
    const unicas = new Set<string>();
    produtos.forEach(p => {
      const cat = String(p.categoria || 'Outros').trim();
      if (cat) unicas.add(cat.charAt(0).toUpperCase() + cat.slice(1).toLowerCase());
    });
    return ['Todos', ...Array.from(unicas)];
  }, [produtos]);
  const verificarOuCadastrar = async () => {
    // 1. Limpeza e Validação Básica de CPF
    const cpfLimpo = cpf.replace(/\D/g, '');
    if (cpfLimpo.length !== 11) {
      return Alert.alert("CPF Inválido", "Por favor, insira o CPF completo com 11 dígitos.");
    }

    setCarregandoLogin(true);

    try {
      // 2. Consulta ao Firestore pelo CPF
      const snapshot = await db.collection('usuarios_app')
        .where('cpf', '==', cpfLimpo)
        .limit(1)
        .get();

      if (!snapshot.empty) {
        // --- CASO: USUÁRIO ENCONTRADO (LOGIN) ---
        const userDoc = snapshot.docs[0];
        const dados = userDoc.data();

        // Salva no cache local para evitar futuras consultas
        await SecureStore.setItemAsync('user_id', userDoc.id);
        await salvarCacheLocal(dados);

        setNome(dados.nome || '');
        setTelefone(dados.telefone || '');
        setEndereco(dados.endereco || '');
        setUsuarioId(userDoc.id);
        setEstaCadastrado(true);
        setAbaAtiva('home');

        Alert.alert("Sucesso", `Bem-vindo de volta, ${dados.nome}!`);
      } else {
        // --- CASO: USUÁRIO NÃO ENCONTRADO ---

        // Se o usuário clicou em "Já sou cliente" (Login), mas o CPF não existe:
        if (modoAcesso === 'login') {
          setCarregandoLogin(false);
          return Alert.alert(
            "Conta não encontrada",
            "Este CPF não possui cadastro. Deseja criar uma conta agora?",
            [
              { text: "Cancelar", style: "cancel" },
              { text: "Cadastrar", onPress: () => setModoAcesso('cadastro') }
            ]
          );
        }

        // Se ele está na tela de "Cadastrar", validamos Nome e Telefone
        if (!nome.trim() || !telefone.trim()) {
          setCarregandoLogin(false);
          return Alert.alert(
            "Dados Incompletos",
            "Para realizar seu primeiro cadastro, precisamos do seu Nome e WhatsApp."
          );
        }

        // TRATAMENTO DO TELEFONE: Remove máscara e garante o 55
        let telefoneLimpo = telefone.replace(/\D/g, '');
        if (telefoneLimpo.length > 0 && !telefoneLimpo.startsWith('55')) {
          telefoneLimpo = '55' + telefoneLimpo;
        }

        const novoId = `cliente_${Date.now()}`;

        const novoUsuario = {
          cpf: cpfLimpo,
          nome: nome.trim(),
          telefone: telefoneLimpo,
          endereco: endereco || '',
          pontos: 0,
          criadoEm: firebase.firestore.Timestamp.now(),
        };

        // Grava no Firebase
        await db.collection('usuarios_app').doc(novoId).set(novoUsuario);

        // Salva localmente
        await SecureStore.setItemAsync('user_id', novoId);
        await salvarCacheLocal(novoUsuario);

        setUsuarioId(novoId);
        setNome(novoUsuario.nome);
        setTelefone(novoUsuario.telefone);
        setEstaCadastrado(true);

        Alert.alert("Sucesso!", "Seu cadastro foi realizado com sucesso.");
      }
    } catch (error) {
      console.error("Erro no Login/Cadastro:", error);
      Alert.alert("Erro", "Não foi possível conectar ao servidor.");
    } finally {
      setCarregandoLogin(false);
    }
  };

  const getCorStatus = (status: any) => {
    switch (status) {
      case 'PENDENTE_PREPARO': return '#f39c12'; // Laranja
      case 'EM_PREPARO': return '#3498db';      // Azul
      case 'PRONTO_PARA_ENTREGA': return BRAND_GREEN; // Verde
      default: return '#95a5a6';                // Cinza
    }
  };

  // --- FUNÇÃO PARA ENVIAR MENSAGEM PARA A SOFIA ---

  // --- COMPONENTE VITRINE (HOME) ---

  if (carregando) return <ActivityIndicator size="large" color={BRAND_GREEN} style={{ flex: 1 }} />;

  return (
    <View style={{ flex: 1, backgroundColor: '#fff' }}>
      <StatusBar barStyle="dark-content" />

      {!estaCadastrado ? (
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1, backgroundColor: corMarca }}>
          <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}>
            <View style={styles.containerCentro}>
              <View style={styles.cardCadastro}>
                <Image source={BRAND_LOGO} style={styles.logoLogin} contentFit="contain" />
                {usaLogotipo && appCfg.logoUrl ? (
                  <Image source={{ uri: appCfg.logoUrl }} style={styles.marcaLogoLogin} contentFit="contain" />
                ) : (
                  <Text style={[styles.tituloCadastro, estiloFonteMarca, { fontSize: tamanhoFonteMarca }]}>{nomeAppExibicao}</Text>
                )}

                {/* --- ESTADO 1: SELEÇÃO INICIAL --- */}
                {modoAcesso === 'selecao' && (
                  <View>
                    <Text style={{ textAlign: 'center', marginBottom: 20, color: '#666' }}>Como deseja prosseguir?</Text>

                    <TouchableOpacity
                      style={[styles.btnCadastroLargo, { backgroundColor: corMarca }]}
                      onPress={() => setModoAcesso('login')}
                    >
                      <Text style={styles.btnTxtBranco}>Já sou cliente (Login) 🔑</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={[styles.btnCadastroLargo, { backgroundColor: BRAND_WHITE, borderWidth: 1, borderColor: corMarca, marginTop: 10 }]}
                      onPress={() => setModoAcesso('cadastro')}
                    >
                      <Text style={[styles.btnTxtBranco, { color: corMarca }]}>Novo por aqui? (Cadastrar) ✨</Text>
                    </TouchableOpacity>
                  </View>
                )}

                {/* --- ESTADO 2: TELA DE LOGIN (Apenas CPF) --- */}
                {modoAcesso === 'login' && (
                  <View>
                    <Text style={styles.label}>DIGITE SEU CPF</Text>
                    <TextInput
                      style={styles.inputVisivel}
                      placeholder="000.000.000-00"
                      keyboardType="numeric"
                      value={cpf}
                      onChangeText={setCpf}
                      maxLength={11}
                    />
                    <TouchableOpacity style={[styles.btnCadastroLargo, { backgroundColor: corMarca, marginTop: 20 }]} onPress={verificarOuCadastrar}>
                      <Text style={styles.btnTxtBranco}>Entrar 🚀</Text>
                    </TouchableOpacity>

                    <TouchableOpacity onPress={() => setModoAcesso('selecao')} style={{ marginTop: 15 }}>
                      <Text style={{ textAlign: 'center', color: '#999' }}>Voltar</Text>
                    </TouchableOpacity>
                  </View>
                )}

                {/* --- ESTADO 3: TELA DE CADASTRO (CPF, Nome, Tel) --- */}
                {modoAcesso === 'cadastro' && (
                  <View>
                    <Text style={styles.label}>CPF (Para seu cadastro)</Text>
                    <TextInput style={styles.inputVisivel} placeholder="000.000.000-00" keyboardType="numeric" value={cpf} onChangeText={setCpf} maxLength={11} />

                    <Text style={[styles.label, { marginTop: 15 }]}>NOME COMPLETO</Text>
                    <TextInput style={styles.inputVisivel} placeholder="Ex: João Silva" value={nome} onChangeText={setNome} />

                    <Text style={[styles.label, { marginTop: 15 }]}>WHATSAPP</Text>
                    <TextInput
                      style={styles.inputVisivel}
                      placeholder="(00) 00000-0000"
                      keyboardType="phone-pad"
                      value={aplicarMascaraTelefone(telefone)}
                      onChangeText={(t) => setTelefone(aplicarMascaraTelefone(t))}
                      maxLength={15}
                    />

                    <TouchableOpacity style={[styles.btnCadastroLargo, { backgroundColor: corMarca, marginTop: 20 }]} onPress={verificarOuCadastrar}>
                      <Text style={styles.btnTxtBranco}>Criar minha conta ⭐</Text>
                    </TouchableOpacity>

                    <TouchableOpacity onPress={() => setModoAcesso('selecao')} style={{ marginTop: 15 }}>
                      <Text style={{ textAlign: 'center', color: '#999' }}>Voltar</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      ) : (
        <View style={{ flex: 1 }}>
          {/* --- CONTEÚDO DAS ABAS --- */}
          <View style={{ flex: 1, paddingBottom: 0 }}>
            {abaAtiva === 'home' && (
              <SecaoHome
                produtosFiltrados={produtosFiltrados}
                nome={nome}
                busca={busca}
                setBusca={setBusca}
                executarBusca={executarBusca}
                adicionarAoCarrinho={adicionarAoCarrinho}
                insets={insets}
                styles={styles}
                pontosPorReal={Number(appCfg.pontosPorReal) || 0}
                fidelidadeAtiva={appCfg.fidelidadeAtiva !== false}
                nomeApp={nomeAppExibicao}
                corMarca={corMarca}
                usaLogotipo={usaLogotipo}
                logoUrl={appCfg.logoUrl}
                estiloFonteMarca={estiloFonteMarca}
                tamanhoFonteMarca={tamanhoFonteMarca}
                bannerAtivo={appCfg.bannerAtivo}
                bannerTexto={appCfg.bannerTexto}
                bannerCor={appCfg.bannerCor}
                destaques={destaquesResolvidos}
                heroUrl={heroUrl}
                corFundo={corFundoVitrine}
                colunasVitrine={Number(appCfg.vitrineColunas) || 1}
                tamanhoImagemVitrine={appCfg.vitrineImagem || 'media'}
                lojaFechada={lojaFechada}
                horarioTexto={horarioTexto}
                categorias={categoriasDisponiveis}
                categoriaAtiva={categoriaAtiva}
                setCategoriaAtiva={setCategoriaAtiva}
              />
            )}

            {abaAtiva === 'chat' && (
              <View style={{ flex: 1 }}>
                <Text style={{ color: '#999', textAlign: 'center', marginTop: 20 }}>Chat em desenvolvimento</Text>
              </View>
            )}

            {abaAtiva === 'pedidos' && (
              <SecaoPedidos
                meusPedidos={meusPedidos}
                insets={insets}
                styles={styles}
                getCorStatus={getCorStatus}
              />
            )}

            {abaAtiva === 'perfil' && (
              <SecaoPerfil
                nome={nome}
                telefone={telefone}
                endereco={endereco}
                usuarioId={usuarioId}
                styles={styles}
                setNome={setNome}
                setTelefone={setTelefone}
                cpf={cpf}
                setCpf={setCpf}
                pontosPerfil={pontosPerfil}
                onSair={async () => {
                  Alert.alert(
                    "Sair",
                    "Deseja realmente sair da conta?",
                    [
                      { text: "Cancelar", style: "cancel" },
                      {
                        text: "Sair",
                        style: "destructive",
                        onPress: async () => {
                          await SecureStore.deleteItemAsync('user_id');
                          await SecureStore.deleteItemAsync('user_phone');
                          setUsuarioId(undefined);
                          setEstaCadastrado(false);
                          setNome('');
                          setTelefone('');
                          setEndereco('');
                          setCarrinho([]);
                          setAbaAtiva('home');
                        }
                      }
                    ]
                  );
                }}
              />
            )}

            {abaAtiva === 'sacola' && (
              <SecaoSacola
                carrinho={carrinho}
                setCarrinho={setCarrinho}
                nome={nome}
                setNome={setNome}
                telefone={telefone}
                setTelefone={setTelefone}
                endereco={endereco}
                setEndereco={setEndereco}
                bairro={bairro}
                setBairro={setBairro}
                bairrosEntrega={bairrosEntrega}
                taxaEntrega={taxaEntrega}
                metodoPagamento={metodoPagamento}
                setMetodoPagamento={setMetodoPagamento}
                tipoEntrega={tipoEntrega}
                setTipoEntrega={setTipoEntrega}
                calcularTotal={calcularTotal}
                verificarOuCadastrar={verificarOuCadastrar}
                carregandoLogin={carregandoLogin}
                insets={insets}
                styles={styles}
                usuarioId={usuarioId}
                setAbaAtiva={setAbaAtiva}
                finalizarPedido={finalizarPedido}
                iniciarPagamentoMercadoPago={iniciarPagamentoMercadoPago}
                processarPagamentoAPI={processarPagamentoAPI}
                setModalCartaoVisivel={setModalCartaoVisivel}
                processarPagamentoPix={processarPagamentoPix}
                tecladoVisivel={tecladoVisivel}
                cupom={cupom}
                setCupom={setCupom}
                aplicarCupom={aplicarCupom}
                cupomAplicado={cupomAplicado}
                calcularSubtotal={calcularSubtotal}
                calcularDesconto={calcularDesconto}
                corMarca={corMarca}
                usarPontos={usarPontos}
                setUsarPontos={setUsarPontos}
                podeResgatar={podeResgatar}
                pontosPerfil={pontosPerfil}
                calcularDescontoResgate={calcularDescontoResgate}
                pontosResgatados={usarPontos ? pontosUsados() : 0}
                lojaFechada={lojaFechada}
                horarioTexto={horarioTexto}
              />
            )}
          </View>
        </View>
      )}

      <View style={[
        styles.tabBar,
        {
          backgroundColor: corMarca,
          paddingBottom: insets.bottom > 20 ? insets.bottom : 10,
          height: insets.bottom > 20 ? 60 + insets.bottom : 65,
        }
      ]}>
        <TouchableOpacity style={styles.tabItem} onPress={() => setAbaAtiva('home')}>
          <Ionicons
            name={abaAtiva === 'home' ? 'home' : 'home-outline'}
            size={22}
            color={abaAtiva === 'home' ? '#fff' : 'rgba(255,255,255,0.65)'}
          />
          <Text style={{ fontSize: 10, color: abaAtiva === 'home' ? '#fff' : 'rgba(255,255,255,0.65)', fontWeight: 'bold' }}>Início</Text>
        </TouchableOpacity>


        <TouchableOpacity style={styles.tabItem} onPress={() => setAbaAtiva('pedidos')}>
          <Ionicons
            name={abaAtiva === 'pedidos' ? 'receipt' : 'receipt-outline'}
            size={22}
            color={abaAtiva === 'pedidos' ? '#fff' : 'rgba(255,255,255,0.65)'}
          />
          <Text style={{ fontSize: 10, color: abaAtiva === 'pedidos' ? '#fff' : 'rgba(255,255,255,0.65)', fontWeight: 'bold' }}>Pedidos</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.tabItem} onPress={() => setAbaAtiva('perfil')}>
          <Ionicons
            name={abaAtiva === 'perfil' ? 'person' : 'person-outline'}
            size={22}
            color={abaAtiva === 'perfil' ? '#fff' : 'rgba(255,255,255,0.65)'}
          />
          <Text style={[styles.tabTxt, { color: abaAtiva === 'perfil' ? '#fff' : 'rgba(255,255,255,0.65)' }]}>Você</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.tabItem} onPress={() => setAbaAtiva('sacola')}>
          <View>
            <Ionicons
              name={abaAtiva === 'sacola' ? 'bag' : 'bag-outline'}
              size={22}
              color={abaAtiva === 'sacola' ? '#fff' : 'rgba(255,255,255,0.65)'}
            />
            {/* Este círculo vermelho avisa quantos itens tem */}
            {carrinho.length > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeTxt}>{carrinho.length}</Text>
              </View>
            )}
          </View>
          <Text style={[styles.tabTxt, { color: abaAtiva === 'sacola' ? '#fff' : 'rgba(255,255,255,0.65)' }]}>
            Sacola
          </Text>
        </TouchableOpacity>
      </View>
      <Modal
        visible={modalVisivel}
        transparent={true}
        animationType="slide"
      >
        <View style={styles.overlayModal}>
          <View style={[styles.cardModal, { paddingBottom: 20 + (insets.bottom > 0 ? insets.bottom : 12), alignItems: 'center' }]}>
            <Text style={{ fontSize: 50 }}>
              {statusPagamento === 'sucesso' ? '✅' : '❌'}
            </Text>

            <Text style={styles.tituloModal}>
              {statusPagamento === 'sucesso' ? 'Pedido Confirmado!' : 'Ops, algo deu errado'}
            </Text>

            <Text style={styles.textoModal}>
              {statusPagamento === 'sucesso'
                ? 'Seu pagamento foi aprovado e a cozinha já está preparando sua pizza!'
                : 'Não conseguimos processar seu pagamento. Tente novamente ou escolha outra forma.'}
            </Text>

            <TouchableOpacity
              style={[styles.btnModal, { backgroundColor: statusPagamento === 'sucesso' ? BRAND_GREEN : BRAND_GREEN }]}
              onPress={() => setModalVisivel(false)}
            >
              <Text style={{ color: '#fff', fontWeight: 'bold' }}>Entendido</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
      <Modal
        visible={modalCartaoVisivel}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setModalCartaoVisivel(false)}
      >
        {/* O KeyboardAvoidingView aqui garante que o modal suba quando o teclado abrir */}
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1 }}
        >
          <View style={styles.overlayModal}>
            <View style={[styles.cardModal, { width: '90%', maxHeight: '85%' }]}>

              {/* ScrollView permite que você arraste para ver os campos escondidos */}
              <ScrollView
                showsVerticalScrollIndicator={false}
                contentContainerStyle={{ alignItems: 'center', paddingBottom: 20 + (insets.bottom > 0 ? insets.bottom : 12) }}
                style={{ width: '100%' }}
              >
                <Text style={styles.tituloModal}>Dados do Cartão</Text>

                <Text style={[styles.label, { marginTop: 15 }]}>NÚMERO DO CARTÃO</Text>
                <TextInput
                  style={styles.inputVisivel}
                  placeholder="0000 0000 0000 0000"
                  keyboardType="numeric"
                  value={dadosCartao.numero}
                  onChangeText={(t) => setDadosCartao({ ...dadosCartao, numero: t })}
                />

                <Text style={styles.label}>NOME NO CARTÃO</Text>
                <TextInput
                  style={styles.inputVisivel}
                  placeholder="Como está no cartão"
                  value={dadosCartao.nomeTitular}
                  onChangeText={(t) => setDadosCartao({ ...dadosCartao, nomeTitular: t })}
                />

                <Text style={styles.label}>CPF DO TITULAR</Text>
                <TextInput
                  style={styles.inputVisivel}
                  placeholder="000.000.000-00"
                  keyboardType="numeric"
                  maxLength={14}
                  value={dadosCartao.cpf || cpf}
                  onChangeText={(t) => {
                    const d = t.replace(/\D/g, '').slice(0, 11);
                    const fmt = d
                      .replace(/(\d{3})(\d)/, '$1.$2')
                      .replace(/(\d{3})(\d)/, '$1.$2')
                      .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
                    setDadosCartao({ ...dadosCartao, cpf: fmt });
                  }}
                />

                <View style={{ flexDirection: 'row', justifyContent: 'space-between', width: '100%' }}>
                  <View style={{ width: '48%' }}>
                    <Text style={styles.label}>VALIDADE</Text>
                    <TextInput
                      style={styles.inputVisivel}
                      placeholder="MM/AA"
                      keyboardType="numeric"
                      value={dadosCartao.validade}
                      onChangeText={(t) => setDadosCartao({ ...dadosCartao, validade: t })}
                    />
                  </View>
                  <View style={{ width: '48%' }}>
                    <Text style={styles.label}>CVV</Text>
                    <TextInput
                      style={styles.inputVisivel}
                      placeholder="123"
                      keyboardType="numeric"
                      maxLength={4}
                      value={dadosCartao.cvv}
                      onChangeText={(t) => setDadosCartao({ ...dadosCartao, cvv: t.replace(/\D/g, '') })}
                    />
                  </View>
                </View>

                <TouchableOpacity
                  onPress={() => setSalvarCartao(!salvarCartao)}
                  style={{
                    marginTop: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                    padding: 12, borderWidth: 1, borderColor: salvarCartao ? BRAND_GREEN : '#ddd',
                    borderRadius: 8, backgroundColor: salvarCartao ? '#eafaf1' : '#fff', width: '100%'
                  }}
                >
                  <Text style={{ fontWeight: '600', color: '#2d3436' }}>💳 Salvar dados do cartão</Text>
                  <Text style={{ fontWeight: 'bold', color: salvarCartao ? BRAND_GREEN : '#999' }}>
                    {salvarCartao ? 'Ativado ✓' : 'Desativado'}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.btnModal, { backgroundColor: BRAND_GREEN, marginTop: 15, width: '100%', alignItems: 'center' }]}
                  onPress={() => {
                    setModalCartaoVisivel(false);
                    processarPagamentoAPI(dadosCartao);
                  }}
                >
                  <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 16 }}>Pagar Agora</Text>
                </TouchableOpacity>

                <TouchableOpacity onPress={() => setModalCartaoVisivel(false)} style={{ marginTop: 20 }}>
                  <Text style={{ color: '#999' }}>Cancelar e Voltar</Text>
                </TouchableOpacity>
              </ScrollView>

            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* MODAL PIX */}
      <Modal
        visible={modalPixVisivel}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setModalPixVisivel(false)}
      >
        <View style={styles.overlayModal}>
          <View style={[styles.cardPix, { paddingBottom: 20 + (insets.bottom > 0 ? insets.bottom : 12) }]}>
            <Text style={styles.tituloPix}>Pagamento via PIX</Text>
            <Text style={styles.subtituloPix}>Copie o código abaixo para pagar:</Text>

            <View style={styles.boxCodigo}>
              <Text numberOfLines={3} style={styles.tituloPix}>{pixCopiaECola}</Text>
            </View>

            <TouchableOpacity
              style={styles.btnCopiar}
              onPress={async () => {
                await Clipboard.setStringAsync(pixCopiaECola);
                Alert.alert("Copiado!", "O código PIX foi copiado para sua área de transferência.");
              }}
            >
              <Text style={{ color: '#fff', fontWeight: 'bold' }}>Copiar Código PIX</Text>
            </TouchableOpacity>

            <TouchableOpacity onPress={() => setModalPixVisivel(false)} style={{ marginTop: 20 }}>
              <Text style={{ color: BRAND_GREEN, fontWeight: 'bold' }}>Fechar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  // === HEADER / TOPO HOME ===
  topoHome: {
    backgroundColor: BRAND_GREEN,
    paddingBottom: 12,
  },
  promoBanner: {
    backgroundColor: '#0f3d1e',
    paddingVertical: 6,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  promoBannerTxt: {
    color: '#FFD700',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  headerHome: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 8,
    backgroundColor: BRAND_GREEN,
  },
  saudacao: { fontSize: 11, color: 'rgba(255,255,255,0.75)', fontWeight: '500', marginTop: 3 },
  logoTexto: {
    fontSize: 32,
    fontWeight: '700',
    fontStyle: 'italic',
    color: '#fff',
    fontFamily: Platform.OS === 'ios' ? 'Snell Roundhand' : 'serif',
  },
  logoSubtexto: {
    fontSize: 11,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.85)',
    letterSpacing: 3,
    marginTop: -2,
  },
  marcaLogoHeader: { height: 44, width: 170 },
  lojaNome: { fontSize: 22, fontWeight: 'bold', color: '#fff' },
  btnNotificacao: { backgroundColor: 'rgba(255,255,255,0.18)', padding: 9, borderRadius: 12 },

  searchContainer: { paddingHorizontal: 16, marginTop: 10 },
  searchBarInterna: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 14,
    height: 42,
    elevation: 3,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },

  // Vitrine
  bannerContainer: { margin: 15, height: 120, borderRadius: 15, overflow: 'hidden', backgroundColor: '#000' },
  bannerImg: { width: '100%', height: '100%', opacity: 0.7 },
  bannerTxt: { position: 'absolute', bottom: 10, left: 15, color: '#fff', fontSize: 20, fontWeight: 'bold' },
  secaoTitulo: { fontSize: 17, fontWeight: 'bold', marginLeft: 16, marginTop: 18, marginBottom: 8, color: '#1a1a1a' },
  cardProduto: { flexDirection: 'row', padding: 15, borderBottomWidth: 1, borderColor: '#eee', alignItems: 'center' },
  infoProduto: { flex: 1, paddingRight: 10 },
  nomeProduto: { fontSize: 15, fontWeight: '700', color: '#1a1a1a' },
  precoProduto: { color: BRAND_GREEN, fontWeight: 'bold', fontSize: 15, marginTop: 4 },
  fotoProduto: { width: 80, height: 80, borderRadius: 10 },

  // Pontos fidelidade badge
  seloPontos: {
    backgroundColor: '#FFF9C4',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: '#FBC02D',
  },
  seloPontosTxt: { fontSize: 10, fontWeight: 'bold', color: '#F57F17' },

  // Menu Inferior
  tabBar: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    justifyContent: 'space-around',
    alignItems: 'center',
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: -2 },
  },
  tabItem: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    height: '100%',
  },

  // Gerais e Cadastro
  containerCentro: {
    width: '100%',
    padding: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardCadastro: { backgroundColor: '#fff', padding: 20, borderRadius: 15, elevation: 5 },
  logoLogin: { width: '100%', height: 115, marginBottom: 8 },
  marcaLogoLogin: { width: '100%', height: 60, marginBottom: 12 },
  emojiBoasVindas: { fontSize: 60, textAlign: 'center', marginBottom: 10 },
  tituloCadastro: { fontSize: 22, fontWeight: 'bold', textAlign: 'center', marginBottom: 20 },
  subtituloCadastro: { fontSize: 16, color: '#666', textAlign: 'center', marginBottom: 20 },
  btnRed: { backgroundColor: BRAND_GREEN, padding: 15, borderRadius: 8, marginTop: 20, alignItems: 'center' },
  btnTxt: { color: '#fff', fontWeight: 'bold' },

  // Chat
  balao: { margin: 5, padding: 10, borderRadius: 10, maxWidth: '80%' },
  meuBalao: { alignSelf: 'flex-end', backgroundColor: '#DCF8C6' },
  inputArea: { flexDirection: 'row', padding: 10, borderTopWidth: 1, borderColor: '#eee' },
  inputChat: { flex: 1, backgroundColor: '#f0f0f0', borderRadius: 20, paddingHorizontal: 15 },
  btnEnviar: { marginLeft: 10, backgroundColor: BRAND_GREEN, paddingHorizontal: 20, borderRadius: 20, height: 40, justifyContent: 'center', alignItems: 'center' },

  label: {
    alignSelf: 'flex-start',
    fontSize: 12,
    fontWeight: 'bold',
    color: '#666',
  },
  inputVisivel: {
    width: '100%',
    height: 45,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingHorizontal: 15,
    marginTop: 5,
    marginBottom: 15,
    backgroundColor: '#f9f9f9',
    fontSize: 16,
    color: '#111',
  },
  btnTxtBranco: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 18
  },
  btnCadastroLargo: {
    backgroundColor: BRAND_GREEN,
    padding: 15,
    borderRadius: 8,
    marginTop: 20,
    alignItems: 'center'
  },
  cardProdutoHorizontal: {
    flexDirection: 'row',
    padding: 14,
    backgroundColor: '#fff',
    alignItems: 'center',
    borderRadius: 16,
    marginHorizontal: 16,
    marginBottom: 12,
    elevation: 3,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
  fotoProdutoEsquerda: {
    width: 88,
    height: 88,
    borderRadius: 12,
    marginRight: 13,
  },
  chipsContainer: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
    gap: 10,
  },
  chip: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#ececec',
    backgroundColor: '#fff',
    elevation: 1,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
  chipTxt: {
    fontSize: 13,
    fontWeight: '700',
    color: '#555',
  },
  descricaoProduto: {
    fontSize: 12,
    color: '#777',
    marginVertical: 3,
    lineHeight: 17,
  },
  btnAdicionar: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: BRAND_GREEN,
    width: 35,
    height: 35,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center'
  },
  btnAdicionarTxt: { color: BRAND_GREEN, fontSize: 20, fontWeight: 'bold' },
  cardGrade: {
    marginBottom: 12,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 10,
    elevation: 2,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  fotoGrade: { width: '100%', borderRadius: 8, marginBottom: 8 },
  nomeGrade: { fontSize: 13, fontWeight: '700', color: '#1a1a1a' },
  precoGrade: { fontSize: 14, fontWeight: 'bold', color: BRAND_GREEN },
  btnAdicionarGrade: {
    backgroundColor: '#fff',
    borderWidth: 1,
    width: 28,
    height: 28,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  heroBanner: {
    width: '100%',
    height: 190,
  },
  faixaDestaque: {
    marginTop: 10,
    marginHorizontal: 16,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
  },
  faixaDestaqueTxt: { color: '#fff', fontWeight: '800', fontSize: 14 },
  fotoDetalheProduto: { width: '100%', height: 240 },
  btnFecharDetalhe: {
    position: 'absolute',
    top: 15,
    right: 15,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#fff',
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  nomeDetalheProduto: { fontSize: 20, fontWeight: 'bold', color: '#1a1a1a' },
  descricaoDetalheProduto: { fontSize: 14, color: '#666', lineHeight: 21, marginTop: 15 },

  // Aba Perfil (Você)
  containerPerfil: { flex: 1, padding: 20, backgroundColor: '#f9f9f9' },
  headerPerfil: { alignItems: 'center', marginBottom: 30 },
  avatar: { width: 80, height: 80, borderRadius: 40, backgroundColor: '#eee', justifyContent: 'center', alignItems: 'center', marginBottom: 10 },
  nomeUsuario: { fontSize: 22, fontWeight: 'bold', color: '#333' },
  infoUsuario: { fontSize: 16, color: '#777' },
  cardInfo: { backgroundColor: '#fff', padding: 15, borderRadius: 10, elevation: 2 },
  labelPerfil: { fontSize: 14, fontWeight: 'bold', color: BRAND_GREEN, marginBottom: 10 },
  valorPerfil: { fontSize: 16, color: '#555', marginBottom: 5 },
  btnSair: { marginTop: 30, alignItems: 'center', padding: 15 },

  tabTxt: { fontSize: 10, fontWeight: 'bold', marginTop: 2 },
  // Sacola de Compras (Carrinho)
  badge: {
    position: 'absolute',
    right: -12,
    top: -5,
    backgroundColor: '#e74c3c',
    borderWidth: 1.5,
    borderColor: '#fff',
    borderRadius: 10,
    width: 18,
    height: 18,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  badgeTxt: {
    color: 'white',
    fontSize: 10,
    fontWeight: 'bold'
  },

  // Estilos da Sacola
  headerSimples: { padding: 20, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#eee' },
  tituloSecao: { fontSize: 20, fontWeight: 'bold', color: '#333' },
  containerVazio: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40 },
  txtVazio: { fontSize: 16, color: '#999', marginTop: 10, marginBottom: 20 },
  btnVoltar: { backgroundColor: BRAND_GREEN, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 20 },

  cardItemCarrinho: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    padding: 15,
    borderRadius: 12,
    marginBottom: 10,
    alignItems: 'center',
    elevation: 2
  },
  nomeItemCarrinho: { fontSize: 16, fontWeight: 'bold', color: '#444' },
  precoItemCarrinho: { fontSize: 14, color: BRAND_GREEN, fontWeight: 'bold' },
  btnRemover: { padding: 5 },

  resumoPedido: {
    backgroundColor: '#FFF',
    paddingHorizontal: 20,
    paddingTop: 15,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    elevation: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -3 },
    shadowOpacity: 0.1,
    shadowRadius: 5,
  },
  btnIrBusca: {
    backgroundColor: BRAND_GREEN,
    paddingHorizontal: 15,
    height: '100%',
    justifyContent: 'center', // Centraliza o texto verticalmente
    alignItems: 'center',     // Centraliza o texto horizontalmente
  },
  btnIrBuscaTxt: {
    color: '#fff',            // Texto Branco
    fontWeight: 'bold',
    fontSize: 14,
  },
  cardPedido: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 15,
    marginBottom: 15,
    elevation: 3,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 5,
    borderLeftWidth: 5,
    borderLeftColor: BRAND_GREEN, // Cor de destaque da sua marca
  },
  linhaPedido: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  idPedido: { fontWeight: 'bold', fontSize: 14 },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 5,
    color: '#fff',
    fontSize: 10,
    fontWeight: 'bold',
  },

  linhaTotal: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 15 },
  txtTotalLabel: { fontSize: 16, color: '#666' },
  txtTotalValor: { fontSize: 22, fontWeight: 'bold', color: '#333' },
  btnFinalizarPedido: {
    height: 55, // Altura padrão de botão mobile
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
  },
  btnFinalizarTxt: { color: '#fff', fontSize: 18, fontWeight: 'bold' },

  topoPedido: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  dataPedido: { fontSize: 12, color: '#999' },
  badgeStatus: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 5 },
  txtStatus: { color: '#fff', fontSize: 10, fontWeight: 'bold' },
  itensPedido: { fontSize: 14, color: '#333', fontWeight: '500', marginBottom: 10 },
  rodapePedido: { borderTopWidth: 1, borderTopColor: '#eee', paddingTop: 10, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  totalPedido: { fontWeight: 'bold', fontSize: 16, color: '#333' },
  txtMotoboy: { fontSize: 12, color: BRAND_GREEN, fontWeight: 'bold', fontStyle: 'italic' },
  input: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 10,
    paddingHorizontal: 15,
    height: 50,
    fontSize: 16,
    color: '#333',
    marginBottom: 10,
  },

  // Contentor de cada secção (Dados e Pagamento)
  secaoCheckout: {
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 12,
    marginBottom: 16,
    // Sombra leve para dar profundidade
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  tituloCheckout: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 15,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
    paddingBottom: 5,
  },
  // O estilo dos Títulos dos campos (Labels)
  labelInput: {
    fontSize: 13,
    fontWeight: '600',
    color: '#7f8c8d', // Cinza médio
    marginBottom: 5,
    marginTop: 5,
  },
  // O estilo das caixas de texto
  inputCheckout: {
    backgroundColor: '#fdfdfd',
    padding: 12,
    borderRadius: 8,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#e0e0e0',
    fontSize: 15,
    color: '#2c3e50',
  },
  // Grid para os botões de pagamento
  gridPagamento: {
    flexDirection: 'column',
    gap: 10,
  },
  btnPagamento: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 15,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#dcdde1',
    backgroundColor: '#fff',
  },
  btnPagamentoAtivo: {
    borderColor: BRAND_GREEN, // Cor da tua marca
    backgroundColor: '#fff5f4', // Fundo rosado leve
  },
  txtPagamento: {
    fontSize: 15,
    color: '#2f3640',
  },
  txtPagamentoAtivo: {
    color: BRAND_GREEN,
    fontWeight: 'bold',
  },
  containerLogin: {
    flex: 1,
    backgroundColor: BRAND_GREEN,
    padding: 20,
    justifyContent: 'center', // Centraliza o card verticalmente
    alignItems: 'center',
  },
  cardLogin: {
    backgroundColor: '#fff',
    width: '100%',
    borderRadius: 15,
    padding: 20,
    elevation: 5, // Sombra no Android
    shadowColor: '#000', // Sombra no iOS
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
  },
  tituloLogin: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#333',
    textAlign: 'center',
    marginBottom: 20,
  },
  subtituloLogin: {
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
    marginBottom: 20,
  },
  inputEdicao: {
    borderBottomWidth: 1,
    borderBottomColor: '#bdc3c7',
    padding: 5,
    marginBottom: 5,
    color: '#2c3e50',
    width: '80%',
  },
  btnAlterar: {
    padding: 10,
    borderRadius: 8,
    backgroundColor: '#f1f2f6',
  },
  overlayModal: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  cardModal: {
    width: '100%', // Ocupa a largura toda
    backgroundColor: '#fff',
    borderTopLeftRadius: 25,
    borderTopRightRadius: 25,
    padding: 20,
    maxHeight: '90%', // Impede de sumir no topo
    elevation: 10,
  },
  tituloModal: {
    fontSize: 20,
    fontWeight: 'bold',
    marginTop: 15,
    textAlign: 'center',
  },
  textoModal: {
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
    marginVertical: 15,
  },
  btnModal: {
    paddingHorizontal: 30,
    paddingVertical: 12,
    borderRadius: 25,
    marginTop: 10,
  },
  cardPix: {
    backgroundColor: '#fff',
    width: '90%',
    borderRadius: 20,
    padding: 25,
    alignItems: 'center',
  },
  tituloPix: { fontSize: 22, fontWeight: 'bold', color: BRAND_GREEN, marginBottom: 10 },
  subtituloPix: { textAlign: 'center', color: '#666', marginBottom: 20 },
  boxCodigo: {
    backgroundColor: '#f1f2f6',
    padding: 15,
    borderRadius: 10,
    borderStyle: 'dashed',
    borderWidth: 1,
    borderColor: '#bdc3c7',
    width: '100%',
  },
  textoCodigo: { fontSize: 12, color: '#34495e', textAlign: 'center' },
  btnCopiar: {
    backgroundColor: BRAND_GREEN,
    width: '100%',
    padding: 15,
    borderRadius: 10,
    marginTop: 20,
    alignItems: 'center',
  },
  textoBtnCopiar: { color: '#fff', fontWeight: 'bold' },
  btnFecharPix: { marginTop: 15, padding: 10 },

  containerFidelidade: {
    paddingHorizontal: 20,
    marginTop: 10,
    marginBottom: 10,
  },
  cartaoFidelidade: {
    backgroundColor: '#1e1e1e', // Cor escura luxuosa
    borderRadius: 20,
    padding: 20,
    elevation: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    borderWidth: 1,
    borderColor: '#d4af37', // Borda dourada sutil
  },
  cartaoTopo: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 15,
  },
  cartaoTitulo: {
    color: '#d4af37',
    fontWeight: 'bold',
    fontSize: 14,
    letterSpacing: 1,
  },
  cartaoEmoji: { fontSize: 20 },
  cartaoConteudo: {
    paddingVertical: 15,
    paddingHorizontal: 0,
  },
  labelSaldo: { color: '#aaa', fontSize: 12, textTransform: 'uppercase' },
  rowPontos: { flexDirection: 'row', alignItems: 'baseline' },
  valorPontosGrandes: { color: '#fff', fontSize: 48, fontWeight: 'bold' },
  labelPontosTexto: { color: '#d4af37', fontSize: 20, fontWeight: 'bold', marginLeft: 5 },
  cartaoBase: {
    marginTop: 15,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 0.2,
    borderTopColor: '#555',
    paddingTop: 10,
  },
  botaoSairFlutuante: {
    position: 'absolute', // Retira o botão do fluxo normal do layout
    right: 15,            // Distância da borda direita
    top: 15,              // Distância do topo
    padding: 10,          // Área de toque maior
    zIndex: 10,           // Garante que fique por cima de tudo
  },
  secaoIdentidade: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
  },
  avatarMini: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#f0f0f0',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#ddd',
  },
  dadosPrincipais: {
    marginLeft: 15,
    flex: 1,
  },
  nomeIdentidade: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#2c3e50',
  },
  sublabelIdentidade: {
    fontSize: 10,
    color: '#95a5a6',
    textTransform: 'uppercase',
    marginTop: 5,
    fontWeight: 'bold',
  },
  infoIdentidade: {
    fontSize: 14,
    color: '#34495e',
  },
  divisor: {
    height: 1,
    backgroundColor: '#eee',
    marginVertical: 15,
  },
  inputEdicaoIdentidade: {
    borderBottomWidth: 1,
    borderBottomColor: '#3498db',
    paddingVertical: 2,
    fontSize: 14,
    color: '#2c3e50',
  },
  containerBotoesEdicao: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 20,
    gap: 10, // Espaço entre os botões
  },
  btnAcaoIdentidade: {
    paddingVertical: 12,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  btnCancelarEdicao: {
    flex: 1,
    backgroundColor: '#fff5f5',
    borderColor: '#fab1a0',
  },
  idUsuarioMini: { color: '#666', fontSize: 10 },
  badgeVip: { backgroundColor: '#d4af37', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 5 },
  txtVip: { color: '#000', fontSize: 10, fontWeight: 'bold' },
});
