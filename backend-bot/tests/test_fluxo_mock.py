# -*- coding: utf-8 -*-
"""Teste de fluxo SEM rede: Firestore em memória (mock-firestore) e uma
OpenAI de mentira que segue um roteiro fixo de tool calls. Não testa a
inteligência do modelo — testa o encanamento: rota /chat_app → ferramentas
→ Firestore → asserções do harness. Serve pra pegar regressão de código
(um campo renomeado, uma exceção nova) sem gastar token nem subir emulador.

    pip install mock-firestore
    cd backend-bot
    python -m pytest tests/test_fluxo_mock.py -q
"""
import json
import os
import sys
import types
from unittest import mock

import pytest

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, RAIZ)
sys.path.insert(0, os.path.join(RAIZ, "tests"))

pytest.importorskip("mockfirestore")

from firestore_memoria import FirestoreMemoria, importar_app_sem_firebase  # noqa: E402
import harness_avaliar  # noqa: E402  (a função 'avaliar' isolada do harness)
import seed_emulador     # noqa: E402

bot = importar_app_sem_firebase(RAIZ)


# ---------- OpenAI de mentira: roteiro por última mensagem do cliente ----------
class _Msg:
    def __init__(self, content=None, tool_calls=None):
        self.content, self.tool_calls, self.role = content, tool_calls, "assistant"


def _tc(nome, args):
    return types.SimpleNamespace(id="call_1", function=types.SimpleNamespace(name=nome, arguments=json.dumps(args)))


class _Resp:
    def __init__(self, msg):
        self.choices = [types.SimpleNamespace(message=msg)]
        self.usage = types.SimpleNamespace(prompt_tokens=100, completion_tokens=20)


def _fake_openai_factory(roteiro):
    """roteiro: {ultima_msg_cliente: passos}, onde passos é
       - (tool, texto)            → 1 tool call, depois o texto (forma curta), ou
       - [tool1, tool2, ..., texto] → tool calls encadeadas numa mesma mensagem
         do cliente (cada rodada do loop consome um passo), fechando com texto.
    O passo é escolhido pelo número de resultados de ferramenta já presentes
    desde a última mensagem do cliente. tool_choice="none" sempre devolve texto."""
    def create(model, messages, tools=None, tool_choice=None, timeout=None):
        idx_user = max(i for i, m in enumerate(messages) if isinstance(m, dict) and m.get("role") == "user")
        ultima = messages[idx_user]["content"]
        feitos = sum(1 for m in messages[idx_user:] if isinstance(m, dict) and m.get("role") == "tool")
        passos = roteiro.get(ultima, [f"[eco] {ultima}"])
        if isinstance(passos, tuple):
            passos = [passos[0], passos[1]] if passos[0] else [passos[1]]
        passo = passos[min(feitos, len(passos) - 1)]
        if isinstance(passo, tuple) and tools is not None and tool_choice != "none":
            return _Resp(_Msg(tool_calls=[_tc(*passo)]))
        texto = passo if isinstance(passo, str) else "[texto forçado]"
        return _Resp(_Msg(content=texto))
    return types.SimpleNamespace(chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create)))


@pytest.fixture
def ambiente(monkeypatch):
    db = FirestoreMemoria()
    monkeypatch.setattr(bot, "db", db)
    seed_emulador.semear(db, limpar=False)
    bot.carregar_cardapio(forcar=True)
    return db


def _codigo(nome):
    """Código curto do item no cardápio em memória (como a IA leria no prompt)."""
    for it in bot.carregar_cardapio(forcar=True):
        if it.get("nome") == nome:
            return it["codigo"]
    raise KeyError(nome)


def _log_da_mensagem(db, mensagem):
    """Entrada de conversas_log de uma mensagem específica (a ordem do
    stream em memória não é garantida — não use [-1])."""
    return next(l.to_dict() for l in db.collection("conversas_log").stream()
                if l.to_dict().get("mensagem_cliente") == mensagem)


def _conversar(tel, msgs):
    c = bot.app.test_client()
    return [(c.post("/chat_app", json={"usuario_id": tel, "mensagem": m}).get_json() or {}).get("resposta") or "" for m in msgs]


def _pedidos(db, tel):
    return [d.to_dict() for d in db.collection("pedidos").where("telefone_cliente", "==", tel).stream()]


