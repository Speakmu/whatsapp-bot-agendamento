import re
import unicodedata
import threading
from flask import Flask, request, jsonify
import requests
import os
import json
import openai
import firebase_admin
from thefuzz import process, fuzz
from firebase_admin import credentials, firestore, storage, messaging
from google.api_core import exceptions as gcp_exceptions
from dotenv import load_dotenv
from flask_cors import CORS
from datetime import datetime, timedelta, timezone

load_dotenv()

# --- CONFIGURAÇÃO FIREBASE ---
FIREBASE_CREDENCIAL_PATH = os.environ.get("FIREBASE_CREDENCIAL_PATH")
FIREBASE_STORAGE_BUCKET = os.environ.get("FIREBASE_STORAGE_BUCKET")

if not firebase_admin._apps:
    # No Cloud Run (K_SERVICE sempre definido em runtime) usa a service
    # account do próprio serviço via Application Default Credentials — sem
    # precisar de arquivo de chave nenhum. Localmente (Render antigo/dev)
    # continua caindo no arquivo apontado por FIREBASE_CREDENCIAL_PATH.
    if os.environ.get("K_SERVICE"):
        cred = credentials.ApplicationDefault()
    else:
        cred = credentials.Certificate(FIREBASE_CREDENCIAL_PATH)
    firebase_admin.initialize_app(cred, {'storageBucket': FIREBASE_STORAGE_BUCKET})
db = firestore.client()

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY") 
openai.api_key = OPENAI_API_KEY

