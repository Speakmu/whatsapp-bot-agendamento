# -*- coding: utf-8 -*-
"""AMBIENTE DE TESTE DO BOT — conversa com o bot de verdade (IA real) sem
tocar em NADA de produção: Firestore em memória, WhatsApp bloqueado.

    cd backend-bot
    pip install mock-firestore          # 1ª vez
    python tests/ambiente_teste.py      # chat no terminal
    python tests/ambiente_teste.py --web   # + página de chat em http://localhost:5055/teste
    python tests/ambiente_teste.py --snapshot tests/snapshot.json   # com cardápio/bairros/config REAIS
                                           # (gere antes com: python tests/snapshot_producao.py)

O que precisa: só o .env do backend-bot com OPENAI_API_KEY (a chave do
Firebase e do WhatsApp NÃO são usadas — o Firebase Admin é substituído por
um dublê e send_message vira um print).

O que é semeado (tests/seed_emulador.py): cardápio de salgaderia com os
itens dos incidentes (coca zero/normal, enroladinho salsicha/presunto,
Salsicha avulsa, Kibe esgotado, bacalhau só balcão), bairros, taxa R$ 5,
PIX de teste, telefone da loja. Tudo some quando o processo fecha
(`/exportar` salva em JSON antes).

Comandos no chat (começam com /):
  /pedidos     pedidos gravados pro cliente atual (resumo, uma linha cada)
  /pedido      último pedido COMPLETO (itens, quantidades, preços, total, endereço...)
  /pedido N    idem, o N-ésimo pedido da lista do /pedidos
  /todos       todos os pedidos da sessão, de todos os clientes
  /rascunho    pedido EM ANDAMENTO no servidor (carrinho, entrega, pagamento, o que falta)
  /log         último turno: ferramentas chamadas, tokens, tempo
  /historico   histórico que a IA recebe (janela de contexto)
  /cardapio    cardápio como a IA vê no prompt (com códigos)
  /esgotar X   marca o item X como esgotado (simula baixa de estoque)
  /repor X     desfaz o /esgotar E libera o item pro App/Bot (disponivel_online)
  /sobalcao X  pausa o item X só pro App/Bot (vende no balcão, some do WhatsApp)
  /itens X     mostra os itens cujo nome contém X, com disponivel / disponivel_online
  /manual      simula um atendente assumindo a conversa (modo_manual)
  /bot         devolve a conversa pro bot
  /novo        troca de cliente (telefone novo, conversa do zero)
  /exportar    salva pedidos + conversas_log em tests/relatorios/*.json
  /sair
"""
import argparse
import json
import os
import sys
import time
from datetime import datetime

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.dirname(AQUI)
sys.path.insert(0, AQUI)
sys.path.insert(0, RAIZ)
os.chdir(RAIZ)   # load_dotenv() do app acha o .env

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("--modelo", default=None, help="modelo da OpenAI só neste ambiente (ex.: gpt-4o-mini)")
parser.add_argument("--web", action="store_true", help="sobe também uma página de chat em http://localhost:PORTA/teste")
parser.add_argument("--porta", type=int, default=5055)
parser.add_argument("--telefone", default=None, help="wa_id do cliente de teste (padrão: gerado)")
parser.add_argument("--snapshot", nargs="?", const="__padrao__", default=None,
                    help="JSON gerado por snapshot_producao.py: usa o cardápio/bairros/config REAIS em vez do seed de teste. "
                         "Sem caminho, usa tests/snapshot.json.")
parser.add_argument("--respeitar-horario", action="store_true",
                    help="com --snapshot: mantém férias e horário de funcionamento reais (por padrão são ignorados no teste)")
args = parser.parse_args()
if args.snapshot == "__padrao__":
    args.snapshot = os.path.join(AQUI, "snapshot.json")
if args.snapshot and not os.path.isabs(args.snapshot) and not os.path.exists(args.snapshot):
    # aceita tanto "tests/snapshot.json" (chamado de backend-bot) quanto "snapshot.json" (chamado de tests/)
    alternativa = os.path.join(AQUI, os.path.basename(args.snapshot))
    if os.path.exists(alternativa):
        args.snapshot = alternativa
