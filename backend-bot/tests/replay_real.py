# -*- coding: utf-8 -*-
"""Reproduz CONVERSAS REAIS no bot (IA real, Firestore em memória, cardápio real) e confere
regras de consistência — em vez de respostas fixas, porque o bot não responde igual ao
atendimento do dia. Serve pra achar o que o teste simulado não acha: a IA "pensando sozinha".

    cd backend-bot
    python tests/snapshot_producao.py                       # retrato do cardápio/config (só leitura)
    python tests/replay_real.py --busca                     # lê conversas reais recentes (só leitura) e salva
    python tests/replay_real.py --modelo gpt-4.1-mini --pausa 4 --max 14

    BOT_TEMPERATURA=padrao ...   # compara com o comportamento antigo (sem temperature)

O que é lido da produção (SÓ leitura, só na opção --busca): historico_conversas (mensagens do CLIENTE).
Os telefones do teste são fictícios. tests/conversas_reais.json e tests/relatorios/ ficam fora do git.

Regras conferidas em cada conversa:
  R1 item no pedido que o cliente nunca citou (tipo ou sabor)
  R2 promessa em nome da loja (taxa grátis, reembolso, desconto...)
  R3 bot afirmou "pedido registrado" sem existir pedido
  R4 bot pediu o nome com o nome já anotado
  R5 total do pedido diferente de itens + taxa
  R6 bairro do pedido é na verdade uma rua
  R7 mesma resposta repetida 3 vezes (loop)
  R8 item citado por nome completo que sumiu sem aviso (omissão — revisar à mão)
"""
import argparse
import json
import os
import re
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("--busca", action="store_true", help="lê conversas reais recentes da produção (só leitura) e grava tests/conversas_reais.json")
parser.add_argument("--max", type=int, default=14, help="máximo de conversas a reproduzir")
parser.add_argument("--msgs", type=int, default=12, help="máximo de mensagens do cliente por conversa")
parser.add_argument("--modelo", default="gpt-4.1-mini")
parser.add_argument("--pausa", type=float, default=4.0)
parser.add_argument("--saida", default=None, help="arquivo JSON do relatório")
parser.add_argument("--so", type=int, action="append", default=[], help="só estas conversas (1, 2, 3... na ordem do relatório)")
parser.add_argument("--estado", action="store_true", help="imprime o carrinho/estado a cada mensagem")
args = parser.parse_args()

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(RAIZ)
sys.path.insert(0, RAIZ)
sys.path.insert(0, os.path.join(RAIZ, "tests"))
ARQ_CONVERSAS = os.path.join(RAIZ, "tests", "conversas_reais.json")


def buscar_conversas():
    """Mensagens dos CLIENTES das conversas mais recentes (só leitura), divididas em sessões (pausa > 3 h)."""
    from dotenv import load_dotenv
    load_dotenv()
    import firebase_admin
    from firebase_admin import credentials, firestore
    if os.environ.get("FIRESTORE_EMULATOR_HOST"):
        sys.exit("FIRESTORE_EMULATOR_HOST definido — --busca lê a PRODUÇÃO.")
    firebase_admin.initialize_app(credentials.Certificate(os.environ["FIREBASE_CREDENCIAL_PATH"]))
    db = firestore.client()
    sessoes = []
    for d in db.collection("historico_conversas").order_by("ultima_interacao", direction=firestore.Query.DESCENDING).limit(120).stream():
        msgs = [m for m in (d.to_dict().get("mensagens") or []) if m.get("timestamp")]
        atual, ultimo = [], None
        for m in msgs:
            if ultimo and (m["timestamp"] - ultimo) > timedelta(hours=3):
                if atual:
                    sessoes.append(atual)
                atual = []
            ultimo = m["timestamp"]
            if m.get("role") == "user":
                txt = str(m.get("content") or "").strip()
                if txt and not txt.startswith("[cliente enviou"):
                    atual.append(txt)
        if atual:
            sessoes.append(atual)
    # só conversas com cara de pedido (itens/entrega/pagamento) e tamanho útil
    pedido = re.compile(r"\bquero\b|queria|gostaria|\bpedir\b|\d\s*x?\s*(past|coxi|esfi|enrol|kibe|quibe|espet|hamb|suco|coca|guar|salsich)|"
                        r"entrega|retirada|\bpix\b|dinheiro|cart[aã]o", re.I)
    boas = [s for s in sessoes if 3 <= len(s) and sum(1 for t in s if pedido.search(t)) >= 2]
    boas.sort(key=lambda s: -len(s))
    ruins = [{"mensagens": [t[:400] for t in s[: args.msgs]]} for s in boas]
    with open(ARQ_CONVERSAS, "w", encoding="utf-8") as f:
        json.dump(ruins, f, ensure_ascii=False, indent=1)
    print(f"{len(sessoes)} sessões lidas; {len(ruins)} com cara de pedido gravadas em tests/conversas_reais.json")


if args.busca:
    buscar_conversas()
    sys.exit(0)

if not os.path.exists(ARQ_CONVERSAS):
    sys.exit("rode antes: python tests/replay_real.py --busca")