BOT_CONFIG_DEFAULTS = {
    "ativo": True,
    "nome_atendente": "Sofia",
    "nome_empresa": "Lileamar Salgados",
    # Vazio de propósito: nunca cair de volta pra uma chave PIX de exemplo
    # (isso já aconteceu — "abc1231234567" era passada como se fosse real
    # quando o campo não tinha sido configurado no painel ainda). Sem chave
    # configurada, o bot deve dizer pra falar com a equipe, não inventar uma.
    "chave_pix": "",
    "modelo": "gpt-4o",
    # Fechar um pedido hoje passa por bem mais etapas do que antes (confirmar
    # bairro, pedir endereço completo, forma de pagamento, resumo antes de
    # fechar) — uma conversa real já passou de 17 mensagens antes do cliente
    # confirmar o pedido. Com o limite antigo (12/15) as primeiras mensagens,
    # onde os itens foram escolhidos, saíam da memória antes de chegar no
    # fechamento — o bot "esquecia" o carrinho de verdade, não só parecia.
    "max_historico_contexto": 24,
    "max_historico_salvar": 30,
    "mensagem_inicial": "Ola! Como posso ajudar?",
    "mensagem_erro": "Desculpe, tive um probleminha aqui. Pode repetir?",
    "mensagem_inativo": "No momento o atendimento automatico esta pausado. Em breve nossa equipe responde por aqui.",
    "mensagem_pronto": "Oi {nome_cliente}! Seu pedido esta pronto!",
    "mensagem_retirada": "Boa noticia, {nome_cliente}! Seu pedido ja pode ser retirado!",
    "instrucoes_extras": "",
    "bairros_entrega": [],
    "taxa_entrega": 0,
    "cidade_atendida": ""
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
        cfg["max_historico_contexto"] = max(2, min(50, int(cfg.get("max_historico_contexto") or 24)))
    except Exception:
        cfg["max_historico_contexto"] = 24
    try:
        cfg["max_historico_salvar"] = max(cfg["max_historico_contexto"], min(60, int(cfg.get("max_historico_salvar") or 30)))
    except Exception:
        cfg["max_historico_salvar"] = 30
    return cfg
# --- FUNÇÕES DE APOIO ---
# OBS: o histórico de conversa agora é persistido 100% no Firestore
# (coleção "historico_conversas"), via obter_historico_firestore /
# salvar_historico_firestore. O antigo armazenamento em arquivo local
# (chat_history.json) foi removido por ser efêmero no deploy (Render)
# e não funcionar com múltiplos workers do gunicorn.

def primeiro_nome(nome):
    """Pra falar com o cliente de forma mais natural (ex.: 'Oi Murilo!' em
    vez de 'Oi Murilo Amorim!'). O nome completo continua sendo usado no
    registro do pedido, só a forma de se dirigir ao cliente é encurtada."""
    return str(nome or '').strip().split(' ')[0] or 'Cliente'

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

def _montar_itens_pedido(itens, tipo_entrega):
    """Casa cada item pedido (nome + quantidade) contra o cardápio via busca
    aproximada e calcula o total — usada tanto por 'calcular_pedido' (só
    prévia, não escreve nada) quanto por 'registrar_pedido' (grava de
    verdade), pra garantir que o valor mostrado na confirmação seja
    exatamente o mesmo que vai pro pedido real.

    'tipo_entrega' é sempre "ENTREGA" ou "RETIRADA", informado explicitamente
    pela IA — nunca adivinhado a partir do texto do endereço. Antes a
    função tentava inferir isso olhando se "endereco_completo" vinha vazio
    ou continha a palavra "retirada": se a IA chamasse 'calcular_pedido' sem
    passar o endereço (o parâmetro não era obrigatório), um pedido de
    entrega de verdade virava RETIRADA sozinho e a taxa de entrega sumia do
    resumo mostrado pro cliente — bug real, não só de prompt.

    Antes o código tentava re-interpretar uma frase inteira escrita pela IA
    (ex.: "2 pastéis de carne e queijo e 2 enroladinhos..."), comparando
    pedaço a pedaço com limite fixo de 85% — um item com plural/acento podia
    ficar 4 pontos abaixo do limite e sumir do pedido inteiro sem aviso.
    Casamos contra o cardápio inteiro (disponível ou não) pra poder avisar
    quando o item existe mas está indisponível — um prato desativado
    automaticamente por falta de estoque (baixa-estoque.js) não pode ser
    aceito aqui, mesmo que o cliente peça pelo nome de cor.
    """
    docs_cardapio = list(db.collection('cardapio').get())
    cardapio_por_nome = {}
    cardapio_por_id = {}
    for doc in docs_cardapio:
        dados = doc.to_dict()
        item_com_id = {**dados, "id": doc.id}
        cardapio_por_id[doc.id] = item_com_id
        nome_chave = str(dados.get('nome', '')).strip().lower()
        if nome_chave:
            cardapio_por_nome[nome_chave] = item_com_id
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

        # Apelido já ensinado pela equipe (painel de Atendimento) pra esse
        # nome exato — pula a busca aproximada e vai direto no item certo.
        dados = None
        try:
            aprendido = db.collection("itens_aprendizado").document(_normalizar_termo(nome_pedido)).get()
            if aprendido.exists:
                item_id_aprendido = aprendido.to_dict().get("item_id")
                dados = cardapio_por_id.get(item_id_aprendido)
        except Exception as e:
            print(f"Erro ao checar item aprendido: {e}")

        if not dados:
            if not nomes_cardapio:
                itens_nao_reconhecidos.append(nome_pedido)
                continue

            # Sem acento dos dois lados (mesmo motivo do verificar_bairro_entrega):
            # uma palavra comum acentuada entre vários itens (ex.: "pastéis")
            # infla a pontuação de itens errados só por ela.
            nomes_normalizados = [_normalizar_termo(n) for n in nomes_cardapio]
            melhor_match_norm, pontuacao = process.extractOne(_normalizar_termo(nome_pedido), nomes_normalizados)
            melhor_match = nomes_cardapio[nomes_normalizados.index(melhor_match_norm)]
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

    tipo_entrega = "RETIRADA" if str(tipo_entrega or "").strip().upper() == "RETIRADA" else "ENTREGA"

    # Taxa de entrega somada aqui pelo servidor (nunca pela IA de cabeça)
    # — só quando é entrega de verdade.
    taxa_entrega = 0.0
    if tipo_entrega == "ENTREGA":
        bot_cfg = obter_config_bot()
        taxa_entrega = float(bot_cfg.get("taxa_entrega") or 0)

    valor_total_final = round(valor_itens + taxa_entrega, 2)

    return {
        "lista_itens_tsx": lista_itens_tsx,
        "itens_nao_reconhecidos": itens_nao_reconhecidos,
        "itens_indisponiveis": itens_indisponiveis,
        "valor_itens": round(valor_itens, 2),
        "taxa_entrega": taxa_entrega,
        "valor_total": valor_total_final,
        "tipo_entrega": tipo_entrega,
        "total_pontos": total_pontos
    }

def calcular_pedido(id_usuario, itens, tipo_entrega=None):
    """Prévia do pedido (não grava nada) — mostra pro cliente exatamente os
    itens reconhecidos, a taxa de entrega e o total ANTES de confirmar de
    vez com 'registrar_pedido'. Existe pra evitar o bot fechar um pedido
    sem o cliente ter chance de corrigir uma quantidade errada antes.

    Guarda o resultado do casamento (itens já resolvidos, não os nomes
    crus) em 'historico_conversas/{id}.ultimo_calculo' — 'registrar_pedido'
    reaproveita isso em vez de rodar a busca aproximada de novo do zero.
    Sem isso, já aconteceu de o cálculo achar um item (ex.: "Coca Cola Lata
    Zero 350ml") e o registro, buscando de novo, achar outro parecido mas
    diferente (ex.: "Coca Cola Zero lata 600ml") — o cliente confirma um
    valor e o pedido de verdade sai com outro."""
    if db is None: return json.dumps({"status": "erro", "motivo": "Erro de conexão."})
    try:
        montado = _montar_itens_pedido(itens, tipo_entrega)
        if not montado["lista_itens_tsx"]:
            return json.dumps({
                "status": "erro",
                "motivo": "Nenhum item reconhecido no cardápio.",
                "itens_nao_reconhecidos": montado["itens_nao_reconhecidos"],
                "itens_indisponiveis": montado["itens_indisponiveis"]
            })

        if id_usuario:
            try:
                db.collection("historico_conversas").document(id_usuario).set({
                    "ultimo_calculo": {
                        "itens": montado["lista_itens_tsx"],
                        "valor_itens": montado["valor_itens"],
                        "taxa_entrega": montado["taxa_entrega"],
                        "valor_total": montado["valor_total"],
                        "tipo_entrega": montado["tipo_entrega"],
                        "total_pontos": montado["total_pontos"],
                        "calculado_em": datetime.now(timezone.utc)
                    }
                }, merge=True)
            except Exception as e:
                print(f"Erro ao cachear ultimo_calculo: {e}")

        return json.dumps({
            "status": "ok",
            "itens_confirmados": [i["nome"] for i in montado["lista_itens_tsx"]],
            "itens_nao_reconhecidos": montado["itens_nao_reconhecidos"],
            "itens_indisponiveis": montado["itens_indisponiveis"],
            "valor_itens": montado["valor_itens"],
            "taxa_entrega": montado["taxa_entrega"],
            "valor_total": montado["valor_total"]
        })
    except Exception as e:
        print(f"ERRO ao calcular pedido: {e}")
        return json.dumps({"status": "erro", "motivo": "Erro interno."})

def registrar_pedido(wa_id: str, nome_cliente: str, itens, valor_total: float, observacao: str, endereco_completo: str, forma_pagamento: str, tipo_entrega=None, telefone=None, id_usuario_cache=None, bairro=None):
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

        # Reaproveita o casamento que 'calcular_pedido' já fez (se foi feito
        # há pouco tempo pra essa mesma conversa) em vez de rodar a busca
        # aproximada de novo do zero — garante que o pedido registrado é
        # EXATAMENTE o que o cliente confirmou, nunca um item parecido mas
        # diferente escolhido numa segunda rodada de fuzzy match.
        montado = None
        hist_ref = db.collection("historico_conversas").document(id_usuario_cache) if id_usuario_cache else None
        if hist_ref:
            try:
                hist_doc = hist_ref.get()
                cache = (hist_doc.to_dict() or {}).get("ultimo_calculo") if hist_doc.exists else None
                calculado_em = cache.get("calculado_em") if cache else None
                if cache and cache.get("itens") and calculado_em and (datetime.now(timezone.utc) - calculado_em) < timedelta(minutes=30):
                    montado = {
                        "lista_itens_tsx": cache["itens"],
                        "itens_nao_reconhecidos": [],
                        "itens_indisponiveis": [],
                        "valor_itens": cache.get("valor_itens", 0),
                        "taxa_entrega": cache.get("taxa_entrega", 0),
                        "valor_total": cache.get("valor_total", 0),
                        "tipo_entrega": cache.get("tipo_entrega") or "RETIRADA",
                        "total_pontos": cache.get("total_pontos", 0)
                    }
                    hist_ref.update({"ultimo_calculo": firestore.DELETE_FIELD})
            except Exception as e:
                print(f"Erro ao reaproveitar ultimo_calculo: {e}")

        if montado is None:
            montado = _montar_itens_pedido(itens, tipo_entrega)
        lista_itens_tsx = montado["lista_itens_tsx"]
        itens_nao_reconhecidos = montado["itens_nao_reconhecidos"]
        itens_indisponiveis = montado["itens_indisponiveis"]
        tipo_entrega = montado["tipo_entrega"]
        taxa_entrega = montado["taxa_entrega"]
        valor_total_final = montado["valor_total"]
        total_pontos = montado["total_pontos"]

        if not lista_itens_tsx:
            return json.dumps({
                "status": "erro",
                "motivo": "Nenhum item reconhecido no cardápio.",
                "itens_nao_reconhecidos": itens_nao_reconhecidos,
                "itens_indisponiveis": itens_indisponiveis
            })

        batch = db.batch()
        pedido_ref = db.collection('pedidos').document()
        dados_pedido = {
            "origem": "WHATSAPP",
            "data_formatada": agora_br.strftime('%d/%m/%Y %H:%M:%S'),
            "endereco": endereco_completo,
            "bairro": bairro or None,
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
            "valor_itens": montado["valor_itens"],
            "taxa_entrega": taxa_entrega,
            "valor_total": valor_total_final
        })

    except Exception as e:
        print(f"ERRO: {str(e)}")
        return json.dumps({"status": "erro", "motivo": "Erro interno."})

