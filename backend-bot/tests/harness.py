# -*- coding: utf-8 -*-
"""Harness de regressão do bot — roda os casos de casos.py contra o bot de
verdade (app.py + OpenAI) usando o EMULADOR do Firestore, e confere o que
ficou gravado em 'pedidos' no final de cada conversa.

Uso (a partir da pasta backend-bot, com o emulador já rodando):

    # terminal 1 — emulador (só Firestore basta):
    cd ../dashboard
    firebase emulators:start --only firestore --project salgadinhos-lileamar

    # terminal 2 — testes:
    cd backend-bot
    python tests/harness.py                    # todos os casos, 1 rodada
    python tests/harness.py -r 3               # 3 rodadas (aprova só se passar em todas)
    python tests/harness.py -k coca_zero -k dupla   # filtra por nome
    python tests/harness.py --sem-seed         # não re-semeia o cardápio/config
    python tests/harness.py --memoria -r 3     # SEM emulador: Firestore em memória (só precisa do .env)

Segurança: o script define FIRESTORE_EMULATOR_HOST ANTES de importar o app e
confere que existe algo escutando lá. Se não houver emulador, aborta — nunca
cai na produção. Ainda assim precisa do .env do backend-bot (OPENAI_API_KEY
e FIREBASE_CREDENCIAL_PATH), porque o app.py inicializa o Firebase Admin com
a credencial mesmo quando o destino é o emulador.

Custo: cada caso gasta chamadas reais na OpenAI (2–3 por mensagem do
cliente). Os 19 casos têm ~130 mensagens → ~300 chamadas por rodada.
"""
import argparse
import json
import os
import socket
import sys
import time
import uuid
from datetime import datetime

# --- 1. Apontar pro emulador ANTES de importar o app ---------------------
parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("--emulador", default=os.environ.get("FIRESTORE_EMULATOR_HOST", "localhost:8080"),
                    help="host:porta do emulador do Firestore (padrão localhost:8080)")
parser.add_argument("-r", "--repeticoes", type=int, default=1, help="rodadas por caso (padrão 1)")
parser.add_argument("-k", "--filtro", action="append", default=[], help="só casos cujo nome contém este trecho (repetível)")
parser.add_argument("--sem-seed", action="store_true", help="não re-semeia cardápio/config no emulador")
parser.add_argument("--pausa", type=float, default=0.0, help="segundos entre mensagens (evita rate limit)")
parser.add_argument("--verboso", "-v", action="store_true", help="imprime a conversa inteira de cada caso")
parser.add_argument("--memoria", action="store_true",
                    help="usa Firestore EM MEMÓRIA em vez do emulador (pip install mock-firestore); não precisa de Java/Firebase CLI")
parser.add_argument("--modelo", default=None, help="modelo da OpenAI só neste run (ex.: gpt-4o-mini)")
parser.add_argument("--snapshot", default=None,
                    help="JSON de snapshot_producao.py: roda com cardápio/bairros/config REAIS (os casos de casos.py "
                         "assumem o seed fictício — com snapshot, use -k pra escolher casos que façam sentido)")
parser.add_argument("--respeitar-horario", action="store_true",
                    help="com --snapshot: mantém férias/horário reais (por padrão ignorados)")
args = parser.parse_args()

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(RAIZ)            # pro load_dotenv() do app achar o .env
sys.path.insert(0, RAIZ)
sys.path.insert(0, os.path.join(RAIZ, "tests"))

if args.memoria:
    from firestore_memoria import FirestoreMemoria, importar_app_sem_firebase  # noqa: E402
    bot = importar_app_sem_firebase(RAIZ)
    bot.db = FirestoreMemoria()
    bot.send_message = lambda to, message: ("EVENT_RECEIVED", 200)   # WhatsApp bloqueado
    print("Firestore EM MEMÓRIA (sem emulador). WhatsApp bloqueado.")
else:
    os.environ["FIRESTORE_EMULATOR_HOST"] = args.emulador
    os.environ.setdefault("FIREBASE_STORAGE_BUCKET", "emulador-teste.appspot.com")
    host, _, porta = args.emulador.partition(":")
    try:
        with socket.create_connection((host, int(porta or 8080)), timeout=2):
            pass
    except OSError:
        sys.exit(f"ABORTADO: nada escutando em {args.emulador}. Suba o emulador do Firestore antes "
                 f"(cd dashboard && firebase emulators:start --only firestore), ou use --memoria.")
    import app as bot            # noqa: E402

from casos import CASOS      # noqa: E402
import seed_emulador         # noqa: E402
from harness_avaliar import avaliar  # noqa: E402

if not os.environ.get("OPENAI_API_KEY"):
    sys.exit("OPENAI_API_KEY não encontrada — confira o .env em backend-bot/.")
if args.modelo:
    seed_emulador.CONFIG_BOT["modelo"] = args.modelo

db = bot.db
cliente_http = bot.app.test_client()


