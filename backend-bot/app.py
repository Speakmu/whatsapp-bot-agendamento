import re
import time
import unicodedata
import threading
import concurrent.futures
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
    # Padrão só quando o campo não existe em configuracoes/bot — o painel
    # grava "modelo" lá e esse valor VENCE este. Fase 5: mini é ~15x mais
    # barato que o gpt-4o e, com o prompt curto da Fase 4, aprova os mesmos
    # casos do harness (confira antes de trocar no painel).
    "modelo": "gpt-4o-mini",
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
    "mensagem_saiu_entrega": "Oi {nome_cliente}! Seu pedido saiu para entrega e ja esta a caminho! 🛵",
    "instrucoes_extras": "",
    "bairros_entrega": [],
    "taxa_entrega": 0,
    "cidade_atendida": "",
    # Desligado por padrão: antes era texto fixo no prompt convidando o
    # cliente a baixar o app pra ganhar pontos, mesmo em lojas onde o app
    # ainda não está no ar. Configurável em Config do Bot.
    "divulgar_app": False,
    # Vazio de propósito (mesmo motivo do chave_pix): sem link configurado,
    # o bot NÃO pode inventar "baixe na Play Store" — nem sempre existe
    # publicação de verdade nas lojas (o app pode estar só na versão web).
    "link_app": "",
    # Texto do convite pro app, editável (mesmo padrão de mensagem_pronto
    # etc.) — {link_app} é trocado pelo link real na hora de enviar.
    "mensagem_convite_app": ("Estamos com nosso app de pedidos! Lá você consegue ver todos os produtos. "
                              "Segue o link: {link_app}\n\nMas se quiser, pode fazer o pedido por aqui também!"),
    # Período de férias/fechamento — data (não horário) configurável no
    # painel. Enquanto ativo, bloqueia o bot igual ao horário de
    # funcionamento fechado, mas por um intervalo de dias em vez de horário
    # diário.
    "ferias_ativo": False,
    "ferias_inicio": "",  # "YYYY-MM-DD"
    "ferias_fim": "",     # "YYYY-MM-DD"
    "ferias_mensagem": "Estamos de férias no momento e voltamos no dia {data_volta}. Até lá!",
    # Encomenda de festa/cento não é um item do cardápio online — precisa ser
    # combinada direto com a loja (quantidade, prazo, sabores). Antes disso
    # ser configurável aqui, o bot tentava responder com preço por unidade
    # do cardápio normal quando o cliente perguntava "cento de salgados" ou
    # "salgadinhos pra festa", em vez de encaminhar pro contato certo.
    "aviso_encomenda_festa_ativo": True,
    "aviso_encomenda_festa_texto": ("Para encomendas de salgadinhos para festa ou cento de salgados, "
                                     "fale direto com a loja: Loja 1 - 3531-5342 (fixo) ou 98807-5519 (WhatsApp).")
}

def obter_config_bot():
    cfg = dict(BOT_CONFIG_DEFAULTS)
    try:
        doc = db.collection("configuracoes").document("bot").get(timeout=10)
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

def _converter_markdown_para_whatsapp(texto):
    """WhatsApp não renderiza Markdown padrão — manda como texto literal.
    Caso real de produção: a IA escreveu "**Total:**" e
    "[link](https://...)"; o cliente viu os asteriscos duplos e os
    colchetes/parênteses na tela sem nenhuma formatação de verdade (achou
    que o link tinha vindo "duplicado"). Converte pro que o WhatsApp
    realmente entende: negrito com UM asterisco, e link markdown vira só a
    URL (que o WhatsApp já sublinha e deixa clicável sozinho)."""
    if not texto:
        return texto

    def _link(m):
        rotulo, url = m.group(1).strip(), m.group(2).strip()
        return url if rotulo == url else f"{rotulo}: {url}"

    texto = re.sub(r'\[([^\]]+)\]\((https?://[^\s)]+)\)', _link, texto)
    texto = re.sub(r'\*\*(.+?)\*\*', r'*\1*', texto)
    return texto


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
        blob.upload_from_filename(caminho_local, timeout=30)

        # Torna o arquivo público para visualização (opcional) ou gera URL assinada
        blob.make_public(timeout=30)
        
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

# ---------- CARDÁPIO NO PROMPT (Fase 3) ----------
# O cardápio inteiro (com um código curto por item) vai no system prompt a
# cada mensagem. Antes a IA não tinha o cardápio e precisava chamar
# listar_cardapio/consultar_sabor e depois passar o NOME do item pra
# calcular/registrar, que refazia uma busca aproximada por texto — foi essa
# busca que produziu "enroladinho de salsicha → presunto e queijo",
# "coca zero → coca normal" e "pastel de salsicha → Salsicha avulsa".
# Agora a IA escolhe o item pelo CÓDIGO e o servidor resolve por id: não há
# mais casamento aproximado no caminho do pedido.

_CACHE_CARDAPIO = {"quando": 0.0, "itens": None}
_CACHE_CARDAPIO_LOCK = threading.Lock()
CACHE_CARDAPIO_SEGUNDOS = 20


def carregar_cardapio(forcar=False):
    """Lista de itens do cardápio (todos, disponíveis ou não), cada um com
    'id' (doc do Firestore) e 'codigo' (prefixo curto e único do id, que é
    o que a IA usa). Cache curto em memória: o cardápio é lido pelo prompt
    E pelas ferramentas na mesma mensagem, e uma leitura por mensagem basta.
    20s é curto o bastante pra um item desativado no painel (ou pela baixa
    de estoque) sumir do prompt antes da próxima mensagem do cliente."""
    agora = time.time()
    with _CACHE_CARDAPIO_LOCK:
        if not forcar and _CACHE_CARDAPIO["itens"] is not None and agora - _CACHE_CARDAPIO["quando"] < CACHE_CARDAPIO_SEGUNDOS:
            return _CACHE_CARDAPIO["itens"]
    itens = []
    for doc in db.collection('cardapio').get():
        dados = doc.to_dict() or {}
        itens.append({**dados, "id": doc.id})
    # Código = menor prefixo do id que seja único entre os itens (mín. 4).
    tamanho = 4
    while True:
        codigos = [it["id"][:tamanho] for it in itens]
        if len(set(codigos)) == len(codigos) or tamanho >= 20:
            break
        tamanho += 1
    for it, cod in zip(itens, codigos):
        it["codigo"] = cod
    with _CACHE_CARDAPIO_LOCK:
        _CACHE_CARDAPIO["itens"] = itens
        _CACHE_CARDAPIO["quando"] = agora
    return itens


def _resolver_item(item_id, cardapio):
    """Acha o item pelo código curto OU pelo id completo (a IA pode mandar
    qualquer um). None se não existir — nunca "o mais parecido"."""
    chave = str(item_id or "").strip()
    if not chave:
        return None
    for it in cardapio:
        if it["id"] == chave or it["codigo"] == chave:
            return it
    # Prefixo mais longo que o código (IA copiou mais caracteres do id)
    candidatos = [it for it in cardapio if it["id"].startswith(chave)] if len(chave) >= 4 else []
    return candidatos[0] if len(candidatos) == 1 else None


def _apelidos_aprendidos():
    """{item_id: [apelido, ...]} ensinados pela equipe no painel (coleção
    itens_aprendizado, doc id = apelido normalizado). Vão pro prompt junto
    do item pra IA reconhecer o jeito que o cliente costuma pedir."""
    apelidos = {}
    try:
        for doc in db.collection("itens_aprendizado").get():
            item_id = (doc.to_dict() or {}).get("item_id")
            if item_id:
                apelidos.setdefault(item_id, []).append(doc.id)
    except Exception as e:
        print(f"Erro ao ler itens_aprendizado: {e}")
    return apelidos


def montar_cardapio_prompt(cardapio=None):
    """Texto do cardápio pro system prompt: por categoria, um item por
    linha, "[codigo] Nome — R$ preço", com apelidos quando houver e
    "(ESGOTADO)" pros indisponíveis (a IA precisa saber que o item EXISTE
    mas está em falta, que é diferente de não existir). Itens só de balcão
    (disponivel_online=False) ficam de fora — pro WhatsApp eles não existem."""
    cardapio = cardapio if cardapio is not None else carregar_cardapio()
    apelidos = _apelidos_aprendidos()
    por_categoria = {}
    for it in cardapio:
        if not _disponivel_online(it):
            continue
        cat = str(it.get('categoria') or 'Outros').strip().title()
        nome = it.get('nome_exibicao') or it.get('nome') or '?'
        try:
            preco = f"R$ {float(it.get('preco') or 0):.2f}".replace('.', ',')
        except (TypeError, ValueError):
            preco = "R$ ?"
        linha = f"[{it['codigo']}] {nome} — {preco}"
        if it.get('disponivel') is False:
            linha += " (ESGOTADO hoje)"
        if apelidos.get(it['id']):
            linha += f" (o cliente também chama de: {', '.join(apelidos[it['id']])})"
        por_categoria.setdefault(cat, []).append(linha)
    if not por_categoria:
        return "CARDÁPIO: nenhum item cadastrado no momento."
    partes = []
    for cat, linhas in por_categoria.items():
        partes.append(f"{cat}:\n" + "\n".join("  " + l for l in linhas))

    # Bloco separado de apelidos: além da nota entre parênteses no item, uma
    # lista "o cliente diz X → é o item Y" no fim do cardápio. Já vimos o
    # modelo ignorar a nota no meio de 80+ linhas e responder "não temos
    # enroladinho de salsicha" com o apelido cadastrado exatamente assim.
    linhas_apelidos = []
    visiveis = {it['id']: it for it in cardapio if _disponivel_online(it)}
    for item_id, nomes in apelidos.items():
        it = visiveis.get(item_id)
        if not it:
            continue
        nome = it.get('nome_exibicao') or it.get('nome') or '?'
        for ap in nomes:
            linhas_apelidos.append(f'  "{ap}" → é o item [{it["codigo"]}] {nome}')
    if linhas_apelidos:
        partes.append("APELIDOS QUE OS CLIENTES USAM (ensinados pela equipe — quando o cliente pedir "
                      "por um desses nomes, ou algo muito parecido/com erro de digitação, é ESTE item; "
                      "não diga que não tem):\n" + "\n".join(linhas_apelidos))
    return "\n".join(partes)


def detalhar_item(item_id, cardapio=None):
    """Ferramenta: ingredientes/detalhes de UM item pelo código. Ingredientes
    ficam fora do prompt de propósito (custo por mensagem) — só entram
    quando o cliente pergunta."""
    cardapio = cardapio if cardapio is not None else carregar_cardapio()
    it = _resolver_item(item_id, cardapio)
    if not it or not _disponivel_online(it):
        return {"status": "nao_encontrado", "item_id": item_id}
    return {
        "status": "ok",
        "codigo": it["codigo"],
        "nome": it.get('nome_exibicao') or it.get('nome'),
        "categoria": it.get('categoria'),
        "preco": it.get('preco'),
        "disponivel": it.get('disponivel') is not False,
        "ingredientes": it.get('ingredientes') or "não informado",
    }


# ====================== RASCUNHO DE PEDIDO (Fase 4) ======================
# O pedido em andamento vive em 'pedidos_rascunho/{wa_id}', não na memória
# da IA. Antes, itens/entrega/pagamento só existiam no texto das últimas 24
# mensagens e a IA tinha que reconstruir tudo a cada resposta e mandar a
# lista inteira de novo em registrar_pedido — daí o carrinho "esquecido",
# o item que mudava entre cálculo e registro, o total somado de cabeça e o
# pedido duplicado na confirmação dupla. Agora as ferramentas são operações
# pequenas sobre o rascunho, e fechar_pedido() não recebe NADA: só lê o
# rascunho e recusa (com motivo) se faltar algo. Regra em código, não em
# prompt.

FORMAS_PAGAMENTO = {"PIX": "PIX", "CARTAO": "CARTÃO", "CARTÃO": "CARTÃO", "DINHEIRO": "DINHEIRO",
                    "DEBITO": "CARTÃO", "DÉBITO": "CARTÃO", "CREDITO": "CARTÃO", "CRÉDITO": "CARTÃO"}
MINUTOS_TRAVA_REFECHAMENTO = 5


def _rascunho_ref(wa_id):
    return db.collection("pedidos_rascunho").document(str(wa_id))


HORAS_EXPIRA_RASCUNHO = 6


def _rascunho_vazio():
    return {"itens": [], "tipo_entrega": None, "bairro": None, "endereco": None,
            "forma_pagamento": None, "nome_cliente": None, "observacao": None,
            "bairro_pendente": None, "bairro_novo": None, "endereco_sugerido": None,
            "resumo_visto_em": None, "atualizado_em": None, "criado_em": datetime.now(timezone.utc),
            "pedido_id": None, "fechado_em": None, "ultimo_pedido": None}


def obter_rascunho(wa_id):
    """Rascunho atual do cliente. Um rascunho já FECHADO (pedido criado)
    conta como vazio: o próximo item começa um pedido novo e independente —
    é o caso "cliente fechou e depois pediu mais uma coisa"."""
    try:
        doc = _rascunho_ref(wa_id).get(timeout=10)
        if doc.exists:
            r = doc.to_dict() or {}
            if not r.get("pedido_id"):
                # Caso real (26/09): carrinho abandonado em 17/09 voltou a valer 9
                # dias depois — itens que a cliente nunca pediu entraram no total.
                # Carrinho parado há mais de HORAS_EXPIRA_RASCUNHO começa do zero
                # (só guarda a referência do último pedido fechado).
                ultimo_toque = r.get("atualizado_em") or r.get("criado_em")
                if (r.get("itens") and ultimo_toque
                        and datetime.now(timezone.utc) - ultimo_toque > timedelta(hours=HORAS_EXPIRA_RASCUNHO)):
                    base = _rascunho_vazio()
                    base["ultimo_pedido"] = r.get("ultimo_pedido")
                    return base
                base = _rascunho_vazio()
                base.update(r)
                return base
            # Marcador de pedido fechado: o rascunho novo nasce vazio, mas
            # LEMBRA do último pedido (pra fechar_pedido reconhecer o cliente
            # que "confirma" de novo depois da IA remontar o carrinho igual).
            base = _rascunho_vazio()
            base["ultimo_pedido"] = {"pedido_id": r.get("pedido_id"), "fechado_em": r.get("fechado_em"),
                                     "valor_total": r.get("valor_total"), "itens_fechados": r.get("itens_fechados") or []}
            return base
    except Exception as e:
        print(f"Erro ao ler rascunho: {e}")
    return _rascunho_vazio()


def _mesmo_pedido(r, fechado):
    """Rascunho atual tem exatamente os itens (id, quantidade) do pedido fechado?"""
    atual = sorted((str(i.get("id")), int(i.get("quantidade") or 0)) for i in r.get("itens") or [])
    antigo = sorted((str(i.get("id")), int(i.get("quantidade") or 0)) for i in fechado.get("itens_fechados") or [] if isinstance(i, dict))
    return bool(atual) and atual == antigo


def _salvar_rascunho(wa_id, r, tocou=True):
    if tocou:
        r["atualizado_em"] = datetime.now(timezone.utc)
    try:
        _rascunho_ref(wa_id).set(r, timeout=10)
    except Exception as e:
        print(f"Erro ao salvar rascunho: {e}")


def _totais_rascunho(r, bot_cfg):
    valor_itens = round(sum(float(i.get("preco") or 0) for i in r.get("itens") or []), 2)
    taxa = 0.0
    if r.get("tipo_entrega") == "ENTREGA":
        taxa = float((bot_cfg or {}).get("taxa_entrega") or 0)
    return valor_itens, taxa, round(valor_itens + taxa, 2)


def _faltando(r):
    """O que ainda impede fechar — na ordem em que o atendente deve perguntar."""
    f = []
    if not r.get("itens"):
        f.append("itens")
    if r.get("tipo_entrega") not in ("ENTREGA", "RETIRADA"):
        f.append("tipo_entrega")
    elif r.get("tipo_entrega") == "ENTREGA":
        if not r.get("bairro"):
            f.append("bairro")
        if not any(ch.isdigit() for ch in str(r.get("endereco") or "")):
            f.append("endereco_com_numero")
    if not r.get("forma_pagamento"):
        f.append("forma_pagamento")
    # Nome NÃO bloqueia: no harness o gpt-4o-mini pediu "nome completo" três
    # vezes seguidas e gastou os "sim" do cliente nisso — 13 de 19 casos sem
    # pedido nenhum. fechar_pedido usa "Cliente" se não souber.
    return f


def _resumo_rascunho(r, bot_cfg, status="ok", **extra):
    """Formato que TODAS as ferramentas do rascunho devolvem: o estado
    inteiro, com totais do servidor e a lista do que falta. A IA responde
    olhando pra isto, nunca pra memória dela."""
    valor_itens, taxa, total = _totais_rascunho(r, bot_cfg)
    out = {
        "status": status,
        "itens": [{"item_id": i.get("codigo") or i.get("id"), "nome": i.get("nome_exibicao") or i.get("nome"),
                   "quantidade": i.get("quantidade"), "preco_unitario": i.get("preco_unitario"), "subtotal": i.get("preco")}
                  for i in r.get("itens") or []],
        "tipo_entrega": r.get("tipo_entrega"),
        "bairro": r.get("bairro"),
        "endereco": r.get("endereco"),
        "forma_pagamento": r.get("forma_pagamento"),
        "nome_cliente": r.get("nome_cliente"),
        "observacao": r.get("observacao"),
        "valor_itens": valor_itens,
        "taxa_entrega": taxa,
        "valor_total": total,
        "falta_para_fechar": _faltando(r),
        "nome_pendente": not r.get("nome_cliente"),
    }
    if not r.get("nome_cliente"):
        out["dica_nome"] = "Ainda não sei o nome: pergunte JUNTO com a confirmação do resumo (não numa rodada só pra isso). Se o cliente não quiser dizer, feche mesmo assim."
    # Caso real de produção: cliente fechou um pedido (R$65), na mensagem
    # seguinte pediu pra TROCAR um item ("é com catupiry", "vai ficar 66")
    # querendo corrigir o pedido já fechado — mas como fechar_pedido reseta
    # o rascunho (obter_rascunho trata pedido_id como "vazio pro próximo"),
    # a IA acabou mexendo num carrinho novo e vazio e AINDA ASSIM respondeu
    # com um resumo "corrigido" de R$66 como se fosse o pedido do cliente.
    # O pedido de verdade continuou R$65, intocado — o cliente achou que
    # tinha corrigido e não tinha. Sem essa função existir (editar pedido
    # já fechado), a única saída seria a equipe ajustar na mão; a IA
    # precisa saber disso pra não inventar uma "correção" que não existe.
    ultimo = r.get("ultimo_pedido") or {}
    fechado_em = ultimo.get("fechado_em")
    if ultimo.get("pedido_id") and fechado_em and (datetime.now(timezone.utc) - fechado_em) < timedelta(minutes=30):
        out["aviso_pedido_anterior_fechado"] = (
            f"O pedido anterior (R$ {ultimo.get('valor_total')}) JÁ FOI REGISTRADO — não existe função pra editar um "
            "pedido depois de fechado. Este resumo aqui é de um carrinho NOVO e separado, não é o pedido antigo "
            "corrigido. Se o cliente estava tentando CORRIGIR/TROCAR ALGO do pedido anterior (não pedindo algo "
            "novo), NUNCA diga que 'corrigiu' o pedido nem informe um total como se fosse dele — diga que vai "
            "avisar a equipe pra ajustar esse pedido manualmente."
        )
    out.update(extra)
    return out


def _pedido_recem_fechado(r, minutos=30):
    """Devolve o último pedido fechado se foi há pouco tempo, senão None."""
    ultimo = r.get("ultimo_pedido") or {}
    fechado_em = ultimo.get("fechado_em")
    if ultimo.get("pedido_id") and fechado_em and (datetime.now(timezone.utc) - fechado_em) < timedelta(minutes=minutos):
        return ultimo
    return None


def rascunho_adicionar_item(wa_id, item_id, quantidade, bot_cfg, cardapio=None):
    cardapio = cardapio if cardapio is not None else carregar_cardapio()
    r = obter_rascunho(wa_id)
    it = _resolver_item(item_id, cardapio)
    if not it or not _disponivel_online(it):
        return _resumo_rascunho(r, bot_cfg, status="erro",
                                motivo=f"Código '{item_id}' não existe no cardápio de agora. Use um código da lista do prompt.")
    if it.get("disponivel") is False:
        return _resumo_rascunho(r, bot_cfg, status="erro",
                                motivo=f"'{it.get('nome_exibicao') or it.get('nome')}' está ESGOTADO hoje — avise o cliente e ofereça outro item.")
    try:
        qtd = max(1, int(quantidade or 1))
    except (TypeError, ValueError):
        qtd = 1
    preco_unit = float(it.get("preco") or 0)
    for existente in r["itens"]:
        if existente.get("id") == it["id"]:
            existente["quantidade"] = int(existente.get("quantidade") or 0) + qtd
            existente["preco"] = round(preco_unit * existente["quantidade"], 2)
            existente["nome"] = f"{existente['quantidade']}x {it.get('nome')}" if existente["quantidade"] > 1 else it.get("nome")
            break
    else:
        r["itens"].append({
            "id": it["id"], "codigo": it["codigo"],
            "nome": f"{qtd}x {it.get('nome')}" if qtd > 1 else it.get("nome"),
            "nome_exibicao": it.get("nome_exibicao") or it.get("nome"),
            "quantidade": qtd, "preco_unitario": preco_unit, "preco": round(preco_unit * qtd, 2),
            "pontos_fidelidade": int(it.get("pontos_fidelidade", 0) or 0),
        })
    r["resumo_visto_em"] = None          # carrinho mudou: o cliente precisa ver o resumo de novo antes de fechar
    _salvar_rascunho(wa_id, r)
    return _resumo_rascunho(r, bot_cfg)


