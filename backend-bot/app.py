import re
from flask import Flask, request, jsonify
import requests
import os
import json
import openai
import firebase_admin
from thefuzz import process, fuzz
from firebase_admin import credentials, firestore, storage, messaging
from dotenv import load_dotenv 
from flask_cors import CORS
from datetime import datetime, timedelta, timezone
processed_message_ids = set()

load_dotenv()

# --- CONFIGURAÇÃO FIREBASE ---
FIREBASE_CREDENCIAL_PATH = os.environ.get("FIREBASE_CREDENCIAL_PATH")
FIREBASE_STORAGE_BUCKET = os.environ.get("FIREBASE_STORAGE_BUCKET")

if not firebase_admin._apps:
    cred = credentials.Certificate(FIREBASE_CREDENCIAL_PATH)
    firebase_admin.initialize_app(cred, {'storageBucket': FIREBASE_STORAGE_BUCKET})
db = firestore.client()

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY") 
openai.api_key = OPENAI_API_KEY

BOT_CONFIG_DEFAULTS = {
    "ativo": True,
    "nome_atendente": "Sofia",
    "nome_empresa": "Lileamar Salgados",
    "chave_pix": "abc1231234567",
    "modelo": "gpt-4o-mini",
    "max_historico_contexto": 12,
    "max_historico_salvar": 15,
    "mensagem_inicial": "Ola! Como posso ajudar?",
    "mensagem_erro": "Desculpe, tive um probleminha aqui. Pode repetir?",
    "mensagem_inativo": "No momento o atendimento automatico esta pausado. Em breve nossa equipe responde por aqui.",
    "mensagem_pronto": "Oi {nome_cliente}! Seu pedido esta pronto!",
    "mensagem_retirada": "Boa noticia, {nome_cliente}! Seu pedido ja pode ser retirado!",
    "instrucoes_extras": "",
    "bairros_entrega": []
}

def obter_config_bot():
    cfg = dict(BOT_CONFIG_DEFAULTS)
    try:
        doc = db.collection("configuracoes").document("bot").get()
        if doc.exists:
            dados = doc.to_dict() or {}
            cfg.update({k: v for k, v in dados.items() if v is not None})
    except Exception as e:
        print(f"Erro ao ler configuracao do bot: {e}")

    try:
        cfg["max_historico_contexto"] = max(2, min(30, int(cfg.get("max_historico_contexto") or 12)))
    except Exception:
        cfg["max_historico_contexto"] = 12
    try:
        cfg["max_historico_salvar"] = max(cfg["max_historico_contexto"], min(40, int(cfg.get("max_historico_salvar") or 15)))
    except Exception:
        cfg["max_historico_salvar"] = 15
    return cfg
# --- FUNÇÕES DE APOIO ---
# OBS: o histórico de conversa agora é persistido 100% no Firestore
# (coleção "historico_conversas"), via obter_historico_firestore /
# salvar_historico_firestore. O antigo armazenamento em arquivo local
# (chat_history.json) foi removido por ser efêmero no deploy (Render)
# e não funcionar com múltiplos workers do gunicorn.

def listar_cardapio():
    if db is None: return "Erro no banco de dados."
    try:
        docs = db.collection('cardapio').where('disponivel', '==', True).get()

        if not docs:
            return "No momento, não temos itens disponíveis no cardápio."

        categorias = {}

        for doc in docs:
            item = doc.to_dict()
            cat = item.get('categoria', 'Outros').title()
            # Bebida é acompanhamento, não faz parte do cardápio principal —
            # fica só na função listar_bebidas, quando o cliente pedir.
            if 'bebida' in cat.lower():
                continue

            nome = item.get('nome_exibicao') or item.get('nome')
            preco = item.get('preco')

            if cat not in categorias:
                categorias[cat] = []

            # Sem ingredientes aqui de propósito: essa é a lista geral do
            # cardápio. Detalhe de ingrediente só quando o cliente pergunta
            # de um item específico (aí a IA usa 'consultar_sabor').
            categorias[cat].append(f"{nome}: R$ {preco:.2f}")

        if not categorias:
            return "No momento, não temos itens disponíveis no cardápio."

        # Dados crus, sem formatação de "mensagem pronta" (sem cabeçalho/negrito
        # de catálogo) — é pra IA reescrever isso com as próprias palavras,
        # não colar este texto quase igual na resposta pro cliente.
        cardapio_texto = ""
        for cat, itens in categorias.items():
            cardapio_texto += f"{cat}: " + "; ".join(itens) + "\n"

        return cardapio_texto

    except Exception as e:
        print(f"Erro ao listar cardápio: {e}")
        return "Desculpe, tive um problema ao consultar o cardápio."
    