def test_fluxo_retirada_completo(ambiente, monkeypatch):
    """Caminho feliz com as ferramentas do rascunho: cada passo grava no
    servidor; fechar_pedido não recebe nada e cria 1 pedido com a conta certa."""
    pc = _codigo("pastel de carne")
    roteiro = {
        "quero 2 pastel de carne": (("adicionar_item", {"item_id": pc, "quantidade": 2}), "Anotei 2 pastéis de carne. Mais alguma coisa?"),
        "retirada": (("definir_entrega", {"tipo": "RETIRADA"}), "Retirada. Como vai pagar?"),
        "dinheiro": (("definir_pagamento", {"forma": "dinheiro"}), "Qual seu nome?"),
        "Murilo": [("definir_nome", {"nome": "Murilo"}), ("ver_resumo", {}), "2x Pastel de Carne, total R$ 16,00. Posso fechar?"],
        "sim": (("fechar_pedido", {}), "Pedido registrado! Total R$ 16,00."),
    }
    monkeypatch.setattr(bot, "openai", _fake_openai_factory(roteiro))
    tel = "5535999000001"
    respostas = _conversar(tel, ["oi", "quero 2 pastel de carne", "retirada", "dinheiro", "Murilo", "sim"])
    pedidos = _pedidos(ambiente, tel)
    assert harness_avaliar.avaliar({"pedidos": 1, "tipo_entrega": "RETIRADA", "valor_total": 16.0,
                                    "itens_contem": ["Pastel de Carne"], "quantidade": {"Pastel de Carne": 2},
                                    "nome_cliente_valido": True}, pedidos, respostas) == []
    p = pedidos[0]
    assert p["valor_itens"] == 16.0 and p["taxa_entrega"] == 0 and p["itens"][0]["id"]
    assert "Pedido registrado" in respostas[-1]                      # texto da IA mantido: fechou de verdade
    assert bot.obter_rascunho(tel)["itens"] == []                    # rascunho zerado depois de fechar


def test_confirmacao_dupla_nao_duplica(ambiente, monkeypatch):
    """'pode sim' + 'confirma': a 2ª chamada de fechar_pedido devolve o MESMO
    pedido (ja_estava_fechado), não cria outro — vale pra entrega com taxa."""
    cx = _codigo("coxinha de frango")
    roteiro = {
        "1 coxinha": (("adicionar_item", {"item_id": cx, "quantidade": 1}), "ok"),
        "entrega centro rua das flores 123": (("definir_entrega", {"tipo": "ENTREGA", "bairro": "Centro", "endereco": "Rua das Flores, 123"}), "ok"),
        "dinheiro": [("definir_pagamento", {"forma": "dinheiro"}), ("definir_nome", {"nome": "Murilo"}), ("ver_resumo", {}), "Total R$ 11,50. Fecha?"],
        "pode sim": (("fechar_pedido", {}), "Pedido registrado!"),
        "confirma": (("fechar_pedido", {}), "Já está registrado!"),
    }
    monkeypatch.setattr(bot, "openai", _fake_openai_factory(roteiro))
    tel = "5535999000002"
    _conversar(tel, ["oi", "1 coxinha", "entrega centro rua das flores 123", "dinheiro", "pode sim", "confirma"])
    pedidos = _pedidos(ambiente, tel)
    assert len(pedidos) == 1
    assert pedidos[0]["valor_total"] == 11.5 and pedidos[0]["valor_itens"] == 6.5 and pedidos[0]["bairro"] == "Centro"
    log = _log_da_mensagem(ambiente, "confirma")
    assert '"ja_estava_fechado": true' in log["ferramentas"][0]["resultado"]


def test_fechar_sem_ver_resumo_e_recusado(ambiente, monkeypatch):
    """A regra 'mostre o resumo antes de fechar' agora é código: fechar sem
    ver_resumo devolve erro e nenhum pedido é criado; a IA que disser
    'registrado' mesmo assim cai na pergunta segura."""
    cx = _codigo("coxinha de frango")
    roteiro = {
        "1 coxinha retirada pix murilo": [("adicionar_item", {"item_id": cx, "quantidade": 1}), ("definir_entrega", {"tipo": "RETIRADA"}),
                                          ("definir_pagamento", {"forma": "pix"}), ("definir_nome", {"nome": "Murilo"}), "ok"],
        "fecha": (("fechar_pedido", {}), "Pedido registrado! Já vamos providenciar."),
    }
    monkeypatch.setattr(bot, "openai", _fake_openai_factory(roteiro))
    tel = "5535999000003"
    respostas = _conversar(tel, ["oi", "1 coxinha retirada pix murilo", "fecha"])
    assert _pedidos(ambiente, tel) == []
    log = _log_da_mensagem(ambiente, "fecha")
    assert '"status": "precisa_confirmar"' in log["ferramentas"][0]["resultado"]
    assert "confirmar certinho" in respostas[-1]


def test_entrega_sem_numero_nao_fecha(ambiente, monkeypatch):
    """Endereço só com bairro: definir_entrega não aceita e fechar_pedido recusa."""
    cx = _codigo("coxinha de frango")
    roteiro = {
        "x": [("adicionar_item", {"item_id": cx, "quantidade": 1}),
              ("definir_entrega", {"tipo": "ENTREGA", "bairro": "Centro", "endereco": "no centro mesmo"}),
              ("definir_pagamento", {"forma": "dinheiro"}), ("definir_nome", {"nome": "Murilo"}),
              ("ver_resumo", {}), ("fechar_pedido", {}), "Qual o endereço com número?"],
    }
    monkeypatch.setattr(bot, "openai", _fake_openai_factory(roteiro))
    tel = "5535999000004"
    _conversar(tel, ["oi", "x"])
    assert _pedidos(ambiente, tel) == []
    r = bot.obter_rascunho(tel)
    assert r["endereco"] is None and r["bairro"] == "Centro" and "endereco_com_numero" in bot._faltando(r)