def rascunho_remover_item(wa_id, item_id, quantidade, bot_cfg, cardapio=None):
    cardapio = cardapio if cardapio is not None else carregar_cardapio()
    r = obter_rascunho(wa_id)
    it = _resolver_item(item_id, cardapio)
    alvo = next((i for i in r["itens"] if it and i.get("id") == it["id"]), None)
    if not alvo:
        return _resumo_rascunho(r, bot_cfg, status="erro", motivo=f"Código '{item_id}' não está no pedido.")
    try:
        qtd = int(quantidade) if quantidade is not None else None
    except (TypeError, ValueError):
        qtd = None
    if qtd is None or qtd >= int(alvo.get("quantidade") or 0):
        r["itens"].remove(alvo)
    else:
        alvo["quantidade"] = int(alvo["quantidade"]) - qtd
        alvo["preco"] = round(float(alvo["preco_unitario"]) * alvo["quantidade"], 2)
        nome_base = alvo.get("nome_exibicao") or alvo.get("nome")
        alvo["nome"] = f"{alvo['quantidade']}x {nome_base}" if alvo["quantidade"] > 1 else nome_base
    r["resumo_visto_em"] = None
    _salvar_rascunho(wa_id, r)
    return _resumo_rascunho(r, bot_cfg)


def rascunho_definir_entrega(wa_id, tipo, bairro, endereco, bot_cfg, texto_cliente=None):
    r = obter_rascunho(wa_id)
    tipo = str(tipo or "").strip().upper()
    if tipo not in ("ENTREGA", "RETIRADA"):
        return _resumo_rascunho(r, bot_cfg, status="erro", motivo="tipo deve ser ENTREGA ou RETIRADA.")
    if tipo == "RETIRADA":
        if r.get("tipo_entrega") == "RETIRADA":
            return _resumo_rascunho(r, bot_cfg)          # já era retirada: nada mudou, não invalida o resumo
        r.update({"tipo_entrega": "RETIRADA", "bairro": None, "endereco": "Retirada no balcão"})
        r["resumo_visto_em"] = None
        _salvar_rascunho(wa_id, r)
        return _resumo_rascunho(r, bot_cfg)

    antes = (r.get("tipo_entrega"), r.get("bairro"), r.get("endereco"))
    r["tipo_entrega"] = "ENTREGA"
    avisos = []
    if bairro:
        # Bairro que ESTE cliente acabou de confirmar ser da cidade: continua valendo
        # (a config carregada no início da mensagem ainda não o tem nos pendentes).
        if r.get("bairro_novo") and _normalizar_termo(r["bairro_novo"]) == _normalizar_termo(bairro):
            res = {"status": "atende", "bairro": r["bairro_novo"]}
        else:
            res = verificar_bairro_entrega(bairro, bot_cfg)
        if res.get("status") == "atende":
            r["bairro"] = res.get("bairro")
            if res.get("bairro_novo"):
                r["bairro_novo"] = res.get("bairro")
        elif res.get("status") == "nao_atende_confirmado":
            r["bairro"] = None
            avisos.append(f"A equipe já confirmou que NÃO entregamos em '{bairro}'. Ofereça retirada.")
        else:
            r["bairro"] = None
            pend = _marcar_bairro_pendente(wa_id, bairro, bot_cfg, texto_cliente=texto_cliente)
            r["bairro_pendente"] = obter_rascunho(wa_id).get("bairro_pendente")
            avisos.append(pend["instrucao"] + (f" Pergunta: \"{pend['pergunta']}\"" if pend.get("pergunta") else ""))
    if endereco is not None:
        end = str(endereco).strip()
        if end and not any(ch.isdigit() for ch in end):
            avisos.append("Endereço sem número — peça rua e número.")
            r["endereco"] = None
        else:
            r["endereco"] = end or None
    # Idempotência: o gpt-4o-mini "reconfirma" entrega/pagamento no turno do
    # "sim". Se nada mudou de fato, não invalida o resumo já mostrado — senão
    # fechar_pedido recusa e o "sim" do cliente é desperdiçado (harness).
    if bairro or endereco:
        r["endereco_sugerido"] = None      # cliente deu endereço: não sugere o antigo
    elif not r.get("bairro") and not r.get("endereco") and not r.get("endereco_sugerido"):
        sug = _endereco_do_ultimo_pedido(wa_id, bot_cfg)
        if sug:
            r["endereco_sugerido"] = sug
            _salvar_rascunho(wa_id, r, tocou=False)
    if r.get("endereco_sugerido") and not r.get("bairro"):
        avisos.append(f"O cliente já recebeu aqui antes. Pergunte EXATAMENTE: \"{_pergunta_mesmo_endereco(r['endereco_sugerido'])}\"")
    if (r.get("tipo_entrega"), r.get("bairro"), r.get("endereco")) != antes:
        r["resumo_visto_em"] = None
        _salvar_rascunho(wa_id, r)
    return _resumo_rascunho(r, bot_cfg, avisos=avisos) if avisos else _resumo_rascunho(r, bot_cfg)


def _endereco_do_ultimo_pedido(wa_id, bot_cfg):
    """Endereço do último pedido de ENTREGA do cliente (WhatsApp ou app), se o
    bairro continua atendido. Caso real (29/09): a cliente tinha recebido no dia
    anterior na Rua Noruega 140, Jardim Europa, e o bot pediu tudo de novo."""
    try:
        for _doc, p in _pedidos_do_cliente(wa_id, limite=10):
            end, bai = str(p.get("endereco") or "").strip(), str(p.get("bairro") or "").strip()
            if (str(p.get("tipo_entrega") or "").upper() != "ENTREGA" or p.get("status") == "CANCELADO"
                    or not bai or not any(ch.isdigit() for ch in end)):
                continue
            res = verificar_bairro_entrega(bai, bot_cfg)
            if res.get("status") != "atende":
                return None
            return {"bairro": res.get("bairro") or bai, "endereco": end}
    except Exception as e:
        print(f"Erro ao buscar endereço do último pedido: {e}")
    return None


def _pergunta_mesmo_endereco(sug):
    return f"Entrego no mesmo endereço do último pedido: {sug['endereco']} — {sug['bairro']}?"


_RE_SIM_ENDERECO = re.compile(r"^(sim|s|ss|isso|isso mesmo|mesmo|o mesmo|e o mesmo|mesmo endereco|pode|pode sim|pode ser|"
                              r"claro|certo|correto|exato|ok|beleza|blz|esse mesmo|e esse|aham|uhum)\b")
_RE_NAO_ENDERECO = re.compile(r"^(nao|n|nop|negativo|outro)\b|outro endereco|mudei|endereco diferente")


def rascunho_definir_pagamento(wa_id, forma, bot_cfg):
    r = obter_rascunho(wa_id)
    chave = _normalizar_termo(forma).upper().replace("Ã", "A")
    forma_norm = None
    for k, v in FORMAS_PAGAMENTO.items():
        if _normalizar_termo(k).upper() in chave:
            forma_norm = v
            break
    if not forma_norm:
        return _resumo_rascunho(r, bot_cfg, status="erro", motivo="Forma de pagamento deve ser PIX, CARTÃO ou DINHEIRO.")
    if r.get("forma_pagamento") != forma_norm:
        r["forma_pagamento"] = forma_norm
        r["resumo_visto_em"] = None
        _salvar_rascunho(wa_id, r)
    extra = {}
    if forma_norm == "PIX":
        chave_pix = ((bot_cfg or {}).get("chave_pix") or "").strip()
        extra["chave_pix"] = chave_pix or "NÃO CONFIGURADA — diga pro cliente que a equipe passa a chave"
        extra["aviso_pix"] = ("PIX é antecipado: passe a chave e diga que precisa do comprovante antes do preparo. "
                              "Na MESMA resposta mostre o resumo (itens, taxa, valor_total) e pergunte 'Confere? Posso fechar?' — "
                              "não termine a resposta sem essa pergunta. O comprovante vem DEPOIS do fechamento: quando o "
                              "cliente confirmar, feche o pedido (fechar_pedido) — NUNCA exija o comprovante pra fechar.")
    return _resumo_rascunho(r, bot_cfg, **extra)


def rascunho_definir_nome(wa_id, nome, bot_cfg):
    r = obter_rascunho(wa_id)
    nome = str(nome or "").strip()
    if nome.lower() in ("", "none", "null", "n/a"):
        return _resumo_rascunho(r, bot_cfg, status="erro", motivo="Nome vazio.")
    r["nome_cliente"] = nome
    _salvar_rascunho(wa_id, r, tocou=False)
    return _resumo_rascunho(r, bot_cfg)


def rascunho_definir_observacao(wa_id, observacao, bot_cfg):
    r = obter_rascunho(wa_id)
    r["observacao"] = str(observacao or "").strip() or None
    _salvar_rascunho(wa_id, r, tocou=False)
    return _resumo_rascunho(r, bot_cfg)


def rascunho_para_prompt(r, bot_cfg):
    """Estado do pedido em andamento, injetado no system prompt a cada
    mensagem — a IA sabe o que já está no carrinho e o que falta sem
    precisar chamar ver_resumo nem reler a conversa."""
    pendente = (f"\n  BAIRRO AGUARDANDO RESPOSTA DO CLIENTE: '{r['bairro_pendente']}' — pergunta feita: "
                f"\"{_pergunta_perimetro(r['bairro_pendente'], bot_cfg)}\" Quando ele responder, chame confirmar_bairro_na_cidade."
                if r.get("bairro_pendente") else "")
    if r.get("endereco_sugerido") and not r.get("bairro"):
        pendente = (f"\n  ENDEREÇO DO ÚLTIMO PEDIDO DO CLIENTE: {r['endereco_sugerido']['endereco']} — "
                    f"{r['endereco_sugerido']['bairro']}. Ao pedir o endereço de entrega, pergunte: "
                    f"\"{_pergunta_mesmo_endereco(r['endereco_sugerido'])}\"") + pendente
    if not r.get("itens") and not r.get("tipo_entrega") and not r.get("forma_pagamento"):
        return "PEDIDO EM ANDAMENTO: nenhum (carrinho vazio)." + pendente
    valor_itens, taxa, total = _totais_rascunho(r, bot_cfg)
    linhas = ["PEDIDO EM ANDAMENTO (do servidor — fonte da verdade):"]
    for i in r.get("itens") or []:
        linhas.append(f"  - {i.get('quantidade')}x {i.get('nome_exibicao') or i.get('nome')} [{i.get('codigo') or i.get('id')}] = R$ {float(i.get('preco') or 0):.2f}")
    linhas.append(f"  entrega: {r.get('tipo_entrega') or '?'} | bairro: {r.get('bairro') or '?'} | endereço: {r.get('endereco') or '?'}")
    linhas.append(f"  pagamento: {r.get('forma_pagamento') or '?'} | nome: {r.get('nome_cliente') or '?'}")
    linhas.append(f"  itens R$ {valor_itens:.2f} + taxa R$ {taxa:.2f} = TOTAL R$ {total:.2f}")
    faltando = _faltando(r)
    linhas.append(f"  falta para fechar: {', '.join(faltando) if faltando else 'nada — mostre o resumo (ver_resumo) e peça confirmação'}")
    return "\n".join(linhas) + pendente


def _aplicar_nome_identificado(r, nome_identificado):
    """Cliente com cadastro (usuarios_app): o nome já é conhecido, não
    precisa perguntar nem chamar definir_nome."""
    if not r.get("nome_cliente") and nome_identificado:
        r["nome_cliente"] = str(nome_identificado).strip()
    return r


def _texto_seguro_progresso(wa_id, bot_cfg, nome_cliente=None, pergunta_prioritaria=None):
    """Usada quando um guard troca a resposta da IA por algo seguro. Caso
    real de produção: o guard de _soa_como_confirmacao disparou (falso
    positivo — a IA só descreveu itens já salvos de verdade via
    adicionar_item, não inventou um pedido fechado) e a resposta genérica
    pedia pro cliente confirmar TUDO de novo, inclusive o endereço que ele
    tinha acabado de mandar — pareceu o bot travado repetindo a mesma
    pergunta. Em vez de um texto fixo, monta a pergunta a partir do estado
    REAL do rascunho: só pede o que realmente falta.

    'pergunta_prioritaria': pergunta que o servidor exigiu nesta mensagem (ex.:
    qual variação da coxinha). Caso real: o texto seguro trocava a resposta e a
    pergunta sumia — as coxinhas nunca entraram no pedido."""
    if pergunta_prioritaria:
        return pergunta_prioritaria
    resumo = rascunho_ver_resumo(wa_id, bot_cfg, nome_identificado=nome_cliente)
    itens = resumo.get("itens") or []
    if not itens:
        return "Pode me confirmar os itens que você quer no pedido?"
    if resumo.get("pode_fechar"):
        itens_txt = ", ".join(f"{i['quantidade']}x {i['nome']}" for i in itens)
        total_txt = f"{float(resumo.get('valor_total') or 0):.2f}".replace(".", ",")
        return f"Deixa eu confirmar: {itens_txt} — total R$ {total_txt}. Posso fechar esse pedido?"
    perguntas = {
        "tipo_entrega": "é pra entrega ou retirada?",
        "bairro": "qual é o bairro da entrega?",
        "endereco_com_numero": "pode me passar o endereço completo com número?",
        "forma_pagamento": "qual vai ser a forma de pagamento: PIX, cartão ou dinheiro?",
    }
    falta = resumo.get("falta_para_fechar") or []
    pedir = next((f for f in falta if f != "itens"), None)
    itens_txt = ", ".join(f"{i['quantidade']}x {i['nome']}" for i in itens)
    total_txt = f"{float(resumo.get('valor_total') or 0):.2f}".replace(".", ",")
    return (f"Seu pedido até agora: {itens_txt} — total R$ {total_txt}.\n"
            f"Só falta uma coisa pra eu fechar: {perguntas.get(pedir, 'pode confirmar o que ainda falta?')}")


def rascunho_ver_resumo(wa_id, bot_cfg, nome_identificado=None):
    """Marca que o resumo foi mostrado — fechar_pedido exige isso DEPOIS
    da última alteração no carrinho/entrega/pagamento."""
    r = _aplicar_nome_identificado(obter_rascunho(wa_id), nome_identificado)
    r["resumo_visto_em"] = datetime.now(timezone.utc)
    _salvar_rascunho(wa_id, r, tocou=False)
    faltando = _faltando(r)
    return _resumo_rascunho(r, bot_cfg, pode_fechar=not faltando,
                            instrucao=("Mostre este resumo ao cliente (itens, taxa, total) e pergunte se pode fechar."
                                       if not faltando else f"Ainda falta: {', '.join(faltando)}. Pergunte UMA coisa por vez."))


def rascunho_fechar_pedido(wa_id, bot_cfg, nome_identificado=None, confirmacao_explicita=False):
    """Cria o pedido REAL em 'pedidos' a partir do rascunho. Sem parâmetros:
    tudo vem do rascunho. Recusa com motivo se faltar algo — é aqui que as
    regras que antes eram prompt viram código.

    'confirmacao_explicita': o cliente acabou de responder "sim" a "posso
    fechar?" — a gate do resumo é dispensada (o resumo já foi mostrado, no
    texto da IA, mesmo que ela não tenha chamado ver_resumo)."""
    r = _aplicar_nome_identificado(obter_rascunho(wa_id), nome_identificado)

    # Idempotência: cliente confirma duas vezes ("pode sim" + "confirma") →
    # a segunda chamada devolve o MESMO pedido, não cria outro.
    try:
        doc = _rascunho_ref(wa_id).get(timeout=10)
        bruto = (doc.to_dict() or {}) if doc.exists else {}
        fechado = bruto if bruto.get("pedido_id") else (bruto.get("ultimo_pedido") or {})
        if fechado.get("pedido_id") and fechado.get("fechado_em") \
                and (datetime.now(timezone.utc) - fechado["fechado_em"]) < timedelta(minutes=MINUTOS_TRAVA_REFECHAMENTO) \
                and (not r.get("itens") or _mesmo_pedido(r, fechado)):
            # Carrinho vazio OU a IA remontou o MESMO pedido (harness: "pode
            # sim" fechou, "confirma" → mini chamou adicionar_item/definir_*/
            # fechar_pedido de novo e criava um 2º pedido idêntico). Devolve
            # o pedido já feito e limpa a remontagem.
            if r.get("itens"):
                _rascunho_ref(wa_id).set({"pedido_id": fechado["pedido_id"], "fechado_em": fechado["fechado_em"],
                                          "valor_total": fechado.get("valor_total"), "itens_fechados": fechado.get("itens_fechados") or [],
                                          "nome_cliente": r.get("nome_cliente")}, timeout=10)
            return {"status": "ok", "ja_estava_fechado": True, "pedido_id": fechado["pedido_id"],
                    "valor_total": fechado.get("valor_total"),
                    "itens": [i.get("nome") if isinstance(i, dict) else i for i in fechado.get("itens_fechados") or []],
                    "instrucao": "Este pedido JÁ foi registrado há pouco. Não registre de novo; só confirme pro cliente."}
    except Exception as e:
        print(f"Erro ao checar refechamento: {e}")

    faltando = _faltando(r)
    if faltando:
        return _resumo_rascunho(r, bot_cfg, status="erro",
                                motivo=f"Não dá pra fechar: falta {', '.join(faltando)}. Pergunte UMA coisa por vez.")
    resumo_pendente = not r.get("resumo_visto_em") or (r.get("atualizado_em") and r["resumo_visto_em"] < r["atualizado_em"])
    if resumo_pendente and not confirmacao_explicita:
        # O gpt-4o-mini escreve o resumo no texto sem chamar ver_resumo, e
        # depois chama fechar_pedido. Em vez de recusar "pra sempre", esta
        # chamada VALE como resumo: marca visto e devolve o estado pra IA
        # mostrar e perguntar "posso fechar?". A próxima chamada (depois do
        # "sim") fecha.
        r["resumo_visto_em"] = datetime.now(timezone.utc)
        _salvar_rascunho(wa_id, r, tocou=False)
        return _resumo_rascunho(r, bot_cfg, status="precisa_confirmar",
                                motivo="NÃO fechei ainda. Mostre este resumo ao cliente (itens, taxa, valor_total) e pergunte "
                                       "'Confere? Posso fechar?'. Quando ele confirmar, chame fechar_pedido de novo.")

    em_ferias, msg_ferias = verificar_ferias(bot_cfg)
    if em_ferias:
        return {"status": "erro", "motivo": msg_ferias}
    aberto, texto_horario = verificar_horario_funcionamento(bot_cfg)
    if not aberto:
        return {"status": "erro", "motivo": "Loja fechada no momento.", "horario_funcionamento": texto_horario}

    fuso_br = timezone(timedelta(hours=-3))
    agora_br = datetime.now(fuso_br)
    valor_itens, taxa, total = _totais_rascunho(r, bot_cfg)
    itens_pedido = [{
        "id": i["id"], "nome": i["nome"], "nome_exibicao": i.get("nome_exibicao"),
        "quantidade": i["quantidade"], "preco_unitario": i["preco_unitario"], "preco": i["preco"],
    } for i in r["itens"]]
    total_pontos = sum(int(i.get("pontos_fidelidade", 0) or 0) * int(i.get("quantidade") or 0) for i in r["itens"])

    try:
        user_query = db.collection('usuarios_app').where('telefone', '==', str(wa_id)).limit(1).get()
        user_doc = user_query[0] if user_query else None
        usuario_id = user_doc.id if user_doc else f"wa_{wa_id}"

        batch = db.batch()
        pedido_ref = db.collection('pedidos').document()
        dados_pedido = {
            "origem": "WHATSAPP",
            "data_formatada": agora_br.strftime('%d/%m/%Y %H:%M:%S'),
            "endereco": r.get("endereco"),
            "bairro": r.get("bairro"),
            "tipo_entrega": r["tipo_entrega"],
            "forma_pagamento": r["forma_pagamento"],
            "hora_pedido": agora_br,
            "itens": itens_pedido,
            "nome_cliente": r.get("nome_cliente") or "Cliente",
            "observacao": r.get("observacao") or "Nenhuma",
            "pagamento_id": int(datetime.now().timestamp()),
            # Fidelidade é só pelo app — pedido do bot não pontua (decisão do
            # negócio), por isso nada de pontos_a_creditar aqui.
            "status": "PENDENTE_PREPARO",
            "telefone_cliente": str(wa_id),
            "usuario_id": usuario_id,
            "valor_total": total,
            "valor_itens": valor_itens,
            "taxa_entrega": taxa,
            # Bairro que o próprio cliente confirmou ser da cidade (não estava na
            # lista): o painel destaca pra equipe conferir o endereço.
            "bairro_novo_pelo_bot": bool(r.get("bairro_novo") and r.get("bairro_novo") == r.get("bairro")
                                         and r["tipo_entrega"] == "ENTREGA"),
        }
        batch.set(pedido_ref, dados_pedido)
        batch.commit()

        # Rascunho vira "fechado": guarda o id pra idempotência e limpa o carrinho.
        _rascunho_ref(wa_id).set({
            "pedido_id": pedido_ref.id, "fechado_em": datetime.now(timezone.utc), "valor_total": total,
            "itens_fechados": [{"id": i["id"], "nome": i["nome"], "quantidade": i["quantidade"]} for i in itens_pedido],
            "nome_cliente": r.get("nome_cliente") or "Cliente",
        }, timeout=10)
        return {
            "status": "ok", "pedido_id": pedido_ref.id,
            "itens": [i["nome"] for i in itens_pedido], "valor_itens": valor_itens, "taxa_entrega": taxa,
            "valor_total": total, "tipo_entrega": r["tipo_entrega"], "forma_pagamento": r["forma_pagamento"],
            "instrucao": "Pedido registrado de verdade. Confirme pro cliente com o valor_total daqui.",
        }
    except Exception as e:
        print(f"ERRO ao fechar pedido: {e}")
        return {"status": "erro", "motivo": "Erro interno."}