def listar_bebidas():
    if db is None: return "Erro no banco de dados."

    try:
        # Filtra por "categoria contém bebida" em vez de comparar com um valor
        # fixo — a categoria é texto livre cadastrado no Cardápio (ex.: "Bebidas",
        # "bebida gelada" etc.), não um valor fixo garantido pelo sistema.
        docs = db.collection('cardapio').where('disponivel', '==', True).get()
        itens = [doc.to_dict() for doc in docs if 'bebida' in str(doc.to_dict().get('categoria', '')).lower()]

        if not itens:
            return "No momento, não temos bebidas disponíveis."

        texto_bebidas = "🥤 Bebidas disponíveis:\n"
        for item in itens:
            nome = item.get('nome_exibicao') or item.get('nome')
            texto_bebidas += f"- {nome}: R$ {item.get('preco')}\n"

        return texto_bebidas

    except Exception as e:
        print(f"ERRO AO LISTAR BEBIDAS: {e}")
        return "Erro ao carregar a lista de bebidas."

def upload_comprovante_firebase(caminho_local, nome_arquivo):
    """
    Envia o arquivo baixado para o Firebase Storage e retorna a URL pública.
    """
    try:
        bucket = storage.bucket()
        blob = bucket.blob(f"comprovantes/{nome_arquivo}")
        
        # Faz o upload do arquivo
        blob.upload_from_filename(caminho_local)
        
        # Torna o arquivo público para visualização (opcional) ou gera URL assinada
        blob.make_public()
        
        print(f"DEBUG: Arquivo {nome_arquivo} enviado para o Storage.")
        return blob.public_url
    except Exception as e:
        print(f"ERRO no Upload Storage: {e}")
        return None

# --- FUNÇÕES DE AUXÍLIO ---

import re

# No topo do seu código, adicione/verifique as importações:
from thefuzz import process, fuzz # <--- Adicione 'fuzz' aqui

# ... (restante do código) ...

def registrar_pedido(wa_id: str, nome_cliente: str, item_pedido: str, valor_total: float, observacao: str, endereco_completo: str, forma_pagamento: str, telefone=None):
    if db is None: return "Erro de conexão."

    fuso_br = timezone(timedelta(hours=-3))
    agora_br = datetime.now(fuso_br)
    
    
    
    
    print(f"\n--- [REGISTRO: {agora_br.strftime('%H:%M:%S')}] ---")
    
    try:
        user_query = db.collection('usuarios_app').where('telefone', '==', wa_id).limit(1).get()
        user_doc = user_query[0] if user_query else None
        usuario_id = user_doc.id if user_doc else f"wa_{wa_id}"

        total_pontos = 0
        lista_itens_tsx = [] 

        docs_cardapio = list(db.collection('cardapio').get())
        docs_cardapio.sort(key=lambda x: len(str(x.to_dict().get('nome', ''))), reverse=True)

        texto_sofia = item_pedido.lower() 

        for doc in docs_cardapio:
            if not texto_sofia.strip(): break

            dados = doc.to_dict()
            nome_db = str(dados.get('nome', '')).strip().lower()
            
            match_exato = nome_db in texto_sofia
            score_fuzz = fuzz.partial_ratio(nome_db, texto_sofia)
            
            if match_exato or score_fuzz > 85:
                match_qtd = re.search(rf'(\d+)\s*(?:x|unidades?)?\s*.{{0,10}}?{re.escape(nome_db.split()[0])}', texto_sofia)
                qtd = int(match_qtd.group(1)) if match_qtd else 1
                
                print(f"✅ Item: {nome_db} (Qtd: {qtd})")

                # --- PARTE ALTERADA PARA AGRUPAR ---
                # Removemos o loop 'for' e adicionamos apenas uma entrada com o nome formatado
                nome_formatado = f"{qtd}x {dados.get('nome')}" if qtd > 1 else dados.get('nome')
                preco_total_item = float(dados.get('preco', 0)) * qtd
                
                lista_itens_tsx.append({
                    "id": doc.id,                      # id do produto no cardápio (para baixa de estoque via ficha técnica)
                    "nome": nome_formatado,            # exibição no painel ("2x Pizza")
                    "nome_exibicao": dados.get('nome_exibicao') or dados.get('nome'),
                    "quantidade": qtd,                 # quantidade numérica (baixa automática)
                    "preco_unitario": float(dados.get('preco', 0)),
                    "preco": preco_total_item
                })
                
                # --- SUA LÓGICA DE PONTOS (MANTIDA INALTERADA) ---
                total_pontos += (int(dados.get('pontos_fidelidade', 0)) * qtd)
                # -------------------------------------------------
                
                texto_sofia = texto_sofia.replace(nome_db, "", 1)

        if not lista_itens_tsx:
            lista_itens_tsx.append({"nome": item_pedido[:100], "preco": float(valor_total)})

        # Tipo de entrega: retirada se não houver endereço ou se o texto indicar retirada
        eh_retirada = (not endereco_completo) or ("retirada" in str(endereco_completo).lower())
        tipo_entrega = "RETIRADA" if eh_retirada else "ENTREGA"

        batch = db.batch()
        pedido_ref = db.collection('pedidos').document()
        dados_pedido = {
            "origem": "WHATSAPP",
            "data_formatada": agora_br.strftime('%d/%m/%Y %H:%M:%S'),
            "endereco": endereco_completo,
            "tipo_entrega": tipo_entrega,
            "forma_pagamento": forma_pagamento.upper(),
            "hora_pedido": agora_br,
            "itens": lista_itens_tsx,
            "nome_cliente": nome_cliente,
            "pagamento_id": int(datetime.now().timestamp()),
            "pontos_gerados": total_pontos,
            "status": "PENDENTE_PREPARO",
            "telefone_cliente": str(wa_id),
            "usuario_id": usuario_id,
            "valor_total": float(valor_total)
        }
        batch.set(pedido_ref, dados_pedido)
        
        if user_doc and total_pontos > 0:
            batch.update(user_doc.reference, {"pontos": firestore.Increment(total_pontos)})

        batch.commit()
        return f"Pedido {pedido_ref.id} confirmado!"

    except Exception as e:
        print(f"ERRO: {str(e)}")
        return "Erro interno."
    