from firestore_memoria import FirestoreMemoria, importar_app_sem_firebase  # noqa: E402
bot = importar_app_sem_firebase(RAIZ)
bot.db = FirestoreMemoria()
bot.send_message = lambda to, message: ("EVENT_RECEIVED", 200)
import seed_emulador  # noqa: E402
if not os.environ.get("OPENAI_API_KEY"):
    sys.exit("OPENAI_API_KEY não encontrada no .env")
db = bot.db
seed_emulador.carregar_snapshot(db, os.path.join(RAIZ, "tests", "snapshot.json"), limpar=False, manter_modelo=args.modelo, ignorar_fechamento=True)
bot.carregar_cardapio(forcar=True)
cardapio = bot.carregar_cardapio()
cliente = bot.app.test_client()

RE_PROMESSA = re.compile(r"(sem (cobrar|custo|taxa)( de entrega)?|n[aã]o (vai|ir[aá]) pagar|gr[aá]tis|de gra[cç]a|reembols|desconto de|vou (te )?(mandar|enviar) outro|"
                         r"reenvi|n[oó]s (vamos|iremos) (entregar|mandar|enviar) .* (sem|de gra))", re.I)
RE_ACOMPANHA = re.compile(r"j[aá] acompanham|sach[eê]s?", re.I)


def pedidos_do(tel):
    return [d.to_dict() for d in db.collection("pedidos").where("telefone_cliente", "==", tel).stream()]


def avaliar(msgs, respostas, tel, nome_conhecido=None):
    """Devolve lista de (regra, detalhe)."""
    falhas = []
    texto_cliente = " \n ".join(msgs)
    pedidos = pedidos_do(tel)
    rascunho = bot.obter_rascunho(tel)
    itens = []
    for p in pedidos:
        itens += [i for i in (p.get("itens") or [])]
    itens += [i for i in (rascunho.get("itens") or [])]
    # R1
    for i in itens:
        it = next((c for c in cardapio if c.get("id") == i.get("id")), None) or {"nome": i.get("nome")}
        if not bot._item_citado(it, texto_cliente) and not bot._tipo_do_item_na_mensagem(it, texto_cliente):
            falhas.append(("R1 item que o cliente não citou", str(i.get("nome"))))
        elif bot._sabor_incompativel(it, texto_cliente, cardapio):
            falhas.append(("R1 sabor errado", str(i.get("nome"))))
    # R2
    for r in respostas:
        m = RE_PROMESSA.search(r or "")
        if m and not RE_ACOMPANHA.search(r or "") and "retirada" not in (r or "").lower():
            falhas.append(("R2 promessa em nome da loja", (r or "")[:140].replace("\n", " ")))
    # R3 / R4 e R7 (por resposta, com o estado do momento não disponível: aproxima pelo final)
    if not pedidos and not any(i for i in itens):
        for r in respostas:
            if bot._soa_como_confirmacao(r or "") and not re.search(r"(?i)n[aã]o (encontrei|achei|consta)", r or ""):
                falhas.append(("R3 disse que registrou sem pedido", (r or "")[:140].replace("\n", " ")))
    if nome_conhecido:
        # a resposta i só conta se o nome já era conhecido DEPOIS da mensagem anterior (i-1)
        for i, r in enumerate(respostas):
            if i > 0 and nome_conhecido[i - 1] and bot._RE_PEDE_NOME.search(bot._normalizar_termo(r or "")):
                falhas.append(("R4 pediu o nome com o nome já anotado", (r or "")[:140].replace("\n", " ")))
    # R5
    for p in pedidos:
        soma = sum(float(i.get("preco") or 0) for i in (p.get("itens") or []))
        if abs(soma + float(p.get("taxa_entrega") or 0) - float(p.get("valor_total") or 0)) > 0.011:
            falhas.append(("R5 total diferente de itens+taxa", f"itens {soma} + taxa {p.get('taxa_entrega')} != {p.get('valor_total')}"))
    # R6
    for p in pedidos:
        b = str(p.get("bairro") or "")
        if b and (re.match(r"(?i)^(rua|av|avenida|travessa|estrada|rodovia)\b", b) or bot._e_nome_de_rua_na_mensagem(b, texto_cliente)):
            falhas.append(("R6 bairro é na verdade uma rua", b))
    # R7
    norm = [bot._normalizar_termo(r or "")[:90] for r in respostas]
    for n in set(norm):
        if n and norm.count(n) >= 3:
            falhas.append(("R7 mesma resposta repetida 3x", n[:90]))
    # R8 (omissão): item citado por nome COMPLETO numa parte do pedido e ausente do carrinho/pedido sem aviso
    ids = {i.get("id") for i in itens}
    todas = "\n".join(respostas).lower()
    for seg in bot._segmentos_do_pedido(texto_cliente):
        for it in cardapio:
            if it.get("disponivel") is False or not bot._disponivel_online(it) or it.get("id") in ids:
                continue
            palavras = bot._palavras_do_nome(it)
            coberto = any(all(any(bot._token_parecido(w, x) for x in bot._palavras_do_nome(i2)) for w in palavras) for i2 in itens)
            if not coberto and len(palavras) >= 2 and all(any(bot._token_parecido(w, t) for t in seg) for w in palavras):
                nome = (it.get("nome_exibicao") or it.get("nome") or "").strip()
                if nome.lower() not in todas and "no momento" not in todas:
                    falhas.append(("R8 possível omissão (revisar)", nome))
    return falhas