def _montar_itens_pedido(itens, tipo_entrega, bot_cfg=None):
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
    cardapio = carregar_cardapio()
    cardapio_por_nome = {}
    cardapio_por_id = {}
    for item_com_id in cardapio:
        cardapio_por_id[item_com_id["id"]] = item_com_id
        nome_chave = str(item_com_id.get('nome', '')).strip().lower()
        if nome_chave:
            cardapio_por_nome[nome_chave] = item_com_id
    nomes_cardapio = list(cardapio_por_nome.keys())

    total_pontos = 0
    lista_itens_tsx = []
    valor_itens = 0.0
    itens_nao_reconhecidos = []
    itens_indisponiveis = []
    # Casamento aceito (>= 70) mas não muito confiante (< 92): já aconteceu
    # de virar item ERRADO em vez de "não reconhecido" — "enroladinho de
    # salsicha" casou com "enroladinho de presunto e queijo" (86 de
    # pontuação, pontuação alta o bastante pra passar direto sem alerta
    # nenhum, palavra errada). Continua aceitando (não trava o pedido por
    # causa disso), mas avisa a equipe pra revisar/ensinar o apelido certo.
    itens_confianca_baixa = []

    for item in (itens or []):
        item = item or {}
        item_id = str(item.get('item_id') or '').strip()
        nome_pedido = str(item.get('nome_produto') or '').strip().lower()
        try:
            qtd = int(item.get('quantidade') or 1)
        except (TypeError, ValueError):
            qtd = 1
        if not item_id and not nome_pedido:
            continue

        dados = None

        # Caminho principal (Fase 3): a IA manda o CÓDIGO do item que leu no
        # cardápio do prompt. Resolve por id exato — se o código não existir,
        # é "não reconhecido", nunca "o mais parecido".
        if item_id:
            dados = _resolver_item(item_id, cardapio)
            if not dados:
                itens_nao_reconhecidos.append(nome_pedido or item_id)
                continue

        # Caminho legado (só se vier 'nome_produto' SEM 'item_id'): apelido
        # ensinado pela equipe, senão busca aproximada. Mantido pra não
        # quebrar chamadas antigas, mas o schema da ferramenta exige item_id.
        if not dados:
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
            nome_pedido_norm = _normalizar_termo(nome_pedido)
            nomes_normalizados = [_normalizar_termo(n) for n in nomes_cardapio]

            # "zero" é uma palavra curta demais pra pesar na pontuação de
            # similaridade — já aconteceu em produção "coca cola ZERO lata
            # 350ml" casar com "coca cola lata 350ml" (sem zero, produto
            # diferente de verdade, com açúcar). Se o cardápio tem as duas
            # variantes, restringe a busca à que bate no "é zero ou não" do
            # pedido antes de rankear por similaridade — só cai pra lista
            # cheia se não existir nenhuma variante com esse status.
            pediu_zero = bool(re.search(r'\bzero\b', nome_pedido_norm))
            candidatos_com_status_certo = [
                n for n in nomes_normalizados if bool(re.search(r'\bzero\b', n)) == pediu_zero
            ]
            pool_busca = candidatos_com_status_certo or nomes_normalizados

            melhor_match_norm, pontuacao = process.extractOne(nome_pedido_norm, pool_busca)
            melhor_match = nomes_cardapio[nomes_normalizados.index(melhor_match_norm)]
            print(f"DEBUG: item do pedido '{nome_pedido}' comparado com '{melhor_match}'. Pontuação: {pontuacao}")

            if pontuacao < 70:
                itens_nao_reconhecidos.append(nome_pedido)
                continue

            if pontuacao < 92:
                itens_confianca_baixa.append({
                    "pedido": nome_pedido, "casou_com": melhor_match, "pontuacao": pontuacao
                })

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
        # Config já lida uma vez por mensagem em get_openai_response e
        # repassada — só cai numa leitura nova se chamada de fora.
        bot_cfg = bot_cfg or obter_config_bot()
        taxa_entrega = float(bot_cfg.get("taxa_entrega") or 0)

    valor_total_final = round(valor_itens + taxa_entrega, 2)

    return {
        "lista_itens_tsx": lista_itens_tsx,
        "itens_nao_reconhecidos": itens_nao_reconhecidos,
        "itens_indisponiveis": itens_indisponiveis,
        "itens_confianca_baixa": itens_confianca_baixa,
        "valor_itens": round(valor_itens, 2),
        "taxa_entrega": taxa_entrega,
        "valor_total": valor_total_final,
        "tipo_entrega": tipo_entrega,
        "total_pontos": total_pontos
    }

def calcular_pedido(id_usuario, itens, tipo_entrega=None, bot_cfg=None):
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
        montado = _montar_itens_pedido(itens, tipo_entrega, bot_cfg)
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

def registrar_pedido(wa_id: str, nome_cliente: str, itens, valor_total: float, observacao: str, endereco_completo: str, forma_pagamento: str, tipo_entrega=None, telefone=None, id_usuario_cache=None, bairro=None, bot_cfg=None):
    if db is None: return json.dumps({"status": "erro", "motivo": "Erro de conexão."})

    # A IA às vezes manda a string literal "None" (não o valor nulo de
    # verdade) quando não sabe o nome do cliente — isso ia parar salvo assim
    # no Firestore e aparecia como "Cliente: None" no painel e no cupom
    # impresso.
    if str(nome_cliente or "").strip().lower() in ("", "none", "null", "n/a"):
        nome_cliente = None

    # Segunda checagem de horário: cobre o caso raro de a conversa ter
    # começado antes de fechar e só terminar (chamar essa função) depois.
    bot_cfg_ferias = bot_cfg or obter_config_bot()
    em_ferias, msg_ferias = verificar_ferias(bot_cfg_ferias)
    if em_ferias:
        return json.dumps({"status": "erro", "motivo": msg_ferias})

    aberto, texto_horario = verificar_horario_funcionamento(bot_cfg_ferias)
    if not aberto:
        return json.dumps({
            "status": "erro",
            "motivo": "Loja fechada no momento.",
            "horario_funcionamento": texto_horario
        })

    fuso_br = timezone(timedelta(hours=-3))
    agora_br = datetime.now(fuso_br)

    # Trava de duplicidade: se o cliente mandar duas confirmações seguidas
    # (ex.: "Nada mais" + "Pode sim" logo em seguida), cada uma é uma
    # mensagem própria e pode gerar sua própria chamada a registrar_pedido —
    # sem isso, vira DOIS pedidos reais no Firestore pro mesmo pedido (já
    # aconteceu). Se já existe um pedido pendente desse mesmo cliente, com o
    # mesmo valor, criado nos últimos 5 minutos, devolve ele em vez de criar
    # outro.
    try:
        recentes = db.collection('pedidos') \
            .where('telefone_cliente', '==', str(wa_id)) \
            .where('status', '==', 'PENDENTE_PREPARO') \
            .order_by('hora_pedido', direction=firestore.Query.DESCENDING) \
            .limit(3).get(timeout=10)
        try:
            estimativa_ia = float(valor_total or 0)
        except (TypeError, ValueError):
            estimativa_ia = 0.0
        for doc in recentes:
            dpedido = doc.to_dict()
            hp = dpedido.get('hora_pedido')
            if not hp or (agora_br - hp).total_seconds() >= 300:
                continue
            # BUG CORRIGIDO: antes comparava só com 'valor_total' gravado, que
            # INCLUI a taxa de entrega — mas a descrição da ferramenta manda a
            # IA passar "só os itens, sem taxa". Em qualquer entrega com taxa
            # > 0 a trava nunca batia e o pedido duplicava justamente no caso
            # mais comum. Agora compara com 'valor_itens' (gravado a partir
            # desta versão) e, por compatibilidade com pedidos antigos sem
            # esse campo, também com 'valor_total'.
            candidatos = []
            for chave in ('valor_itens', 'valor_total'):
                try:
                    if dpedido.get(chave) is not None:
                        candidatos.append(float(dpedido.get(chave)))
                except (TypeError, ValueError):
                    pass
            if any(abs(c - estimativa_ia) < 0.01 for c in candidatos):
                return json.dumps({
                    "status": "ok",
                    "pedido_id": doc.id,
                    "itens_confirmados": [i.get("nome") for i in (dpedido.get("itens") or [])],
                    "itens_nao_reconhecidos": [],
                    "itens_indisponiveis": [],
                    "valor_itens": dpedido.get("valor_total"),
                    "taxa_entrega": dpedido.get("taxa_entrega", 0),
                    "valor_total": dpedido.get("valor_total")
                })
    except Exception as e:
        print(f"Erro ao checar duplicidade de pedido: {e}")

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
                    # A taxa de entrega NUNCA vem do cache — ela é lida de novo
                    # aqui, na hora de registrar de verdade. Se o valor mudou
                    # no painel entre o cálculo e a confirmação do cliente
                    # (mesmo minutos depois), o pedido tem que sair com a taxa
                    # atual, não com a que estava valendo quando calculou.
                    tipo_entrega_cache = cache.get("tipo_entrega") or "RETIRADA"
                    valor_itens_cache = cache.get("valor_itens", 0)
                    taxa_entrega_atual = 0.0
                    if tipo_entrega_cache == "ENTREGA":
                        taxa_entrega_atual = float(bot_cfg_ferias.get("taxa_entrega") or 0)
                    montado = {
                        "lista_itens_tsx": cache["itens"],
                        "itens_nao_reconhecidos": [],
                        "itens_indisponiveis": [],
                        "valor_itens": valor_itens_cache,
                        "taxa_entrega": taxa_entrega_atual,
                        "valor_total": round(valor_itens_cache + taxa_entrega_atual, 2),
                        "tipo_entrega": tipo_entrega_cache,
                        "total_pontos": cache.get("total_pontos", 0)
                    }
                    hist_ref.update({"ultimo_calculo": firestore.DELETE_FIELD})
            except Exception as e:
                print(f"Erro ao reaproveitar ultimo_calculo: {e}")

        if montado is None:
            montado = _montar_itens_pedido(itens, tipo_entrega, bot_cfg_ferias)
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
            # Fidelidade é só pelo app — pedido do bot não pontua.
            "status": "PENDENTE_PREPARO",
            "telefone_cliente": str(wa_id),
            "usuario_id": usuario_id,
            "valor_total": valor_total_final,
            "valor_itens": montado["valor_itens"],   # subtotal sem taxa (trava de duplicidade compara com isto)
            "taxa_entrega": taxa_entrega
        }
        batch.set(pedido_ref, dados_pedido)
        batch.commit()
        return json.dumps({
            "status": "ok",
            "pedido_id": pedido_ref.id,
            "itens_confirmados": [i["nome"] for i in lista_itens_tsx],
            "itens_nao_reconhecidos": itens_nao_reconhecidos,
            "itens_indisponiveis": itens_indisponiveis,
            "itens_confianca_baixa": montado.get("itens_confianca_baixa", []),
            "valor_itens": montado["valor_itens"],
            "taxa_entrega": taxa_entrega,
            "valor_total": valor_total_final
        })

    except Exception as e:
        print(f"ERRO: {str(e)}")
        return json.dumps({"status": "erro", "motivo": "Erro interno."})

def _variantes_telefone(wa_id):
    """O WhatsApp manda o número SEM o nono dígito (553592678488) e o app grava
    COM ele (5535992678488). Devolve as duas formas pra busca achar os dois."""
    t = re.sub(r"\D", "", str(wa_id or ""))
    v = {t}
    if t.startswith("55") and len(t) == 12:
        v.add(t[:4] + "9" + t[4:])
    elif t.startswith("55") and len(t) == 13 and t[4] == "9":
        v.add(t[:4] + t[5:])
    return [x for x in v if x]


def _pedidos_do_cliente(wa_id, limite=5):
    """Pedidos deste cliente em QUALQUER canal, mais recente primeiro. Caso real
    (29/09): cliente pediu pelo app, veio ao WhatsApp falar do pedido e o bot
    disse que "o pedido do app foi cancelado" — só procurava telefone_cliente com
    o número do WhatsApp; o app grava com o nono dígito e, no dinheiro, no campo
    'telefone'. Devolve [(doc, dados)]."""
    achados = {}
    variantes = _variantes_telefone(wa_id)
    for campo in ("telefone_cliente", "telefone"):
        try:
            for doc in db.collection('pedidos').where(campo, 'in', variantes).get(timeout=10):
                achados[doc.id] = doc
        except Exception as e:
            print(f"Erro ao buscar pedidos por {campo}: {e}")
    minimo = datetime(2000, 1, 1, tzinfo=timezone.utc)
    docs = sorted(achados.values(), key=lambda d: (d.to_dict() or {}).get('hora_pedido') or minimo, reverse=True)
    return [(d, d.to_dict() or {}) for d in docs[:limite]]


def _pix_app_ja_pago(p):
    """PIX do app é cobrado pelo gateway (Mercado Pago) e confirmado sozinho pelo
    webhook: saiu de AGUARDANDO_PIX = pago. Não precisa de comprovante."""
    return (str(p.get('origem') or '').upper() == 'APP' and 'PIX' in str(p.get('forma_pagamento') or '').upper()
            and p.get('status') not in ('AGUARDANDO_PIX', 'CANCELADO'))


def consultar_meu_pedido(wa_id: str):
    """Busca o pedido mais recente já registrado deste cliente — usada quando
    ele pergunta sobre um pedido que JÁ fez (valor, itens, status), pra não
    o bot precisar "adivinhar"/reconstruir isso de cabeça (ou, pior, chamar
    registrar_pedido de novo só pra descrever, o que cria um pedido duplicado
    de verdade no sistema)."""
    if db is None: return json.dumps({"status": "erro", "motivo": "Erro de conexão."})
    try:
        pedidos = _pedidos_do_cliente(wa_id, limite=1)
        if not pedidos:
            return json.dumps({"status": "sem_pedido"})

        doc, pedido = pedidos[0]
        hp = pedido.get("hora_pedido")
        out = {
            "status": "ok",
            "pedido_id": doc.id,
            "canal": "APP" if str(pedido.get("origem") or "").upper() == "APP" else "WHATSAPP/LOJA",
            "feito_em": hp.astimezone(timezone(timedelta(hours=-3))).strftime("%d/%m %H:%M") if hp else None,
            "itens": [(i.get("nome_exibicao") or i.get("nome")) if isinstance(i, dict) else i for i in (pedido.get("itens") or [])],
            "valor_total": pedido.get("valor_total"),
            "taxa_entrega": pedido.get("taxa_entrega"),
            "tipo_entrega": pedido.get("tipo_entrega"),
            "endereco": pedido.get("endereco"),
            "forma_pagamento": pedido.get("forma_pagamento"),
            "status_pedido": pedido.get("status"),
            "instrucao": "Este é o pedido que o cliente já fez (fale dele com a data/hora). Se o cliente está falando "
                         "DESTE pedido, NÃO monte outro carrinho nem chame adicionar_item.",
        }
        if _pix_app_ja_pago(pedido):
            out["pagamento"] = "PIX já confirmado automaticamente pelo app — NÃO peça comprovante."
        elif pedido.get("status") == "AGUARDANDO_PIX":
            out["pagamento"] = "PIX do app ainda não pago: o cliente paga pelo código PIX na aba Pedidos do app (confirma sozinho)."
        return json.dumps(out, ensure_ascii=False, default=str)
    except Exception as e:
        print(f"ERRO ao consultar pedido: {e}")
        return json.dumps({"status": "erro", "motivo": "Erro interno."})

# Status em que o pedido ainda pode ser cancelado pelo próprio cliente via
# bot — depois que a cozinha começa a preparar (EM_PREPARO em diante), quem
# decide é a equipe, não uma função automática.
STATUS_CANCELAVEL_PELO_CLIENTE = ("PENDENTE_PREPARO", "PENDENTE_VALIDACAO", "AGUARDANDO_PIX")

def cancelar_pedido_recente(wa_id: str):
    """Cancela DE VERDADE o pedido mais recente deste cliente, se ainda
    estiver num status cancelável. Existe porque a IA já disse 'pedido
    cancelado' pro cliente sem chamar função nenhuma — o pedido continuava
    ativo no Firestore, foi parar na cozinha e virou venda de verdade
    mesmo com cliente e atendente achando que tinha sido cancelado."""
    if db is None:
        return json.dumps({"status": "erro", "motivo": "Erro de conexão."})
    try:
        pedidos = _pedidos_do_cliente(wa_id, limite=1)
        if not pedidos:
            return json.dumps({"status": "sem_pedido"})

        doc, pedido = pedidos[0]
        status_atual = pedido.get("status")
        if status_atual == "CANCELADO":
            return json.dumps({"status": "ok", "ja_estava_cancelado": True})
        if status_atual not in STATUS_CANCELAVEL_PELO_CLIENTE:
            return json.dumps({
                "status": "erro",
                "motivo": f"Pedido já está '{status_atual}' — nesse ponto só a equipe pode cancelar manualmente.",
                "status_pedido": status_atual
            })
        doc.reference.update({"status": "CANCELADO"}, timeout=10)
        return json.dumps({"status": "ok", "pedido_id": doc.id, "valor_total": pedido.get("valor_total")})
    except Exception as e:
        print(f"ERRO ao cancelar pedido: {e}")
        return json.dumps({"status": "erro", "motivo": "Erro interno."})

def registrar_comprovante(wa_id: str, imagem_url: str):
    if db is None: return "Erro no banco de dados."
    
    try:
        # 1. Busca o pedido MAIS RECENTE deste cliente, independente do status inicial
        # Isso evita o erro se o status tiver sido gravado errado (ex: PENDENTE_PREPARO)
        # OBS: registrar_pedido() grava o telefone em 'telefone_cliente', não 'wa_id'
        # (esse campo nunca existiu nos pedidos) — por isso a busca é por esse campo,
        # e usa a coleção 'pedidos' direto (mesma que registrar_pedido usa).

        # Caso real (29/09, duas clientes): o bot pediu "o comprovante antes de
        # fechar", a cliente pagou e mandou — e o pedido nunca tinha sido criado; o
        # comprovante caía num pedido antigo. Carrinho completo com PIX + comprovante
        # = o cliente confirmou: fecha o pedido AGORA e anexa o comprovante nele.
        r = obter_rascunho(wa_id)
        if r.get("itens") and not _faltando(r) and r.get("forma_pagamento") == "PIX":
            res = rascunho_fechar_pedido(wa_id, obter_config_bot(), confirmacao_explicita=True)
            if res.get("status") == "ok" and res.get("pedido_id"):
                db.collection('pedidos').document(res["pedido_id"]).update(
                    {'comprovante_url': imagem_url, 'status': "PENDENTE_VALIDACAO"}, timeout=10)
                total = f"{float(res.get('valor_total') or 0):.2f}".replace(".", ",")
                return (f"Recebi o comprovante e seu pedido foi registrado! ✅ Total: R$ {total}. "
                        "Nossa equipe confere o pagamento e já inicia o preparo.")

        pedidos = _pedidos_do_cliente(wa_id, limite=1)

        if pedidos:
            doc, dados = pedidos[0]
            forma_up = str(dados.get('forma_pagamento') or '').upper()

            def _anotar(nota):
                obs = str(dados.get('observacao') or '').strip()
                obs = f"{obs} | {nota}" if obs and obs.lower() != 'nenhuma' else nota
                doc.reference.update({'comprovante_url': imagem_url, 'observacao': obs}, timeout=10)

            # PIX do app: cobrado e confirmado pelo gateway — comprovante não muda nada.
            if _pix_app_ja_pago(dados):
                doc.reference.update({'comprovante_url': imagem_url}, timeout=10)
                return "Recebi! Mas nem precisava: o pagamento PIX do seu pedido pelo app já foi confirmado automaticamente. ✅"
            if str(dados.get('origem') or '').upper() == 'APP' and dados.get('status') == 'AGUARDANDO_PIX':
                _anotar("Cliente mandou comprovante PIX pelo WhatsApp")
                return ("Recebi o comprovante e anexei ao seu pedido! Se pagou pelo código PIX do app, ele confirma sozinho "
                        "em instantes e o pedido segue pro preparo.")
            # Caso real (29/09): pedido do app em dinheiro, cliente pagou uma PARTE no
            # PIX. Anexa ao pedido e anota pra equipe/entregador cobrar só o restante.
            if 'PIX' not in forma_up and dados.get('status') not in ('CONCLUIDO', 'CANCELADO'):
                _anotar("Cliente pagou parte no PIX (comprovante no pedido) — confira o valor e cobre só o restante")
                return ("Recebi seu comprovante e anexei ao seu pedido! ✅ A equipe confere o valor e na entrega "
                        "é cobrado só o que faltar.")

            # 2. Só vincula o comprovante se for um pedido de PIX ainda em
            # aberto — sem isso, um comprovante mandado por engano (ou um
            # pedido novo por cartão/dinheiro feito logo depois) reverte pro
            # status "aguardando validação" um pedido que já pode estar
            # EM_PREPARO ou CONCLUIDO, bagunçando a fila da cozinha.
            forma_pagamento = str(dados.get('forma_pagamento') or '').upper()
            status_atual = dados.get('status')
            STATUS_ACEITA_COMPROVANTE = ('PENDENTE_PREPARO', 'PENDENTE_VALIDACAO', 'AGUARDANDO_PIX')
            if 'PIX' not in forma_pagamento or status_atual not in STATUS_ACEITA_COMPROVANTE:
                marcar_atencao(
                    wa_id,
                    "Cliente mandou um comprovante, mas o pedido mais recente não é PIX pendente — confira manualmente.",
                    tipo="pedido_falhou",
                    dados={"pedido_id": doc.id, "forma_pagamento": forma_pagamento, "status": status_atual}
                )
                return "Recebi sua imagem! Como seu pedido mais recente não está aguardando PIX, já avisei nossa equipe pra conferir manualmente — eles confirmam com você em instantes."

            doc.reference.update({
                'comprovante_url': imagem_url,
                'status': "PENDENTE_VALIDACAO"
            }, timeout=10)

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
        response_info = requests.get(url_info, headers=headers, timeout=15)
        if response_info.status_code != 200:
            print(f"Erro ao obter info da mídia: {response_info.text}")
            return None

        url_download = response_info.json().get("url")

        # 2. Faz o download do arquivo real
        media_res = requests.get(url_download, headers=headers, timeout=15)
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
       
_PALAVRAS_SAUDACAO = {"oi", "oii", "oiii", "oie", "ola", "opa", "bom", "boa", "dia", "tarde", "noite", "e", "ai", "eai",
                      "hey", "hello", "hi", "salve", "tudo", "bem", "td", "como", "vai", "fala", "pessoal", "gente",
                      "tranquilo", "blz", "beleza", "ei", "eae"}


def _e_so_saudacao(texto):
    """A mensagem é só um cumprimento ("oi", "bom dia", "tudo bem?")? Se tiver
    qualquer outra palavra (pergunta, pedido), não é — caso real de produção:
    cliente abriu com "Tem salgado assado de salsicha?", a saudação fixa de
    primeiro contato (que nem passa pela IA) engoliu a pergunta e ela nunca
    foi respondida."""
    tokens = [t for t in re.split(r"[^a-z0-9]+", _normalizar_termo(texto)) if t]
    return len(tokens) <= 6 and all(t in _PALAVRAS_SAUDACAO for t in tokens)