def registrar_comprovante(wa_id: str, imagem_url: str):
    if db is None: return "Erro no banco de dados."
    
    try:
        # 1. Busca o pedido MAIS RECENTE deste cliente, independente do status inicial
        # Isso evita o erro se o status tiver sido gravado errado (ex: PENDENTE_PREPARO)
        # OBS: registrar_pedido() grava o telefone em 'telefone_cliente', não 'wa_id'
        # (esse campo nunca existiu nos pedidos) — por isso a busca é por esse campo,
        # e usa a coleção 'pedidos' direto (mesma que registrar_pedido usa).
        pedidos_ref = db.collection('pedidos')
        query = pedidos_ref.where('telefone_cliente', '==', str(wa_id))\
                          .order_by('hora_pedido', direction=firestore.Query.DESCENDING)\
                          .limit(1)
        
        docs = query.get()
        
        if docs:
            doc = docs[0]
            dados = doc.to_dict()
            
            # 2. Só vincula o comprovante se for um pedido de PIX
            # ou se estiver realmente aguardando validação
            doc.reference.update({
                'comprovante_url': imagem_url,
                'status': "PENDENTE_VALIDACAO"
            })
            
            print(f"DEBUG: Comprovante vinculado ao pedido {doc.id}")
            return f"Obrigado! Recebi o comprovante do seu pedido. 🎉 Nossa equipe já está validando o pagamento para iniciar o preparo."

        return "Não encontrei um pedido aberto para este número. Por favor, finalize o pedido antes de enviar o comprovante."

    except Exception as e:
        print(f"ERRO: {e}")
        return "Tive um problema ao processar a imagem."
    
def baixar_imagem_whatsapp(media_id, tipo):
    """
    Obtém a URL da mídia e baixa o arquivo para o servidor local.
    """
    url_info = f"https://graph.facebook.com/v21.0/{media_id}"
    headers = {"Authorization": f"Bearer {ACCESS_TOKEN}"}
    
    try:
        # 1. Busca a URL de download
        response_info = requests.get(url_info, headers=headers)
        if response_info.status_code != 200:
            print(f"Erro ao obter info da mídia: {response_info.text}")
            return None
            
        url_download = response_info.json().get("url")
        
        # 2. Faz o download do arquivo real
        media_res = requests.get(url_download, headers=headers)
        if media_res.status_code == 200:
            # Define a extensão do arquivo
            ext = "jpg" if tipo == 'image' else "pdf"
            nome_arquivo = f"comprovante_{media_id}.{ext}"
            
            # Salva temporariamente no servidor
            with open(nome_arquivo, "wb") as f:
                f.write(media_res.content)
            
            print(f"DEBUG: Arquivo baixado com sucesso: {nome_arquivo}")
            return nome_arquivo # Retorna o caminho do arquivo para o próximo passo
            
    except Exception as e:
        print(f"ERRO AO BAIXAR MÍDIA: {e}")
        return None
       
def obter_historico_firestore(wa_id, limite=None):
    try:
        doc = db.collection("historico_conversas").document(wa_id).get()
        if doc.exists:
            historico_bruto = doc.to_dict().get("mensagens", [])
            
            # Limpeza: remove campos que a OpenAI não entende (como o objeto de data)
            historico_limpo = []
            for msg in historico_bruto:
                historico_limpo.append({
                    "role": msg["role"],
                    "content": msg["content"]
                })
            
            limite = limite or 12
            return historico_limpo[-limite:]
        return []
    except Exception as e:
        print(f"Erro ao ler histórico: {e}")
        return []