def test_carrinho_sobrevive_sem_historico(ambiente, monkeypatch):
    """O carrinho está no servidor: mesmo com histórico de contexto de 2
    mensagens, o pedido fecha com os 3 itens — a IA não precisa lembrar."""
    ambiente.collection("configuracoes").document("bot").update({"max_historico_contexto": 2})
    cx, gu, pq = _codigo("coxinha de frango"), _codigo("guarana lata"), _codigo("pastel de queijo")
    roteiro = {
        "2 coxinha": (("adicionar_item", {"item_id": cx, "quantidade": 2}), "ok"),
        "1 guarana": (("adicionar_item", {"item_id": gu, "quantidade": 1}), "ok"),
        "1 pastel de queijo": (("adicionar_item", {"item_id": pq, "quantidade": 1}), "ok"),
        "tira 1 coxinha": (("remover_item", {"item_id": cx, "quantidade": 1}), "ok"),
        "retirada dinheiro murilo": [("definir_entrega", {"tipo": "RETIRADA"}), ("definir_pagamento", {"forma": "dinheiro"}),
                                     ("definir_nome", {"nome": "Murilo"}), ("ver_resumo", {}), "resumo"],
        "sim": (("fechar_pedido", {}), "Pedido registrado!"),
    }
    monkeypatch.setattr(bot, "openai", _fake_openai_factory(roteiro))
    tel = "5535999000005"
    _conversar(tel, ["oi", "2 coxinha", "1 guarana", "1 pastel de queijo", "tira 1 coxinha", "retirada dinheiro murilo", "sim"])
    p = _pedidos(ambiente, tel)[0]
    nomes = {i["nome_exibicao"]: i["quantidade"] for i in p["itens"]}
    assert nomes == {"Coxinha de Frango": 1, "Guaraná Lata": 1, "Pastel de Queijo": 1}
    assert p["valor_total"] == 6.5 + 5.0 + 8.0


def test_prompt_traz_estado_do_rascunho(ambiente, monkeypatch):
    capturado = {}
    def create(model, messages, tools=None, tool_choice=None, timeout=None):
        capturado["system"] = messages[0]["content"]
        return _Resp(_Msg(content="ok"))
    monkeypatch.setattr(bot, "openai", types.SimpleNamespace(chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create))))
    tel = "5535999000006"
    bot.rascunho_adicionar_item(tel, _codigo("coxinha de frango"), 3, bot.obter_config_bot())
    _conversar(tel, ["oi", "e aí"])
    sp = capturado["system"]
    assert "PEDIDO EM ANDAMENTO (do servidor" in sp and "3x Coxinha de Frango" in sp and "TOTAL R$ 19.50" in sp
    assert "falta para fechar: tipo_entrega, forma_pagamento" in sp
    assert "adicionar_item" in sp and "calcular_pedido" not in sp


# ---------- Fase 4: unidade das validações do rascunho ----------
def test_rascunho_validacoes(ambiente):
    cfg = bot.obter_config_bot()
    tel = "5535999000007"
    assert bot.rascunho_adicionar_item(tel, "zzzz", 1, cfg)["status"] == "erro"                 # código inválido
    assert "ESGOTADO" in bot.rascunho_adicionar_item(tel, _codigo("kibe"), 1, cfg)["motivo"]    # esgotado
    assert bot.rascunho_adicionar_item(tel, _codigo("bolinho de bacalhau"), 1, cfg)["status"] == "erro"  # só balcão
    r = bot.rascunho_adicionar_item(tel, _codigo("coxinha de frango"), 2, cfg)
    assert r["status"] == "ok" and r["valor_total"] == 13.0 and r["falta_para_fechar"] == ["tipo_entrega", "forma_pagamento"]
    assert r["nome_pendente"] is True
    r = bot.rascunho_adicionar_item(tel, _codigo("coxinha de frango"), 1, cfg)                    # soma no mesmo item
    assert r["itens"][0]["quantidade"] == 3 and r["valor_total"] == 19.5
    assert bot.rascunho_definir_pagamento(tel, "cheque", cfg)["status"] == "erro"
    assert bot.rascunho_definir_pagamento(tel, "no pix", cfg)["chave_pix"] == "pix-teste@lileamar.com.br"
    assert bot.rascunho_definir_pagamento(tel, "cartão de crédito", cfg)["forma_pagamento"] == "CARTÃO"
    r = bot.rascunho_definir_entrega(tel, "ENTREGA", "Passos", None, cfg)
    assert r["bairro"] is None and r["avisos"]
    r = bot.rascunho_definir_entrega(tel, "ENTREGA", "são genaro", "Av. Brasil, 45", cfg)
    assert r["bairro"] == "San Genaro" and r["taxa_entrega"] == 5.0 and r["valor_total"] == 24.5
    assert bot.rascunho_fechar_pedido(tel, cfg, nome_identificado="Cadastro")["status"] == "precisa_confirmar"
    bot.rascunho_ver_resumo(tel, cfg, nome_identificado="Cadastro")
    ok = bot.rascunho_fechar_pedido(tel, cfg, nome_identificado="Cadastro")
    assert ok["status"] == "ok" and ok["valor_total"] == 24.5
    p = _pedidos(ambiente, tel)[0]
    assert p["nome_cliente"] == "Cadastro" and p["tipo_entrega"] == "ENTREGA" and p["endereco"] == "Av. Brasil, 45"
    # pedido novo depois de fechado começa do zero
    r = bot.rascunho_adicionar_item(tel, _codigo("guarana lata"), 1, cfg)
    assert [i["nome"] for i in r["itens"]] == ["Guaraná Lata"] and r["tipo_entrega"] is None