if args.snapshot and not os.path.exists(args.snapshot):
    sys.exit(f"Snapshot não encontrado: {args.snapshot}. Gere com: python tests/snapshot_producao.py")

# --- 1. app.py sem Firebase real, banco em memória, WhatsApp bloqueado ------
from firestore_memoria import FirestoreMemoria, importar_app_sem_firebase  # noqa: E402
import seed_emulador  # noqa: E402

bot = importar_app_sem_firebase(RAIZ)
if not os.environ.get("OPENAI_API_KEY"):
    sys.exit("OPENAI_API_KEY não encontrada — confira o .env em backend-bot/.")

db = FirestoreMemoria()
bot.db = db
if args.modelo:
    seed_emulador.CONFIG_BOT["modelo"] = args.modelo
if args.snapshot:
    seed_emulador.carregar_snapshot(db, args.snapshot, limpar=False, manter_modelo=args.modelo,
                                    ignorar_fechamento=not args.respeitar_horario)
else:
    seed_emulador.semear(db, limpar=False)
bot.carregar_cardapio(forcar=True)


def _avisar_apelidos_invisiveis():
    """Apelido ensinado pela equipe apontando pra item pausado no App/Bot ou
    esgotado: o bot NÃO vai reconhecer o apelido (o item não entra no
    prompt). Já custou uma tarde de investigação — avisa na abertura."""
    por_id = {it["id"]: it for it in bot.carregar_cardapio(forcar=True)}
    problemas = []
    for item_id, nomes in bot._apelidos_aprendidos().items():
        it = por_id.get(item_id)
        if not it:
            problemas.append(f"{', '.join(nomes)} → item {item_id} NÃO EXISTE mais no cardápio")
        elif not bot._disponivel_online(it):
            problemas.append(f"{', '.join(nomes)} → '{it.get('nome')}' está PAUSADO no App/Bot (disponivel_online=False)")
        elif it.get("disponivel") is False:
            problemas.append(f"{', '.join(nomes)} → '{it.get('nome')}' está ESGOTADO")
    if problemas:
        print("  AVISO — apelidos que o bot NÃO vai reconhecer agora:")
        for pr in problemas:
            print(f"    • {pr}")
        print("    (no painel: 'Repor no App/Bot' e gere o snapshot de novo; ou aqui: /repor <item>)")


_avisar_apelidos_invisiveis()


def _send_message_bloqueado(to, message):
    print(f"   [WhatsApp BLOQUEADO — não enviou pra {to}]: {message[:120]}")
    return "EVENT_RECEIVED", 200


bot.send_message = _send_message_bloqueado

ESTADO = {"telefone": args.telefone or f"5535{int(time.time()) % 100000000:08d}"}


# --- 2. helpers ----------------------------------------------------------------
def pedidos_atual():
    ps = [p for p in db.exportar("pedidos") if p.get("telefone_cliente") == ESTADO["telefone"]]
    ps.sort(key=lambda p: str(p.get("hora_pedido") or ""))
    return ps


def ultimo_log():
    """Ordena por criado_em: a ordem do stream em memória NÃO é a de inserção,
    e o /log chegou a mostrar as ferramentas de um turno anterior."""
    logs = [l for l in db.exportar("conversas_log") if l.get("wa_id") == ESTADO["telefone"]]
    logs.sort(key=lambda l: str(l.get("criado_em") or ""))
    return logs[-1] if logs else None


def _fmt_pedido(p):
    itens = ", ".join(i.get("nome", "?") for i in (p.get("itens") or []))
    return (f"  #{p['id'][:6]} {p.get('status')} | {p.get('tipo_entrega')} | {p.get('forma_pagamento')} | "
            f"R$ {float(p.get('valor_total') or 0):.2f} (taxa {float(p.get('taxa_entrega') or 0):.2f}) | "
            f"{itens} | end: {p.get('endereco')} | bairro: {p.get('bairro')} | cliente: {p.get('nome_cliente')}")