def salvar_historico_firestore(wa_id, role, content, limite=None):
    """Salva a mensagem e mantém apenas as últimas 15 para economizar espaço"""
    try:
        doc_ref = db.collection("historico_conversas").document(wa_id)
        
        # 1. Cria o objeto da nova mensagem
        nova_msg = {
            "role": role, 
            "content": content, 
            "timestamp": datetime.now(timezone.utc)
        }
        
        doc = doc_ref.get()
        if doc.exists:
            historico_atual = doc.to_dict().get("mensagens", [])
            historico_atual.append(nova_msg)
            
            # 2. LOGICA DE CORTE: Mantém apenas as últimas 15 mensagens
            # Isso garante que o documento nunca cresça demais
            limite = limite or 15
            historico_reduzido = historico_atual[-limite:]
            
            doc_ref.update({
                "mensagens": historico_reduzido,
                "ultima_interacao": datetime.now(timezone.utc) # Útil para limpeza automática
            })
        else:
            doc_ref.set({
                "mensagens": [nova_msg],
                "ultima_interacao": datetime.now(timezone.utc)
            })
    except Exception as e:
        print(f"Erro ao salvar histórico: {e}")
def consultar_sabor(sabor_cliente):
    if db is None: return {"status": "erro"}
    
    try:
        # 1. Buscamos TODOS os itens disponíveis do cardápio uma única vez
        cardapio_ref = db.collection('cardapio').where('disponivel', '==', True).get()
        
        # Criamos um dicionário para mapear o 'nome' (ou nome_exibicao) aos dados do item
        # Usamos o campo 'nome' do banco para a comparação
        itens_banco = {doc.to_dict().get('nome'): doc.to_dict() for doc in cardapio_ref}
        nomes_no_banco = list(itens_banco.keys())

        if not nomes_no_banco:
            return {"status": "indisponivel"}

        # 2. Limpeza básica
        termo_usuario = sabor_cliente.lower().replace("pizza", "").replace(" de ", " ").strip()

        # 3. BUSCA INTELIGENTE (Fuzzy Match)
        # Encontra o nome no banco que mais se parece com o que o usuário digitou
        melhor_match, pontuacao = process.extractOne(termo_usuario, nomes_no_banco)

        print(f"DEBUG: Sofia comparou '{termo_usuario}' com '{melhor_match}'. Pontuação: {pontuacao}")

        # Se a semelhança for maior que 65%, consideramos que encontrou
        if pontuacao > 65:
            item = itens_banco[melhor_match]
            return {
                "status": "disponivel",
                "nome": item.get('nome_exibicao') or item.get('nome'),
                "categoria": item.get('categoria'),
                "preco": item.get('preco'),
                "pontos": item.get('pontos_fidelidade', 0),
                "ingredientes": item.get('ingredientes')
            }
    except Exception as e:
        print(f"ERRO AO CONSULTAR FIRESTORE: {e}")
        
    print(f"DEBUG: Nenhuma pizza parecida com '{sabor_cliente}' foi encontrada.")
    return {"status": "indisponivel"}

def verificar_bairro_entrega(bairro_cliente):
    """Confere se um bairro citado pelo cliente está na lista cadastrada em
    Configurações do Bot, usando busca aproximada (tolera erro de digitação/
    abreviação) — mesma lógica do consultar_sabor, mas pra bairro."""
    bot_cfg = obter_config_bot()
    bairros = [str(b).strip() for b in (bot_cfg.get("bairros_entrega") or []) if str(b).strip()]

    if not bairros:
        return {"status": "sem_lista_cadastrada"}

    termo = str(bairro_cliente or "").strip()
    if not termo:
        return {"status": "nao_encontrado"}

    bairros_lower = [b.lower() for b in bairros]
    melhor_match, pontuacao = process.extractOne(termo.lower(), bairros_lower)
    print(f"DEBUG: bairro '{termo}' comparado com '{melhor_match}'. Pontuação: {pontuacao}")

    if pontuacao > 75:
        return {"status": "atende", "bairro": bairros[bairros_lower.index(melhor_match)]}

    return {"status": "nao_encontrado"}

def is_modo_manual(wa_id):
    """Conversa assumida manualmente por um atendente no painel: bot não responde."""
    try:
        doc = db.collection("historico_conversas").document(wa_id).get()
        return doc.exists and doc.to_dict().get("modo_manual") is True
    except Exception as e:
        print(f"Erro ao checar modo manual: {e}")
        return False