def _texto_convite_app(bot_cfg):
    """Convite pro app (mensagem_convite_app com {link_app} trocado) — vazio
    se "divulgar_app" estiver desligado ou sem link configurado (nunca
    convida pra algo que o bot não teria como mostrar de verdade)."""
    link = (bot_cfg.get("link_app") or "").strip()
    if not (bot_cfg.get("divulgar_app") and link):
        return ""
    convite = bot_cfg.get("mensagem_convite_app") or BOT_CONFIG_DEFAULTS["mensagem_convite_app"]
    return convite.format(link_app=link)


def _horas_desde_ultima_mensagem(wa_id):
    """Horas desde a última mensagem deste cliente no histórico, ou None se
    não há histórico/timestamp. obter_historico_firestore descarta o
    timestamp (a OpenAI não entende), então lê o doc direto."""
    try:
        doc = db.collection("historico_conversas").document(wa_id).get(timeout=10)
        if not doc.exists:
            return None
        d = doc.to_dict() or {}
        msgs = d.get("mensagens") or []
        ts = (msgs[-1].get("timestamp") if msgs else None) or d.get("ultima_interacao")
        if not ts:
            return None
        return (datetime.now(timezone.utc) - ts).total_seconds() / 3600
    except Exception as e:
        print(f"Erro ao ler última interação: {e}")
        return None


def obter_historico_firestore(wa_id, limite=None):
    try:
        # timeout explicito: sem isso, uma chamada ao Firestore que trave (ex.:
        # canal gRPC "morto" apos o container ficar horas ocioso) prende essa
        # thread pra sempre — e como cada mensagem roda na sua propria thread
        # (travada so por cliente), o cliente afetado fica sem resposta
        # indefinidamente, sem nenhum erro no log. Ja aconteceu em producao.
        doc = db.collection("historico_conversas").document(wa_id).get(timeout=10)
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
        
        doc = doc_ref.get(timeout=10)
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
            }, timeout=10)
        else:
            doc_ref.set({
                "mensagens": [nova_msg],
                "ultima_interacao": datetime.now(timezone.utc)
            }, timeout=10)
    except Exception as e:
        print(f"Erro ao salvar histórico: {e}")

def registrar_log_conversa(wa_id, origem, mensagem_cliente, resposta_final, modelo,
                           ferramentas=None, usage=None, duracao_s=None, erro=None,
                           chamadas_ia=0, observacao=None):
    """Log APPEND-ONLY de cada turno, na coleção 'conversas_log' — um
    documento por mensagem do cliente, nunca sobrescrito nem cortado.

    Existe porque 'historico_conversas' guarda só as últimas N mensagens
    por cliente (é contexto pra IA, não registro): a conversa de ontem some
    quando o cliente pede de novo hoje. Sem este log não há como montar um
    conjunto de teste com conversas reais, nem medir custo por conversa
    (tokens) ou taxa de erro por tipo de ferramenta. Best-effort: nunca
    derruba o atendimento se falhar."""
    try:
        doc = {
            "wa_id": str(wa_id),
            "origem": origem,
            "mensagem_cliente": mensagem_cliente,
            "resposta_final": resposta_final,
            "modelo": modelo,
            "ferramentas": ferramentas or [],
            "chamadas_ia": chamadas_ia,
            "tokens_entrada": (usage or {}).get("prompt_tokens", 0),
            "tokens_saida": (usage or {}).get("completion_tokens", 0),
            "duracao_s": round(duracao_s, 2) if duracao_s is not None else None,
            "erro": erro,
            "observacao": observacao,
            "criado_em": datetime.now(timezone.utc),
        }
        db.collection("conversas_log").add(doc, timeout=10)
    except Exception as e:
        print(f"Erro ao gravar conversas_log: {e}")


def _somar_usage(acumulado, response):
    """Soma o 'usage' de uma resposta da OpenAI no dict acumulado (in-place)."""
    try:
        u = getattr(response, "usage", None)
        if u:
            acumulado["prompt_tokens"] = acumulado.get("prompt_tokens", 0) + int(getattr(u, "prompt_tokens", 0) or 0)
            acumulado["completion_tokens"] = acumulado.get("completion_tokens", 0) + int(getattr(u, "completion_tokens", 0) or 0)
    except Exception:
        pass
    return acumulado


def _normalizar_termo(s):
    """Chave de comparação exata pra aprendizado (bairro/item): minúsculo,
    sem espaço sobrando, sem acento — pra 'Passos' e 'passos ' caírem na
    mesma entrada aprendida."""
    semAcento = ''.join(
        ch for ch in unicodedata.normalize('NFD', str(s or ''))
        if not unicodedata.combining(ch)
    )
    return ' '.join(semAcento.lower().split())

TIPOS_ALERTA_PISCANTE = ("humano",)


def marcar_atencao(wa_id, motivo, tipo=None, dados=None):
    """Sinaliza pro painel de Atendimento (bot-chat.html) que essa conversa
    tem uma situação que o bot não conseguiu resolver sozinho — bairro
    ambíguo, item do pedido não reconhecido, etc. — e precisa de um humano
    olhando. 'tipo'/'dados' alimentam a caixa de resposta rápida do painel
    (ex.: tipo='bairro', dados={'bairro_cliente': 'Passos'}).
    Só o cliente pedindo pra FALAR COM A EQUIPE (tipo 'humano') acende o alerta
    piscando (precisa_atencao). O resto vira um aviso discreto na lista
    (aviso_equipe), sem piscar: o alerta ficava aceso em conversa já resolvida."""
    campos = {
        "aviso_equipe": True,
        "motivo_atencao": motivo,
        "tipo_atencao": tipo,
        "atencao_dados": dados or {},
        "atencao_marcada_em": datetime.now(timezone.utc),
    }
    if tipo in TIPOS_ALERTA_PISCANTE:
        campos["precisa_atencao"] = True
    try:
        db.collection("historico_conversas").document(wa_id).set(campos, merge=True)
    except Exception as e:
        print(f"Erro ao marcar atenção: {e}")

def limpar_atencao(wa_id):
    """Tira a marca "Precisa de atenção" da conversa. Ela só deve existir enquanto
    o bot está esperando a equipe: quando a equipe responde ou o pedido é
    registrado, a pendência acabou."""
    try:
        db.collection("historico_conversas").document(wa_id).set({"precisa_atencao": False, "aviso_equipe": False}, merge=True)
    except Exception as e:
        print(f"Erro ao limpar atenção: {e}")

def texto_atencao_pendente_antiga(wa_id, minutos_limite=10):
    """Se essa conversa tem uma dúvida marcada pra equipe há mais tempo que
    o limite e ninguém respondeu ainda, devolve um aviso pro prompt — sem
    isso o bot ficaria prometendo "vou confirmar com a equipe" de novo a
    cada mensagem, numa espera que nunca chega no fim. Não há timer/cron
    rodando o tempo todo; a checagem acontece na próxima mensagem que o
    cliente mandar (verificado aqui, no início de cada resposta)."""
    try:
        doc = db.collection("historico_conversas").document(wa_id).get(timeout=10)
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

def verificar_bairro_entrega(bairro_cliente, bot_cfg=None):
    """Confere se um bairro citado pelo cliente está na lista cadastrada em
    Configurações do Bot, usando busca aproximada (tolera erro de digitação/
    abreviação) — mesma lógica do consultar_sabor, mas pra bairro.

    Antes de tudo, checa 'bairros_aprendizado' — respostas que a própria
    equipe já deu antes pra esse nome exato de bairro (pelo painel de
    Atendimento), pra não escalar de novo uma dúvida que já foi resolvida."""
    termo = str(bairro_cliente or "").strip()
    if not termo:
        return {"status": "nao_encontrado"}

    bot_cfg = bot_cfg or obter_config_bot()

    # Caso real de produção: a IA às vezes manda o endereço inteiro em vez
    # de só o bairro (ex.: "Morumbi São Sebastião do Paraíso" — cliente
    # mencionou o bairro E a cidade na mesma frase). O nome da cidade
    # sozinho já bate quase igual com um bairro real de mesmo nome
    # ("São Sebastião"), e a pontuação aproximada, incluída, inflava pra
    # 90 — "Morumbi" (que não atendemos) virava "atende" por causa da
    # cidade grudada no termo. Tira as variantes da cidade antes de comparar.
    termo_normalizado = _normalizar_termo(termo)
    for variante_cidade in str(bot_cfg.get("cidade_atendida") or "").split(","):
        vc = _normalizar_termo(variante_cidade)
        if vc and vc in termo_normalizado:
            termo_normalizado = termo_normalizado.replace(vc, " ")
    termo_normalizado = " ".join(termo_normalizado.split()) or _normalizar_termo(termo)

    try:
        aprendido = db.collection("bairros_aprendizado").document(termo_normalizado).get()
        if aprendido.exists:
            dados_aprendido = aprendido.to_dict()
            bot_cfg_taxa = bot_cfg.get("taxa_entrega") or 0
            if dados_aprendido.get("atende"):
                return {
                    "status": "atende",
                    "bairro": dados_aprendido.get("bairro_original") or termo,
                    "taxa_entrega": bot_cfg_taxa
                }
            return {"status": "nao_atende_confirmado", "bairro": dados_aprendido.get("bairro_original") or termo}
    except Exception as e:
        print(f"Erro ao checar bairro aprendido: {e}")

    # Bairro que um cliente já confirmou ser da cidade (lista de pendentes, aguardando
    # a 1ª entrega): vale como atendido. Caso real (29/09): o cliente confirmou, e a
    # chamada seguinte de definir_entrega não achava o bairro na lista oficial, apagava
    # do pedido e perguntava tudo de novo — o "pode fechar" dele foi recusado.
    for pend in bot_cfg.get("bairros_pendentes_bot") or []:
        if isinstance(pend, dict) and _normalizar_termo(pend.get("bairro")) == termo_normalizado:
            return {"status": "atende", "bairro": pend.get("bairro"), "bairro_novo": True,
                    "taxa_entrega": bot_cfg.get("taxa_entrega") or 0}

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
    melhor_match, pontuacao = process.extractOne(termo_normalizado, bairros_normalizados)
    print(f"DEBUG: bairro '{termo}' (limpo: '{termo_normalizado}') comparado com '{melhor_match}'. Pontuação: {pontuacao}")

    if pontuacao > 75:
        return {
            "status": "atende",
            "bairro": bairros[bairros_normalizados.index(melhor_match)],
            "taxa_entrega": bot_cfg.get("taxa_entrega") or 0
        }

    return {"status": "nao_encontrado"}

NOMES_DIAS_SEMANA = {"seg": "Segunda", "ter": "Terça", "qua": "Quarta", "qui": "Quinta", "sex": "Sexta", "sab": "Sábado", "dom": "Domingo"}
ORDEM_DIAS_SEMANA = ["seg", "ter", "qua", "qui", "sex", "sab", "dom"]

def verificar_ferias(bot_cfg):
    """Confere se hoje (data, fuso BR) cai dentro do período de férias
    configurado em configuracoes/bot -> ferias_inicio/ferias_fim. Retorna
    (em_ferias: bool, mensagem: str) — mensagem já com {data_volta} formatado,
    pronta pra mandar pro cliente."""
    if not bot_cfg.get("ferias_ativo"):
        return False, ""
    inicio_str = str(bot_cfg.get("ferias_inicio") or "").strip()
    fim_str = str(bot_cfg.get("ferias_fim") or "").strip()
    if not inicio_str or not fim_str:
        return False, ""
    try:
        inicio = datetime.strptime(inicio_str, "%Y-%m-%d").date()
        fim = datetime.strptime(fim_str, "%Y-%m-%d").date()
    except ValueError:
        return False, ""
    hoje = datetime.now(timezone(timedelta(hours=-3))).date()
    if not (inicio <= hoje <= fim):
        return False, ""
    template = bot_cfg.get("ferias_mensagem") or BOT_CONFIG_DEFAULTS["ferias_mensagem"]
    data_volta = (fim + timedelta(days=1)).strftime("%d/%m/%Y")
    return True, template.replace("{data_volta}", data_volta)

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
        doc = db.collection("historico_conversas").document(wa_id).get(timeout=10)
        return doc.exists and doc.to_dict().get("modo_manual") is True
    except Exception as e:
        print(f"Erro ao checar modo manual: {e}")
        return False

_RE_CONFIRMACAO_CLIENTE = re.compile(
    r"^\s*(sim|s|ss|pode|pode sim|pode ser|pode fechar|fecha|fechar|confirma|confirmo|confirmado|confere|isso|isso mesmo|"
    r"ok|okay|certo|correto|beleza|blz|show|perfeito|claro|manda|vai|bora|pode mandar|é isso|e isso|tá certo|ta certo|"
    r"tá|ta|tudo certo|está certo|esta certo|pode confirmar|pode registrar|pode mandar entregar|pode entregar|"
    r"manda entregar|pode enviar|pode mandar fazer|pode fazer|pode preparar|fechado|pode fechar sim|👍|✅)\s*[.!]*\s*$", re.I)


def _cliente_confirmou(texto):
    """Mensagem curta de confirmação ('sim', 'pode fechar', 'confere'...)."""
    return bool(_RE_CONFIRMACAO_CLIENTE.match(_normalizar_termo(texto) if texto else ""))


def _ultima_resposta_mostrou_total(historico):
    """A última fala do bot exibiu o total do pedido ("Total: R$ 31,00")?
    Um "sim" do cliente logo depois é "pode fechar", mesmo que o bot tenha
    esquecido de perguntar (mini: passou a chave PIX e parou)."""
    for m in reversed(historico or []):
        if m.get("role") == "assistant":
            t = _normalizar_termo(m.get("content") or "")
            return "total" in t and "r$" in t
    return False


def _ultima_resposta_pediu_confirmacao(historico):
    """A última fala do bot perguntou se pode FECHAR O PEDIDO (não qualquer
    outra confirmação no meio do fluxo)? É o contexto em que um 'sim' do
    cliente significa 'fecha o pedido' e libera o fechamento determinístico.

    Caso real de produção: os radicais soltos ("confer", "confirm",
    "registr"...) casavam com QUALQUER pergunta de confirmação — "Confirma
    o bairro?", "Confere o endereço?" — e se o carrinho JÁ estivesse
    completo nesse ponto (nada_falta), um "sim" respondendo a essa pergunta
    fechava o pedido de verdade sem o cliente ter pedido isso. Agora exige
    frases que mencionem claramente FECHAR/CONCLUIR o PEDIDO."""
    radicais = ("posso fechar", "posso concluir", "posso registrar", "posso confirmar o pedido",
                "fechar o pedido", "fechar esse pedido", "fechar seu pedido", "confirma o pedido",
                "confirmar o pedido", "confere o pedido", "concluir o pedido", "registrar o pedido",
                "fechamento")
    for m in reversed(historico or []):
        if m.get("role") == "assistant":
            t = _normalizar_termo(m.get("content") or "")
            return "?" in (m.get("content") or "") and any(rad in t for rad in radicais)
    return False


_RE_SLOT_RETIRADA = re.compile(r"^(retirada|retirar|retiro|vou retirar|pra retirar|para retirar|busco|vou buscar|pego ai|pego aí|balcao|balcão|no balcao|no balcão)$")
_RE_SLOT_ENTREGA = re.compile(r"^(entrega|entregar|pra entregar|para entregar|para entrega|pra entrega|delivery|entregue|quero entrega)$")
_RE_SLOT_PAGAMENTO = re.compile(r"^(no |em |vou pagar no |vou pagar em |pago no |pago em )?(pix|dinheiro|cartao|cartão|credito|crédito|debito|débito|cartao de credito|cartão de crédito|cartao de debito|cartão de débito|maquininha)$")


_PALAVRAS_PAGAMENTO = {"PIX": ("pix",),
                       "DINHEIRO": ("dinheiro", "especie", "troco", "grana"),
                       "CARTAO": ("cartao", "credito", "debito", "maquininha", "maquina")}


def _cliente_mencionou_pagamento(forma, mensagem_atual, historico):
    """A forma de pagamento apareceu em alguma fala do CLIENTE? O gpt-4o-mini
    chamava definir_pagamento("DINHEIRO") sem o cliente ter dito nada — o
    resumo saía com pagamento inventado e, quando o cliente corrigia ("pix"),
    a conversa perdia o fio e o pedido não fechava."""
    chave = _normalizar_termo(forma).upper().replace("Ã", "A")
    forma_norm = next((v for k, v in FORMAS_PAGAMENTO.items() if _normalizar_termo(k).upper() in chave), None)
    grupo = _PALAVRAS_PAGAMENTO.get((forma_norm or "").replace("Ã", "A"))
    if not grupo:
        return True   # forma inválida: deixa rascunho_definir_pagamento devolver o erro certo
    falas = [m.get("content") or "" for m in (historico or []) if m.get("role") == "user"] + [mensagem_atual or ""]
    texto = " " + _normalizar_termo(" ".join(falas)) + " "
    return any(p in texto for p in grupo)


_PALAVRAS_GENERICAS_ITEM = {"de", "da", "do", "com", "e", "sem", "lata", "ml", "350ml", "600ml", "zero", "queijo", "carne", "frango"}


def _tokens_item(it):
    """Palavras distintivas do nome de um item (sem acento, sem genéricas)."""
    nome = _normalizar_termo(f"{it.get('nome') or ''} {it.get('nome_exibicao') or ''}")
    return {t for t in re.split(r"[^a-z0-9]+", nome) if len(t) >= 4 and t not in _PALAVRAS_GENERICAS_ITEM}


def _tipo_do_item_na_mensagem(item, mensagem):
    """A primeira palavra do nome do item (o tipo: pastel, coxinha, esfirra, coca...)
    aparece na mensagem? Compara pelo começo da palavra (pastel/pastéis)."""
    nome = _normalizar_termo((item or {}).get("nome_exibicao") or (item or {}).get("nome") or "")
    tipo = next((p for p in re.split(r"[^a-z0-9]+", nome) if len(p) >= 3), "")
    if not tipo:
        return True
    raiz = tipo[:4]
    return any(t.startswith(raiz) for t in re.split(r"[^a-z0-9]+", _normalizar_termo(mensagem or "")))


def _itens_mencionados(mensagem, cardapio):
    """ids dos itens do cardápio cujo nome (palavra distintiva) aparece na mensagem."""
    m = " " + _normalizar_termo(mensagem or "") + " "
    toks = set(re.split(r"[^a-z0-9]+", m))
    return {it["id"] for it in (cardapio or []) if _tokens_item(it) & toks}


# Itens com mais de uma variação parecida onde a IA já resolveu errado
# silenciosamente: cliente pediu "coxinha de frango com catupiry", o item
# adicionado foi a Coxinha Frango normal (R$1 mais barata, sem catupiry) —
# sem perguntar nada. Cada palavra aqui é a "base" que agrupa as variações;
# extensível se aparecer outro caso parecido no cardápio. "enroladinho":
# caso real de produção — cliente pediu "2 enroladinhos" (sem dizer "de
# salsicha" nem "de presunto"), a IA resolveu pra Salsicha via apelido
# ensinado ("enroladinho de salsicha"), ignorando que existe um item cujo
# NOME DE VERDADE é "Enroladinho de presunto e queijo" — a leitura mais
# direta da palavra sozinha.
_PALAVRAS_BASE_VARIACAO_ITEM = ["coxinha", "enroladinho"]


def _nome_com_apelidos(item, apelidos):
    """Nome + apelidos ensinados (itens_aprendizado), normalizado — pra
    detectar ambiguidade que só existe por causa de um apelido (ex.: o
    apelido 'enroladinho de salsicha' faz 'Salsicha' competir com o item
    que se chama de verdade 'Enroladinho de presunto e queijo')."""
    extras = " ".join(apelidos.get(item.get("id"), []))
    return _normalizar_termo(f"{item.get('nome') or ''} {item.get('nome_exibicao') or ''} {extras}")


def _variantes_do_grupo(item, cardapio, apelidos=None):
    """Outros itens do cardápio que compartilham a mesma palavra-base deste
    (ex.: as duas coxinhas, ou 'enroladinho' batendo tanto no nome de um
    item quanto no apelido ensinado de outro). None se este item não faz
    parte de um grupo conhecido ou só existe uma variação dele agora (ex.:
    a outra ficou indisponível)."""
    if not item:
        return None
    apelidos = apelidos if apelidos is not None else _apelidos_aprendidos()
    nome_item = _nome_com_apelidos(item, apelidos)
    base = next((b for b in _PALAVRAS_BASE_VARIACAO_ITEM if b in nome_item), None)
    if not base:
        return None
    variantes = [it for it in (cardapio or []) if base in _nome_com_apelidos(it, apelidos)]
    return variantes if len(variantes) >= 2 else None


def _palavras_proprias(item, variantes, apelidos=None):
    """Palavras do nome/apelido deste item que NENHUMA outra variação do
    grupo tem — o que realmente diferencia esta variação das demais (ex.:
    'catupiry', ou 'salsicha' pro item que só bate no apelido)."""
    apelidos = apelidos if apelidos is not None else _apelidos_aprendidos()
    outras = [o for o in variantes if o["id"] != item["id"]]
    nome = _nome_com_apelidos(item, apelidos)
    toks = set(t for t in re.split(r"[^a-z0-9]+", nome) if len(t) >= 4)
    toks_outras = set()
    for o in outras:
        toks_outras |= set(re.split(r"[^a-z0-9]+", _nome_com_apelidos(o, apelidos)))
    return toks - toks_outras


def _resolver_variante_ambigua(item_resolvido, cardapio, mensagem):
    """Caso real de produção acima: devolve (item_correto, None) se a
    mensagem do cliente deixou claro qual variação ele quer — corrigindo se
    a IA tinha escolhido a errada — ou (None, [opções]) se está ambíguo e
    precisa perguntar antes de adicionar. (None, None) se não é um item com
    variações conhecidas."""
    apelidos = _apelidos_aprendidos()
    variantes = _variantes_do_grupo(item_resolvido, cardapio, apelidos)
    if not variantes:
        return None, None
    msg_toks = set(re.split(r"[^a-z0-9]+", _normalizar_termo(mensagem or "")))
    bateu = [v for v in variantes if _palavras_proprias(v, variantes, apelidos) & msg_toks]
    if len(bateu) == 1:
        return bateu[0], None
    return None, variantes


_RE_PARECE_ENDERECO = re.compile(r"^(?=.*\d)(?=.*[a-z]{3,}).{5,80}$")