def test_fecha_sem_nome_como_cliente(ambiente):
    """Nome não bloqueia: sem definir_nome e sem cadastro, o pedido sai como 'Cliente' (nunca None)."""
    cfg = bot.obter_config_bot()
    tel = "5535999000009"
    bot.rascunho_adicionar_item(tel, _codigo("coxinha de frango"), 1, cfg)
    bot.rascunho_definir_entrega(tel, "RETIRADA", None, None, cfg)
    bot.rascunho_definir_pagamento(tel, "dinheiro", cfg)
    bot.rascunho_ver_resumo(tel, cfg)
    assert bot.rascunho_fechar_pedido(tel, cfg)["status"] == "ok"
    assert _pedidos(ambiente, tel)[0]["nome_cliente"] == "Cliente"


def test_limite_de_rodadas_fecha_com_texto(ambiente, monkeypatch):
    roteiro = {"lista de novo": [("detalhar_item", {"item_id": "xxxx"})] * 20 + ["fim"]}
    monkeypatch.setattr(bot, "openai", _fake_openai_factory(roteiro))
    tel = "5535999000008"
    respostas = _conversar(tel, ["oi", "lista de novo"])
    log = _log_da_mensagem(ambiente, "lista de novo")
    assert len(log["ferramentas"]) == 5 and log["chamadas_ia"] == 6 and log["observacao"] == "limite_rodadas_ferramenta"
    assert respostas[-1] == "[texto forçado]"


# ---------- Fase 3: cardápio com código no prompt ----------
def test_prompt_contem_cardapio_com_codigos(ambiente, monkeypatch):
    """O system prompt leva o cardápio com códigos; itens só-balcão ficam de
    fora; esgotado vem marcado; ingredientes NÃO vão (custo)."""
    capturado = {}
    def create(model, messages, tools=None, tool_choice=None, timeout=None):
        capturado["system"] = messages[0]["content"]
        capturado["tools"] = [t["function"]["name"] for t in tools]
        return _Resp(_Msg(content="ok"))
    monkeypatch.setattr(bot, "openai", types.SimpleNamespace(chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create))))
    _conversar("5535999000010", ["oi", "tem o que?"])
    sp = capturado["system"]
    assert "CARDÁPIO DE AGORA" in sp
    assert f"[{_codigo('pastel de carne')}] Pastel de Carne — R$ 8,00" in sp
    assert "Kibe — R$ 6,50 (ESGOTADO hoje)" in sp
    assert "Bacalhau" not in sp                    # disponivel_online=False
    assert "Carne moída" not in sp                # ingredientes fora do prompt
    assert "listar_cardapio" not in capturado["tools"] and "consultar_sabor" not in capturado["tools"]
    assert "detalhar_item" in capturado["tools"]
    # Tamanho (16 itens): original ~19,5k chars; Fase 3 ~16,8k (regra 0 e
    # seção 2 encolheram, cardápio entrou). As seções 3-5 (~9k) saem na
    # Fase 4. Trava de regressão: não deixar voltar a crescer.
    assert len(sp) < 17500, len(sp)


def test_item_id_resolve_por_codigo_ou_id_completo(ambiente):
    card = bot.carregar_cardapio(forcar=True)
    it = next(i for i in card if i["nome"] == "coca cola zero lata 350ml")
    assert bot._resolver_item(it["codigo"], card)["id"] == it["id"]
    assert bot._resolver_item(it["id"], card)["id"] == it["id"]
    assert bot._resolver_item(it["id"][:10], card)["id"] == it["id"]   # prefixo mais longo
    assert bot._resolver_item("zzzz", card) is None
    assert bot._resolver_item("", card) is None


def test_codigo_invalido_vira_nao_reconhecido_nunca_parecido(ambiente):
    r = bot._montar_itens_pedido([{"item_id": "naoexiste", "quantidade": 2}], "RETIRADA")
    assert r["lista_itens_tsx"] == [] and r["itens_nao_reconhecidos"] == ["naoexiste"]
    assert r["itens_confianca_baixa"] == []


def test_esgotado_e_so_balcao_recusados_por_id(ambiente):
    r = bot._montar_itens_pedido([{"item_id": _codigo("kibe"), "quantidade": 1},
                                  {"item_id": _codigo("bolinho de bacalhau"), "quantidade": 1},
                                  {"item_id": _codigo("coxinha de frango"), "quantidade": 3}], "RETIRADA")
    assert [i["nome"] for i in r["lista_itens_tsx"]] == ["3x coxinha de frango"]
    assert sorted(r["itens_indisponiveis"]) == ["bolinho de bacalhau", "kibe"]
    assert r["valor_total"] == 19.5