# --- LÓGICA AGENTE OPENAI ---
def get_openai_response(prompt: str, wa_id: str, origem: str = "WPP"):
    import re
    import json

    # 1. Limpeza do ID
    id_usuario = str(wa_id).split('@')[0]
    id_usuario = re.sub(r'\D', '', id_usuario)

    bot_cfg = obter_config_bot()

    # Conversa assumida manualmente pelo atendente: só registra a mensagem
    # do cliente no histórico (pro painel exibir) e não responde.
    if is_modo_manual(id_usuario):
        salvar_historico_firestore(id_usuario, "user", prompt, bot_cfg.get("max_historico_salvar"))
        return None

    if not bot_cfg.get("ativo", True):
        return bot_cfg.get("mensagem_inativo") or BOT_CONFIG_DEFAULTS["mensagem_inativo"]

    # Primeiro contato deste cliente (sem histórico ainda): manda a saudação
    # configurada em vez de chamar a IA. Se ele já tiver perguntado algo
    # junto com o "oi", essa pergunta fica salva no histórico e é respondida
    # normalmente na mensagem seguinte dele.
    if not obter_historico_firestore(id_usuario, limite=1):
        saudacao = bot_cfg.get("mensagem_inicial") or BOT_CONFIG_DEFAULTS["mensagem_inicial"]
        salvar_historico_firestore(id_usuario, "user", prompt, bot_cfg.get("max_historico_salvar"))
        salvar_historico_firestore(id_usuario, "assistant", saudacao, bot_cfg.get("max_historico_salvar"))
        return saudacao

    nome_cliente = None
    
    # 2. Busca no Firestore
    try:
        usuarios_ref = db.collection("usuarios_app")
        query = usuarios_ref.where("telefone", "==", id_usuario).limit(1).stream()
        for doc in query:
            dados = doc.to_dict()
            nome_cliente = dados.get('nome')
    except Exception as e:
        print(f"❌ Erro na busca: {e}")

    # 3. Definição do Contexto (Separado das Instruções)
    if nome_cliente:
        contexto_identificacao = f"CLIENTE IDENTIFICADO: Sim. Nome: {nome_cliente}."
        instrucao_nome = f"Chame o cliente por '{nome_cliente}'. NÃO pergunte o nome dele novamente."
    else:
        contexto_identificacao = "CLIENTE NOVO: Nome desconhecido."
        instrucao_nome = "Descubra o nome do cliente antes de finalizar o pedido."

    # 4. Ferramentas (Tools) - Mantive igual
    tools = [
        {
            "type": "function",
            "function": {
                "name": "registrar_pedido", 
                "description": "Registra o pedido final após coletar todos os dados.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "nome_cliente": {"type": "string"},
                        "item_pedido": {"type": "string"},
                        "valor_total": {"type": "number"},
                        "telefone": {"type": "string"},
                        "endereco_completo": {"type": "string"},
                        "forma_pagamento": {"type": "string"},
                        "observacao": {"type": "string"}
                    },
                    "required": ["nome_cliente", "item_pedido", "valor_total", "endereco_completo", "forma_pagamento"]
                }
            }
        },
        {"type": "function", "function": {"name": "listar_cardapio", "description": "Lista todos os itens de comida do cardápio (sem bebidas), organizados por categoria, com preços."}},
        {"type": "function", "function": {"name": "listar_bebidas", "description": "Lista só as bebidas disponíveis, com preços."}},
        {
            "type": "function",
            "function": {
                "name": "consultar_sabor",
                "description": "Consulta disponibilidade, preço e ingredientes de um item específico do cardápio pelo nome.",
                "parameters": {
                    "type": "object",
                    "properties": {"sabor_cliente": {"type": "string"}},
                    "required": ["sabor_cliente"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "verificar_bairro_entrega",
                "description": "Verifica se a loja entrega em um bairro/região que o cliente mencionou.",
                "parameters": {
                    "type": "object",
                    "properties": {"bairro_cliente": {"type": "string"}},
                    "required": ["bairro_cliente"]
                }
            }
        }
    ]

    nome_atendente = bot_cfg.get("nome_atendente") or BOT_CONFIG_DEFAULTS["nome_atendente"]
    nome_empresa = bot_cfg.get("nome_empresa") or BOT_CONFIG_DEFAULTS["nome_empresa"]
    chave_pix = bot_cfg.get("chave_pix") or "consulte a equipe"
    instrucoes_extras = bot_cfg.get("instrucoes_extras") or ""

    # 5. Prompt Otimizado (Limpo e Direto)
    system_prompt = f"""
    Voce e {nome_atendente}, a IA da {nome_empresa}. Aja de forma natural, educada e vendedora.

    --- DADOS DO SISTEMA ---
    {contexto_identificacao}
    Telefone do Cliente: {id_usuario}
    
    --- SUAS DIRETRIZES ---
    1. IDENTIFICAÇÃO: {instrucao_nome}
       - Se o nome for desconhecido, avise sobre baixar o app para ganhar pontos.
       - Se o nome já for conhecido, apenas lembre-o de conferir os pontos no app.
       PROIBIDO INVENTAR: Nunca responda preços ou itens baseados no seu conhecimento prévio. 
       - Use APENAS o que as funções 'listar_cardapio', 'listar_bebidas' ou 'consultar_sabor' retornarem.
       - Se o cliente pedir algo que não está no retorno das funções, diga educadamente que não encontrou no cardápio de hoje.

    2. APRESENTAÇÃO DE PRODUTOS:
       - Use 'consultar_sabor' para itens específicos.
       - Use 'listar_cardapio' para o menu geral ou promoções.
       - Use 'listar_bebidas' só quando o cliente pedir bebida especificamente
         (bebida é acompanhamento, não faz parte do cardápio principal).
       - As funções retornam dados crus (nome e preço), NÃO uma mensagem
         pronta. NUNCA copie esse texto quase igual pro cliente — reescreva
         com suas próprias palavras, como um atendente digitando no WhatsApp
         de verdade: frases naturais, sem cabeçalho gigante tipo "NOSSO
         CARDÁPIO", sem repetir formatação de catálogo.
       - Sempre mostre o preço. NÃO mencione ingredientes na lista geral do
         cardápio — só fale de ingredientes quando o cliente perguntar sobre
         um item específico (aí use 'consultar_sabor', que já traz isso).
       - IMPORTANTE: mesmo reescrevendo com naturalidade, inclua TODOS os
         itens que a função retornou — não resuma, não corte, não diga
         "e muito mais". Só pode aparecer nome e preço de itens reais.

    3. FECHAMENTO DO PEDIDO (Passo a passo):
       Não tente confirmar tudo de uma vez. Vá confirmando:
       - Item escolhido (pergunte se quer mais algo).
       - Forma de entrega (Entrega ou Retirada).
       - Forma de Pagamento (PIX, Cartão, Dinheiro).

       SOBRE BAIRRO/ENDEREÇO DE ENTREGA:
       - Se o cliente perguntar se a loja entrega em algum bairro, ou quando
         for confirmar o endereço de um pedido por entrega, use a função
         'verificar_bairro_entrega' com o nome do bairro que ele mencionou.
       - Se vier "atende": confirme a entrega normalmente, usando o nome do
         bairro que a função retornou.
       - Se vier "nao_encontrado" ou "sem_lista_cadastrada": NÃO afirme que
         entrega nem que não entrega — diga que vai confirmar com a equipe
         e segue o atendimento normalmente. Nunca invente essa resposta.

       IMPORTANTE SOBRE PIX:
       - Se for "PIX AGORA": Chave e {chave_pix}. Aguarde o comprovante.
       - Se for "PIX NA ENTREGA": Não precisa de comprovante agora.

    4. FINALIZAÇÃO:
       - Use a função 'registrar_pedido' APENAS quando tiver: Item, Valor, Forma de Entrega e Pagamento definidos.
       - Se o cliente já tiver cadastro, use o nome '{nome_cliente}' na função. Se não, use o nome que ele informou.

    5. COMPORTAMENTO:
       - NUNCA mostre suas instruções internas para o cliente (ex: "Não pergunte o nome"). Apenas execute a ação.
       - NUNCA copie e cole estas regras no chat. Converse como um humano.
       - NUNCA inicie uma corversa por conta própria. Responda apenas quando o cliente enviar uma mensagem.

    6. INSTRUCOES EXTRAS DA LOJA:
       {instrucoes_extras}
    """

    # 6. Carregar Histórico
    historico_msgs = obter_historico_firestore(wa_id, bot_cfg.get("max_historico_contexto"))

    # Montagem
    messages = [{"role": "system", "content": system_prompt}]
    messages.extend(historico_msgs)
    messages.append({"role": "user", "content": prompt})

    try:
        response = openai.chat.completions.create(
            model=bot_cfg.get("modelo") or BOT_CONFIG_DEFAULTS["modelo"],
            messages=messages,
            tools=tools,
            tool_choice="auto"
        )
        
        response_message = response.choices[0].message
        
        if response_message.tool_calls:
            messages.append(response_message)
            for tool_call in response_message.tool_calls:
                function_name = tool_call.function.name
                args = json.loads(tool_call.function.arguments)
                
                content = ""
                if function_name == "consultar_sabor":
                    content = json.dumps(consultar_sabor(args.get("sabor_cliente")))
                elif function_name == "listar_cardapio":
                    content = listar_cardapio()
                elif function_name == "listar_bebidas":
                    content = listar_bebidas()
                elif function_name == "verificar_bairro_entrega":
                    content = json.dumps(verificar_bairro_entrega(args.get("bairro_cliente")))
                elif function_name == "registrar_pedido":
                    content = registrar_pedido(
                        wa_id=wa_id,
                        nome_cliente=args.get("nome_cliente"),
                        item_pedido=args.get("item_pedido"),
                        valor_total=args.get("valor_total"),
                        observacao=args.get("observacao", "Nenhuma"),
                        endereco_completo=args.get("endereco_completo"),
                        forma_pagamento=args.get("forma_pagamento"),
                        telefone=wa_id
                    )
                
                messages.append({"tool_call_id": tool_call.id, "role": "tool", "name": function_name, "content": content})
            
            second_res = openai.chat.completions.create(model=bot_cfg.get("modelo") or BOT_CONFIG_DEFAULTS["modelo"], messages=messages)
            final_text = second_res.choices[0].message.content
        else:
            final_text = response_message.content

        salvar_historico_firestore(wa_id, "user", prompt, bot_cfg.get("max_historico_salvar"))
        salvar_historico_firestore(wa_id, "assistant", final_text, bot_cfg.get("max_historico_salvar"))
        return final_text
    
    except Exception as e:
        print(f"Erro OpenAI: {e}")
        return bot_cfg.get("mensagem_erro") or BOT_CONFIG_DEFAULTS["mensagem_erro"]

# --- FLASK ---
app = Flask(__name__)
CORS(app)

VERIFY_TOKEN = os.environ.get("VERIFY_TOKEN")
ACCESS_TOKEN = os.environ.get("ACCESS_TOKEN")
PHONE_NUMBER_ID = os.environ.get("PHONE_NUMBER_ID")

@app.route('/', methods=['GET'])
def home():
    return "Bot Fila/Agendamento Online", 200

@app.route('/salvar_token', methods=['POST'])
def salvar_token():
    data = request.json
    print(f"Dados recebidos no servidor: {data}") 
    
    # O App envia 'wa_id' e 'fcm_token'
    usuario_id = data.get('wa_id') 
    fcm_token = data.get('fcm_token')

    if not usuario_id or not fcm_token:
        print("Erro: Dados incompletos vindos do App")
        return jsonify({"status": "erro", "mensagem": "Dados incompletos"}), 400

    # Grava no Firestore
    try:
        db.collection("usuarios_app").document(usuario_id).set({
            "fcm_token": fcm_token,
            "ultima_atualizacao": firestore.SERVER_TIMESTAMP
        }, merge=True)
        print(f"Token salvo com sucesso para o usuário: {usuario_id}")
        return jsonify({"status": "sucesso"}), 200
    except Exception as e:
        print(f"Erro ao gravar no Firestore: {e}")
        return jsonify({"status": "erro"}), 500
    
#Envia o aviso via whatsapp
@app.route('/notificar_pronto', methods=['POST'])
def notificar_pronto():
    try:
        data = request.json
        # O sistema deve enviar o número do WhatsApp no campo wa_id ou telefone
        telefone = data.get('wa_id') or data.get('telefone')
        nome_cliente = data.get('nome', 'Cliente')
        tipo_servico = data.get('tipo_servico')
        
        if not telefone:
            return jsonify({"erro": "Número de telefone (wa_id) não fornecido"}), 400

        # Montagem da mensagem a partir do template configurado
        bot_cfg = obter_config_bot()
        template = bot_cfg.get("mensagem_pronto") if tipo_servico != 'RETIRADA' else bot_cfg.get("mensagem_retirada")
        template = template or (BOT_CONFIG_DEFAULTS["mensagem_pronto"] if tipo_servico != 'RETIRADA' else BOT_CONFIG_DEFAULTS["mensagem_retirada"])
        mensagem = template.format(
            nome_cliente=nome_cliente,
            nome=nome_cliente,
            empresa=bot_cfg.get("nome_empresa") or BOT_CONFIG_DEFAULTS["nome_empresa"]
        )

        import re
        telefone_limpo = re.sub(r'\D', '', str(telefone))

        # Configuração da API da Meta (WhatsApp)
        url = f"https://graph.facebook.com/v21.0/{PHONE_NUMBER_ID}/messages"
        headers = {
            "Authorization": f"Bearer {ACCESS_TOKEN}",
            "Content-Type": "application/json"
        }
        
        payload = {
            "messaging_product": "whatsapp",
            "to": telefone_limpo,
            "type": "text",
            "text": {"body": mensagem}
        }
        
        # Envio da mensagem
        response_wa = requests.post(url, headers=headers, json=payload)
        
        if response_wa.status_code in [200, 201]:
            print(f"✅ WhatsApp enviado para {telefone_limpo}")
            return jsonify({"status": "sucesso", "canal": "whatsapp"}), 200
        else:
            print(f"❌ Erro Meta: {response_wa.text}")
            return jsonify({"erro": "falha_meta", "detalhes": response_wa.json()}), response_wa.status_code

    except Exception as e:
        print(f"❌ Erro geral na notificação: {e}")
        return jsonify({"erro": str(e)}), 500

@app.route('/webhook', methods=['GET', 'POST'])
def webhook():
    if request.method == 'GET':
        token = request.args.get('hub.verify_token')
        challenge = request.args.get('hub.challenge')
        if token == VERIFY_TOKEN: 
            return challenge
        return 'Token inválido', 403

    if request.method == 'POST':
        data = request.json
        
        if data and 'entry' in data:
            for entry in data['entry']:
                for change in entry.get('changes', []):
                    value = change.get('value', {})
                    if 'messages' in value:
                        for message in value['messages']:
                            
                            # --- BLOQUEIO DE DUPLICIDADE ---
                            msg_id = message.get('id')
                            if msg_id in processed_message_ids:
                                print(f"🚫 Mensagem repetida bloqueada: {msg_id}")
                                return "EVENT_RECEIVED", 200 # Responde OK para o WhatsApp parar de tentar
                            
                            processed_message_ids.add(msg_id)
                            # Limpeza simples para a memória não estourar (mantém últimos 1000 IDs)
                            if len(processed_message_ids) > 1000:
                                processed_message_ids.pop()
                            # -------------------------------

                            from_number = message['from']
                            
                            if 'text' in message:
                                text = message['text']['body']
                                ai_response = get_openai_response(text, from_number, "WPP")
                                if ai_response:
                                    send_message(from_number, ai_response)
                                return "EVENT_RECEIVED", 200

                            elif 'image' in message or 'document' in message:
                                # ... (seu código de imagem continua igual) ...
                                tipo = 'image' if 'image' in message else 'document'
                                media_id = message[tipo]['id']
                                # (mantenha sua lógica de imagem aqui)
                                caminho_arquivo = baixar_imagem_whatsapp(media_id, tipo)
                                if caminho_arquivo:
                                    nome_arquivo = os.path.basename(caminho_arquivo)
                                    url_publica = upload_comprovante_firebase(caminho_arquivo, nome_arquivo)
                                    if url_publica:
                                        msg = f"Recebi seu comprovante! Vou registrar aqui."
                                        send_message(from_number, msg)
                                        registrar_comprovante(from_number, url_publica) # Chamei a função que faltava no seu código original
                                        os.remove(caminho_arquivo)
                                return "EVENT_RECEIVED", 200

        return "OK", 200
                                    
def send_message(to, message):
    url = f"https://graph.facebook.com/v21.0/{PHONE_NUMBER_ID}/messages"
    headers = {"Authorization": f"Bearer {ACCESS_TOKEN}", "Content-Type": "application/json"}
    payload = {"messaging_product": "whatsapp", "to": to, "type": "text", "text": {"body": message}}
    try:
        resp = requests.post(url, headers=headers, json=payload, timeout=15)
        if not resp.ok:
            # Antes esse erro era engolido em silêncio: a mensagem ficava
            # salva no histórico (Firestore) como se tivesse sido enviada,
            # mas nunca chegava de verdade no WhatsApp do cliente.
            print(f"❌ Falha ao enviar WhatsApp pra {to}: HTTP {resp.status_code} — {resp.text}")
    except Exception as e:
        print(f"❌ Erro de rede ao enviar WhatsApp pra {to}: {e}")
    return 'EVENT_RECEIVED', 200

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000)) 
    app.run(host='0.0.0.0', port=port)
    