# --- Bairro fora da lista: o próprio cliente confirma se é da cidade ---
# Antes, bairro não reconhecido chamava a equipe e o cliente ficava esperando.
# Agora o bot pergunta se o local fica dentro da cidade (perímetro urbano); se
# o cliente disser que sim, o bairro entra na lista de entrega na hora e o
# pedido segue, marcado "bairro_novo_pelo_bot" pra equipe conferir (e cancelar
# se for o caso). Bairro que a equipe já recusou continua recusado
# (bairros_aprendizado é consultado antes, em verificar_bairro_entrega).
_RE_NAO_E_BAIRRO = re.compile(r"^(rua|r|av|avenida|praca|pca|travessa|tv|alameda|rodovia|rod|estrada)\b\.?", re.I)
_RE_SIM_PERIMETRO = re.compile(r"^(sim|s|ss|fica|fica sim|e sim|isso|isso mesmo|claro|com certeza|exato|correto|certo|"
                               r"e dentro|fica dentro|dentro|e da cidade|e aqui|aqui mesmo|e|uhum|aham|yes)\b", re.I)
_RE_NAO_PERIMETRO = re.compile(r"^(nao|n|nop|negativo|nem|fora)\b|outra cidade|zona rural|sitio|fazenda|chacara|distrito", re.I)


def _parece_nome_de_bairro(nome):
    n = str(nome or "").strip()
    if not n or len(n) > 40 or len(n.split()) > 5 or any(ch.isdigit() for ch in n):
        return False
    return not _RE_NAO_E_BAIRRO.match(_normalizar_termo(n))


def _cidade_principal(bot_cfg):
    return str((bot_cfg or {}).get("cidade_atendida") or "").split(",")[0].strip() or "nossa cidade"


def _pergunta_perimetro(bairro, bot_cfg):
    return f"{bairro} fica dentro da cidade de {_cidade_principal(bot_cfg)} (perímetro urbano)?"


def _e_nome_de_rua_na_mensagem(nome, texto_cliente):
    """O cliente escreveu esse nome logo depois de 'rua'/'av'...? Então é a RUA, não
    o bairro. Caso real (29/09): "rua Pinto Ribeiro 505" → a IA passou "Pinto
    Ribeiro" como bairro e perguntou o perímetro urbano de uma rua."""
    n, t = _normalizar_termo(nome), _normalizar_termo(texto_cliente or "")
    if not n or not t:
        return False
    return bool(re.search(r"\b(rua|r|av|avenida|travessa|tv|alameda|praca|pca|rodovia|estrada)\.?\s+"
                          r"(\w+\s+){0,3}" + re.escape(n) + r"\b", t))


def _marcar_bairro_pendente(wa_id, bairro, bot_cfg, texto_cliente=None):
    """verificar_bairro_entrega não achou o bairro: guarda no rascunho e devolve
    a instrução pra IA perguntar ao cliente — sem chamar a equipe."""
    if not _parece_nome_de_bairro(bairro) or _e_nome_de_rua_na_mensagem(bairro, texto_cliente):
        return {"acao": "pedir_nome_do_bairro",
                "instrucao": f"'{bairro}' não parece nome de bairro (rua/número). Peça só o NOME DO BAIRRO ao cliente. "
                             "NÃO diga que entregamos nem que não entregamos."}
    r = obter_rascunho(wa_id)
    r["bairro_pendente"] = str(bairro).strip()
    _salvar_rascunho(wa_id, r, tocou=False)
    return {"acao": "perguntar_perimetro", "pergunta": _pergunta_perimetro(str(bairro).strip(), bot_cfg),
            "instrucao": "Bairro fora da lista. Faça EXATAMENTE esta pergunta ao cliente e pare (NÃO diga que entregamos nem "
                         "que não entregamos, NÃO fale em equipe). Quando ele responder, chame confirmar_bairro_na_cidade."}


def _registrar_bairro_novo(bairro, wa_id):
    """Cliente confirmou que é da cidade: vai pra lista SEPARADA de bairros
    pendentes (configuracoes/bot.bairros_pendentes_bot). Só entra na lista
    oficial de entrega quando um pedido pra esse bairro for concluído (o painel
    promove ao marcar CONCLUIDO) — pedido cancelado não promove."""
    try:
        ref = db.collection("configuracoes").document("bot")
        doc = ref.get(timeout=10)
        dados = (doc.to_dict() or {}) if doc.exists else {}
        pendentes = list(dados.get("bairros_pendentes_bot") or [])
        if not any(_normalizar_termo(p.get("bairro")) == _normalizar_termo(bairro) for p in pendentes if isinstance(p, dict)):
            pendentes.append({"bairro": bairro, "wa_id": str(wa_id), "em": datetime.now(timezone.utc)})
            ref.set({"bairros_pendentes_bot": pendentes[-200:]}, merge=True)
    except Exception as e:
        print(f"Erro ao registrar bairro novo: {e}")


def confirmar_bairro_na_cidade(wa_id, dentro_da_cidade, bot_cfg):
    r = obter_rascunho(wa_id)
    bairro = r.get("bairro_pendente")
    if not bairro:
        return {"status": "erro", "motivo": "Nenhum bairro aguardando confirmação. Use definir_entrega/verificar_bairro_entrega."}
    r["bairro_pendente"] = None
    if not dentro_da_cidade:
        _salvar_rascunho(wa_id, r, tocou=False)
        return {"status": "fora_da_cidade", "bairro": bairro,
                "instrucao": f"Diga, com educação, que só entregamos dentro de {_cidade_principal(bot_cfg)} e ofereça retirada na loja."}
    _registrar_bairro_novo(bairro, wa_id)
    r["bairro_novo"] = bairro
    if r.get("itens") and r.get("tipo_entrega") != "RETIRADA":
        r.update({"tipo_entrega": "ENTREGA", "bairro": bairro, "resumo_visto_em": None})
        _salvar_rascunho(wa_id, r)
    else:
        _salvar_rascunho(wa_id, r, tocou=False)
    return {"status": "atende", "bairro": bairro, "taxa_entrega": (bot_cfg or {}).get("taxa_entrega") or 0,
            "bairro_gravado_no_pedido": r.get("bairro") == bairro,
            "instrucao": f"Confirme que entregamos em {bairro} (informe a taxa) e siga o pedido normalmente."}


def _resolver_endereco_sugerido(wa_id, id_usuario, mensagem, bot_cfg):
    """Resposta à pergunta "Entrego no mesmo endereço do último pedido: ...?".
    'sim' grava rua e bairro de uma vez; 'não'/endereço novo descarta a sugestão
    (o endereço novo segue pela IA). Só age se a ÚLTIMA fala do bot foi a pergunta."""
    r = obter_rascunho(id_usuario)
    sug = r.get("endereco_sugerido")
    if not sug or r.get("bairro"):
        return []
    ultima = next((m.get("content") or "" for m in reversed(obter_historico_firestore(wa_id, limite=4))
                   if m.get("role") == "assistant"), "")
    if "mesmo endereco" not in _normalizar_termo(ultima):
        return []
    m = _normalizar_termo(mensagem).strip(".!?,; ")
    if not m or len(m) > 80:
        return []
    if any(ch.isdigit() for ch in m) or _RE_NAO_ENDERECO.search(m):
        r["endereco_sugerido"] = None
        _salvar_rascunho(id_usuario, r, tocou=False)
        return [{"nome": "endereco_ultimo_pedido[servidor]", "args": {"mesmo": False}, "resultado": "{}",
                 "instrucao": "O cliente NÃO quer o endereço do último pedido. Use o endereço que ele mandou "
                              "(definir_entrega) ou peça rua, número e bairro."}]
    if not (_RE_SIM_ENDERECO.match(m) or _cliente_confirmou(m)):
        return []
    r.update({"tipo_entrega": "ENTREGA", "bairro": sug["bairro"], "endereco": sug["endereco"],
              "endereco_sugerido": None, "resumo_visto_em": None})
    _salvar_rascunho(id_usuario, r)
    return [{"nome": "definir_entrega[servidor]", "args": {"tipo": "ENTREGA", "bairro": sug["bairro"], "endereco": sug["endereco"]},
             "resultado": "{}", "instrucao": f"Entrega confirmada no endereço do último pedido ({sug['endereco']} — "
                                             f"{sug['bairro']}). Siga pro próximo passo; NÃO pergunte endereço nem bairro."}]


def _resolver_bairro_pendente(wa_id, id_usuario, mensagem, bot_cfg):
    """Resposta curta ("sim"/"não, é em Passos") à pergunta do perímetro urbano
    vira estado sem depender da IA. Só age se a ÚLTIMA fala do bot foi essa
    pergunta — senão um "sim" pra "posso fechar?" seria consumido aqui."""
    r = obter_rascunho(id_usuario)
    if not r.get("bairro_pendente"):
        return []
    # Caso real (29/09): pendente era a RUA ("Pinto Ribeiro"); a cliente respondeu
    # "Centro! Pinto Ribeiro 505 centro" e o bot seguiu com a rua. Se a mensagem cita
    # um bairro da lista oficial, é esse o bairro.
    msg_norm = f" {' '.join(re.split(r'[^a-z0-9]+', _normalizar_termo(mensagem or '')))} "
    oficiais = sorted((str(b).strip() for b in (bot_cfg or {}).get("bairros_entrega") or [] if str(b).strip()),
                      key=len, reverse=True)
    citado = next((b for b in oficiais if len(_normalizar_termo(b)) >= 4
                   and f" {' '.join(re.split(r'[^a-z0-9]+', _normalizar_termo(b)))} " in msg_norm), None)
    if citado:
        r["bairro_pendente"] = None
        if r.get("itens") and r.get("tipo_entrega") != "RETIRADA":
            r.update({"tipo_entrega": "ENTREGA", "bairro": citado, "resumo_visto_em": None})
            _salvar_rascunho(id_usuario, r)
        else:
            _salvar_rascunho(id_usuario, r, tocou=False)
        return [{"nome": "definir_entrega[servidor]", "args": {"tipo": "ENTREGA", "bairro": citado},
                 "resultado": json.dumps({"status": "atende", "bairro": citado}, ensure_ascii=False),
                 "instrucao": f"O cliente informou o bairro {citado}, que é atendido (taxa normal). Siga o pedido; "
                              "NÃO pergunte de novo sobre bairro nem perímetro urbano."}]
    ultima = next((m.get("content") or "" for m in reversed(obter_historico_firestore(wa_id, limite=4))
                   if m.get("role") == "assistant"), "")
    if "perimetro urbano" not in _normalizar_termo(ultima):
        return []
    m = _normalizar_termo(mensagem).strip(".!?,; ")
    if not m or len(m) > 80:
        return []
    if _RE_NAO_PERIMETRO.search(m):
        dentro = False
    elif _RE_SIM_PERIMETRO.match(m) or _cliente_confirmou(m):
        dentro = True
    else:
        return []
    res = confirmar_bairro_na_cidade(id_usuario, dentro, bot_cfg)
    return [{"nome": "confirmar_bairro_na_cidade[servidor]", "args": {"dentro_da_cidade": dentro},
             "resultado": json.dumps(res, ensure_ascii=False, default=str)[:2000], "instrucao": res.get("instrucao")}]


def _preencher_slots_obvios(wa_id, mensagem, bot_cfg):
    """Resposta de uma palavra a uma pergunta do fluxo ("retirada", "pix",
    "dinheiro") não precisa da IA pra virar estado — e o gpt-4o-mini às
    vezes responde "a retirada está confirmada" SEM chamar definir_entrega,
    deixando o rascunho incompleto. Só age com carrinho não vazio e mensagem
    curta exatamente igual a um slot. Devolve a lista de eventos pro log."""
    eventos = []
    # Caso real de produção: cliente respondeu "Dinheiro." (com ponto final)
    # a "qual a forma de pagamento?" — o ponto sozinho fazia o regex de slot
    # não bater (ele exige a palavra exata, sem sobra), a IA não chamou
    # definir_pagamento, e o cliente teve que confirmar "pode fechar" mais
    # três vezes até o servidor finalmente reconhecer o pagamento. Pontuação
    # de fim de frase (. ! ? , ;) não muda o que o cliente quis dizer.
    m = _normalizar_termo(mensagem).strip(".!?,; ")
    if not m or len(m) > 80:
        return eventos
    r = obter_rascunho(wa_id)
    if not r.get("itens"):
        return eventos
    if len(m) > 30 and not _RE_PARECE_ENDERECO.match(m):
        return eventos
    if _RE_SLOT_RETIRADA.match(m):
        res = rascunho_definir_entrega(wa_id, "RETIRADA", None, None, bot_cfg)
        eventos.append({"nome": "definir_entrega[servidor]", "args": {"tipo": "RETIRADA"}, "resultado": json.dumps(res, ensure_ascii=False, default=str)[:2000]})
    elif _RE_SLOT_ENTREGA.match(m) and r.get("tipo_entrega") != "ENTREGA":
        res = rascunho_definir_entrega(wa_id, "ENTREGA", None, None, bot_cfg)
        eventos.append({"nome": "definir_entrega[servidor]", "args": {"tipo": "ENTREGA"}, "resultado": json.dumps(res, ensure_ascii=False, default=str)[:2000]})
    elif _RE_SLOT_PAGAMENTO.match(m):
        forma = _RE_SLOT_PAGAMENTO.match(m).group(2)
        res = rascunho_definir_pagamento(wa_id, forma, bot_cfg)
        if res.get("status") == "ok":
            eventos.append({"nome": "definir_pagamento[servidor]", "args": {"forma": forma}, "resultado": json.dumps(res, ensure_ascii=False, default=str)[:2000]})
    elif (r.get("tipo_entrega") == "ENTREGA" and not r.get("bairro") and len(m) <= 40
          and not any(ch.isdigit() for ch in m) and not _cliente_confirmou(m)
          and not _itens_mencionados(mensagem, carregar_cardapio())
          and verificar_bairro_entrega(mensagem, bot_cfg).get("status") == "atende"):
        # Bot perguntou "qual o bairro?", cliente respondeu "San Genaro" e o
        # mini chamou verificar_bairro_entrega (consulta) em vez de
        # definir_entrega → bairro nunca entrava no rascunho (harness run 7).
        res = rascunho_definir_entrega(wa_id, "ENTREGA", str(mensagem).strip(), None, bot_cfg)
        if res.get("status") == "ok" and obter_rascunho(wa_id).get("bairro"):
            eventos.append({"nome": "definir_entrega[servidor]", "args": {"tipo": "ENTREGA", "bairro": str(mensagem).strip()},
                            "resultado": json.dumps(res, ensure_ascii=False, default=str)[:2000]})
    elif (r.get("tipo_entrega") == "ENTREGA" and r.get("bairro") and not r.get("endereco")
          and _RE_PARECE_ENDERECO.match(m) and not _cliente_confirmou(m)
          and not _itens_mencionados(mensagem, carregar_cardapio())):
        # Bot pediu "rua e número", cliente mandou "Av. Brasil, 45" e o
        # gpt-4o-mini respondia "Perfeito, seu endereço é..." SEM chamar
        # definir_entrega → fechar_pedido caía em "falta endereco" (harness
        # run 5, dois casos). Só age no ponto exato do fluxo (entrega + bairro
        # já definidos, endereço vazio) e se a mensagem não cita item do cardápio.
        res = rascunho_definir_entrega(wa_id, "ENTREGA", None, str(mensagem).strip(), bot_cfg)
        if res.get("status") == "ok" and obter_rascunho(wa_id).get("endereco"):
            eventos.append({"nome": "definir_entrega[servidor]", "args": {"tipo": "ENTREGA", "endereco": str(mensagem).strip()},
                            "resultado": json.dumps(res, ensure_ascii=False, default=str)[:2000]})
    return eventos


_RE_PEDIU_HUMANO = re.compile(
    r"\b(falar|conversar|contato|contatar|atendido|atender)\b[^.?!]{0,25}\b(alguem|atendente|pessoa|humano|equipe|gerente|dono|dona|"
    r"responsavel|funcionari\w*|moca|moco|eles)\b|atendimento humano|atendente humano|\bquero (um|uma) atendente\b")


_RE_COMPROVANTE_ANTES_DE_FECHAR = re.compile(
    r"comprovante[^.?!\n]{0,90}\b(fech|finaliz|prossegu|registr|conclu)|"
    r"\b(fech|finaliz|prossegu|registr|conclu)\w*[^.?!\n]{0,60}(assim que|depois que|quando)[^.?!\n]{0,40}comprovante|"
    r"(antes de|para|pra) (fechar|finalizar|prosseguir|registrar)[^.?!\n]{0,60}comprovante")


_RE_MSG_DE_PEDIDO = re.compile(r"\d|\b(quero|queria|manda|mande|encomend\w*|pedido|pedir|me ve|vou querer|gostaria)\b")


def _soa_como_nao_temos(texto):
    """A IA respondeu que algum item não existe/não temos?"""
    t = _normalizar_termo(texto or "")
    return any(r in t for r in ("nao temos", "nao trabalhamos", "nao possuimos", "nao esta no cardapio",
                                "nao tem no cardapio", "nao temos no cardapio", "nao consta no cardapio"))


def _soa_como_adicao(texto):
    """O texto final afirma que ADICIONOU/incluiu item no pedido? Caso real de
    produção: cliente pediu "1 coca zero 600", a IA (gpt-4o-mini) escreveu que
    tinha adicionado mas nunca chamou adicionar_item — o item não entrou e o
    cliente nem ficou sabendo. Perguntas e frases com "equipe" não contam."""
    if not texto:
        return False
    radicais = ("adicionei", "adicionado", "adicionada", "incluí", "inclui ", "incluído", "incluido",
                "coloquei", "acrescentei", "já está no seu pedido", "ja esta no seu pedido")
    for frase in re.split(r'(?<=[.!?\n])\s+', texto):
        f = frase.lower()
        if "?" in f or "equipe" in f:
            continue
        if any(r in f for r in radicais):
            return True
    return False


def _soa_como_confirmacao(texto):
    """Heurística: o texto final da IA afirma que o pedido foi registrado?
    Avaliada FRASE a frase (não no texto inteiro): antes, um único "?" em
    qualquer lugar liberava o texto todo — "Pedido registrado! Quer mais
    alguma coisa?" passava batido. Frases com "equipe" são ignoradas
    ("vou confirmar com a equipe" é o fluxo legítimo de escalação de
    bairro, não uma confirmação de pedido). Função pura: sem rede, sem
    Firestore — coberta por tests/test_unidade.py."""
    if not texto:
        return False
    # Só afirmações de que o PEDIDO foi registrado/fechado. "A retirada está
    # confirmada" ou "pagamento confirmado" NÃO contam — o radical "confirm"
    # solto comeu turnos legítimos (inclusive o que mostrava a chave PIX).
    radicais = ("registr", "anotei", "anotad", "pedido feito", "pedido pronto", "pedido fechado", "pedido foi fechado",
                "pedido finalizado", "pedido foi finalizado", "pedido confirmado", "pedido foi confirmado",
                "pedido está confirmado", "pedido esta confirmado", "finalizei", "fechei o pedido", "fechamos o pedido",
                "pedido concluído", "pedido concluido", "pedido foi concluído", "pedido foi concluido")
    for frase in re.split(r'(?<=[.!?\n])\s+', texto):
        f = frase.lower()
        if "?" in f or "equipe" in f or "pedido" not in f:
            continue
        if any(r in f for r in radicais):
            return True
    return False


def _soa_como_negativa_entrega(texto):
    """Heurística irmã de _soa_como_confirmacao: o texto final da IA nega
    entrega num bairro ("não entregamos aí")? Só deve disparar quando
    verificar_bairro_entrega voltou "nao_encontrado"/"sem_lista_cadastrada"
    NESTA rodada — nesse caso não existe base pra afirmar que não atende
    (só que não achou o bairro na lista); a resposta certa é escalar pra
    equipe, nunca declarar recusa. Frase a frase, mesma lógica de ignorar
    "?" e "equipe" (fluxo legítimo de escalação já menciona os dois)."""
    if not texto:
        return False
    radicais = ("nao entregamos", "não entregamos", "nao atendemos", "não atendemos",
                "nao realizamos entrega", "não realizamos entrega", "nao fazemos entrega",
                "não fazemos entrega", "nao entrega nesse bairro", "não entrega nesse bairro",
                "nao entrega nessa regiao", "não entrega nessa região",
                "só entregamos", "so entregamos", "somente em", "apenas em",
                "atender somente", "atender apenas", "não temos entrega", "nao temos entrega")
    padroes = (r"n[aã]o\s+(conseguimos|podemos|temos como|dá pra|da pra|é possível|e possivel)\s+(entregar|atender)",
               r"infelizmente[^.!?\n]*(entreg|atend)")
    for frase in re.split(r'(?<=[.!?\n])\s+', texto):
        f = frase.lower()
        if "?" in f or "equipe" in f:
            continue
        if any(r in f for r in radicais) or any(re.search(p, f) for p in padroes):
            return True
    return False


def _soa_como_cancelamento(texto):
    """Heurística irmã de _soa_como_confirmacao: o texto final da IA afirma
    que o PEDIDO (já registrado) foi cancelado? Caso real de produção: cliente
    pediu cancelamento, a IA respondeu "o pedido foi cancelado" sem chamar
    cancelar_pedido — o pedido continuou ativo, foi pra cozinha e virou venda
    de verdade, enganando cliente e equipe ao mesmo tempo."""
    if not texto:
        return False
    radicais = ("pedido foi cancelado", "pedido cancelado", "cancelei seu pedido", "cancelei o pedido",
                "pedido está cancelado", "pedido esta cancelado", "cancelamos seu pedido", "cancelamos o pedido")
    for frase in re.split(r'(?<=[.!?\n])\s+', texto):
        f = frase.lower()
        if "?" in f or "equipe" in f:
            continue
        if any(r in f for r in radicais):
            return True
    return False


def _soa_como_correcao_pos_fechamento(texto):
    """Heurística irmã de _soa_como_cancelamento: depois que a ferramenta do
    rascunho já bloqueou a mutação (pedido_pos_fechamento_bloqueado) porque o
    pedido anterior tinha acabado de fechar, a IA ainda afirma ter corrigido
    o pedido OU que vai abrir/fazer um pedido novo/separado? Caso real de
    produção: cliente confirmou e fechou (R$65), minutos depois pediu pra
    trocar um item — o resultado da ferramenta veio "erro" com instrução
    clara pra não afirmar nada disso, mas a IA descreveu um "pedido
    corrigido" que nunca existiu em lugar nenhum."""
    if not texto:
        return False
    radicais = ("corrigi o pedido", "corrigi seu pedido", "pedido corrigido", "pedido foi corrigido",
                "atualizei o pedido", "atualizei seu pedido", "pedido atualizado", "vou abrir outro pedido",
                "vou fazer um novo pedido", "outro pedido separado", "um novo pedido separado",
                "abrindo um novo pedido")
    for frase in re.split(r'(?<=[.!?\n])\s+', texto):
        f = frase.lower()
        if "?" in f or "equipe" in f:
            continue
        if any(r in f for r in radicais):
            return True
    return False