def _mostrar_pedido_completo(p):
    itens = p.get("itens") or []
    print(f"  Pedido #{p['id']}")
    print(f"    cliente: {p.get('nome_cliente')}  tel: {p.get('telefone_cliente')}  origem: {p.get('origem')}  status: {p.get('status')}")
    print(f"    {p.get('tipo_entrega')} | pagamento: {p.get('forma_pagamento')} | data: {p.get('data_formatada')}")
    print(f"    endereço: {p.get('endereco')} | bairro: {p.get('bairro')}")
    print(f"    itens ({len(itens)}):")
    soma = 0.0
    for i in itens:
        qtd = i.get("quantidade")
        unit = i.get("preco_unitario")
        tot = float(i.get("preco") or 0)
        soma += tot
        print(f"      - {qtd} x {i.get('nome_exibicao') or i.get('nome')}  @ R$ {float(unit or 0):.2f}  = R$ {tot:.2f}   (id {i.get('id')})")
    vi, tx, vt = float(p.get("valor_itens") or 0), float(p.get("taxa_entrega") or 0), float(p.get("valor_total") or 0)
    ok = abs(soma - vi) < 0.01 and abs(vi + tx - vt) < 0.01
    print(f"    subtotal itens: R$ {vi:.2f} | taxa: R$ {tx:.2f} | TOTAL: R$ {vt:.2f}   "
          f"{'✅ conta fecha' if ok else '❌ CONTA NÃO FECHA (soma dos itens = ' + f'{soma:.2f}' + ')'}")
    if p.get("observacao") and p.get("observacao") != "Nenhuma":
        print(f"    observação: {p.get('observacao')}")
    print(f"    pontos gerados: {p.get('pontos_gerados')}")


def _achar_item(trecho):
    """Nome exato primeiro, depois 'começa com', depois 'contém' — senão
    '/repor salsicha' pegava 'paozinho salsicha' em vez de 'salsicha'."""
    trecho = bot._normalizar_termo(trecho)
    if not trecho:
        return None
    itens = bot.carregar_cardapio(forcar=True)
    nomes = [(it, bot._normalizar_termo(it.get("nome") or ""), bot._normalizar_termo(it.get("nome_exibicao") or "")) for it in itens]
    for it, n, e in nomes:
        if trecho in (n, e):
            return it
    for it, n, e in nomes:
        if n.startswith(trecho) or e.startswith(trecho):
            return it
    for it, n, e in nomes:
        if trecho in n or trecho in e:
            return it
    return None


