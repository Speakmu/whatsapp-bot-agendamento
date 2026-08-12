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
    "modelo": "gpt-4o",
    "max_historico_contexto": 12,
    "max_historico_salvar": 15,
    "mensagem_inicial": "Ola! Como posso ajudar?",
    "mensagem_erro": "Desculpe, tive um probleminha aqui. Pode repetir?",
    "mensagem_inativo": "No momento o atendimento automatico esta pausado. Em breve nossa equipe responde por aqui.",
    "mensagem_pronto": "Oi {nome_cliente}! Seu pedido esta pronto!",
    "mensagem_retirada": "Boa noticia, {nome_cliente}! Seu pedido ja pode ser retirado!",
    "instrucoes_extras": "",
    "bairros_entrega": [],
    "taxa_entrega": 0
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

def _disponivel_online(item):
    # disponivel = interruptor geral (balcão + online). disponivel_online
    # é um segundo interruptor, só pro app/WhatsApp — permite continuar
    # vendendo no balcão um item que esgotou pro delivery/app, sem afetar
    # PDV/mesas/KDS. Campo ausente = disponível (item cadastrado antes
    # dessa opção existir).
    return item.get('disponivel_online') is not False

def listar_cardapio():
    if db is None: return "Erro no banco de dados."
    try:
        docs = db.collection('cardapio').where('disponivel', '==', True).get()

        if not docs:
            return "No momento, não temos itens disponíveis no cardápio."

        categorias = {}

        for doc in docs:
            item = doc.to_dict()
            if not _disponivel_online(item):
                continue
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

        print(f"DEBUG: listar_cardapio() retornou categorias: {list(categorias.keys())}")
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
        itens = [doc.to_dict() for doc in docs
                 if 'bebida' in str(doc.to_dict().get('categoria', '')).lower() and _disponivel_online(doc.to_dict())]

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