def test_detalhar_item(ambiente):
    d = bot.detalhar_item(_codigo("pastel de carne"))
    assert d["status"] == "ok" and d["ingredientes"] == "Carne moída temperada" and d["preco"] == 8.0
    assert bot.detalhar_item(_codigo("bolinho de bacalhau"))["status"] == "nao_encontrado"
    assert bot.detalhar_item("zzzz")["status"] == "nao_encontrado"


def test_caminho_legado_nome_produto_usa_apelido(ambiente):
    """Sem item_id (compatibilidade), o apelido ensinado resolve antes do fuzzy:
    'enroladinho de salsicha' → Salsicha, nunca 'presunto e queijo'."""
    r = bot._montar_itens_pedido([{"nome_produto": "enroladinho de salsicha", "quantidade": 1}], "RETIRADA")
    assert [i["nome"] for i in r["lista_itens_tsx"]] == ["salsicha"]
    assert r["itens_confianca_baixa"] == []


def test_prompt_mostra_apelido_ao_lado_do_item(ambiente, monkeypatch):
    capturado = {}
    def create(model, messages, tools=None, tool_choice=None, timeout=None):
        capturado["system"] = messages[0]["content"]
        return _Resp(_Msg(content="ok"))
    monkeypatch.setattr(bot, "openai", types.SimpleNamespace(chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create))))
    _conversar("5535999000011", ["oi", "x"])
    sp = capturado["system"]
    assert "Enroladinho de Salsicha" not in sp
    linha = next(l for l in sp.splitlines() if "] Salsicha —" in l)
    assert "enroladinho de salsicha" in linha and "o cliente também chama de" in linha


def test_reconfirmar_pagamento_nao_invalida_resumo(ambiente):
    """gpt-4o-mini chama definir_pagamento de novo no turno do 'sim'. Mesmo
    valor = nada mudou = fechar_pedido continua aceitando."""
    cfg = bot.obter_config_bot()
    tel = "5535999000010"
    bot.rascunho_adicionar_item(tel, _codigo("coxinha de frango"), 1, cfg)
    bot.rascunho_definir_entrega(tel, "RETIRADA", None, None, cfg)
    bot.rascunho_definir_pagamento(tel, "dinheiro", cfg)
    bot.rascunho_ver_resumo(tel, cfg)
    bot.rascunho_definir_pagamento(tel, "dinheiro", cfg)          # reconfirmação
    bot.rascunho_definir_entrega(tel, "RETIRADA", None, None, cfg)  # reconfirmação
    assert bot.rascunho_fechar_pedido(tel, cfg)["status"] == "ok"
    # mas uma mudança REAL depois do resumo ainda bloqueia
    tel2 = "5535999000011"
    bot.rascunho_adicionar_item(tel2, _codigo("coxinha de frango"), 1, cfg)
    bot.rascunho_definir_entrega(tel2, "RETIRADA", None, None, cfg)
    bot.rascunho_definir_pagamento(tel2, "dinheiro", cfg)
    bot.rascunho_ver_resumo(tel2, cfg)
    bot.rascunho_definir_pagamento(tel2, "pix", cfg)
    assert bot.rascunho_fechar_pedido(tel2, cfg)["status"] == "precisa_confirmar"   # 1ª chamada vira "resumo visto"
    assert bot.rascunho_fechar_pedido(tel2, cfg)["status"] == "ok"                  # 2ª fecha


def test_fechamento_deterministico_quando_ia_nao_fecha(ambiente, monkeypatch):
    """Resumo mostrado + 'posso fechar?' + cliente 'sim' + IA só repete o resumo
    → o servidor fecha e responde com o total. Sem confirmação explícita
    (mensagem diferente) NÃO fecha."""
    cx = _codigo("coxinha de frango")
    roteiro = {
        "1 coxinha retirada dinheiro": [("adicionar_item", {"item_id": cx, "quantidade": 1}), ("definir_entrega", {"tipo": "RETIRADA"}),
                                        ("definir_pagamento", {"forma": "dinheiro"}), ("ver_resumo", {}),
                                        "1x Coxinha, total R$ 6,50, retirada, dinheiro. Confere? Posso fechar o pedido?"],
        "sim": [("definir_pagamento", {"forma": "dinheiro"}), ("ver_resumo", {}), "Aqui está o resumo de novo... Posso fechar?"],
    }
    monkeypatch.setattr(bot, "openai", _fake_openai_factory(roteiro))
    tel = "5535999000012"
    respostas = _conversar(tel, ["oi", "1 coxinha retirada dinheiro", "sim"])
    pedidos = _pedidos(ambiente, tel)
    assert len(pedidos) == 1 and pedidos[0]["valor_total"] == 6.5
    assert respostas[-1].startswith("Pedido registrado para retirada")
    log = _log_da_mensagem(ambiente, "sim")
    assert log["observacao"] == "fechamento_deterministico"
    assert any(f["nome"] == "fechar_pedido[servidor]" for f in log["ferramentas"])

    # controle: 'sim' respondendo a OUTRA pergunta (bot não perguntou se pode fechar) não fecha
    roteiro2 = {
        "1 coxinha": [("adicionar_item", {"item_id": cx, "quantidade": 1}), "Adicionei. Quer uma bebida também?"],
        "sim": ["Qual bebida?"],
    }
    monkeypatch.setattr(bot, "openai", _fake_openai_factory(roteiro2))
    tel2 = "5535999000013"
    _conversar(tel2, ["oi", "1 coxinha", "sim"])
    assert _pedidos(ambiente, tel2) == []