def _total_mencionado_bate_com_rascunho(texto, valor_real):
    """O "Total"/"Total geral" que o texto final menciona bate com o
    valor_total DE VERDADE do rascunho agora? Caso real de produção: cliente
    pediu 3 itens (pastel, refrigerante, molho), só o molho foi realmente
    adicionado via adicionar_item (os outros dois nunca rodaram — a IA só
    perguntou "posso adicionar?" e nunca chamou a função quando o cliente
    confirmou), mas a IA escreveu um resumo com os 3 itens e "Total geral:
    R$26" — carrinho de verdade tinha R$1. O cliente confirmou o fechamento
    achando que os 3 itens estavam lá, e o pedido fechou faltando 2 deles.
    Essa checagem pega qualquer resumo cujo total dito não bate com o
    total real, não só "pedido fechado" — cobre alucinação de CONTEÚDO do
    carrinho, não só de status. True se não há nada pra checar (texto sem
    "total") ou se bate; False só quando há um total dito E ele diverge."""
    if not texto or "total" not in texto.lower():
        return True
    matches = re.findall(r'total[^\n\d]{0,25}r\$\s*([\d]{1,3}(?:\.\d{3})*(?:,\d{2})?)', texto, re.IGNORECASE)
    if not matches:
        return True
    try:
        valor_dito = float(matches[-1].replace(".", "").replace(",", "."))
    except ValueError:
        return True
    return abs(valor_dito - valor_real) < 0.02