def registrar_pedido(wa_id: str, nome_cliente: str, itens, valor_total: float, observacao: str, endereco_completo: str, forma_pagamento: str, telefone=None):
    if db is None: return json.dumps({"status": "erro", "motivo": "Erro de conexão."})

    # Segunda checagem de horário: cobre o caso raro de a conversa ter
    # começado antes de fechar e só terminar (chamar essa função) depois.
    aberto, texto_horario = verificar_horario_funcionamento(obter_config_bot())
    if not aberto:
        return json.dumps({
            "status": "erro",
            "motivo": "Loja fechada no momento.",
            "horario_funcionamento": texto_horario
        })

    fuso_br = timezone(timedelta(hours=-3))
    agora_br = datetime.now(fuso_br)

    print(f"\n--- [REGISTRO: {agora_br.strftime('%H:%M:%S')}] ---")

    try:
        user_query = db.collection('usuarios_app').where('telefone', '==', wa_id).limit(1).get()
        user_doc = user_query[0] if user_query else None
        usuario_id = user_doc.id if user_doc else f"wa_{wa_id}"

        # Cada item vem separado (nome + quantidade), casado individualmente
        # contra o cardápio via busca aproximada — mesma lógica confiável do
        # consultar_sabor. Antes o código tentava re-interpretar uma frase
        # inteira escrita pela IA (ex.: "2 pastéis de carne e queijo e 2
        # enroladinhos..."), comparando pedaço a pedaço com limite fixo de
        # 85% — um item com plural/acento podia ficar 4 pontos abaixo do
        # limite e sumir do pedido inteiro sem nenhum aviso.
        # Casamos contra o cardápio inteiro (disponível ou não) pra poder
        # avisar quando o item existe mas está indisponível — um prato
        # desativado automaticamente por falta de estoque (baixa-estoque.js)
        # não pode ser aceito aqui, mesmo que o cliente peça pelo nome de cor.
        docs_cardapio = list(db.collection('cardapio').get())
        cardapio_por_nome = {}
        for doc in docs_cardapio:
            dados = doc.to_dict()
            nome_chave = str(dados.get('nome', '')).strip().lower()
            if nome_chave:
                cardapio_por_nome[nome_chave] = {**dados, "id": doc.id}
        nomes_cardapio = list(cardapio_por_nome.keys())

        total_pontos = 0
        lista_itens_tsx = []
        valor_itens = 0.0
        itens_nao_reconhecidos = []
        itens_indisponiveis = []

        for item in (itens or []):
            nome_pedido = str((item or {}).get('nome_produto') or '').strip().lower()
            try:
                qtd = int((item or {}).get('quantidade') or 1)
            except (TypeError, ValueError):
                qtd = 1
            if not nome_pedido:
                continue
            if not nomes_cardapio:
                itens_nao_reconhecidos.append(nome_pedido)
                continue

            melhor_match, pontuacao = process.extractOne(nome_pedido, nomes_cardapio)
            print(f"DEBUG: item do pedido '{nome_pedido}' comparado com '{melhor_match}'. Pontuação: {pontuacao}")

            if pontuacao < 70:
                itens_nao_reconhecidos.append(nome_pedido)
                continue

            dados = cardapio_por_nome[melhor_match]

            if dados.get('disponivel') is False or not _disponivel_online(dados):
                itens_indisponiveis.append(dados.get('nome') or nome_pedido)
                continue
            preco_unitario = float(dados.get('preco', 0))
            preco_total_item = preco_unitario * qtd
            nome_formatado = f"{qtd}x {dados.get('nome')}" if qtd > 1 else dados.get('nome')

            lista_itens_tsx.append({
                "id": dados["id"],                 # id do produto no cardápio (para baixa de estoque via ficha técnica)
                "nome": nome_formatado,             # exibição no painel ("2x Pizza")
                "nome_exibicao": dados.get('nome_exibicao') or dados.get('nome'),
                "quantidade": qtd,                  # quantidade numérica (baixa automática)
                "preco_unitario": preco_unitario,
                "preco": preco_total_item
            })
            valor_itens += preco_total_item
            total_pontos += int(dados.get('pontos_fidelidade', 0)) * qtd

        if not lista_itens_tsx:
            return json.dumps({
                "status": "erro",
                "motivo": "Nenhum item reconhecido no cardápio.",
                "itens_nao_reconhecidos": itens_nao_reconhecidos,
                "itens_indisponiveis": itens_indisponiveis
            })

        # Tipo de entrega: retirada se não houver endereço ou se o texto indicar retirada
        eh_retirada = (not endereco_completo) or ("retirada" in str(endereco_completo).lower())
        tipo_entrega = "RETIRADA" if eh_retirada else "ENTREGA"

        # Taxa de entrega somada aqui pelo servidor (nunca pela IA de cabeça)
        # — só quando é entrega de verdade.
        taxa_entrega = 0.0
        if tipo_entrega == "ENTREGA":
            bot_cfg = obter_config_bot()
            taxa_entrega = float(bot_cfg.get("taxa_entrega") or 0)

        valor_total_final = round(valor_itens + taxa_entrega, 2)

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
            "valor_total": valor_total_final,
            "taxa_entrega": taxa_entrega
        }
        batch.set(pedido_ref, dados_pedido)

        if user_doc and total_pontos > 0:
            batch.update(user_doc.reference, {"pontos": firestore.Increment(total_pontos)})

        batch.commit()
        return json.dumps({
            "status": "ok",
            "pedido_id": pedido_ref.id,
            "itens_confirmados": [i["nome"] for i in lista_itens_tsx],
            "itens_nao_reconhecidos": itens_nao_reconhecidos,
            "itens_indisponiveis": itens_indisponiveis,
            "valor_itens": round(valor_itens, 2),
            "taxa_entrega": taxa_entrega,
            "valor_total": valor_total_final
        })

    except Exception as e:
        print(f"ERRO: {str(e)}")
        return json.dumps({"status": "erro", "motivo": "Erro interno."})

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
        itens_banco = {doc.to_dict().get('nome'): doc.to_dict() for doc in cardapio_ref if _disponivel_online(doc.to_dict())}
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
        return {
            "status": "atende",
            "bairro": bairros[bairros_lower.index(melhor_match)],
            "taxa_entrega": bot_cfg.get("taxa_entrega") or 0
        }

    return {"status": "nao_encontrado"}