RE_JA_FEZ = re.compile(r"j[aá] (fiz|realizei|paguei|pedi|fechei)|pelo (app|aplicativo|site|link)|sa[ií]u pra entrega|"
                       r"cad[eê] (o )?meu|fiz um pedido|acompanhar|quanto tempo (falta|vai)|j[aá] foi (entregue|pago)", re.I)
conversas = [c for c in json.load(open(ARQ_CONVERSAS, encoding="utf-8"))
             if not any(RE_JA_FEZ.search(m) for m in c["mensagens"])][: args.max]
if args.so:
    conversas = [conversas[i - 1] for i in args.so]
run = uuid.uuid4().hex[:5]
print(f"Reproduzindo {len(conversas)} conversas reais | modelo {args.modelo} | temperatura {os.environ.get('BOT_TEMPERATURA', '0')} | run {run}")
resultados, total = [], {}
t0 = time.time()
for idx, c in enumerate(conversas):
    tel = f"5535{int(run, 16) % 10000:04d}{idx:03d}"
    respostas = []
    nome_conhecido = []   # nome_conhecido[i] = o nome já estava anotado DEPOIS da mensagem i
    for m in c["mensagens"][: args.msgs]:
        try:
            r = cliente.post("/chat_app", json={"usuario_id": tel, "mensagem": m})
            respostas.append((r.get_json() or {}).get("resposta") or "")
        except Exception as e:  # noqa: BLE001
            respostas.append(f"[erro: {e}]")
        if args.estado:
            rs = bot.obter_rascunho(tel)
            print(f"      > {m[:60]!r}\n        BOT: {respostas[-1][:150]!r}\n        ESTADO: itens={[(i.get('nome'), i.get('quantidade')) for i in rs.get('itens') or []]} "
                  f"entrega={rs.get('tipo_entrega')} bairro={rs.get('bairro')} pendente={rs.get('bairro_pendente')} end={rs.get('endereco')} "
                  f"pag={rs.get('forma_pagamento')} nome={rs.get('nome_cliente')}")
        rs_ = bot.obter_rascunho(tel)
        ped_ = pedidos_do(tel)
        nome_conhecido.append(bool(rs_.get("nome_cliente")) or any(str(p_.get("nome_cliente") or "").lower() not in ("", "none", "cliente") for p_ in ped_))
        time.sleep(args.pausa)
    turnos = []
    for l in sorted((x.to_dict() for x in db.collection("conversas_log").where("wa_id", "==", tel).stream()), key=lambda x: str(x.get("criado_em"))):
        turnos.append({"msg": str(l.get("mensagem_cliente"))[:80], "obs": l.get("observacao"),
                       "tools": [f"{f.get('nome')}->{(json.loads(f.get('resultado') or '{}') or {}).get('status') if str(f.get('resultado') or '').startswith('{') else ''}" for f in (l.get("ferramentas") or [])]})
    falhas = avaliar(c["mensagens"][: args.msgs], respostas, tel, nome_conhecido)
    fatais = [f for f in falhas if not f[0].startswith("R8")]
    for regra, _ in falhas:
        total[regra] = total.get(regra, 0) + 1
    print(f"{'✅' if not fatais else '❌'} conversa {idx + 1:02d} ({len(c['mensagens'][: args.msgs])} msgs)"
          + ("" if not falhas else "".join(f"\n      - {r}: {d}" for r, d in falhas)))
    resultados.append({"idx": idx, "mensagens": c["mensagens"][: args.msgs], "respostas": respostas, "turnos": turnos,
                       "falhas": falhas, "pedidos": [{k: v for k, v in p.items() if k != "hora_pedido"} for p in pedidos_do(tel)]})

ok = sum(1 for r in resultados if not [f for f in r["falhas"] if not f[0].startswith("R8")])
print(f"\n{'=' * 70}\nCONVERSAS SEM VIOLAÇÃO: {ok}/{len(resultados)} em {time.time() - t0:.0f}s")
for regra, n in sorted(total.items()):
    print(f"  {regra}: {n}")
saida = args.saida or os.path.join(RAIZ, "tests", "relatorios", f"replay-{datetime.now().strftime('%Y%m%d-%H%M%S')}-{run}.json")
os.makedirs(os.path.dirname(saida), exist_ok=True)
with open(saida, "w", encoding="utf-8") as f:
    json.dump({"modelo": args.modelo, "temperatura": os.environ.get("BOT_TEMPERATURA", "0"), "ok": ok, "total": len(resultados),
               "violacoes": total, "conversas": resultados}, f, ensure_ascii=False, indent=1, default=str)
print("Relatório:", saida)