# --- LÓGICA AGENTE OPENAI ---
def get_openai_response(prompt: str, wa_id: str, origem: str = "WPP"):
    import re
    import json

    # Checkpoints temporarios pra achar onde exatamente o processamento
    # trava (visto em produção travando minutos sem nenhum erro no log,
    # mesmo com timeout=10 nas chamadas do Firestore) — remover depois de
    # identificada a causa raiz.
    t0 = time.time()
    def ck(marca):
        print(f"⏱️ CKPT [{wa_id}] {marca} — {time.time() - t0:.2f}s")

    # 1. Limpeza do ID
    id_usuario = str(wa_id).split('@')[0]
    id_usuario = re.sub(r'\D', '', id_usuario)

    ck("antes obter_config_bot")
    bot_cfg = obter_config_bot()
    ck("depois obter_config_bot")

    # Conversa assumida manualmente pelo atendente: só registra a mensagem
    # do cliente no histórico (pro painel exibir) e não responde.
    ck("antes is_modo_manual")
    if is_modo_manual(id_usuario):
        ck("depois is_modo_manual (True)")
        salvar_historico_firestore(id_usuario, "user", prompt, bot_cfg.get("max_historico_salvar"))
        ck("depois salvar_historico_firestore (modo manual)")
        return None
    ck("depois is_modo_manual (False)")

    if not bot_cfg.get("ativo", True):
        return bot_cfg.get("mensagem_inativo") or BOT_CONFIG_DEFAULTS["mensagem_inativo"]

    em_ferias, msg_ferias = verificar_ferias(bot_cfg)
    if em_ferias:
        return msg_ferias

    aberto, texto_horario = verificar_horario_funcionamento(bot_cfg)
    ck("depois verificar_horario_funcionamento")
    if not aberto:
        horario_cfg = bot_cfg.get("horario_funcionamento") or {}
        msg_fechado = horario_cfg.get("mensagem_fechado") or "No momento estamos fechados. Nosso horário de funcionamento: {horario}"
        return msg_fechado.replace("{horario}", texto_horario)

    aviso_atencao_antiga = texto_atencao_pendente_antiga(id_usuario)
    ck("depois texto_atencao_pendente_antiga")

    # Primeiro contato deste cliente (sem histórico ainda): manda a saudação
    # configurada em vez de chamar a IA. Se ele já tiver perguntado algo
    # junto com o "oi", essa pergunta fica salva no histórico e é respondida
    # normalmente na mensagem seguinte dele.
    historico_check = obter_historico_firestore(id_usuario, limite=1)
    ck("depois obter_historico_firestore (checagem primeiro contato)")
    if not historico_check and _e_so_saudacao(prompt):
        saudacao = bot_cfg.get("mensagem_inicial") or BOT_CONFIG_DEFAULTS["mensagem_inicial"]
        # Convite pro app já no primeiro contato — só quando ativo E com link
        # configurado (mesma trava de "divulgar_app": sem link, nunca convida
        # pra algo que a IA não teria como mostrar de verdade).
        convite_app = _texto_convite_app(bot_cfg)
        if convite_app:
            saudacao += "\n\n" + convite_app
        salvar_historico_firestore(id_usuario, "user", prompt, bot_cfg.get("max_historico_salvar"))
        salvar_historico_firestore(id_usuario, "assistant", saudacao, bot_cfg.get("max_historico_salvar"))
        ck("retornou saudacao inicial")
        return saudacao

    # Cliente que JÁ tem histórico mas volta depois de horas (ex.: pediu na
    # semana passada, manda "bom dia" hoje): não cai na saudação de primeiro
    # contato, então o convite pro app nunca aparecia pra quem já era
    # cliente. Marca a "sessão nova" AQUI (antes de salvar a mensagem de
    # agora, que atualizaria a hora) e anexa o convite na resposta no fim.
    horas_parado = _horas_desde_ultima_mensagem(id_usuario)
    convidar_app_nesta_msg = (not historico_check  # 1º contato que já veio com pergunta: IA responde e o convite vai no fim
                              or (horas_parado is not None
                                  and horas_parado >= float(bot_cfg.get("convite_app_intervalo_horas") or 6)))

    nome_cliente = None

    # 2. Busca no Firestore
    ck("antes query usuarios_app")
    try:
        usuarios_ref = db.collection("usuarios_app")
        query = usuarios_ref.where("telefone", "==", id_usuario).limit(1).stream(timeout=10)
        for doc in query:
            dados = doc.to_dict()
            nome_cliente = dados.get('nome')
    except Exception as e:
        print(f"❌ Erro na busca: {e}")
    ck("depois query usuarios_app")

    # 3. Definição do Contexto (Separado das Instruções)
    if nome_cliente:
        contexto_identificacao = f"CLIENTE IDENTIFICADO: Sim. Nome: {nome_cliente}."
        instrucao_nome = f"Chame o cliente só pelo primeiro nome, '{primeiro_nome(nome_cliente)}' (nunca o nome completo, soa mais natural). NÃO pergunte o nome dele novamente."
    else:
        contexto_identificacao = "CLIENTE NOVO: Nome desconhecido."
        instrucao_nome = ("Cliente sem cadastro. Se ele disser o nome em QUALQUER momento — inclusive respondendo "
                          "só 'Murilo' ou se apresentando — chame 'definir_nome' NA HORA. Primeiro nome basta; NUNCA "
                          "peça 'nome completo'. Se ainda não souber na hora do resumo, pergunte junto com a "
                          "confirmação ('Confere? Posso fechar? E me diz seu nome pra anotar'). Se ele não quiser "
                          "informar, feche mesmo assim — o nome não é obrigatório.")

    link_app = (bot_cfg.get("link_app") or "").strip()
    if bot_cfg.get("divulgar_app") and link_app:
        instrucao_divulgar_app = (
            f"Se o nome for desconhecido, avise sobre o app pra ganhar pontos e mande o link: {link_app} "
            "(é o único link real — nunca invente 'baixe na Play Store/App Store' se não for esse link). "
            "Se o nome já for conhecido, apenas lembre-o de conferir os pontos no app."
        )
    elif bot_cfg.get("divulgar_app"):
        # Ativado no painel mas sem link configurado ainda — não convida o
        # cliente pra algo que a IA não tem como mostrar de verdade.
        instrucao_divulgar_app = ""
    else:
        # App ainda não está no ar pra essa loja — não convida o cliente pra
        # baixar nada que não existe de verdade ainda.
        instrucao_divulgar_app = ""

    # 4. Ferramentas (Fase 4: operações sobre o RASCUNHO do pedido)
    def _f(nome, descricao, props=None, required=None):
        f = {"name": nome, "description": descricao}
        if props is not None:
            f["parameters"] = {"type": "object", "properties": props, "required": required or []}
        return {"type": "function", "function": f}

    P_ITEM = {"type": "string", "description": "Código entre colchetes do item no CARDÁPIO do prompt. Nunca o nome."}
    tools = [
        _f("adicionar_item",
           "Adiciona um item ao pedido em andamento (o servidor guarda o carrinho). Chame IMEDIATAMENTE quando o cliente "
           "pedir um item, um por chamada. Adicione SOMENTE o que o cliente pediu: se o nome dito bate com o nome exato de um item "
           "(ex.: 'pastel de carne'), é esse — NÃO adicione também os parecidos ('pastel de carne e queijo'). Se ficar em dúvida "
           "entre dois, pergunte qual em vez de adicionar os dois. Devolve o pedido inteiro atualizado com totais.",
           {"item_id": P_ITEM, "quantidade": {"type": "integer", "minimum": 1}}, ["item_id", "quantidade"]),
        _f("remover_item",
           "Remove um item do pedido (ou diminui a quantidade, se 'quantidade' for informada).",
           {"item_id": P_ITEM, "quantidade": {"type": "integer", "description": "Quantas unidades tirar. Omita pra remover o item todo."}},
           ["item_id"]),
        _f("definir_entrega",
           "Define se é ENTREGA ou RETIRADA. Para ENTREGA informe o bairro (o servidor confere se atendemos) e, quando o cliente "
           "passar, o endereço completo com rua e número. Pode ser chamada mais de uma vez (ex.: primeiro só o bairro, depois o endereço).",
           {"tipo": {"type": "string", "enum": ["ENTREGA", "RETIRADA"]},
            "bairro": {"type": "string", "description": "Bairro dito pelo cliente (só ENTREGA)."},
            "endereco": {"type": "string", "description": "Rua e número (e complemento). Só ENTREGA. Nunca só o bairro."}},
           ["tipo"]),
        _f("definir_pagamento", "Define a forma de pagamento: PIX, CARTÃO ou DINHEIRO. Se for PIX, a resposta traz a chave.",
           {"forma": {"type": "string"}}, ["forma"]),
        _f("definir_nome",
           "Guarda o nome do cliente. Chame ASSIM QUE ele disser o nome, em qualquer ponto da conversa (ex.: responde "
           "'Murilo', ou 'aqui é a Ana'). Primeiro nome basta.",
           {"nome": {"type": "string"}}, ["nome"]),
        _f("definir_observacao", "Observação do cliente sobre o pedido (ex.: 'sem cebola', 'troco pra 50').",
           {"observacao": {"type": "string"}}, ["observacao"]),
        _f("ver_resumo",
           "Devolve o pedido completo com itens, taxa e TOTAL calculados pelo servidor, e o que ainda falta. OBRIGATÓRIO antes de "
           "fechar_pedido: mostre esse resumo ao cliente e pergunte se pode fechar. Use também sempre que for citar valores."),
        _f("fechar_pedido",
           "Registra o pedido DE VERDADE a partir do rascunho. Sem parâmetros. Chame SÓ depois que o cliente confirmar o resumo "
           "explicitamente ('sim', 'pode fechar'). Se devolver status 'erro', leia o 'motivo' e resolva com o cliente (uma pergunta por vez)."),
        _f("item_nao_encontrado",
           "Chame quando o cliente pedir algo que NÃO está no cardápio nem nos apelidos (ex.: 'pastel de salsicha' quando não existe). "
           "Avisa a equipe pra cadastrar um apelido. Depois diga ao cliente que não temos e ofereça a categoria mais próxima.",
           {"nome_pedido": {"type": "string", "description": "Exatamente como o cliente escreveu."}}, ["nome_pedido"]),
        _f("detalhar_item",
           "Ingredientes e detalhes de UM item do cardápio, pelo código. Use quando o cliente perguntar 'o que vem', 'tem cebola?', "
           "'é assado ou frito?'. Não use pra preço ou disponibilidade — isso já está no CARDÁPIO.",
           {"item_id": P_ITEM}, ["item_id"]),
        _f("verificar_bairro_entrega",
           "Só pra responder 'vocês entregam no bairro X?' quando o cliente ainda NÃO está fechando pedido. No fechamento use definir_entrega.",
           {"bairro_cliente": {"type": "string"}}, ["bairro_cliente"]),
        _f("confirmar_bairro_na_cidade",
           "Chame quando o cliente RESPONDER à pergunta se o bairro fica dentro da cidade (perímetro urbano). "
           "dentro_da_cidade=true se ele disse que sim; false se disse que é outra cidade, zona rural, sítio etc.",
           {"dentro_da_cidade": {"type": "boolean"}}, ["dentro_da_cidade"]),
        _f("consultar_meu_pedido",
           "Pedido mais recente JÁ REGISTRADO deste cliente (itens, valor, status). Use quando ele perguntar de um pedido já feito."),
        _f("cancelar_pedido",
           "Chame sempre que o cliente pedir pra cancelar — funciona tanto pro pedido mais recente JÁ REGISTRADO (fechar_pedido "
           "já rodou) quanto pro carrinho que ainda está sendo montado (fechar_pedido nunca rodou). Sem parâmetros. OBRIGATÓRIO "
           "chamar antes de dizer 'cancelado' — NUNCA diga que cancelou sem chamar. Se voltar status 'erro' (já em preparo), "
           "diga que a equipe vai confirmar o cancelamento."),
    ]

    nome_atendente = bot_cfg.get("nome_atendente") or BOT_CONFIG_DEFAULTS["nome_atendente"]
    nome_empresa = bot_cfg.get("nome_empresa") or BOT_CONFIG_DEFAULTS["nome_empresa"]
    # .strip() pra pegar também o caso de alguém salvar só espaço em branco
    # no painel — não é só "campo ausente" que precisa cair no fallback.
    chave_pix = (bot_cfg.get("chave_pix") or "").strip() or "consulte a equipe"
    instrucoes_extras = bot_cfg.get("instrucoes_extras") or ""
    cidade_atendida = bot_cfg.get("cidade_atendida") or ""
    # Lista de bairros no prompt: sem ela o gpt-4o-mini respondia "entregam
    # no São Genaro?" de cabeça ("só entregamos em <cidade>") sem chamar
    # verificar_bairro_entrega. Com a lista à vista ele não precisa adivinhar;
    # a função continua valendo pra nomes fora da lista (fuzzy + aprendizado).
    _bairros_cfg = [str(b).strip() for b in (bot_cfg.get("bairros_entrega") or []) if str(b).strip()]
    if _bairros_cfg:
        _taxa_cfg = bot_cfg.get("taxa_entrega") or 0
        bairros_texto = (f"BAIRROS ONDE ENTREGAMOS (taxa R$ {float(_taxa_cfg):.2f}): {', '.join(_bairros_cfg)}. "
                         "Cliente perguntou de um bairro parecido com um desses (acento/grafia diferente) → é esse, confirme. "
                         "Bairro que NÃO está na lista → chame verificar_bairro_entrega antes de responder; nunca diga "
                         "'não entregamos' de cabeça.")
    else:
        bairros_texto = ""
    # Telefone de contato da loja — mesma fonte que o painel usa (Config >
    # Estabelecimento). Sem isso, quando o cliente pede "o contato" a IA não
    # tinha nenhum número de verdade pra dar e ACABAVA INVENTANDO um número
    # parecido mas errado (aconteceu em produção). Se não estiver configurado,
    # cai no fallback explícito abaixo, nunca inventa.
    try:
        doc_sistema = db.collection("configuracoes").document("sistema").get(timeout=10)
        telefone_contato = (doc_sistema.to_dict() or {}).get("telefone") if doc_sistema.exists else None
    except Exception:
        telefone_contato = None
    telefone_contato = str(telefone_contato or "").strip() or "não tenho esse número aqui, peça pra equipe confirmar"

    # Aviso de encomenda de festa/cento — configurável em Config do Bot,
    # sem precisar mexer em código pra trocar telefone/texto.
    aviso_encomenda_festa = ""
    if bot_cfg.get("aviso_encomenda_festa_ativo", True):
        aviso_encomenda_festa = (bot_cfg.get("aviso_encomenda_festa_texto")
                                  or BOT_CONFIG_DEFAULTS["aviso_encomenda_festa_texto"])

    # 5. Cardápio pro prompt (Fase 3) — uma leitura por mensagem, com cache.
    ck("antes carregar_cardapio")
    cardapio_atual = carregar_cardapio()
    cardapio_texto = montar_cardapio_prompt(cardapio_atual)
    ck("depois carregar_cardapio")

    # Slots óbvios ("retirada", "pix", "dinheiro") registrados pelo servidor
    # ANTES da IA — o prompt já reflete, e a IA não precisa chamar a função.
    # Cliente pediu pra falar com uma pessoa: marca a conversa pra equipe (selo
    # piscando no painel) e a equipe responde pelo Atendimento. Caso real
    # (26/09): o bot disse "não consigo conectar você com a equipe aqui".
    pediu_humano = bool(_RE_PEDIU_HUMANO.search(_normalizar_termo(prompt or "")))
    if pediu_humano:
        marcar_atencao(id_usuario, f"Cliente pediu pra falar com a equipe: \"{str(prompt)[:150]}\"", tipo="humano")
    eventos_servidor = _resolver_endereco_sugerido(wa_id, id_usuario, prompt, bot_cfg)
    eventos_servidor += _resolver_bairro_pendente(wa_id, id_usuario, prompt, bot_cfg)
    eventos_servidor += _preencher_slots_obvios(id_usuario, prompt, bot_cfg)

    # Estado do pedido em andamento (Fase 4) — uma leitura por mensagem.
    rascunho_inicio_turno = _aplicar_nome_identificado(obter_rascunho(id_usuario), nome_cliente)
    rascunho_texto = rascunho_para_prompt(rascunho_inicio_turno, bot_cfg)
    if eventos_servidor:
        rascunho_texto += "\n  (o servidor acabou de registrar, a partir desta mensagem do cliente: " + \
            ", ".join(e["nome"].replace("[servidor]", "") + "=" + json.dumps(e["args"], ensure_ascii=False) for e in eventos_servidor) + \
            " — NÃO chame essa função de novo; siga pro próximo passo)"
        for e in eventos_servidor:
            if e.get("instrucao"):
                rascunho_texto += f"\n  INSTRUÇÃO DESTA MENSAGEM: {e['instrucao']}"
    if pediu_humano:
        rascunho_texto += ("\n  INSTRUÇÃO DESTA MENSAGEM: o cliente pediu pra falar com a equipe e o servidor JÁ AVISOU a equipe. "
                           "Diga que chamou a equipe e que alguém responde AQUI MESMO nesta conversa em instantes "
                           "(não mande ligar nem mandar mensagem pra outro número).")

    # 5. Prompt Otimizado (Limpo e Direto)
    system_prompt = f"""
    Voce e {nome_atendente}, a IA da {nome_empresa}. Aja de forma natural, educada e vendedora.

    --- DADOS DO SISTEMA ---
    {contexto_identificacao}
    TELEFONE_DO_CLIENTE (uso interno do sistema, NUNCA fale esse número pro
    cliente, ele já sabe o próprio número): {id_usuario}
    TELEFONE_DE_CONTATO_DA_LOJA (é ESTE que você informa se o cliente pedir
    "o contato"/"o telefone de vocês"/"o whatsapp da loja" — use EXATAMENTE
    este valor, nunca o TELEFONE_DO_CLIENTE acima, nunca invente outro número,
    nem parecido): {telefone_contato}
    {f"Cidade onde a loja entrega: {cidade_atendida} (só entrega dentro dessa cidade, nenhuma outra)." if cidade_atendida else ""}
    {bairros_texto}
    {aviso_atencao_antiga}

    {rascunho_texto}

    --- CARDÁPIO DE AGORA (lido do sistema nesta mensagem; código entre colchetes) ---
{cardapio_texto}
    
    --- SUAS DIRETRIZES ---
    0. O CARDÁPIO É A ÚNICA VERDADE — PROIBIDO INVENTAR:
       - O bloco "CARDÁPIO DE AGORA" acima foi lido do sistema NESTA mensagem
         e é a única fonte de produtos, preços e disponibilidade. Se um
         produto, sabor, categoria, complemento ou molho não está lá, ele
         NÃO EXISTE — mesmo que seja comum numa lanchonete, mesmo que o
         cliente afirme que já comprou, mesmo que apareça em mensagens
         antigas desta conversa (o cardápio muda; vale só o de agora).
       - Item marcado "(ESGOTADO hoje)": existe, mas está em falta — diga
         isso e ofereça outro da mesma categoria. Não aceite no pedido.
       - Cliente pede algo que não está no cardápio (ex.: "pastel de
         salsicha" quando só existe "Salsicha" avulsa e "Pastel de Carne"):
         diga que não tem ESSE item e mostre as opções da categoria mais
         próxima. NUNCA confirme com o nome que o cliente usou se o nome
         real for outro — fale sempre o nome como está no cardápio.
       - Preços: só os do cardápio, copiados exatamente. Nunca some totais
         de cabeça (o servidor calcula em 'ver_resumo').
       - Categoria que não existe no cardápio ("sobremesas", "combos",
         "molhos"): diga que não tem, sem inventar lista.
       - Em 'adicionar_item'/'remover_item', identifique o item pelo CÓDIGO
         entre colchetes ("item_id"), nunca pelo nome.
       - Item com mais de uma variação parecida no cardápio (ex.: Coxinha
         Frango normal e Coxinha com Catupiry): se o cliente não deixou
         claro qual delas quer, PERGUNTE antes de chamar 'adicionar_item' —
         não escolha a mais barata/comum de cabeça. Se mesmo assim você
         chamar a função com a variação errada, o servidor recusa e pede
         pra perguntar; não insista na mesma escolhida, pergunte de fato.

    1. IDENTIFICAÇÃO: {instrucao_nome}
       {instrucao_divulgar_app}
       - Sempre que for se dirigir ao cliente pelo nome (identificado ou se
         ele informar o nome completo na conversa), use só o primeiro nome
         — nunca o nome completo, soa mais natural e menos formal.

    2. APRESENTAÇÃO DE PRODUTOS:
       - Pergunta genérica ("o que tem?", "tem salgado assado?", "quais
         pastéis?"): responda com os itens da(s) categoria(s) que batem,
         nome e preço de cada um, TODOS os itens da categoria — não resuma,
         não corte, não diga "e muito mais". Não mostre os códigos pro
         cliente, eles são só pra você usar nas funções.
       - Bebida é acompanhamento: só liste bebidas quando o cliente pedir
         bebida, ou quando for oferecer uma junto do pedido.
       - Reescreva com suas palavras, como um atendente digitando no
         WhatsApp: frases naturais, sem cabeçalho de catálogo, sem colar o
         bloco do prompt.
       - Ingredientes NÃO estão no prompt: quando o cliente perguntar "o que
         vem", "tem cebola?", "é frito ou assado?", chame 'detalhar_item'
         com o código e responda com o que ela devolver. Não invente
         ingrediente.
       - Ao confirmar um item que o cliente escolheu, use o nome EXATO do
         cardápio (ex.: cliente escreve "coca zero", você confirma
         "Coca-Cola Zero Lata 350ml"). Se houver mais de uma variante que
         pode ser o que ele quis (lata 350ml e 600ml), pergunte qual.

    3. O PEDIDO FICA NO SERVIDOR — você opera com as funções, não de memória:
       - Cliente pede um item → 'adicionar_item' NA HORA (uma chamada por
         item), depois pergunte só "Mais alguma coisa?". Nada de entrega ou
         pagamento nessa hora. Só o item que ele pediu: nome exato do
         cardápio ganha do parecido ("pastel de carne" NÃO é "pastel de
         carne e queijo"); em dúvida, pergunte — nunca adicione os dois.
       - Cliente tira/troca algo → 'remover_item' / 'adicionar_item'. Não
         readicione o que já está no PEDIDO EM ANDAMENTO.
       - Quando disser que é só isso: se ainda não sabe, pergunte "entrega
         ou retirada?" → 'definir_entrega'. Se ele já falou de bairro/
         entrega antes, não pergunte de novo. ENTREGA precisa de bairro E
         endereço com rua e número — peça o endereço numa pergunta
         própria; bairro sozinho não serve.
       - Depois, forma de pagamento (PIX, cartão ou dinheiro) →
         'definir_pagamento'. PIX é sempre antecipado: passe a chave que a
         função devolver e diga que precisa do comprovante antes do preparo;
         "pagar na entrega" só com cartão ou dinheiro.
       - Nome: se o cliente já disse, 'definir_nome' na hora em que disse.
         Se não, pergunte junto com a confirmação do resumo, uma vez só;
         não trave o pedido por causa do nome. Cliente identificado: não
         pergunte.
       - Aí 'ver_resumo' e mostre ao cliente cada item, a taxa se houver e o
         "valor_total" que a função devolveu, perguntando "Confere? Posso
         fechar?". Só depois de um "sim" claro → 'fechar_pedido'.
       - Quando o cliente responder "sim"/"pode"/"confere"/"isso" à sua
         pergunta "posso fechar?": chame 'fechar_pedido' IMEDIATAMENTE.
         Não mostre o resumo de novo, não chame definir_* de novo.
       - 'fechar_pedido' com status "erro": leia o "motivo" e resolva
         (pergunte o que falta, uma coisa por vez, ou mostre o resumo de
         novo). Com status "ok": confirme com o "valor_total" da resposta.
         Se vier "ja_estava_fechado", o pedido já existe — só confirme.
       - NUNCA diga "registrado"/"confirmado"/"anotado" sem 'fechar_pedido'
         ter devolvido "ok" NESTA resposta. NUNCA some valores de cabeça:
         todo "R$" que você escrever vem de uma função desta resposta.
       - Pedido depois de um já fechado é um pedido NOVO (o servidor começa
         outro rascunho): deixe isso claro pro cliente.
       - Pergunta sobre pedido já feito ("o que eu pedi?", "cadê meu
         pedido?") → 'consultar_meu_pedido'.
       - Item que o cliente pediu e não existe no cardápio nem nos
         apelidos → 'item_nao_encontrado' e ofereça a categoria mais próxima.

       SOBRE BAIRRO: chame 'verificar_bairro_entrega' passando só o NOME DO
       BAIRRO (nunca a cidade nem o endereço inteiro junto — "Morumbi, São
       Sebastião do Paraíso" vira bairro_cliente="Morumbi", não a frase
       toda). 'definir_entrega'/'verificar_bairro_entrega' já conferem a
       lista. "atende": confirme e informe a taxa. "nao_atende_confirmado":
       diga com firmeza que não entregamos ali e ofereça retirada. Bairro
       não reconhecido ("nao_encontrado"), MESMO que pareça outra
       cidade, povoado ou zona rural (já erramos com "Alpinia": entregamos
       lá): você NÃO decide isso e NÃO chama a equipe. O resultado traz a
       'pergunta' — faça EXATAMENTE ela ao cliente (se o bairro fica dentro
       da cidade, perímetro urbano) e pare. Quando ele responder, chame
       'confirmar_bairro_na_cidade' (true = dentro da cidade; false = outra
       cidade/zona rural/sítio). "atende" → confirme a entrega com a taxa e
       siga o pedido; "fora_da_cidade" → diga que só entregamos na cidade e
       ofereça retirada. NUNCA, antes da resposta do cliente: (1) diga que
       entregamos ou que não entregamos; (2) peça pro cliente confirmar o
       nome do bairro que ele já disse; (3) sugira outro nome de bairro.

       SOBRE PEDIDO JÁ FEITO (inclusive PELO APP): se o cliente falar de um
       pedido que já fez ("pedi no app", "meu pedido", "já paguei"), chame
       'consultar_meu_pedido' ANTES de tudo e fale desse pedido. NUNCA monte
       o mesmo pedido de novo no carrinho. Se o resultado diz que o PIX já
       foi confirmado, NÃO peça comprovante.

       SOBRE PAGAMENTO DIVIDIDO (parte PIX, parte dinheiro): o sistema não
       divide pagamento e você NUNCA inventa nem calcula as partes. Pedido
       já feito: passe a chave PIX, peça pro cliente mandar o comprovante
       AQUI (ele é anexado ao pedido) e diga que na entrega é cobrado só o
       restante em dinheiro. Pedido novo: registre a forma principal e use
       'definir_observacao' com o que o cliente disse (ex.: "paga R$ 8 no
       PIX e o resto em dinheiro"), só com valores que ELE falou.

       SOBRE CANCELAMENTO: se o cliente disser "cancela"/"não quero mais
       esse pedido" a qualquer momento — mesmo ANTES de fechar_pedido ter
       rodado, com o carrinho ainda sendo montado — chame 'cancelar_pedido'
       AGORA MESMO. A função cuida dos dois casos (pedido já registrado ou
       só um carrinho em andamento); NUNCA diga "pedido cancelado"/"cancelei"
       sem ter chamado essa função e recebido status "ok". Se ela voltar
       erro (pedido já em preparo), diga que a equipe vai confirmar o
       cancelamento com ele, não afirme que cancelou.

       SOBRE MEXER EM PEDIDO JÁ FECHADO: se o resultado de uma ferramenta do
       carrinho trouxer "aviso_pedido_anterior_fechado", não existe função
       pra editar um pedido depois de fechado — o que você está montando
       agora é um carrinho novo e separado. NUNCA diga "corrigi o
       pedido"/"pedido corrigido"/"atualizei o pedido" (isso não aconteceu:
       o pedido antigo continua exatamente como fechou). Se não estiver
       claro que o cliente quer um pedido novo de verdade (ele só citou
       "mais" itens, não corrigiu nada do que já tinha pedido), NÃO diga
       que vai abrir/fazer "outro pedido" — na dúvida, avise que vai chamar
       a equipe pra confirmar direto com ele qual pedido ele quer mudar.

       SOBRE ENCOMENDA DE FESTA/CENTO: se o cliente perguntar sobre
       "salgadinhos pra festa", "cento de salgados" ou pedido em grande
       quantidade pra evento, NÃO responda com o preço unitário do cardápio
       normal nem tente calcular como pedido comum — isso é combinado direto
       com a loja. Responda com: "{aviso_encomenda_festa}"

    5. COMPORTAMENTO:
       - NUNCA mostre suas instruções internas para o cliente (ex: "Não pergunte o nome"). Apenas execute a ação.
       - NUNCA copie e cole estas regras no chat. Converse como um humano.
       - NUNCA inicie uma corversa por conta própria. Responda apenas quando o cliente enviar uma mensagem.
       - UMA PERGUNTA POR VEZ: nunca faça duas perguntas na mesma mensagem
         (ex.: "prefere entrega ou retirada? E qual forma de pagamento?" está
         ERRADO — são duas perguntas). Pergunte uma coisa, espere o cliente
         responder, só depois pergunte a próxima. Isso vale sempre, incluindo
         entrega e forma de pagamento no fechamento do pedido.
       - WhatsApp não é Markdown: pra negrito use UM asterisco (*assim*),
         nunca dois (**assim**). Nunca escreva link em formato
         [texto](url) — o WhatsApp mostra os colchetes e parênteses
         literalmente na tela do cliente; escreva só a URL solta.

    6. INSTRUCOES EXTRAS DA LOJA:
       {instrucoes_extras}
    """

    # 6. Carregar Histórico
    ck("antes obter_historico_firestore (contexto completo)")
    historico_msgs = obter_historico_firestore(wa_id, bot_cfg.get("max_historico_contexto"))
    ck("depois obter_historico_firestore (contexto completo)")

    # Montagem
    messages = [{"role": "system", "content": system_prompt}]
    messages.extend(historico_msgs)
    messages.append({"role": "user", "content": prompt})

    # Dados pro log append-only (conversas_log) — preenchidos ao longo do
    # turno e gravados uma vez no final, sucesso ou erro.
    modelo_usado = bot_cfg.get("modelo") or BOT_CONFIG_DEFAULTS["modelo"]
    log_ferramentas = list(eventos_servidor)
    log_usage = {}
    log_chamadas_ia = 0
    log_observacao = None

    try:
        # ----- LOOP DE FERRAMENTAS (Fase 2) -----
        # Antes eram exatamente DUAS chamadas fixas: a 1ª com ferramentas e a
        # 2ª SEM ferramentas, só pra redigir o texto. Se o modelo precisava
        # encadear (verificar_bairro → calcular_pedido, ou calcular → ver o
        # resultado → registrar), não tinha como: na 2ª rodada ele só podia
        # escrever texto — e escrevia "pedido registrado" sem ter registrado.
        # Agora ele pode chamar ferramentas em rodadas sucessivas, até
        # MAX_RODADAS_FERRAMENTA; ao sair do loop sem texto, uma última
        # chamada com tool_choice="none" fecha a resposta.
        #
        # Se registrar_pedido falhar por erro DE SISTEMA (Firestore fora do
        # ar, exceção não prevista) — não por regra de negócio esperada (loja
        # fechada, item não reconhecido) — a resposta final não pode depender
        # da IA "perceber" isso e admitir o erro pro cliente: ela pode gerar
        # uma confirmação plausível mesmo com a função tendo retornado erro
        # (já aconteceu). Nesse caso a resposta é fixa e a equipe é avisada.
        MAX_RODADAS_FERRAMENTA = 5
        # "sim"/"pode"/"confere" respondendo a "posso fechar?" — vale pra
        # tool fechar_pedido (dispensa a gate do resumo) e pro fechamento
        # determinístico no fim do turno.
        confirmacao_explicita = _cliente_confirmou(prompt) and (_ultima_resposta_pediu_confirmacao(historico_msgs)
                                                                or _ultima_resposta_mostrou_total(historico_msgs))
        falha_sistema_pedido = None
        pedido_registrado_ok = False
        pedido_cancelado_ok = False
        bairro_nao_encontrado = False
        bairro_negado_confirmado = False
        consultou_pedido_sem_achar = False
        item_adicionado_ok = False
        pergunta_variacao = None
        retentativa_adicao_feita = False
        tool_choice_rodada = "auto"
        final_text = None

        for rodada in range(1, MAX_RODADAS_FERRAMENTA + 1):
            ck(f"antes chamada OpenAI #{rodada}")
            # timeout explícito: sem isso, uma resposta pendurada da OpenAI
            # prende essa thread indefinidamente (travava ESSE cliente pro
            # resto da conversa). 60s é folgado pra uma rodada com tools.
            response = openai.chat.completions.create(
                model=modelo_usado,
                messages=messages,
                tools=tools,
                tool_choice=tool_choice_rodada,
                timeout=60
            )
            ck(f"depois chamada OpenAI #{rodada}")
            log_chamadas_ia += 1
            _somar_usage(log_usage, response)

            response_message = response.choices[0].message
            tool_choice_rodada = "auto"
            if not response_message.tool_calls:
                final_text = response_message.content
                # A IA disse que ADICIONOU algo mas nenhum adicionar_item deu
                # certo nesta mensagem, e o cliente citou item do cardápio:
                # uma única retentativa exigindo a chamada da ferramenta (o
                # item não pode ficar de fora em silêncio). O resultado real
                # da ferramenta é que vira a resposta final.
                # Caso real (26/09): cliente mandou pedido de 8 itens, a IA respondeu
                # "não temos pastel de palmito" (tinha!) sem chamar adicionar_item
                # pra nada. Mensagem com cara de PEDIDO (quantidade/"quero") que
                # cita itens do cardápio e ficou sem nenhum adicionar_item → mesma
                # retentativa forçada. Pergunta "tem X?" não entra (não é pedido).
                soa_nao_temos = (_soa_como_nao_temos(final_text) and pergunta_variacao is None
                                 and _RE_MSG_DE_PEDIDO.search(_normalizar_termo(prompt)))
                if (not item_adicionado_ok and not retentativa_adicao_feita
                        and (_soa_como_adicao(final_text) or soa_nao_temos)
                        and _itens_mencionados(prompt, cardapio_atual)):
                    retentativa_adicao_feita = True
                    log_observacao = "retentativa_forcada_adicionar_item"
                    messages.append(response_message)
                    messages.append({"role": "system", "content":
                                     "O cliente pediu itens que EXISTEM no cardápio e você NÃO chamou adicionar_item. Chame "
                                     "adicionar_item AGORA para cada item do cardápio que o cliente pediu nesta mensagem (use o "
                                     "código do cardápio). Se algum item for ambíguo, chame só pros claros e pergunte depois; "
                                     "só diga que não temos o que realmente não está no cardápio."})
                    tool_choice_rodada = "required"
                    continue
                break

            messages.append(response_message)
            for tool_call in response_message.tool_calls:
                function_name = tool_call.function.name
                args = json.loads(tool_call.function.arguments)
                
                content = ""
                resultado = None
                if function_name == "adicionar_item":
                    it_pedido = _resolver_item(args.get("item_id"), cardapio_atual)
                    ja_no_carrinho = it_pedido and any(i.get("id") == it_pedido["id"] for i in obter_rascunho(id_usuario).get("itens") or [])
                    mencionados = _itens_mencionados(prompt, cardapio_atual)
                    item_certo, opcoes_variante = _resolver_variante_ambigua(it_pedido, cardapio_atual, prompt)
                    if opcoes_variante:
                        # Caso real (28/09): "coxinha com catupiry" veio numa mensagem e a
                        # IA só adicionou depois ("valor e número do pix") — a checagem
                        # olhava só a mensagem atual e perguntou 3x qual coxinha.
                        # Considera também as últimas mensagens do cliente.
                        recentes = [m.get("content") or "" for m in historico_msgs if m.get("role") == "user"][-3:]
                        certo_ctx, _ = _resolver_variante_ambigua(it_pedido, cardapio_atual, " ".join(recentes + [prompt]))
                        if certo_ctx:
                            item_certo, opcoes_variante = certo_ctx, None
                    if (retentativa_adicao_feita and it_pedido
                            and not _tipo_do_item_na_mensagem(it_pedido, " ".join([prompt] + [m.get("content") or "" for m in historico_msgs if m.get("role") == "user"][-2:]))):
                        # Caso real (28/09): na retentativa forçada a IA adicionou um
                        # "Pastel Frango Catupiry" pra quem escreveu "coxinha de frango
                        # com catupiry". Na retentativa só entra item cujo TIPO
                        # (pastel, coxinha...) o cliente citou.
                        resultado = _resumo_rascunho(obter_rascunho(id_usuario), bot_cfg, status="erro",
                                                     motivo="Esse item não foi pedido pelo cliente — não adicionei. Adicione só o que ele pediu.")
                    elif ja_no_carrinho and mencionados and it_pedido["id"] not in mencionados:
                        # "1 guaraná lata" → o mini readicionava as 2 coxinhas que já
                        # estavam no carrinho (total dobrava). Se a mensagem cita outro
                        # item e não este, é repetição: devolve o rascunho sem somar.
                        resultado = _resumo_rascunho(obter_rascunho(id_usuario), bot_cfg,
                                                     aviso="Esse item JÁ ESTAVA no pedido e o cliente não pediu mais dele agora — não somei. "
                                                           "Não readicione o que já está no PEDIDO EM ANDAMENTO.")
                    elif opcoes_variante:
                        # Caso real de produção: cliente pediu "coxinha de frango com
                        # catupiry", a IA adicionou a Coxinha Frango normal (mais barata,
                        # sem catupiry) sem perguntar nada — pedido fechou com o item
                        # errado e valor errado. Existe mais de uma variação e a
                        # mensagem não deixou claro qual: não adiciona nada, pergunta.
                        opcoes_txt = " ou ".join(f"{v.get('nome_exibicao') or v.get('nome')} (R$ {float(v.get('preco') or 0):.2f})"
                                                  for v in opcoes_variante)
                        pergunta_variacao = ("Uma dúvida antes de seguir: qual você quer — "
                                             + " ou ".join(f"{v.get('nome_exibicao') or v.get('nome')} (R$ {float(v.get('preco') or 0):.2f})".replace(".", ",")
                                                           for v in opcoes_variante) + "?")
                        resultado = _resumo_rascunho(obter_rascunho(id_usuario), bot_cfg, status="erro",
                                                     motivo=f"Existe mais de uma variação: {opcoes_txt}. NÃO adicione nenhuma ainda — "
                                                            "pergunte ao cliente qual delas ele quer.")
                    else:
                        item_id_usar = item_certo["codigo"] if item_certo else args.get("item_id")
                        resultado = rascunho_adicionar_item(id_usuario, item_id_usar, args.get("quantidade"), bot_cfg, cardapio_atual)
                elif function_name == "remover_item":
                    resultado = rascunho_remover_item(id_usuario, args.get("item_id"), args.get("quantidade"), bot_cfg, cardapio_atual)
                elif function_name == "definir_entrega":
                    resultado = rascunho_definir_entrega(id_usuario, args.get("tipo"), args.get("bairro"), args.get("endereco"), bot_cfg,
                                                         texto_cliente=prompt)
                elif function_name == "definir_pagamento":
                    if _cliente_mencionou_pagamento(args.get("forma"), prompt, historico_msgs):
                        resultado = rascunho_definir_pagamento(id_usuario, args.get("forma"), bot_cfg)
                    else:
                        resultado = {"status": "erro", "motivo": "O cliente ainda NÃO disse a forma de pagamento. Não invente: "
                                                                  "pergunte 'PIX, cartão ou dinheiro?' e só chame definir_pagamento "
                                                                  "com a resposta dele."}
                elif function_name == "definir_nome":
                    resultado = rascunho_definir_nome(id_usuario, args.get("nome"), bot_cfg)
                elif function_name == "definir_observacao":
                    resultado = rascunho_definir_observacao(id_usuario, args.get("observacao"), bot_cfg)
                elif function_name == "ver_resumo":
                    resultado = rascunho_ver_resumo(id_usuario, bot_cfg, nome_identificado=nome_cliente)
                elif function_name == "fechar_pedido":
                    resultado = rascunho_fechar_pedido(id_usuario, bot_cfg, nome_identificado=nome_cliente,
                                                       confirmacao_explicita=confirmacao_explicita)
                    if resultado.get("status") == "ok":
                        pedido_registrado_ok = True
                        limpar_atencao(id_usuario)
                    elif resultado.get("motivo") == "Erro interno.":
                        falha_sistema_pedido = "Erro interno."
                        marcar_atencao(id_usuario, "FALHA ao registrar pedido (não foi salvo): Erro interno.",
                                       tipo="pedido_falhou", dados={"rascunho": obter_rascunho(id_usuario).get("itens")})
                elif function_name == "item_nao_encontrado":
                    nome_pedido = str(args.get("nome_pedido") or "").strip()
                    marcar_atencao(id_usuario, f"Item(ns) não reconhecido(s) no pedido: {nome_pedido}",
                                   tipo="item", dados={"nome_produto": nome_pedido, "todos": [nome_pedido]})
                    resultado = {"status": "ok", "instrucao": "Equipe avisada. Diga ao cliente que não temos esse item e ofereça a categoria mais próxima do cardápio."}
                elif function_name == "detalhar_item":
                    resultado = detalhar_item(args.get("item_id"), cardapio_atual)
                elif function_name == "verificar_bairro_entrega":
                    resultado = verificar_bairro_entrega(args.get("bairro_cliente"), bot_cfg)
                    r_tmp = obter_rascunho(id_usuario)
                    if resultado.get("status") == "atende" and r_tmp.get("itens") and r_tmp.get("tipo_entrega") == "ENTREGA" and not r_tmp.get("bairro"):
                        # A IA "consultou" o bairro no ponto em que devia defini-lo: grava.
                        rascunho_definir_entrega(id_usuario, "ENTREGA", resultado.get("bairro"), None, bot_cfg)
                        resultado["bairro_gravado_no_pedido"] = True
                    if resultado.get("status") == "nao_atende_confirmado":
                        bairro_negado_confirmado = True
                    if resultado.get("status") in ("nao_encontrado", "sem_lista_cadastrada"):
                        bairro_nao_encontrado = True
                        resultado.update(_marcar_bairro_pendente(id_usuario, args.get("bairro_cliente"), bot_cfg, texto_cliente=prompt))
                elif function_name == "confirmar_bairro_na_cidade":
                    resultado = confirmar_bairro_na_cidade(id_usuario, bool(args.get("dentro_da_cidade")), bot_cfg)
                    if resultado.get("status") == "fora_da_cidade":
                        bairro_negado_confirmado = True
                elif function_name == "consultar_meu_pedido":
                    content = consultar_meu_pedido(wa_id)
                    if json.loads(content).get("status") == "sem_pedido":
                        consultou_pedido_sem_achar = True
                elif function_name == "cancelar_pedido":
                    resultado = json.loads(cancelar_pedido_recente(wa_id))
                    if resultado.get("status") == "ok" and not (resultado.get("ja_estava_cancelado")
                                                                and obter_rascunho(id_usuario).get("itens")):
                        pedido_cancelado_ok = True
                    elif obter_rascunho(id_usuario).get("itens") and (
                            resultado.get("status") == "sem_pedido" or resultado.get("ja_estava_cancelado")
                            or resultado.get("status_pedido") == "CONCLUIDO"):
                        # Caso real (26/09): o último pedido registrado era de 9 dias
                        # antes e já estava CONCLUIDO; o bot respondeu "o pedido já
                        # está concluído, só a equipe cancela" e o carrinho de agora
                        # ficou lá. Pedido antigo encerrado + carrinho em andamento
                        # = o cliente quer cancelar o carrinho.
                        # Caso real de produção: cliente nunca chegou a
                        # fechar_pedido (nada registrado de verdade), mas
                        # pediu "cancela meu pedido"/"não quero mais esse
                        # pedido" — cancelar_pedido_recente só olha pedidos
                        # JÁ REGISTRADOS e não achou nada, então o carrinho
                        # em andamento ficava intocado pra sempre. Cliente
                        # ficava preso: toda mensagem seguinte caía num
                        # fallback perguntando entrega/pagamento como se
                        # nada tivesse acontecido. Sem função pra "esvaziar
                        # o carrinho" ainda em rascunho, o servidor limpa
                        # direto — é exatamente isso que o cliente pediu.
                        _salvar_rascunho(id_usuario, _rascunho_vazio())
                        pedido_cancelado_ok = True
                        resultado = {"status": "ok", "carrinho_limpo": True,
                                     "instrucao": "Não havia pedido registrado ainda — o carrinho em andamento foi esvaziado. "
                                                  "Diga que cancelou/limpou o que estava montando, sem afirmar que um pedido "
                                                  "formal foi cancelado."}
                    elif resultado.get("status") != "sem_pedido":
                        marcar_atencao(
                            id_usuario,
                            f"Cliente pediu cancelamento mas o pedido já está '{resultado.get('status_pedido')}' — confirme manualmente.",
                            tipo="pedido_falhou", dados={"resultado": resultado}
                        )
                elif function_name in ("calcular_pedido", "registrar_pedido"):
                    # Removidas na Fase 4 — o pedido vive no rascunho.
                    resultado = {"status": "erro", "motivo": "Essa função não existe mais. Use adicionar_item / definir_entrega / "
                                                              "definir_pagamento / ver_resumo / fechar_pedido."}
                elif function_name in ("consultar_sabor", "listar_cardapio", "listar_bebidas"):
                    content = "O cardápio completo já está no seu prompt (CARDÁPIO DE AGORA). Use os códigos de lá.\n" + cardapio_texto
                else:
                    resultado = {"status": "erro", "motivo": f"Função desconhecida: {function_name}"}
                if function_name == "adicionar_item" and isinstance(resultado, dict) and resultado.get("status") == "ok":
                    item_adicionado_ok = True
                if resultado is not None:
                    content = json.dumps(resultado, ensure_ascii=False, default=str)

                # Registro pro conversas_log (argumentos e resultado crus —
                # é isso que vira caso de teste depois).
                log_ferramentas.append({
                    "nome": function_name,
                    "args": args,
                    "resultado": content[:2000] if isinstance(content, str) else str(content)[:2000]
                })

                messages.append({"tool_call_id": tool_call.id, "role": "tool", "name": function_name, "content": content})

            if falha_sistema_pedido:
                break

        if falha_sistema_pedido:
            # Texto fixo, não vem da IA: garante que o cliente nunca recebe
            # uma "confirmação" pra um pedido que não foi salvo.
            final_text = (
                "Poxa, tive um problema técnico bem na hora de registrar seu "
                "pedido — ele NÃO foi confirmado ainda. Já avisei nossa equipe "
                "aqui, alguém confere e fala com você em instantes. Desculpa o "
                "transtorno!"
            )
        else:
            if final_text is None:
                # Estourou o limite de rodadas ainda pedindo ferramenta
                # (loop de chamadas repetidas) — fecha com uma chamada que
                # só pode responder em texto, e deixa marcado no log.
                log_observacao = "limite_rodadas_ferramenta"
                ck("antes chamada final sem ferramentas")
                ultima = openai.chat.completions.create(
                    model=modelo_usado, messages=messages, tools=tools, tool_choice="none", timeout=60
                )
                ck("depois chamada final sem ferramentas")
                log_chamadas_ia += 1
                _somar_usage(log_usage, ultima)
                final_text = ultima.choices[0].message.content

            # FECHAMENTO DETERMINÍSTICO (Fase 4): o bot mostrou o resumo e
            # perguntou "posso fechar?", o cliente respondeu "sim"/"pode"/
            # "confere", nada faltava e nada mudou desde o resumo — e mesmo
            # assim a IA NÃO chamou fechar_pedido (o gpt-4o-mini mostra o
            # resumo de novo e gasta o "sim" do cliente; 13/19 casos do
            # harness). Nessa situação, e SÓ nela, o servidor fecha. É o
            # oposto da "retentativa forçada" antiga: aqui a confirmação do
            # cliente é explícita e o estado do pedido é conhecido.
            if not pedido_registrado_ok and not falha_sistema_pedido and confirmacao_explicita:
                r_atual = _aplicar_nome_identificado(obter_rascunho(id_usuario), nome_cliente)
                nada_falta = not _faltando(r_atual)
                # O que o cliente confirmou é o que o bot mostrou na resposta
                # anterior; se a IA mudou o rascunho NESTE turno (ex.: readicionou
                # um item), não é mais aquilo — não fecha.
                nada_mudou_no_turno = r_atual.get("atualizado_em") == rascunho_inicio_turno.get("atualizado_em")
                if nada_falta and nada_mudou_no_turno and r_atual.get("itens"):
                    ck("fechamento deterministico: cliente confirmou e IA nao fechou")
                    res_fecha = rascunho_fechar_pedido(id_usuario, bot_cfg, nome_identificado=nome_cliente, confirmacao_explicita=True)
                    log_ferramentas.append({"nome": "fechar_pedido[servidor]", "args": {}, "resultado": json.dumps(res_fecha, ensure_ascii=False, default=str)[:2000]})
                    if res_fecha.get("status") == "ok":
                        pedido_registrado_ok = True
                        limpar_atencao(id_usuario)
                        log_observacao = "fechamento_deterministico"
                        itens_txt = ", ".join(res_fecha.get("itens") or [])
                        total_txt = f"{float(res_fecha.get('valor_total') or 0):.2f}".replace(".", ",")
                        tipo_txt = " para entrega" if res_fecha.get("tipo_entrega") == "ENTREGA" else " para retirada"
                        final_text = f"Pedido registrado{tipo_txt}: {itens_txt} — total R$ {total_txt}. Já vamos providenciar!"

            # Rede de segurança contra alucinação: a IA escreve "Pedido
            # registrado!" sem registrar_pedido ter rodado com sucesso NESTA
            # mensagem. Com o loop acima isso ficou raro (ela agora PODE
            # chamar a função depois de ver o resultado de calcular_pedido),
            # mas a checagem fica: texto seguro + aviso pra equipe. Nunca
            # força registro (ver Fase 0).
            if _soa_como_confirmacao(final_text) and not pedido_registrado_ok:
                log_observacao = "texto_confirmacao_sem_registrar_pedido"
                marcar_atencao(
                    id_usuario,
                    "IA disse que o pedido foi registrado sem ter chamado registrar_pedido — confirme com o cliente manualmente.",
                    tipo="pedido_falhou",
                    dados={"resposta_suspeita": final_text}
                )
                # Caso real de produção: cliente perguntou "quero acompanhar
                # meu pedido" sem nunca ter um pedido registrado —
                # consultar_meu_pedido voltou "sem_pedido", o guard disparou
                # (a IA disse algo com jeito de confirmação) e o fallback
                # genérico de carrinho ("pode confirmar os itens?") repetiu
                # essa MESMA frase 4 vezes seguidas, ignorando que a pergunta
                # do cliente era sobre status, não sobre montar um pedido.
                if consultou_pedido_sem_achar and not obter_rascunho(id_usuario).get("itens"):
                    final_text = ("Não encontrei nenhum pedido seu registrado por aqui. Se quiser, me diga os "
                                  "itens que você gostaria de pedir que eu já vou te ajudando!")
                else:
                    final_text = _texto_seguro_progresso(id_usuario, bot_cfg, nome_cliente=nome_cliente, pergunta_prioritaria=pergunta_variacao)

            # Mesma rede de segurança, pro caso do bairro: verificar_bairro_entrega
            # voltou "não achei na lista" (não "não atende" — a lista não tem
            # esse bairro cadastrado nem pra sim nem pra não), e mesmo assim a
            # IA declarou recusa de entrega pro cliente. Já aconteceu em
            # produção mesmo com a instrução no prompt pra escalar em vez de
            # negar. marcar_atencao (equipe avisada) já rodou lá na chamada da
            # função; aqui só troca o texto que vai pro cliente.
            # Caso real ("Alpinia"): a IA negou entrega sem nem chamar a ferramenta
            # (tratou como "outra cidade") e a equipe depois confirmou que entrega.
            # Só a equipe/lista pode negar: sem "nao_atende_confirmado" nesta
            # rodada, qualquer recusa vira escalação.
            if any(e.get("nome") == "confirmar_bairro_na_cidade[servidor]" and not e["args"].get("dentro_da_cidade")
                   for e in eventos_servidor):
                bairro_negado_confirmado = True   # o próprio cliente disse que é fora da cidade
            pendente_agora = obter_rascunho(id_usuario).get("bairro_pendente")
            if not bairro_negado_confirmado and _soa_como_negativa_entrega(final_text):
                log_observacao = "texto_negou_entrega_sem_confirmar_bairro"
                final_text = (_pergunta_perimetro(pendente_agora, bot_cfg) if pendente_agora else
                              f"Pra eu confirmar a entrega: qual o nome do seu bairro? Ele fica dentro da cidade de "
                              f"{_cidade_principal(bot_cfg)} (perímetro urbano)?")
            elif (bairro_nao_encontrado and pendente_agora
                  and "perimetro urbano" not in _normalizar_termo(final_text)):
                # Bairro acabou de ficar pendente mas a IA não fez a pergunta (ou
                # já "confirmou" a entrega por conta própria): a pergunta é obrigatória.
                log_observacao = "bairro_pendente_sem_pergunta_perimetro"
                final_text = _pergunta_perimetro(pendente_agora, bot_cfg)

            # Mesma rede de segurança pro cancelamento: já aconteceu em produção
            # a IA dizer "pedido cancelado" sem ter chamado cancelar_pedido — o
            # pedido continuou ativo, foi pra cozinha e virou venda de verdade,
            # com cliente E equipe achando que tinha sido cancelado.
            if _soa_como_cancelamento(final_text) and not pedido_cancelado_ok:
                log_observacao = "texto_cancelamento_sem_chamar_cancelar_pedido"
                marcar_atencao(
                    id_usuario,
                    "IA disse que o pedido foi cancelado sem ter chamado cancelar_pedido — o pedido pode continuar ativo, confirme manualmente.",
                    tipo="pedido_falhou",
                    dados={"resposta_suspeita": final_text}
                )
                final_text = (
                    "Só um instante — deixa eu confirmar esse cancelamento certinho com a "
                    "equipe antes de garantir. Alguém já vai confirmar com você."
                )

            # Mesma rede de segurança pra mexer em pedido já fechado: não dá
            # pra saber com certeza, só pelas ferramentas chamadas, se o
            # cliente queria corrigir o pedido antigo ou fazer um novo — mas
            # se o TEXTO afirma ter "corrigido" um pedido ou vai "abrir
            # outro", isso é sempre mentira (fechar_pedido não roda de novo
            # nesse fluxo, e o rascunho novo não é o pedido que o cliente
            # tinha em mente). Caso real de produção: pedido fechado em
            # R$65, cliente pediu pra trocar um item, IA respondeu "Corrigi
            # o pedido... Total: R$66" sem nada disso ter acontecido de
            # verdade.
            if _pedido_recem_fechado(obter_rascunho(id_usuario)) and _soa_como_correcao_pos_fechamento(final_text):
                log_observacao = "texto_correcao_pedido_ja_fechado"
                marcar_atencao(
                    id_usuario,
                    "IA disse ter corrigido/reaberto um pedido já fechado sem função pra isso — confira com o cliente qual pedido ele quer mudar.",
                    tipo="pedido_pos_fechamento",
                    dados={"resposta_suspeita": final_text}
                )
                final_text = (
                    "Seu pedido anterior já está registrado — não dá pra alterar automaticamente por aqui. "
                    "Já chamei a equipe pra confirmar essa mudança direto com você."
                )

            # Rede de segurança pra alucinação de CONTEÚDO do carrinho (não
            # só de status): caso real de produção, cliente pediu 3 itens,
            # só 1 foi realmente adicionado (adicionar_item nunca rodou pros
            # outros dois), mas a IA escreveu um resumo com os 3 itens e um
            # "Total geral" que não existia — o cliente confirmou o
            # fechamento achando que tinha os 3, e o pedido fechou faltando
            # 2 itens de verdade pagos. Só roda se o pedido NÃO fechou
            # nesta mensagem (senão o rascunho já foi resetado e comparar
            # não faz sentido).
            if not pedido_registrado_ok:
                valor_real = _totais_rascunho(obter_rascunho(id_usuario), bot_cfg)[2]
                if not _total_mencionado_bate_com_rascunho(final_text, valor_real):
                    # Sem marcar_atencao: o bot se corrige sozinho com o resumo real
                    # do carrinho (não fica esperando a equipe), então não é pendência.
                    log_observacao = "texto_total_nao_bate_com_carrinho"
                    final_text = _texto_seguro_progresso(id_usuario, bot_cfg, nome_cliente=nome_cliente, pergunta_prioritaria=pergunta_variacao)
                elif ("total" in _normalizar_termo(final_text or "") and "r$" in (final_text or "").lower()
                      and pergunta_variacao is None):
                    # Caso real (28/09): o resumo mostrado tinha coxinha + Coca Zero e
                    # o total certo (R$ 29,50), mas o carrinho tinha também uma Sprite
                    # Zero que a cliente nunca pediu — o item ficou escondido e foi pro
                    # pedido. Resumo com total que omite item do carrinho → resumo real.
                    faltou = [i for i in obter_rascunho(id_usuario).get("itens") or []
                              if not _tipo_do_item_na_mensagem(i, final_text)]
                    if faltou:
                        log_observacao = "resumo_omitiu_item_do_carrinho"
                        final_text = _texto_seguro_progresso(id_usuario, bot_cfg, nome_cliente=nome_cliente)

        # Caso real de produção: a IA escreveu "**Total:**" e
        # "[link](link)" — Markdown padrão, que o WhatsApp não entende.
        # O cliente via os asteriscos duplos e os colchetes/parênteses
        # literais na tela, sem nenhuma formatação de verdade (achou que o
        # link tinha vindo "duplicado"). WhatsApp tem sua própria sintaxe
        # (negrito com UM asterisco), então converte aqui — regra em
        # código, não depende da IA lembrar de nunca usar Markdown.
        if convidar_app_nesta_msg and final_text and not pedido_registrado_ok:
            convite_app = _texto_convite_app(bot_cfg)
            if convite_app and (bot_cfg.get("link_app") or "").strip() not in final_text:
                final_text = final_text + "\n\n" + convite_app

        # Caso real (29/09, duas clientes): mesmo com a instrução, a IA dizia "me envie
        # o comprovante antes de prosseguirmos/para eu fechar" e o pedido nunca era
        # criado. Carrinho completo + texto condicionando o fechamento ao comprovante
        # → troca pelo resumo real + "Posso fechar?" (o comprovante vem depois).
        # Cliente já recebeu antes: se a IA vai pedir bairro/endereço sem oferecer o
        # do último pedido, troca pela pergunta do "mesmo endereço".
        if not pedido_registrado_ok:
            r_end = obter_rascunho(id_usuario)
            t_norm = _normalizar_termo(final_text or "")
            if (r_end.get("endereco_sugerido") and not r_end.get("bairro") and "?" in (final_text or "")
                    and ("bairro" in t_norm or "endereco" in t_norm) and "mesmo endereco" not in t_norm):
                log_observacao = "pergunta_endereco_trocada_por_ultimo_endereco"
                final_text = _pergunta_mesmo_endereco(r_end["endereco_sugerido"])

        if not pedido_registrado_ok and _RE_COMPROVANTE_ANTES_DE_FECHAR.search(_normalizar_termo(final_text or "")):
            r_fim = obter_rascunho(id_usuario)
            if r_fim.get("itens") and not _faltando(r_fim):
                log_observacao = "texto_exigiu_comprovante_antes_de_fechar"
                final_text = _texto_seguro_progresso(id_usuario, bot_cfg, nome_cliente=nome_cliente)
                chave = (bot_cfg.get("chave_pix") or "").strip()
                if r_fim.get("forma_pagamento") == "PIX" and chave:
                    final_text += f"\n\nChave PIX: {chave} — o comprovante você pode mandar depois que eu fechar."

        if pediu_humano and "equipe" not in _normalizar_termo(final_text or ""):
            log_observacao = "pediu_humano_texto_substituido"
            final_text = "Já chamei nossa equipe! Alguém vai te responder aqui mesmo nesta conversa em instantes. 🙂"

        final_text = _converter_markdown_para_whatsapp(final_text)

        ck("antes salvar_historico_firestore final")
        salvar_historico_firestore(wa_id, "user", prompt, bot_cfg.get("max_historico_salvar"))
        salvar_historico_firestore(wa_id, "assistant", final_text, bot_cfg.get("max_historico_salvar"))
        ck("depois salvar_historico_firestore final")
        registrar_log_conversa(
            id_usuario, origem, prompt, final_text, modelo_usado,
            ferramentas=log_ferramentas, usage=log_usage, duracao_s=time.time() - t0,
            chamadas_ia=log_chamadas_ia, observacao=log_observacao
        )
        return final_text

    except Exception as e:
        print(f"Erro OpenAI: {e}")
        texto_erro = bot_cfg.get("mensagem_erro") or BOT_CONFIG_DEFAULTS["mensagem_erro"]
        registrar_log_conversa(
            id_usuario, origem, prompt, texto_erro, modelo_usado,
            ferramentas=log_ferramentas, usage=log_usage, duracao_s=time.time() - t0,
            chamadas_ia=log_chamadas_ia, erro=str(e)[:500], observacao=log_observacao
        )
        return texto_erro

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
        # 'pronto' (padrão, comportamento de sempre) ou 'saiu_entrega' — usado
        # quando o pedido muda pra SAIU_PARA_ENTREGA (inclusive pelo atalho
        # "Despachar", que antes pulava esse status sem avisar o cliente).
        status_evento = data.get('status') or 'pronto'

        if not telefone:
            return jsonify({"erro": "Número de telefone (wa_id) não fornecido"}), 400

        # Montagem da mensagem a partir do template configurado
        bot_cfg = obter_config_bot()
        if status_evento == 'saiu_entrega':
            template = bot_cfg.get("mensagem_saiu_entrega") or BOT_CONFIG_DEFAULTS["mensagem_saiu_entrega"]
        else:
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
        response_wa = requests.post(url, headers=headers, json=payload, timeout=15)
        
        if response_wa.status_code in [200, 201]:
            print(f"✅ WhatsApp enviado para {telefone_limpo}")
            # Sem isso, a mensagem chegava de verdade pro cliente mas nunca
            # aparecia no painel de Atendimento do Bot (que lê
            # historico_conversas) — a equipe achava que não tinha sido
            # enviada e reenviava a mesma coisa na mão pro cliente.
            try:
                salvar_historico_firestore(telefone_limpo, "assistant", mensagem, bot_cfg.get("max_historico_salvar"))
            except Exception as e:
                print(f"⚠️ Aviso enviado mas não salvo no histórico: {e}")
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