def consultar_meu_pedido(wa_id: str):
    """Busca o pedido mais recente já registrado deste cliente — usada quando
    ele pergunta sobre um pedido que JÁ fez (valor, itens, status), pra não
    o bot precisar "adivinhar"/reconstruir isso de cabeça (ou, pior, chamar
    registrar_pedido de novo só pra descrever, o que cria um pedido duplicado
    de verdade no sistema)."""
    if db is None: return json.dumps({"status": "erro", "motivo": "Erro de conexão."})
    try:
        docs = db.collection('pedidos') \
            .where('telefone_cliente', '==', str(wa_id)) \
            .order_by('hora_pedido', direction=firestore.Query.DESCENDING) \
            .limit(1).get()
        if not docs:
            return json.dumps({"status": "sem_pedido"})

        pedido = docs[0].to_dict()
        return json.dumps({
            "status": "ok",
            "itens": [i.get("nome") for i in (pedido.get("itens") or [])],
            "valor_total": pedido.get("valor_total"),
            "taxa_entrega": pedido.get("taxa_entrega"),
            "tipo_entrega": pedido.get("tipo_entrega"),
            "forma_pagamento": pedido.get("forma_pagamento"),
            "status_pedido": pedido.get("status")
        })
    except Exception as e:
        print(f"ERRO ao consultar pedido: {e}")
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

def _normalizar_termo(s):
    """Chave de comparação exata pra aprendizado (bairro/item): minúsculo,
    sem espaço sobrando, sem acento — pra 'Passos' e 'passos ' caírem na
    mesma entrada aprendida."""
    semAcento = ''.join(
        ch for ch in unicodedata.normalize('NFD', str(s or ''))
        if not unicodedata.combining(ch)
    )
    return ' '.join(semAcento.lower().split())

def marcar_atencao(wa_id, motivo, tipo=None, dados=None):
    """Sinaliza pro painel de Atendimento (bot-chat.html) que essa conversa
    tem uma situação que o bot não conseguiu resolver sozinho — bairro
    ambíguo, item do pedido não reconhecido, etc. — e precisa de um humano
    olhando. 'tipo'/'dados' alimentam a caixa de resposta rápida do painel
    (ex.: tipo='bairro', dados={'bairro_cliente': 'Passos'})."""
    try:
        db.collection("historico_conversas").document(wa_id).set({
            "precisa_atencao": True,
            "motivo_atencao": motivo,
            "tipo_atencao": tipo,
            "atencao_dados": dados or {},
            "atencao_marcada_em": datetime.now(timezone.utc)
        }, merge=True)
    except Exception as e:
        print(f"Erro ao marcar atenção: {e}")