def comando(linha):
    cmd, _, arg = linha[1:].partition(" ")
    cmd = cmd.lower()
    if cmd == "pedidos":
        ps = pedidos_atual()
        print(f"  {len(ps)} pedido(s) pro {ESTADO['telefone']}")
        for p in ps:
            print(_fmt_pedido(p))
    elif cmd == "pedido":
        ps = pedidos_atual()
        if not ps:
            print("  (nenhum pedido gravado pra este cliente)")
        else:
            try:
                idx = int(arg) - 1 if arg.strip() else len(ps) - 1
                _mostrar_pedido_completo(ps[idx])
            except (ValueError, IndexError):
                print(f"  use /pedido ou /pedido N (1..{len(ps)})")
    elif cmd == "todos":
        ps = db.exportar("pedidos")
        print(f"  {len(ps)} pedido(s) na sessão")
        for p in ps:
            print(_fmt_pedido(p))
    elif cmd == "rascunho":
        print("  " + bot.rascunho_para_prompt(bot.obter_rascunho(ESTADO["telefone"]), bot.obter_config_bot()).replace("\n", "\n  "))
    elif cmd == "log":
        l = ultimo_log()
        if not l:
            print("  (sem turno ainda)")
        else:
            print(f"  modelo={l.get('modelo')} chamadas_ia={l.get('chamadas_ia')} tokens_in={l.get('tokens_entrada')} "
                  f"tokens_out={l.get('tokens_saida')} duracao={l.get('duracao_s')}s obs={l.get('observacao')} erro={l.get('erro')}")
            for f in l.get("ferramentas") or []:
                print(f"    🔧 {f['nome']}({json.dumps(f['args'], ensure_ascii=False)}) → {str(f['resultado'])[:200]}")
    elif cmd == "historico":
        for m in bot.obter_historico_firestore(ESTADO["telefone"], 50):
            print(f"  [{m['role']}] {m['content'][:200]}")
    elif cmd == "cardapio":
        print(bot.montar_cardapio_prompt())
    elif cmd in ("esgotar", "repor", "sobalcao"):
        it = _achar_item(arg)
        if not it:
            print(f"  item '{arg}' não encontrado (use /itens {arg} pra ver os nomes)")
        else:
            if cmd == "esgotar":
                mudanca = {"disponivel": False}
            elif cmd == "repor":
                mudanca = {"disponivel": True, "disponivel_online": True}
            else:
                mudanca = {"disponivel_online": False}
            db.collection("cardapio").document(it["id"]).update(mudanca)
            bot.carregar_cardapio(forcar=True)
            print(f"  {it['nome']} → {mudanca}  (só na memória do teste)")
            _avisar_apelidos_invisiveis()
    elif cmd == "itens":
        achados = [it for it in bot.carregar_cardapio(forcar=True) if arg.strip().lower() in str(it.get("nome", "")).lower()]
        for it in achados:
            print(f"  [{it['codigo']}] {it.get('nome_exibicao') or it.get('nome')} | R$ {float(it.get('preco') or 0):.2f} | "
                  f"disponivel={it.get('disponivel')} online={it.get('disponivel_online')} | cat={it.get('categoria')}")
        if not achados:
            print("  nenhum item")
    elif cmd == "manual":
        db.collection("historico_conversas").document(ESTADO["telefone"]).set({"modo_manual": True}, merge=True)
        print("  modo manual ligado — o bot não responde (mensagens só vão pro histórico)")
    elif cmd == "bot":
        db.collection("historico_conversas").document(ESTADO["telefone"]).set({"modo_manual": False}, merge=True)
        print("  bot de volta")
    elif cmd == "novo":
        ESTADO["telefone"] = f"5535{int(time.time() * 1000) % 100000000:08d}"
        print(f"  novo cliente: {ESTADO['telefone']}")
    elif cmd == "exportar":
        os.makedirs(os.path.join(AQUI, "relatorios"), exist_ok=True)
        caminho = os.path.join(AQUI, "relatorios", f"ambiente-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json")
        with open(caminho, "w", encoding="utf-8") as f:
            json.dump({"pedidos": db.exportar("pedidos"), "conversas_log": db.exportar("conversas_log"),
                       "historico_conversas": db.exportar("historico_conversas")}, f, ensure_ascii=False, indent=2, default=str)
        print(f"  salvo em {caminho}")
    elif cmd == "sair":
        return False
    else:
        print("  comandos: /pedidos /pedido [N] /todos /rascunho /log /historico /cardapio /itens X /esgotar X /repor X /sobalcao X /manual /bot /novo /exportar /sair")
    return True


def enviar(texto):
    t0 = time.time()
    resposta = bot.get_openai_response(texto, ESTADO["telefone"], "WPP")
    dur = time.time() - t0
    if resposta is None:
        print(f"🤖 (modo manual — sem resposta)  {dur:.1f}s")
    else:
        print(f"🤖 {resposta}\n   ⏱ {dur:.1f}s", end="")
        l = ultimo_log()
        if l and l.get("ferramentas"):
            print(f"  🔧 {', '.join(f['nome'] for f in l['ferramentas'])}  tokens_in={l.get('tokens_entrada')}", end="")
        print()


# --- 3. página web opcional -------------------------------------------------------
PAGINA = """<!doctype html><meta charset=utf-8><title>Bot — ambiente de teste</title>
<style>body{font-family:system-ui;max-width:640px;margin:20px auto;padding:0 12px}
#c{border:1px solid #ccc;border-radius:8px;padding:12px;height:60vh;overflow:auto;background:#f7f7f7}
.u{text-align:right;margin:6px 0}.u span{background:#dcf8c6;padding:6px 10px;border-radius:12px;display:inline-block}
.b{margin:6px 0}.b span{background:#fff;padding:6px 10px;border-radius:12px;display:inline-block;white-space:pre-wrap}
form{display:flex;gap:8px;margin-top:8px}input{flex:1;padding:8px}small{color:#666}</style>
<h3>Ambiente de teste — Firestore em memória, WhatsApp bloqueado</h3>
<small>cliente: <code id=tel></code> · <a href="#" onclick="novo();return false">novo cliente</a> · <a href="/teste/pedidos" target=_blank>pedidos</a></small>
<div id=c></div>
<form onsubmit="enviar();return false"><input id=m autofocus placeholder="mensagem do cliente"><button>Enviar</button></form>
<script>
let tel='55359'+String(Date.now()).slice(-8);document.getElementById('tel').textContent=tel;
function novo(){tel='55359'+String(Date.now()).slice(-8);document.getElementById('tel').textContent=tel;document.getElementById('c').innerHTML='';}
function add(cls,t){const d=document.createElement('div');d.className=cls;const s=document.createElement('span');s.textContent=t;d.appendChild(s);
const c=document.getElementById('c');c.appendChild(d);c.scrollTop=c.scrollHeight;}
async function enviar(){const i=document.getElementById('m');const t=i.value.trim();if(!t)return;i.value='';add('u',t);
const r=await fetch('/chat_app',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({usuario_id:tel,mensagem:t})});
const j=await r.json();add('b',j.resposta||'(sem resposta — modo manual?)');}
</script>"""