_executor_mensagens = concurrent.futures.ThreadPoolExecutor(max_workers=16, thread_name_prefix="msg")


def processar_mensagem_recebida(message, from_number):
    with _lock_do_cliente(from_number):
        # Teto absoluto de tempo pro processamento inteiro (Firestore + OpenAI
        # + envio), não importa ONDE trave. Já vimos em produção uma chamada
        # ao Firestore ficar pendurada por minutos mesmo com timeout=10 no
        # nível da chamada — não deu pra confirmar a causa raiz exata (nem
        # é rede lenta: a mesma consulta rodou em 1s de fora do Cloud Run),
        # então isso aqui é a rede de segurança final: o cliente NUNCA fica
        # sem nenhuma resposta. Roda o trabalho de verdade num executor à
        # parte e só espera até 90s por ele — se estourar, a thread original
        # pode continuar presa em segundo plano (é um vazamento aceitável
        # frente à alternativa de silêncio total), mas o cliente já recebe
        # um aviso na hora. Se o trabalho travado eventualmente terminar
        # sozinho depois, pode gerar uma segunda mensagem duplicada — pior
        # cenário aceitável comparado a nunca responder.
        futuro = _executor_mensagens.submit(_processar_mensagem_recebida, message, from_number)
        try:
            futuro.result(timeout=90)
        except concurrent.futures.TimeoutError:
            print(f"⏱️ Timeout absoluto (90s) processando mensagem de {from_number} — avisando o cliente e seguindo em frente.")
            send_message(from_number, "Desculpe, tive um problema técnico bem na hora de te responder. Pode mandar sua mensagem de novo, por favor?")
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
                # Antes: mandava sempre "Recebi seu comprovante! Vou registrar aqui."
                # e descartava a resposta real de registrar_comprovante (pedido fechado
                # agora, PIX do app já confirmado, anexado ao pedido...).
                resposta = registrar_comprovante(from_number, url_publica)
                send_message(from_number, resposta)
                salvar_historico_firestore(from_number, "user", "[cliente enviou imagem/comprovante]")
                salvar_historico_firestore(from_number, "assistant", resposta)
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
    limpar_atencao(wa_id)  # equipe respondeu: pendência resolvida
    if assumir_manual:
        db.collection("historico_conversas").document(wa_id).set({"modo_manual": True}, merge=True)
    return jsonify({"ok": True}), 200