def texto_atencao_pendente_antiga(wa_id, minutos_limite=10):
    """Se essa conversa tem uma dúvida marcada pra equipe há mais tempo que
    o limite e ninguém respondeu ainda, devolve um aviso pro prompt — sem
    isso o bot ficaria prometendo "vou confirmar com a equipe" de novo a
    cada mensagem, numa espera que nunca chega no fim. Não há timer/cron
    rodando o tempo todo; a checagem acontece na próxima mensagem que o
    cliente mandar (verificado aqui, no início de cada resposta)."""
    try:
        doc = db.collection("historico_conversas").document(wa_id).get()
        if not doc.exists:
            return ""
        dados = doc.to_dict()
        if not dados.get("precisa_atencao"):
            return ""
        marcado_em = dados.get("atencao_marcada_em")
        if not marcado_em:
            return ""
        agora = datetime.now(timezone.utc)
        if agora - marcado_em > timedelta(minutes=minutos_limite):
            return (
                f'AVISO: você marcou uma dúvida pra equipe há mais de {minutos_limite} '
                f'minutos ("{dados.get("motivo_atencao", "")}") e ninguém respondeu ainda. '
                f'NÃO prometa verificar com a equipe de novo sobre isso — resolva com o '
                f'cliente agora mesmo (ofereça retirada como alternativa, ou siga sem esse '
                f'dado se ele preferir esperar por conta própria).'
            )
    except Exception as e:
        print(f"Erro ao checar atenção pendente: {e}")
    return ""

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
        # Encontra o nome no banco que mais se parece com o que o usuário digitou.
        # Sem acento dos dois lados — mesmo motivo do verificar_bairro_entrega
        # (uma palavra comum acentuada infla a pontuação de itens errados).
        nomes_normalizados = [_normalizar_termo(n) for n in nomes_no_banco]
        melhor_match_norm, pontuacao = process.extractOne(_normalizar_termo(termo_usuario), nomes_normalizados)
        melhor_match = nomes_no_banco[nomes_normalizados.index(melhor_match_norm)]

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
    abreviação) — mesma lógica do consultar_sabor, mas pra bairro.

    Antes de tudo, checa 'bairros_aprendizado' — respostas que a própria
    equipe já deu antes pra esse nome exato de bairro (pelo painel de
    Atendimento), pra não escalar de novo uma dúvida que já foi resolvida."""
    termo = str(bairro_cliente or "").strip()
    if not termo:
        return {"status": "nao_encontrado"}

    try:
        aprendido = db.collection("bairros_aprendizado").document(_normalizar_termo(termo)).get()
        if aprendido.exists:
            dados_aprendido = aprendido.to_dict()
            bot_cfg_taxa = obter_config_bot().get("taxa_entrega") or 0
            if dados_aprendido.get("atende"):
                return {
                    "status": "atende",
                    "bairro": dados_aprendido.get("bairro_original") or termo,
                    "taxa_entrega": bot_cfg_taxa
                }
            return {"status": "nao_atende_confirmado", "bairro": dados_aprendido.get("bairro_original") or termo}
    except Exception as e:
        print(f"Erro ao checar bairro aprendido: {e}")

    bot_cfg = obter_config_bot()
    bairros = [str(b).strip() for b in (bot_cfg.get("bairros_entrega") or []) if str(b).strip()]

    if not bairros:
        return {"status": "sem_lista_cadastrada"}

    # Compara sem acento dos dois lados — com acento, "são genaro" (a
    # forma como o cliente costuma digitar) pontuava EMPATADO ou PIOR
    # contra bairros errados tipo "São Judas Tadeu"/"Jardim São José"
    # (a letra "ã" compartilhada infla a pontuação do scorer padrão do
    # thefuzz) do que contra o bairro certo "San Genaro" — testado com a
    # lista real: 86 vs 84, o errado "ganhando". Sem acento, "san genaro"
    # sobe pra 90 e o falso positivo cai pra 86, com folga de verdade.
    bairros_normalizados = [_normalizar_termo(b) for b in bairros]
    melhor_match, pontuacao = process.extractOne(_normalizar_termo(termo), bairros_normalizados)
    print(f"DEBUG: bairro '{termo}' comparado com '{melhor_match}'. Pontuação: {pontuacao}")

    if pontuacao > 75:
        return {
            "status": "atende",
            "bairro": bairros[bairros_normalizados.index(melhor_match)],
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

    aviso_atencao_antiga = texto_atencao_pendente_antiga(id_usuario)

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
        instrucao_nome = f"Chame o cliente só pelo primeiro nome, '{primeiro_nome(nome_cliente)}' (nunca o nome completo, soa mais natural). NÃO pergunte o nome dele novamente."
    else:
        contexto_identificacao = "CLIENTE NOVO: Nome desconhecido."
        instrucao_nome = "Descubra o nome do cliente antes de finalizar o pedido."

    # 4. Ferramentas (Tools) - Mantive igual
    tools = [
        {
            "type": "function",
            "function": {
                "name": "calcular_pedido",
                "description": "Calcula uma PRÉVIA do pedido (itens reconhecidos, taxa de entrega, total) SEM registrar nada. Use pra mostrar o resumo e pedir confirmação do cliente antes de chamar 'registrar_pedido' de vez.",
                "parameters": {
                    "type": "object",
                    "properties": {
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
                        "tipo_entrega": {
                            "type": "string",
                            "enum": ["ENTREGA", "RETIRADA"],
                            "description": "OBRIGATÓRIO e explícito — nunca deduza pelo texto do endereço. Se ainda não sabe se é entrega ou retirada, não chame esta função ainda."
                        }
                    },
                    "required": ["itens", "tipo_entrega"]
                }
            }
        },
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
                        "tipo_entrega": {
                            "type": "string",
                            "enum": ["ENTREGA", "RETIRADA"],
                            "description": "OBRIGATÓRIO e explícito — nunca deduza pelo texto do endereço, mesmo que pareça óbvio."
                        },
                        "endereco_completo": {"type": "string", "description": "Se for ENTREGA: rua e número de verdade (não só o bairro). Se for RETIRADA, pode deixar vazio ou escrever 'Retirada no balcão'."},
                        "bairro": {"type": "string", "description": "Se for ENTREGA: o nome do bairro exatamente como 'verificar_bairro_entrega' confirmou (campo \"bairro\" do retorno) — fica separado do endereço pro painel/impressão mostrarem sozinho. Deixe vazio se for RETIRADA."},
                        "forma_pagamento": {"type": "string"},
                        "observacao": {"type": "string"}
                    },
                    "required": ["nome_cliente", "itens", "valor_total", "tipo_entrega", "endereco_completo", "forma_pagamento"]
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
        },
        {
            "type": "function",
            "function": {
                "name": "consultar_meu_pedido",
                "description": "Busca o pedido mais recente que este cliente já fez (itens, valor total, forma de pagamento, status). Use quando ele perguntar sobre um pedido já realizado — NUNCA use 'registrar_pedido' pra responder esse tipo de pergunta."
            }
        }
    ]

    nome_atendente = bot_cfg.get("nome_atendente") or BOT_CONFIG_DEFAULTS["nome_atendente"]
    nome_empresa = bot_cfg.get("nome_empresa") or BOT_CONFIG_DEFAULTS["nome_empresa"]
    # .strip() pra pegar também o caso de alguém salvar só espaço em branco
    # no painel — não é só "campo ausente" que precisa cair no fallback.
    chave_pix = (bot_cfg.get("chave_pix") or "").strip() or "consulte a equipe"
    instrucoes_extras = bot_cfg.get("instrucoes_extras") or ""
    cidade_atendida = bot_cfg.get("cidade_atendida") or ""

    # 5. Prompt Otimizado (Limpo e Direto)
    system_prompt = f"""
    Voce e {nome_atendente}, a IA da {nome_empresa}. Aja de forma natural, educada e vendedora.

    --- DADOS DO SISTEMA ---
    {contexto_identificacao}
    Telefone do Cliente: {id_usuario}
    {f"Cidade onde a loja entrega: {cidade_atendida} (só entrega dentro dessa cidade, nenhuma outra)." if cidade_atendida else ""}
    {aviso_atencao_antiga}
    
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
       - Sempre que for se dirigir ao cliente pelo nome (identificado ou se
         ele informar o nome completo na conversa), use só o primeiro nome
         — nunca o nome completo, soa mais natural e menos formal.

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
       - Se 'consultar_sabor' retornar "disponivel", ANTES de aceitar o
         resultado, confira com seu próprio bom senso: o "nome" devolvido é
         realmente o mesmo prato/sabor que o cliente pediu, ou é só uma
         busca aproximada que "achou algo parecido" mas é um produto
         diferente de verdade (sabor/recheio diferente)? A busca por texto
         não entende significado — ela pode devolver "Pastel Chocolate com
         Queijo" pra quem pediu "pastel de salsicha" só porque as palavras
         se parecem, mesmo sendo sabores completamente diferentes. Se o
         item devolvido claramente NÃO é o que o cliente pediu (recheio/
         sabor diferente, não é a mesma categoria de produto), trate como
         se tivesse vindo "indisponivel": diga que não achou esse item
         específico e ofereça mostrar as opções daquela categoria (ex.:
         "não achei pastel de salsicha no cardápio — quer ver os pastéis
         que temos?", chamando 'listar_cardapio' se ele disser que sim).
       - Se o item devolvido REALMENTE for o que o cliente quis dizer, use
         o nome EXATO do campo "nome" da resposta pra falar do produto —
         nunca o jeito que o cliente escreveu. ERRO REAL QUE JÁ ACONTECEU:
         cliente pediu "pastel de salsicha", a busca achou o item real
         "Salsicha" (não é um pastel, é vendida avulsa) e o bot confirmou
         "temos o pastel de salsicha" — inventou um produto que não existe,
         só por repetir a frase do cliente em vez do nome real. Se o nome
         real for parecido mas descrito diferente (esse caso, não o de
         sabor errado acima), avise com naturalidade (ex.: "achei aqui, é
         a nossa Salsicha — não é um pastel, é vendida avulsa mesmo, por
         R$ 6,50. Quer que eu adicione?").
       - Esse mesmo risco de casamento errado vale pra 'calcular_pedido' e
         'registrar_pedido' — elas também usam busca aproximada por texto,
         não por significado. NUNCA chame essas duas com um "nome_produto"
         que você ainda não confirmou ser o item certo (via 'consultar_sabor'
         ou já visto em 'listar_cardapio' nesta conversa) — passar direto o
         que o cliente escreveu, sem checar antes, arrisca registrar um
         prato errado no pedido de verdade.
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
          isso claro antes (ver abaixo, sobre bairro).
       c2) Se for ENTREGA: depois de confirmar que a loja atende o bairro
          (função 'verificar_bairro_entrega'), pergunte especificamente o
          ENDEREÇO COMPLETO — rua e número (e complemento, se tiver) — numa
          pergunta própria, tipo "Qual o endereço completo? (rua e número)".
          Bairro sozinho NUNCA é endereço suficiente pra registrar o
          pedido — "endereco_completo" tem que ter rua/número de verdade,
          não só o nome do bairro que o cliente já mencionou antes. Só
          depois de o cliente responder isso vá pro passo (d). Se for
          RETIRADA, pule direto pro passo (d).
       d) Depois de saber o endereço (ou que é retirada), pergunta a forma
          de pagamento (PIX, Cartão, Dinheiro).
       e) OBRIGATÓRIO antes de registrar de vez: chame 'calcular_pedido' com
          os itens que o cliente pediu E o "tipo_entrega" (ENTREGA ou
          RETIRADA) que você já confirmou nos passos (c)/(c2) — nunca deixe
          esse campo de fora nem deixe a função adivinhar: um pedido de
          entrega sem "tipo_entrega": "ENTREGA" explícito já saiu como
          retirada, e a taxa de entrega sumiu do total mostrado pro
          cliente. (Não registra nada, só calcula.) Mostre um resumo — cada
          item, a taxa de entrega se houver, e o "valor_total" que a função
          devolveu — perguntando algo como "Confere? Posso fechar o
          pedido?". SÓ chame 'registrar_pedido'
          depois que o cliente confirmar explicitamente (ex.: "sim",
          "confere", "pode fechar"). Se ele apontar algo errado (quantidade,
          item errado), corrija e chame 'calcular_pedido' de novo antes de
          pedir confirmação outra vez — nunca registre com base numa
          quantidade que você não confirmou com o cliente.
          ERRO REAL QUE JÁ ACONTECEU MAIS DE UMA VEZ: você escreveu um
          resumo com um total errado (somado de cabeça, sem ter chamado
          'calcular_pedido' nessa resposta) — isso é uma cobrança errada
          de verdade pro cliente, não é um erro cosmético. Antes de
          escrever QUALQUER "R$" nesse resumo, confirme pra si mesmo: "eu
          chamei 'calcular_pedido' NESTA resposta, e estou copiando o
          'valor_total' exatamente como veio?" — se a resposta for não,
          chame a função primeiro. Nunca some preços de itens de cabeça,
          mesmo que pareça uma conta simples.
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
       - Se vier "nao_atende_confirmado": a equipe já confirmou antes que
         NÃO entrega nesse bairro exato — diga isso com confiança, sem
         hesitar e sem escalar de novo (já é resposta definitiva), e ofereça
         a retirada no balcão como alternativa.
       - Se vier "nao_encontrado" ou "sem_lista_cadastrada":
         · Se a loja tem cidade configurada (ver "Cidade onde a loja
           entrega" no topo) e o que o cliente mencionou é claramente uma
           cidade DIFERENTE dessa (não um bairro local) — use seu
           conhecimento geral pra reconhecer isso (ex.: "Passos" é uma
           cidade vizinha, não um bairro de São Sebastião do Paraíso) — diga
           com confiança que a entrega é só dentro de "{cidade_atendida}" e
           que ali fora não dá, oferecendo a retirada no balcão como
           alternativa. NÃO escala pra equipe nesse caso — você já tem
           certeza suficiente sozinho.
         · Se for realmente ambíguo (pode ser um bairro local não
           cadastrado na lista, dentro da mesma cidade): diga que não tem
           certeza se esse bairro específico está na área de entrega, que
           vai confirmar com a equipe e avisa assim que souber — essa
           promessa agora é real (a equipe recebe um aviso no painel e
           pode responder, e essa resposta fica salva pra próxima vez que
           alguém perguntar do mesmo bairro). Enquanto isso, ofereça a
           retirada como alternativa imediata pro cliente não ficar sem
           opção. NÃO prossiga pra pergunta de pagamento nesse caso; espere
           o cliente decidir entre retirada ou continuar aguardando a
           entrega.
         · EXCEÇÃO — se no topo do prompt vier um aviso dizendo que essa
           mesma dúvida já foi escalada há mais de 10 minutos sem resposta:
           NÃO repita a promessa de confirmar com a equipe de novo — nesse
           caso, resolva você mesmo com o cliente (ofereça só a retirada,
           ou siga sem confirmar a entrega se ele preferir esperar por
           conta própria).
         Nunca invente uma resposta de "atende" ou "não atende" fora dessas
         situações.
       - IMPORTANTE: se o cliente já perguntou/mencionou um bairro pra
         entrega, ele JÁ deixou claro que quer "Entrega" — NUNCA pergunte
         "entrega ou retirada?" depois disso, seria redundante. Pule direto
         pro passo (c2): ainda falta pedir o endereço completo (rua/número)
         numa pergunta própria — o nome do bairro sozinho não é suficiente.

       IMPORTANTE SOBRE PIX:
       - Se for "PIX AGORA": Chave e {chave_pix}. Aguarde o comprovante.
       - Se for "PIX NA ENTREGA": Não precisa de comprovante agora.

    4. FINALIZAÇÃO:
       - Use a função 'registrar_pedido' APENAS quando tiver: Itens, Forma de
         Entrega, Forma de Pagamento definidos E o cliente já ter confirmado
         o resumo do passo (e) acima. Nunca pule direto pra 'registrar_pedido'
         sem antes ter mostrado o resumo via 'calcular_pedido' e recebido um
         "sim"/confirmação clara.
       - Se for ENTREGA, o parâmetro "endereco_completo" da função tem que
         ser o endereço de verdade (rua e número) que o cliente te passou
         no passo (c2) — NUNCA mande só o nome do bairro nesse campo. Já
         aconteceu de o pedido ser registrado só com o bairro (ex.:
         "endereco_completo": "São Judas Tadeu"), sem rua nem número, e o
         entregador não tem como achar a casa com isso.
       - Se for ENTREGA, mande TAMBÉM o parâmetro "bairro" (separado do
         endereço) com o nome exato que 'verificar_bairro_entrega' devolveu
         no campo "bairro" — o painel/impressão da loja mostra o bairro
         separado pro entregador, então esse campo não pode ficar vazio
         numa entrega de verdade.
       - Se o cliente perguntar sobre um pedido que ELE JÁ FEZ (ex.: "qual o
         valor do meu pedido?", "pode descrever meu pedido?", "o que eu
         pedi mesmo?", "cadê meu pedido"), use a função
         'consultar_meu_pedido' — NUNCA 'registrar_pedido' pra isso, mesmo
         que pareça mais simples. 'registrar_pedido' sempre CRIA um pedido
         novo no sistema; usá-la só pra responder uma pergunta duplica o
         pedido do cliente de verdade. Se 'consultar_meu_pedido' devolver
         "sem_pedido", diga que não encontrou nenhum pedido dele ainda.
       - Passe cada item pedido separadamente em "itens" (nome_produto +
         quantidade) — NUNCA junte tudo numa frase só de novo.
       - Se o cliente já tiver cadastro, use o nome '{nome_cliente}' na função. Se não, use o nome que ele informou.
       - O valor total que você informar ao cliente DEVE ser o "valor_total"
         que a própria função 'registrar_pedido' devolveu (ela já soma os
         itens certos + a taxa de entrega, se houver) — nunca calcule o
         total sozinho antes ou depois de chamar a função.
       - PERIGO DE MISTURAR PEDIDOS: cada chamada de 'registrar_pedido' cria
         um pedido NOVO e SEPARADO no sistema — nunca "soma" com um pedido
         que você já confirmou antes nesta mesma conversa. Se o cliente já
         tinha fechado um pedido e agora pede mais alguma coisa, isso vira
         um SEGUNDO pedido independente, com seu próprio total. Ao falar o
         total pro cliente depois dessa nova chamada, use SEMPRE o
         "valor_total" que ESSA chamada específica devolveu — nunca repita,
         some ou reaproveite um valor de um pedido anterior, mesmo que
         pareça "o mesmo pedido continuando". Se for mesmo um pedido
         adicional, deixe isso explícito pro cliente (ex.: "Registrei como
         um novo pedido, esse aqui fica R$ {{valor}}") em vez de dar a
         entender que é o mesmo total de antes.
       - Se a função devolver "itens_nao_reconhecidos" com algo dentro,
         avise o cliente que esses itens específicos não foram reconhecidos
         e pergunte de novo sobre eles (pode ser um apelido diferente do
         nome no cardápio) — não finja que deu tudo certo. Isso também fica
         registrado pro painel de Atendimento; se a equipe já tiver
         ensinado esse apelido antes, a próxima tentativa já reconhece
         normal, sem precisar escalar de novo.
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
        # timeout explícito: sem isso, uma resposta lenta/pendurada da OpenAI
        # prende essa thread indefinidamente. Como cada mensagem já roda numa
        # thread própria (travada só por cliente, não globalmente), isso por
        # si só não travaria outros clientes — mas travava ESSE cliente pro
        # resto da conversa, e sem limite de tempo. 60s é folgado pra uma
        # resposta com function-calling.
        response = openai.chat.completions.create(
            model=bot_cfg.get("modelo") or BOT_CONFIG_DEFAULTS["modelo"],
            messages=messages,
            tools=tools,
            tool_choice="auto",
            timeout=60
        )
        
        response_message = response.choices[0].message
        
        if response_message.tool_calls:
            messages.append(response_message)
            for tool_call in response_message.tool_calls:
                function_name = tool_call.function.name
                args = json.loads(tool_call.function.arguments)
                
                content = ""
                if function_name == "calcular_pedido":
                    content = calcular_pedido(id_usuario, args.get("itens"), args.get("tipo_entrega"))
                elif function_name == "consultar_sabor":
                    content = json.dumps(consultar_sabor(args.get("sabor_cliente")))
                elif function_name == "listar_cardapio":
                    content = listar_cardapio()
                elif function_name == "listar_bebidas":
                    content = listar_bebidas()
                elif function_name == "verificar_bairro_entrega":
                    content = json.dumps(verificar_bairro_entrega(args.get("bairro_cliente")))
                elif function_name == "consultar_meu_pedido":
                    content = consultar_meu_pedido(wa_id)
                elif function_name == "registrar_pedido":
                    content = registrar_pedido(
                        wa_id=wa_id,
                        nome_cliente=args.get("nome_cliente"),
                        itens=args.get("itens"),
                        valor_total=args.get("valor_total"),
                        observacao=args.get("observacao", "Nenhuma"),
                        endereco_completo=args.get("endereco_completo"),
                        bairro=args.get("bairro"),
                        forma_pagamento=args.get("forma_pagamento"),
                        tipo_entrega=args.get("tipo_entrega"),
                        telefone=wa_id,
                        id_usuario_cache=id_usuario
                    )

                # Sinaliza no painel de Atendimento quando o bot bate numa
                # situação que não consegue resolver sozinho — dá pra ver
                # o texto exato que o cliente digitou em 'args', então usa
                # ele na mensagem em vez do que a função devolveu. 'tipo' e
                # 'dados' alimentam a caixa de resposta rápida do painel.
                if function_name == "verificar_bairro_entrega":
                    try:
                        resultado_bairro = json.loads(content)
                        if resultado_bairro.get("status") in ("nao_encontrado", "sem_lista_cadastrada"):
                            bairro_cliente = args.get("bairro_cliente")
                            marcar_atencao(
                                id_usuario,
                                f"Bairro não reconhecido: \"{bairro_cliente}\"",
                                tipo="bairro",
                                dados={"bairro_cliente": bairro_cliente}
                            )
                    except (ValueError, TypeError):
                        pass
                elif function_name in ("registrar_pedido", "calcular_pedido"):
                    try:
                        resultado_pedido = json.loads(content)
                        nao_reconhecidos = resultado_pedido.get("itens_nao_reconhecidos") or []
                        if nao_reconhecidos:
                            marcar_atencao(
                                id_usuario,
                                f"Item(ns) não reconhecido(s) no pedido: {', '.join(nao_reconhecidos)}",
                                tipo="item",
                                dados={"nome_produto": nao_reconhecidos[0], "todos": nao_reconhecidos}
                            )
                    except (ValueError, TypeError):
                        pass

                messages.append({"tool_call_id": tool_call.id, "role": "tool", "name": function_name, "content": content})
            
            second_res = openai.chat.completions.create(model=bot_cfg.get("modelo") or BOT_CONFIG_DEFAULTS["modelo"], messages=messages, timeout=60)
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
            nome_cliente=primeiro_nome(nome_cliente),
            nome=primeiro_nome(nome_cliente),
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

                            # --- BLOQUEIO DE DUPLICIDADE (persistente, entre instâncias) ---
                            # O Meta reenvia o webhook (às vezes horas depois) se o 200 não
                            # volta rápido o bastante. Um set() em memória não sobrevive a um
                            # restart/cold-start do Cloud Run, então o bot reprocessava
                            # eventos antigos como se fossem mensagem nova — daí ele "puxava
                            # assunto sozinho". O claim abaixo é atômico: create() falha com
                            # AlreadyExists se outro processo (ou uma instância anterior) já
                            # reivindicou esse msg_id.
                            msg_id = message.get('id')
                            try:
                                db.collection('webhook_processed_ids').document(msg_id).create({
                                    'processado_em': firestore.SERVER_TIMESTAMP
                                })
                            except gcp_exceptions.AlreadyExists:
                                print(f"🚫 Mensagem repetida bloqueada: {msg_id}")
                                return "EVENT_RECEIVED", 200
                            # -----------------------------------------------------------

                            from_number = message['from']

                            # O Meta espera o 200 rápido — não o fim do processamento, que
                            # envolve Firestore + OpenAI + envio pelo WhatsApp e pode passar
                            # do timeout do webhook, disparando um retry (e uma resposta
                            # duplicada). Processa em background e confirma na hora.
                            threading.Thread(
                                target=processar_mensagem_recebida,
                                args=(message, from_number),
                                daemon=True
                            ).start()
                            return "EVENT_RECEIVED", 200

        return "OK", 200


_locks_por_cliente = {}
_locks_por_cliente_guard = threading.Lock()


def _lock_do_cliente(wa_id):
    # Uma thread por mensagem (bom pra concorrência entre clientes diferentes),
    # mas com um lock por wa_id: duas mensagens seguidas do MESMO cliente (ex.:
    # "Cartão" e "Sim" logo em seguida) não podem processar em paralelo, senão
    # correm pra ler/escrever o mesmo histórico no Firestore (leitura-
    # modificação-escrita não é atômica em salvar_historico_firestore) — a
    # segunda pode perder o contexto da primeira, a IA "confirma" o pedido em
    # texto mas nunca chama registrar_pedido de verdade. Uma fila GLOBAL única
    # já foi tentada aqui e criou o problema oposto: um cliente travado (ex.:
    # a chamada da OpenAI sem timeout demorando minutos) travava o atendimento
    # de TODO MUNDO, porque só existia um worker pra fila inteira.
    with _locks_por_cliente_guard:
        lock = _locks_por_cliente.get(wa_id)
        if lock is None:
            lock = threading.Lock()
            _locks_por_cliente[wa_id] = lock
        return lock


def processar_mensagem_recebida(message, from_number):
    with _lock_do_cliente(from_number):
        try:
            _processar_mensagem_recebida(message, from_number)
        except Exception as e:
            print(f"❌ Erro ao processar mensagem de {from_number}: {e}")


def _processar_mensagem_recebida(message, from_number):
    if 'text' in message:
        text = message['text']['body']
        ai_response = get_openai_response(text, from_number, "WPP")
        if ai_response:
            send_message(from_number, ai_response)

    elif 'image' in message or 'document' in message:
        tipo = 'image' if 'image' in message else 'document'
        media_id = message[tipo]['id']
        caminho_arquivo = baixar_imagem_whatsapp(media_id, tipo)
        if caminho_arquivo:
            nome_arquivo = os.path.basename(caminho_arquivo)
            url_publica = upload_comprovante_firebase(caminho_arquivo, nome_arquivo)
            if url_publica:
                msg = f"Recebi seu comprovante! Vou registrar aqui."
                send_message(from_number, msg)
                registrar_comprovante(from_number, url_publica)
                os.remove(caminho_arquivo)


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
        else:
            print(f"✅ WhatsApp enviado pra {to}: {resp.status_code}")
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
    """Atendente responde manualmente pelo painel: envia via WhatsApp e
    registra no histórico. Por padrão assume o controle manual da conversa
    (composer de texto livre) — mas a caixa de resposta rápida (bairro/item
    aprendido) manda 'assumir_manual: false', porque ali o objetivo é só
    informar o cliente e deixar o bot seguir cuidando do resto sozinho."""
    data = request.json or {}
    wa_id = re.sub(r'\D', '', str(data.get('wa_id') or ''))
    mensagem = str(data.get('mensagem') or '').strip()
    assumir_manual = data.get('assumir_manual', True)

    if not wa_id or not mensagem:
        return jsonify({"error": "wa_id e mensagem são obrigatórios"}), 400

    send_message(wa_id, mensagem)
    salvar_historico_firestore(wa_id, "assistant", mensagem)
    if assumir_manual:
        db.collection("historico_conversas").document(wa_id).set({"modo_manual": True}, merge=True)
    return jsonify({"ok": True}), 200

