# -*- coding: utf-8 -*-
"""Semeia o EMULADOR do Firestore com um cardápio de salgaderia e a config do
bot, do jeito que os casos em casos.py esperam.

Só roda com FIRESTORE_EMULATOR_HOST definido — se não estiver, aborta antes
de tocar em qualquer coleção. Nunca aponte isto pra produção.
"""
import os
import sys


def _exigir_emulador():
    host = os.environ.get("FIRESTORE_EMULATOR_HOST")
    if not host:
        sys.exit("ABORTADO: FIRESTORE_EMULATOR_HOST não está definido — este script só roda contra o emulador.")
    return host


CARDAPIO = [
    # nome (chave de busca), nome_exibicao, categoria, preco, disponivel, disponivel_online, ingredientes
    ("pastel de carne",               "Pastel de Carne",               "Salgados Fritos",   8.00, True,  True,  "Carne moída temperada"),
    ("pastel de queijo",              "Pastel de Queijo",              "Salgados Fritos",   8.00, True,  True,  "Mussarela"),
    ("pastel de carne e queijo",      "Pastel de Carne e Queijo",      "Salgados Fritos",   9.00, True,  True,  "Carne e mussarela"),
    ("pastel chocolate com queijo",   "Pastel Chocolate com Queijo",   "Salgados Fritos",   9.50, True,  True,  "Chocolate e mussarela"),
    ("coxinha de frango",             "Coxinha de Frango",             "Salgados Fritos",   6.50, True,  True,  "Frango desfiado"),
    ("kibe",                          "Kibe",                          "Salgados Fritos",   6.50, False, True,  "Carne e trigo"),
    ("bolinho de bacalhau",           "Bolinho de Bacalhau",           "Salgados Fritos",   7.50, True,  False, "Bacalhau"),
    ("enroladinho de presunto e queijo", "Enroladinho de Presunto e Queijo", "Salgados Assados", 5.50, True, True, "Presunto e mussarela"),
    ("esfirra de carne",              "Esfirra de Carne",              "Salgados Assados",  6.00, True,  True,  "Carne temperada"),
    ("esfirra de frango",             "Esfirra de Frango",             "Salgados Assados",  6.00, True,  True,  "Frango"),
    ("salsicha",                      "Salsicha",                      "Avulsos",           6.50, True,  True,  "Salsicha avulsa"),
    ("coca cola lata 350ml",          "Coca-Cola Lata 350ml",          "Bebidas",           6.00, True,  True,  "Refrigerante"),
    ("coca cola zero lata 350ml",     "Coca-Cola Zero Lata 350ml",     "Bebidas",           6.00, True,  True,  "Refrigerante"),
    ("coca cola zero 600ml",          "Coca-Cola Zero 600ml",          "Bebidas",           8.00, True,  True,  "Refrigerante"),
    ("guarana lata",                  "Guaraná Lata",                  "Bebidas",           5.00, True,  True,  "Refrigerante"),
]

# Apelidos ensinados pela equipe no painel (coleção itens_aprendizado:
# doc id = apelido normalizado, campo item_id). Espelha a Lileamar real:
# NÃO existe "enroladinho de salsicha" no cardápio — o cliente pede assim,
# mas o item certo é a "Salsicha". Foi exatamente esse pedido que o fuzzy
# antigo casou com "enroladinho de presunto e queijo" (86%).
ITENS_APRENDIZADO = [
    ("enroladinho de salsicha", "salsicha"),
    ("enroladinho salsicha", "salsicha"),
    ("coca zero", "coca cola zero lata 350ml"),
]

CONFIG_BOT = {
    "ativo": True,
    "nome_atendente": "Sofia",
    "nome_empresa": "Lileamar Salgados (TESTE)",
    "chave_pix": "pix-teste@lileamar.com.br",
    "modelo": os.environ.get("BOT_MODELO_TESTE", "gpt-4o"),
    "max_historico_contexto": 24,
    "max_historico_salvar": 30,
    "mensagem_inicial": "Olá! Como posso ajudar?",
    "bairros_entrega": ["Centro", "San Genaro", "São Judas Tadeu", "Jardim São José", "Lagoinha"],
    "taxa_entrega": 5.00,
    "cidade_atendida": "São Sebastião do Paraíso",
    "divulgar_app": False,
    "ferias_ativo": False,
    "horario_funcionamento": {"ativo": False},
}

CONFIG_SISTEMA = {
    "nome": "Lileamar Salgados (TESTE)",
    "telefone": "(35) 3531-0000",
    "endereco": "Rua Teste, 1 - Centro",
}

COLECOES_LIMPAR = ["cardapio", "pedidos", "historico_conversas", "itens_aprendizado",
                   "bairros_aprendizado", "webhook_processed_ids", "conversas_log", "usuarios_app"]