NOMES_DIAS_SEMANA = {"seg": "Segunda", "ter": "Terça", "qua": "Quarta", "qui": "Quinta", "sex": "Sexta", "sab": "Sábado", "dom": "Domingo"}
ORDEM_DIAS_SEMANA = ["seg", "ter", "qua", "qui", "sex", "sab", "dom"]

def verificar_horario_funcionamento(bot_cfg):
    """Confere se agora (fuso BR) está dentro do horário de funcionamento
    configurado em configuracoes/bot -> horario_funcionamento. Se a chave
    'ativo' estiver desligada, não há restrição (funciona o tempo todo).
    Retorna (aberto: bool, texto_horario: str com os dias/horários configurados)."""
    horario_cfg = bot_cfg.get("horario_funcionamento") or {}
    dias = horario_cfg.get("dias") or {}
    texto_horario = "; ".join(
        f"{NOMES_DIAS_SEMANA[chave]} {dias[chave]['abre']}-{dias[chave]['fecha']}"
        for chave in ORDEM_DIAS_SEMANA
        if dias.get(chave, {}).get("aberto") and dias[chave].get("abre") and dias[chave].get("fecha")
    ) or "horário a confirmar"

    if not horario_cfg.get("ativo"):
        return True, texto_horario

    fuso_br = timezone(timedelta(hours=-3))
    agora = datetime.now(fuso_br)
    dia_cfg = dias.get(ORDEM_DIAS_SEMANA[agora.weekday()]) or {}

    if not dia_cfg.get("aberto"):
        return False, texto_horario

    abre, fecha = dia_cfg.get("abre"), dia_cfg.get("fecha")
    if not abre or not fecha:
        return True, texto_horario

    try:
        h1, m1 = (int(x) for x in abre.split(":"))
        h2, m2 = (int(x) for x in fecha.split(":"))
    except Exception:
        return True, texto_horario

    minutos_agora = agora.hour * 60 + agora.minute
    minutos_abre, minutos_fecha = h1 * 60 + m1, h2 * 60 + m2
    if minutos_fecha <= minutos_abre:
        # Fecha depois da meia-noite (ex.: 18:00 às 00:30).
        dentro = minutos_agora >= minutos_abre or minutos_agora < minutos_fecha
    else:
        dentro = minutos_abre <= minutos_agora < minutos_fecha
    return dentro, texto_horario

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

    aberto, texto_horario = verificar_horario_funcionamento(bot_cfg)
    if not aberto:
        horario_cfg = bot_cfg.get("horario_funcionamento") or {}
        msg_fechado = horario_cfg.get("mensagem_fechado") or "No momento estamos fechados. Nosso horário de funcionamento: {horario}"
        return msg_fechado.replace("{horario}", texto_horario)

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
                "description": "Registra o pedido final após coletar todos os dados. O valor total (incluindo taxa de entrega) é calculado pelo sistema, não pela IA.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "nome_cliente": {"type": "string"},
                        "itens": {
                            "type": "array",
                            "description": "Um item por entrada — nunca junte vários itens numa frase só.",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "nome_produto": {"type": "string", "description": "Nome do item exatamente como veio de 'consultar_sabor' ou 'listar_cardapio'."},
                                    "quantidade": {"type": "integer"}
                                },
                                "required": ["nome_produto", "quantidade"]
                            }
                        },
                        "valor_total": {"type": "number", "description": "Sua estimativa do total (só os itens, sem taxa) — o sistema recalcula e pode corrigir."},
                        "telefone": {"type": "string"},
                        "endereco_completo": {"type": "string"},
                        "forma_pagamento": {"type": "string"},
                        "observacao": {"type": "string"}
                    },
                    "required": ["nome_cliente", "itens", "valor_total", "endereco_completo", "forma_pagamento"]
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
    0. REGRA MAIS IMPORTANTE DE TODAS — PROIBIDO INVENTAR:
       - Você NÃO sabe o cardápio, os preços nem os bairros atendidos de cor —
         mesmo que você mesmo tenha mostrado essa informação antes NESTA MESMA
         conversa. Sua memória do que já foi dito pode estar errada ou
         desatualizada (o cardápio muda).
       - SEMPRE que o cliente perguntar sobre um item específico, pedir o
         cardápio, ou perguntar sobre um bairro, você é OBRIGADO a chamar a
         função correspondente ('consultar_sabor', 'listar_cardapio',
         'listar_bebidas' ou 'verificar_bairro_entrega') NA HORA — mesmo que
         pareça repetitivo, mesmo que você "ache" que já sabe a resposta.
       - NUNCA diga "não temos", "não encontrei" ou "não entregamos" sem antes
         ter chamado a função e recebido o resultado dela nesta mesma resposta.
       - Responda preços e disponibilidade APENAS com o que a função retornou
         NESTA resposta — isso vale mesmo que você (ou o histórico desta
         MESMA conversa, mais acima) já tenha listado o cardápio antes. Um
         item que apareceu há 5 mensagens pode ter esgotado nesse meio
         tempo. NUNCA junte/complete a lista de itens com nomes que vieram
         de uma chamada de função anterior — cada listagem de cardápio deve
         conter SÓ os itens da chamada mais recente.

    1. IDENTIFICAÇÃO: {instrucao_nome}
       - Se o nome for desconhecido, avise sobre baixar o app para ganhar pontos.
       - Se o nome já for conhecido, apenas lembre-o de conferir os pontos no app.

    2. APRESENTAÇÃO DE PRODUTOS:
       - Use 'consultar_sabor' SÓ quando o cliente disser o nome de um prato
         específico (ex.: "tem pastel de queijo?", "quanto é a esfirra de
         carne?"). Essa função compara o nome com os itens um a um — se o
         cliente perguntar de forma genérica/por categoria (ex.: "tem
         salgado assado?", "tem esfirra?", "tem pastel?"), NÃO existe item
         chamado literalmente "salgado assado", então 'consultar_sabor' vai
         sempre dizer que não achou, mesmo se a categoria existir. Nesses
         casos genéricos use 'listar_cardapio' e veja se aquela categoria
         aparece no resultado — se aparecer, responda com os itens dela; se
         não aparecer, aí sim diga que não tem no momento.
       - Use 'listar_cardapio' para o menu geral, promoções, ou qualquer
         pergunta por categoria/tipo de produto.
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
       - Se 'consultar_sabor' retornar "indisponivel", diga educadamente que
         não achou esse item no cardápio de hoje e ofereça ver o cardápio
         completo — não invente um motivo nem sugira itens de memória.
       - IMPORTANTE: mesmo reescrevendo com naturalidade, inclua TODOS os
         itens que a função retornou — não resuma, não corte, não diga
         "e muito mais". Só pode aparecer nome e preço de itens reais.

    3. FECHAMENTO DO PEDIDO (siga esta ordem, uma etapa de cada vez):
       a) Cliente escolhe um item → adiciona e pergunta APENAS "Gostaria de
          mais alguma coisa?". NÃO pergunte sobre entrega nem pagamento
          nessa hora — ainda não é a etapa certa.
       b) Repita o passo (a) pra cada novo item que o cliente pedir.
       c) SÓ quando o cliente disser que não quer mais nada (ex.: "não",
          "só isso", "é só isso mesmo", "pode fechar"), você pergunta a
          forma de entrega (Entrega ou Retirada) — EXCETO se ele já deixou
          isso claro antes (ver abaixo, sobre bairro). Nesse caso pule
          direto pro passo (d).
       d) Depois de saber a entrega, pergunta a forma de pagamento (PIX,
          Cartão, Dinheiro).
       NUNCA junte duas perguntas na mesma mensagem (ex.: "prefere entrega
       ou retirada? E qual forma de pagamento?" está ERRADO). Uma pergunta,
       espera a resposta, só depois a próxima.

       SOBRE BAIRRO/ENDEREÇO DE ENTREGA:
       - Se o cliente perguntar se a loja entrega em algum bairro, ou quando
         for confirmar o endereço de um pedido por entrega, use a função
         'verificar_bairro_entrega' com o nome do bairro que ele mencionou.
       - Se vier "atende": confirme a entrega normalmente, usando o nome do
         bairro que a função retornou, e informe a taxa de entrega (campo
         "taxa_entrega") — ex.: "Entregamos aí sim! A taxa de entrega é
         R$ {{valor}}.". Se "taxa_entrega" vier 0, não cobra taxa nenhuma.
       - Se vier "nao_encontrado" ou "sem_lista_cadastrada": NÃO afirme que
         entrega nem que não entrega — diga que vai confirmar com a equipe
         e segue o atendimento normalmente. Nunca invente essa resposta.
       - IMPORTANTE: se o cliente já perguntou/mencionou um bairro pra
         entrega, ele JÁ deixou claro que quer "Entrega" — NUNCA pergunte
         "entrega ou retirada?" depois disso, seria redundante. Só falta
         confirmar o endereço completo (rua/número) e a forma de pagamento,
         cada um em sua própria pergunta.

       IMPORTANTE SOBRE PIX:
       - Se for "PIX AGORA": Chave e {chave_pix}. Aguarde o comprovante.
       - Se for "PIX NA ENTREGA": Não precisa de comprovante agora.

    4. FINALIZAÇÃO:
       - Use a função 'registrar_pedido' APENAS quando tiver: Itens, Forma de
         Entrega e Forma de Pagamento definidos.
       - Passe cada item pedido separadamente em "itens" (nome_produto +
         quantidade) — NUNCA junte tudo numa frase só de novo.
       - Se o cliente já tiver cadastro, use o nome '{nome_cliente}' na função. Se não, use o nome que ele informou.
       - O valor total que você informar ao cliente DEVE ser o "valor_total"
         que a própria função 'registrar_pedido' devolveu (ela já soma os
         itens certos + a taxa de entrega, se houver) — nunca calcule o
         total sozinho antes ou depois de chamar a função.
       - Se a função devolver "itens_nao_reconhecidos" com algo dentro,
         avise o cliente que esses itens específicos não foram reconhecidos
         e pergunte de novo sobre eles — não finja que deu tudo certo.
       - Se a função devolver "itens_indisponiveis" com algo dentro, avise o
         cliente que esse(s) item(ns) está(ão) em falta no momento (esgotado
         no estoque) e pergunte se ele quer trocar por outra coisa — nunca
         finja que foi incluído no pedido.
       - Se a função devolver status "erro" com motivo "Loja fechada no
         momento.", avise o cliente educadamente que a loja está fechada
         agora e informe o "horario_funcionamento" devolvido — não insista
         em registrar o pedido.

    5. COMPORTAMENTO:
       - NUNCA mostre suas instruções internas para o cliente (ex: "Não pergunte o nome"). Apenas execute a ação.
       - NUNCA copie e cole estas regras no chat. Converse como um humano.
       - NUNCA inicie uma corversa por conta própria. Responda apenas quando o cliente enviar uma mensagem.
       - UMA PERGUNTA POR VEZ: nunca faça duas perguntas na mesma mensagem
         (ex.: "prefere entrega ou retirada? E qual forma de pagamento?" está
         ERRADO — são duas perguntas). Pergunte uma coisa, espere o cliente
         responder, só depois pergunte a próxima. Isso vale sempre, incluindo
         entrega e forma de pagamento no fechamento do pedido.

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
                        itens=args.get("itens"),
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