def _servir_web():
    from flask import Response, jsonify

    @bot.app.route("/teste")
    def _pagina():
        return Response(PAGINA, mimetype="text/html")

    @bot.app.route("/teste/pedidos.json")
    def _pedidos_json():
        return jsonify(db.exportar("pedidos"))

    @bot.app.route("/teste/pedidos")
    def _pedidos():
        linhas = []
        for p in db.exportar("pedidos"):
            itens = "<br>".join(
                f"{i.get('quantidade')} x {i.get('nome_exibicao') or i.get('nome')} @ {float(i.get('preco_unitario') or 0):.2f} = {float(i.get('preco') or 0):.2f}"
                for i in (p.get("itens") or []))
            linhas.append(
                f"<tr><td>{p['id'][:8]}</td><td>{p.get('data_formatada')}</td><td>{p.get('telefone_cliente')}<br>{p.get('nome_cliente')}</td>"
                f"<td>{p.get('tipo_entrega')}<br>{p.get('endereco') or ''}<br><small>{p.get('bairro') or ''}</small></td>"
                f"<td>{p.get('forma_pagamento')}</td><td>{itens}</td>"
                f"<td>itens {float(p.get('valor_itens') or 0):.2f}<br>taxa {float(p.get('taxa_entrega') or 0):.2f}<br><b>total {float(p.get('valor_total') or 0):.2f}</b></td>"
                f"<td>{p.get('status')}</td></tr>")
        html = ("<!doctype html><meta charset=utf-8><meta http-equiv=refresh content=5><title>Pedidos — teste</title>"
                "<style>body{font-family:system-ui;margin:16px}table{border-collapse:collapse;width:100%}"
                "td,th{border:1px solid #ccc;padding:6px;vertical-align:top;font-size:13px}th{background:#eee}</style>"
                f"<h3>Pedidos gravados nesta sessão de teste ({len(linhas)}) — atualiza a cada 5s · <a href='/teste/pedidos.json'>JSON</a></h3>"
                "<table><tr><th>id</th><th>data</th><th>cliente</th><th>entrega</th><th>pagto</th><th>itens</th><th>valores</th><th>status</th></tr>"
                + "".join(linhas) + "</table>")
        return Response(html, mimetype="text/html")

    import threading
    th = threading.Thread(target=lambda: bot.app.run(host="127.0.0.1", port=args.porta, debug=False, use_reloader=False), daemon=True)
    th.start()
    print(f"🌐 página de chat: http://localhost:{args.porta}/teste")


# --- 4. loop ----------------------------------------------------------------------
if __name__ == "__main__":
    print("=" * 70)
    print("AMBIENTE DE TESTE — Firestore em memória, IA real, WhatsApp bloqueado")
    print(f"dados: {'SNAPSHOT DA PRODUÇÃO (' + args.snapshot + ')' if args.snapshot else 'seed de teste (salgaderia fictícia)'}")
    print(f"modelo: {seed_emulador.CONFIG_BOT['modelo']} | cliente: {ESTADO['telefone']} | /ajuda para comandos")
    print("=" * 70)
    if args.web:
        _servir_web()
    try:
        while True:
            try:
                linha = input("👤 > ").strip()
            except EOFError:
                break
            if not linha:
                continue
            if linha.startswith("/"):
                if comando(linha) is False:
                    break
                continue
            enviar(linha)
    except KeyboardInterrupt:
        pass
    print("\naté mais — nada foi gravado em produção.")