def test_slots_obvios_pelo_servidor(ambiente, monkeypatch):
    """'retirada' e 'dinheiro' viram estado ANTES da IA, mesmo que ela não
    chame definir_*; e o prompt avisa a IA do que o servidor já registrou."""
    capturado = {}
    def create(model, messages, tools=None, tool_choice=None, timeout=None):
        capturado["system"] = messages[0]["content"]
        return _Resp(_Msg(content="Certo! Como vai pagar?"))
    monkeypatch.setattr(bot, "openai", types.SimpleNamespace(chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create))))
    cfg = bot.obter_config_bot()
    tel = "5535999000014"
    bot.rascunho_adicionar_item(tel, _codigo("coxinha de frango"), 1, cfg)
    _conversar(tel, ["oi", "retirada"])
    assert bot.obter_rascunho(tel)["tipo_entrega"] == "RETIRADA"
    assert "o servidor acabou de registrar" in capturado["system"] and "definir_entrega" in capturado["system"]
    _conversar(tel, ["no pix"])
    r = bot.obter_rascunho(tel)
    assert r["forma_pagamento"] == "PIX"
    log = _log_da_mensagem(ambiente, "no pix")
    assert log["ferramentas"][0]["nome"] == "definir_pagamento[servidor]"
    # carrinho vazio: não age
    tel2 = "5535999000015"
    _conversar(tel2, ["oi", "retirada"])
    assert bot.obter_rascunho(tel2)["tipo_entrega"] is None


def test_heuristica_nao_come_turno_legitimo():
    assert not bot._soa_como_confirmacao("A retirada está confirmada! Agora, qual será a forma de pagamento?")
    assert not bot._soa_como_confirmacao("Pagamento confirmado como PIX. A chave é x@y. Envie o comprovante do seu pedido.")
    assert bot._soa_como_confirmacao("Seu pedido foi fechado com sucesso, Murilo! 🎉")
    assert bot._soa_como_confirmacao("Pedido confirmado. Já vamos preparar.")


def test_confirmacao_explicita_fecha_mesmo_sem_ver_resumo(ambiente, monkeypatch):
    """Bot mostrou o resumo em TEXTO (sem ver_resumo) e perguntou 'posso fechar?';
    cliente 'sim'; IA chama fechar_pedido → fecha na hora (gate dispensada)."""
    cx = _codigo("coxinha de frango")
    roteiro = {
        "1 coxinha retirada dinheiro": [("adicionar_item", {"item_id": cx, "quantidade": 1}), ("definir_entrega", {"tipo": "RETIRADA"}),
                                        ("definir_pagamento", {"forma": "dinheiro"}),
                                        "Seu pedido: 1x Coxinha, R$ 6,50, retirada, dinheiro. Confere? Posso fechar?"],
        "sim": (("fechar_pedido", {}), "Pedido registrado! Total R$ 6,50."),
    }
    monkeypatch.setattr(bot, "openai", _fake_openai_factory(roteiro))
    tel = "5535999000016"
    respostas = _conversar(tel, ["oi", "1 coxinha retirada dinheiro", "sim"])
    assert len(_pedidos(ambiente, tel)) == 1
    assert respostas[-1] == "Pedido registrado! Total R$ 6,50."


def test_pagamento_inventado_pela_ia_e_recusado(ambiente, monkeypatch):
    """A IA chama definir_pagamento('DINHEIRO') sem o cliente ter dito nada →
    erro (pergunte). Depois o cliente diz 'pix' → aceito. (harness run 4:
    resumo saía com pagamento inventado e o pedido não fechava.)"""
    cx = _codigo("coxinha de frango")
    roteiro = {
        "1 coxinha pra retirar": [("adicionar_item", {"item_id": cx, "quantidade": 1}), ("definir_entrega", {"tipo": "RETIRADA"}),
                                  ("definir_pagamento", {"forma": "DINHEIRO"}), "Como vai pagar: PIX, cartão ou dinheiro?"],
        "vou pagar no pix": (("definir_pagamento", {"forma": "PIX"}), "Chave PIX enviada."),
    }
    monkeypatch.setattr(bot, "openai", _fake_openai_factory(roteiro))
    tel = "5535999000017"
    _conversar(tel, ["oi", "1 coxinha pra retirar"])
    assert bot.obter_rascunho(tel)["forma_pagamento"] is None
    log = _log_da_mensagem(ambiente, "1 coxinha pra retirar")
    pag = next(f for f in log["ferramentas"] if f["nome"] == "definir_pagamento")
    assert json.loads(pag["resultado"])["status"] == "erro"
    _conversar(tel, ["vou pagar no pix"])
    assert bot.obter_rascunho(tel)["forma_pagamento"] == "PIX"