def _limpar(db, colecao):
    docs = list(db.collection(colecao).stream())
    lote = db.batch()
    n = 0
    for d in docs:
        lote.delete(d.reference)
        n += 1
        if n % 400 == 0:
            lote.commit()
            lote = db.batch()
    if n % 400:
        lote.commit()
    return n


def semear(db, limpar=True):
    _exigir_emulador()
    if limpar:
        for c in COLECOES_LIMPAR:
            n = _limpar(db, c)
            if n:
                print(f"  limpou {n:>3} docs de {c}")
    for nome, exib, cat, preco, disp, disp_online, ingr in CARDAPIO:
        db.collection("cardapio").add({
            "nome": nome, "nome_exibicao": exib, "categoria": cat, "preco": preco,
            "disponivel": disp, "disponivel_online": disp_online,
            "ingredientes": ingr, "pontos_fidelidade": int(preco),
        })
    ids_por_nome = {d.to_dict().get("nome"): d.id for d in db.collection("cardapio").get()}
    for apelido, nome_item in ITENS_APRENDIZADO:
        if nome_item in ids_por_nome:
            chave = ''.join(ch for ch in __import__('unicodedata').normalize('NFD', apelido)
                            if not __import__('unicodedata').combining(ch)).lower().strip()
            db.collection("itens_aprendizado").document(chave).set({
                "item_id": ids_por_nome[nome_item], "apelido_original": apelido, "origem": "seed_teste"})
    db.collection("configuracoes").document("bot").set(CONFIG_BOT)
    db.collection("configuracoes").document("sistema").set(CONFIG_SISTEMA)
    print(f"  cardápio: {len(CARDAPIO)} itens + {len(ITENS_APRENDIZADO)} apelidos; config do bot e do sistema gravadas")


def carregar_snapshot(db, caminho, limpar=True, manter_modelo=None, ignorar_fechamento=True):
    """Popula o banco de teste com um snapshot da PRODUÇÃO gerado por
    snapshot_producao.py (cardápio, config do bot, config do sistema,
    apelidos, bairros aprendidos). Continua sem tocar em produção: só lê o
    JSON. 'manter_modelo' força o modelo da OpenAI (ex.: pra testar um
    modelo mais barato com os dados reais)."""
    import json
    _exigir_emulador()
    with open(caminho, encoding="utf-8") as f:
        snap = json.load(f)
    if limpar:
        for c in COLECOES_LIMPAR:
            _limpar(db, c)
    for colecao, docs in (snap.get("colecoes") or {}).items():
        for doc_id, dados in docs.items():
            db.collection(colecao).document(doc_id).set(dados)
    for caminho_doc, dados in (snap.get("documentos") or {}).items():
        if dados is None:
            continue
        colecao, doc_id = caminho_doc.split("/", 1)
        if caminho_doc == "configuracoes/bot":
            dados = dict(dados)
            dados["ativo"] = True                       # bot pausado no painel não deve travar o teste
            dados.setdefault("horario_funcionamento", {})
            if ignorar_fechamento:
                # Férias e horário de funcionamento REAIS ficam de fora do teste
                # por padrão: senão, em período de férias ou fora do horário,
                # toda mensagem vira "estamos fechados" e não dá pra testar o
                # atendimento. --respeitar-horario liga de volta.
                dados["ferias_ativo"] = False
                dados["horario_funcionamento"] = dict(dados.get("horario_funcionamento") or {}, ativo=False)
            if manter_modelo:
                dados["modelo"] = manter_modelo
            CONFIG_BOT.update({k: dados[k] for k in ("modelo", "nome_empresa", "chave_pix") if k in dados})
        db.collection(colecao).document(doc_id).set(dados)
    bot_cfg = (snap.get("documentos") or {}).get("configuracoes/bot") or {}
    n_itens = len((snap.get("colecoes") or {}).get("cardapio") or {})
    print(f"  snapshot de {snap.get('gerado_em')}: {n_itens} itens no cardápio; "
          f"bairros: {bot_cfg.get('bairros_entrega')}; taxa: {bot_cfg.get('taxa_entrega')}")
    ferias = bot_cfg.get("ferias_ativo")
    horario = (bot_cfg.get("horario_funcionamento") or {}).get("ativo")
    if ignorar_fechamento and (ferias or horario):
        print(f"  férias/horário do snapshot IGNORADOS no teste (férias={'sim' if ferias else 'não'}, "
              f"horário={'sim' if horario else 'não'}) — use --respeitar-horario pra testar essas mensagens")
    elif ferias:
        print("  AVISO: período de férias ativo — o bot vai responder a mensagem de férias.")
    elif horario:
        print("  AVISO: horário de funcionamento ativo — fora do horário o bot responde 'fechado'.")


if __name__ == "__main__":
    _exigir_emulador()
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from app import db  # noqa: E402  (importa o app já apontando pro emulador)
    semear(db)