# --- 2. Execução de um caso ------------------------------------------------
def conversar(telefone, mensagens, pausa=0.0, verboso=False):
    respostas = []
    for m in mensagens:
        r = cliente_http.post("/chat_app", json={"usuario_id": telefone, "mensagem": m})
        resposta = (r.get_json() or {}).get("resposta") or ""
        respostas.append(resposta)
        if verboso:
            print(f"      👤 {m}\n      🤖 {resposta.strip()[:400]}")
        if pausa:
            time.sleep(pausa)
    return respostas


def pedidos_do_telefone(telefone):
    docs = db.collection("pedidos").where("telefone_cliente", "==", telefone).stream()
    return [d.to_dict() for d in docs]


def ferramentas_por_turno(telefone):
    """[{mensagem, ferramentas:[nome(args)->status], chamadas_ia, tokens}] a partir do conversas_log."""
    logs = [l.to_dict() for l in db.collection("conversas_log").where("wa_id", "==", telefone).stream()]
    logs.sort(key=lambda l: str(l.get("criado_em") or ""))
    out = []
    for l in logs:
        fs = []
        for f in l.get("ferramentas") or []:
            status = ""
            try:
                res = json.loads(f.get("resultado") or "{}")
                status = res.get("status") or ""
                if res.get("motivo"):
                    status += f": {res['motivo'][:80]}"
            except (ValueError, TypeError):
                pass
            fs.append(f"{f['nome']}({json.dumps(f.get('args') or {}, ensure_ascii=False)}) -> {status}")
        out.append({"mensagem": l.get("mensagem_cliente"), "ferramentas": fs, "chamadas_ia": l.get("chamadas_ia"),
                    "tokens_entrada": l.get("tokens_entrada"), "observacao": l.get("observacao")})
    return out


# --- 3. Loop principal -----------------------------------------------------
def main():
    casos = [c for c in CASOS if not args.filtro or any(f in c["nome"] for f in args.filtro)]
    if not casos:
        sys.exit("nenhum caso bate com o filtro")

    if not args.sem_seed:
        print("Semeando banco de teste...")
        if args.snapshot:
            seed_emulador.carregar_snapshot(db, args.snapshot, limpar=not args.memoria, manter_modelo=args.modelo,
                                            ignorar_fechamento=not args.respeitar_horario)
        else:
            seed_emulador.semear(db, limpar=not args.memoria)
        bot.carregar_cardapio(forcar=True)

    run_id = uuid.uuid4().hex[:6]
    print(f"\nRodando {len(casos)} caso(s) × {args.repeticoes} rodada(s) — run {run_id}\n")
    resultados = []
    t_inicio = time.time()

    for idx, caso in enumerate(casos):
        ok_rodadas = 0
        detalhes = []
        for rod in range(args.repeticoes):
            telefone = f"5535{int(run_id, 16) % 10000:04d}{idx:02d}{rod:02d}"
            t0 = time.time()
            respostas = conversar(telefone, caso["mensagens"], args.pausa, args.verboso)
            pedidos = pedidos_do_telefone(telefone)
            falhas = avaliar(caso["espera"], pedidos, respostas)
            dur = time.time() - t0
            if not falhas:
                ok_rodadas += 1
            detalhes.append({"rodada": rod + 1, "telefone": telefone, "falhas": falhas,
                             "duracao_s": round(dur, 1), "respostas": respostas,
                             "turnos": ferramentas_por_turno(telefone),
                             "pedidos": [{k: v for k, v in p.items() if k != "hora_pedido"} for p in pedidos]})
            status = "✅" if not falhas else "❌"
            print(f"{status} {caso['nome']:<45} rodada {rod + 1}  {dur:5.1f}s"
                  + ("" if not falhas else "\n      - " + "\n      - ".join(falhas)))
        resultados.append({"nome": caso["nome"], "aprovado": ok_rodadas == args.repeticoes,
                           "rodadas_ok": ok_rodadas, "rodadas": args.repeticoes, "detalhes": detalhes})

    aprovados = sum(1 for r in resultados if r["aprovado"])
    print(f"\n{'=' * 70}\nAPROVADOS: {aprovados}/{len(resultados)}  "
          f"({aprovados / len(resultados) * 100:.0f}%)  em {time.time() - t_inicio:.0f}s")
    for r in resultados:
        if not r["aprovado"]:
            print(f"  ❌ {r['nome']}  ({r['rodadas_ok']}/{r['rodadas']} rodadas ok)")

    os.makedirs("tests/relatorios", exist_ok=True)
    caminho = f"tests/relatorios/{datetime.now().strftime('%Y%m%d-%H%M%S')}-{run_id}.json"
    with open(caminho, "w", encoding="utf-8") as f:
        json.dump({"run": run_id, "modelo": seed_emulador.CONFIG_BOT["modelo"], "aprovados": aprovados,
                   "total": len(resultados), "resultados": resultados}, f, ensure_ascii=False, indent=2, default=str)
    print(f"Relatório completo (conversas + pedidos): {caminho}")
    return 0 if aprovados == len(resultados) else 1


if __name__ == "__main__":
    sys.exit(main())