def test_pergunta_de_fechamento_com_radical_vale_como_pedido_de_confirmacao():
    assert bot._ultima_resposta_pediu_confirmacao([{"role": "assistant", "content": "Posso seguir com o fechamento do seu pedido?"}])
    assert bot._ultima_resposta_pediu_confirmacao([{"role": "assistant", "content": "Confere? Posso fechar?"}])
    assert not bot._ultima_resposta_pediu_confirmacao([{"role": "assistant", "content": "Posso te ajudar com mais alguma coisa?"}])
    assert not bot._ultima_resposta_pediu_confirmacao([{"role": "assistant", "content": "Pedido fechado com sucesso!"}])


def test_prompt_lista_bairros_atendidos(ambiente, monkeypatch):
    capturado = {}
    def create(model, messages, tools=None, tool_choice=None, timeout=None):
        capturado["system"] = messages[0]["content"]
        return _Resp(_Msg(content="ok"))
    monkeypatch.setattr(bot, "openai", types.SimpleNamespace(chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create))))
    _conversar("5535999000018", ["oi", "entregam no são genaro?"])
    assert "BAIRROS ONDE ENTREGAMOS" in capturado["system"]
    assert "San Genaro" in capturado["system"] and "Lagoinha" in capturado["system"]


def test_endereco_preenchido_pelo_servidor(ambiente, monkeypatch):
    """Entrega + bairro definidos, bot pediu rua e número, cliente manda
    'Av. Brasil, 45' e a IA NÃO chama definir_entrega → o servidor grava o
    endereço. Mensagem que cita item do cardápio não é tratada como endereço."""
    monkeypatch.setattr(bot, "openai", _fake_openai_factory({}))   # IA só ecoa, nunca chama função
    cfg = bot.obter_config_bot()
    tel = "5535999000019"
    bot.rascunho_adicionar_item(tel, _codigo("esfirra de carne"), 1, cfg)
    bot.rascunho_definir_entrega(tel, "ENTREGA", "San Genaro", None, cfg)
    _conversar(tel, ["oi", "2 coxinha de frango"])          # cita item → não vira endereço
    assert bot.obter_rascunho(tel)["endereco"] is None
    _conversar(tel, ["Av. Brasil, 45"])
    r = bot.obter_rascunho(tel)
    assert r["endereco"] == "Av. Brasil, 45" and r["bairro"] == "San Genaro"
    assert _log_da_mensagem(ambiente, "Av. Brasil, 45")["ferramentas"][0]["nome"] == "definir_entrega[servidor]"
    assert "endereco_com_numero" not in bot._faltando(r)
    # já tem endereço: outra mensagem com número não sobrescreve
    _conversar(tel, ["troco pra 50"])
    assert bot.obter_rascunho(tel)["endereco"] == "Av. Brasil, 45"


def test_ia_nao_readiciona_item_quando_cliente_pede_outro(ambiente, monkeypatch):
    """'1 guaraná lata' → IA chama adicionar_item das 2 coxinhas de novo E do
    guaraná. Servidor ignora a repetição (coxinha não foi citada) e soma só o guaraná."""
    cx, gu = _codigo("coxinha de frango"), _codigo("guarana lata")
    roteiro = {
        "quero 2 coxinha de frango": (("adicionar_item", {"item_id": cx, "quantidade": 2}), "2 coxinhas. Mais algo?"),
        "1 guaraná lata": [("adicionar_item", {"item_id": cx, "quantidade": 2}), ("adicionar_item", {"item_id": gu, "quantidade": 1}), "ok"],
        "mais 2 dessas": (("adicionar_item", {"item_id": cx, "quantidade": 2}), "ok"),
    }
    monkeypatch.setattr(bot, "openai", _fake_openai_factory(roteiro))
    tel = "5535999000020"
    _conversar(tel, ["oi", "quero 2 coxinha de frango", "1 guaraná lata"])
    itens = {i["id"]: i["quantidade"] for i in bot.obter_rascunho(tel)["itens"]}
    assert itens == {bot._resolver_item(cx, bot.carregar_cardapio())["id"]: 2, bot._resolver_item(gu, bot.carregar_cardapio())["id"]: 1}
    _conversar(tel, ["mais 2 dessas"])          # sem citar outro item: soma normalmente
    assert {i["quantidade"] for i in bot.obter_rascunho(tel)["itens"]} == {4, 1}