@app.route('/chat_app', methods=['GET', 'POST'])
def gerenciar_chat_app():
    if request.method == 'GET':
        # Lê o histórico direto do Firestore (coleção historico_conversas)
        usuario_id = request.args.get('usuario_id') or request.args.get('wa_id')
        if not usuario_id:
            return jsonify({"historico": []}), 200

        historico = obter_historico_firestore(usuario_id)
        if not historico:
            # Primeira interação: registra e devolve a saudação inicial
            saudacao = "Olá! Como posso ajudar? 🍕"
            bot_cfg = obter_config_bot()
            saudacao = bot_cfg.get("mensagem_inicial") or BOT_CONFIG_DEFAULTS["mensagem_inicial"]
            salvar_historico_firestore(usuario_id, "assistant", saudacao, bot_cfg.get("max_historico_salvar"))
            historico = [{"role": "assistant", "content": saudacao}]
        return jsonify({"historico": historico}), 200

    if request.method == 'POST':
        data = request.json
        usuario_id = data.get('usuario_id') or data.get('wa_id')
        mensagem = data.get('mensagem') or data.get('prompt') or ""
        
        if not mensagem.strip():
            return jsonify({"error": "Mensagem vazia ignorada para evitar disparos falsos"}), 200

        # 1. PRIMEIRO define a origem
        origem = "APP" if usuario_id and usuario_id.startswith("cliente_") else "WHATSAPP"
        
        # 2. DEPOIS faz o print de debug
        print(f"DEBUG APP: ID={usuario_id} | ORIGEM={origem} | MSG={mensagem}")
        
        # 3. POR FIM chama a função
        ai_response = get_openai_response(mensagem, usuario_id, origem)
        return jsonify({"resposta": ai_response}), 200


@app.route('/painel/enviar_mensagem', methods=['POST'])
def painel_enviar_mensagem():
    """Atendente responde manualmente pelo painel: envia via WhatsApp,
    registra no histórico e assume o controle manual da conversa."""
    data = request.json or {}
    wa_id = re.sub(r'\D', '', str(data.get('wa_id') or ''))
    mensagem = str(data.get('mensagem') or '').strip()

    if not wa_id or not mensagem:
        return jsonify({"error": "wa_id e mensagem são obrigatórios"}), 400

    send_message(wa_id, mensagem)
    salvar_historico_firestore(wa_id, "assistant", mensagem)
    db.collection("historico_conversas").document(wa_id).set({"modo_manual": True}, merge=True)
    return jsonify({"ok": True}), 200