def test_ia_remonta_pedido_igual_depois_de_fechado_nao_duplica(ambiente, monkeypatch):
    """'pode sim' fechou (servidor). 'confirma' → IA remonta o carrinho igual
    (adicionar_item + definir_* + fechar_pedido) → ja_estava_fechado, 1 pedido só.
    Pedido DIFERENTE depois do fechamento continua virando pedido novo."""
    cx = _codigo("coxinha de frango")
    roteiro = {
        "1 coxinha retirada dinheiro": [("adicionar_item", {"item_id": cx, "quantidade": 1}), ("definir_entrega", {"tipo": "RETIRADA"}),
                                        ("definir_pagamento", {"forma": "dinheiro"}), ("ver_resumo", {}),
                                        "1x Coxinha, R$ 6,50, retirada, dinheiro. Confere? Posso fechar?"],
        "sim": (("fechar_pedido", {}), "Pedido registrado!"),
        "confirma": [("adicionar_item", {"item_id": cx, "quantidade": 1}), ("definir_entrega", {"tipo": "RETIRADA"}),
                     ("definir_pagamento", {"forma": "dinheiro"}), ("fechar_pedido", {}), "Já está registrado!"],
        "quero mais 2 coxinha": [("adicionar_item", {"item_id": cx, "quantidade": 2}), ("definir_entrega", {"tipo": "RETIRADA"}),
                                 ("definir_pagamento", {"forma": "dinheiro"}), ("ver_resumo", {}), "2x Coxinha. Posso fechar?"],
    }
    monkeypatch.setattr(bot, "openai", _fake_openai_factory(roteiro))
    tel = "5535999000021"
    _conversar(tel, ["oi", "1 coxinha retirada dinheiro", "sim", "confirma"])
    assert len(_pedidos(ambiente, tel)) == 1
    log = _log_da_mensagem(ambiente, "confirma")
    fech = next(f for f in log["ferramentas"] if f["nome"] == "fechar_pedido")
    assert json.loads(fech["resultado"]).get("ja_estava_fechado") is True
    assert bot.obter_rascunho(tel)["itens"] == []          # remontagem foi limpa
    _conversar(tel, ["quero mais 2 coxinha", "sim"])
    assert len(_pedidos(ambiente, tel)) == 2


def test_bairro_preenchido_pelo_servidor(ambiente, monkeypatch):
    """Entrega definida, bot perguntou o bairro, cliente 'San Genaro' e a IA
    só CONSULTA (verificar_bairro_entrega) → o servidor grava o bairro nos dois
    caminhos (slot antes da IA; e no retorno 'atende' da consulta)."""
    cfg = bot.obter_config_bot()
    # caminho 1: slot no servidor, IA não chama nada
    monkeypatch.setattr(bot, "openai", _fake_openai_factory({}))
    tel = "5535999000022"
    bot.rascunho_adicionar_item(tel, _codigo("esfirra de carne"), 1, cfg)
    bot.rascunho_definir_entrega(tel, "ENTREGA", None, None, cfg)
    _conversar(tel, ["oi", "San Genaro"])
    assert bot.obter_rascunho(tel)["bairro"] == "San Genaro"
    assert _log_da_mensagem(ambiente, "San Genaro")["ferramentas"][0]["nome"] == "definir_entrega[servidor]"
    _conversar(tel, ["Av. Brasil, 45"])
    assert bot.obter_rascunho(tel)["endereco"] == "Av. Brasil, 45"
    # caminho 2: mensagem que o slot não pega ("é o são genaro"), IA consulta
    roteiro = {"é o são genaro": (("verificar_bairro_entrega", {"bairro_cliente": "são genaro"}), "Entregamos sim!")}
    monkeypatch.setattr(bot, "openai", _fake_openai_factory(roteiro))
    tel2 = "5535999000023"
    bot.rascunho_adicionar_item(tel2, _codigo("esfirra de carne"), 1, cfg)
    bot.rascunho_definir_entrega(tel2, "ENTREGA", None, None, cfg)
    _conversar(tel2, ["oi", "é o são genaro"])
    assert bot.obter_rascunho(tel2)["bairro"] == "San Genaro"
    # bairro fora da lista não grava
    tel3 = "5535999000024"
    bot.rascunho_adicionar_item(tel3, _codigo("esfirra de carne"), 1, cfg)
    bot.rascunho_definir_entrega(tel3, "ENTREGA", None, None, cfg)
    monkeypatch.setattr(bot, "openai", _fake_openai_factory({}))
    _conversar(tel3, ["oi", "Passos"])
    assert bot.obter_rascunho(tel3)["bairro"] is None


def test_sim_depois_do_total_fecha_mesmo_sem_pergunta(ambiente, monkeypatch):
    """Bot passou a chave PIX com 'Total: R$ 11,00' e NÃO perguntou 'posso
    fechar?'. Cliente 'sim' → fecha (a exibição do total vale como pedido de
    confirmação). Sem total na última fala, 'sim' não fecha."""
    cx = _codigo("coxinha de frango")
    roteiro = {
        "1 coxinha retirada": [("adicionar_item", {"item_id": cx, "quantidade": 1}), ("definir_entrega", {"tipo": "RETIRADA"}),
                               "Como vai pagar?"],
        "pix": ["Chave: pix-teste@lileamar.com.br. Total: R$ 6,50. Assim que receber o comprovante, continuamos!"],
        "sim": (("fechar_pedido", {}), "Fechado!"),
    }
    monkeypatch.setattr(bot, "openai", _fake_openai_factory(roteiro))
    tel = "5535999000025"
    _conversar(tel, ["oi", "1 coxinha retirada", "pix", "sim"])
    assert len(_pedidos(ambiente, tel)) == 1
    roteiro2 = dict(roteiro, pix=["Chave: pix-teste@lileamar.com.br. Envie o comprovante."])
    monkeypatch.setattr(bot, "openai", _fake_openai_factory(roteiro2))
    tel2 = "5535999000026"
    _conversar(tel2, ["oi", "1 coxinha retirada", "pix", "sim"])
    assert len(_pedidos(ambiente, tel2)) == 0
