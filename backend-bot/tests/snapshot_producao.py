# -*- coding: utf-8 -*-
"""Tira um SNAPSHOT (somente leitura) das configurações e do cardápio que
estão em produção, pra usar no ambiente de teste com os dados reais.

    cd backend-bot
    python tests/snapshot_producao.py                 # grava tests/snapshot.json
    python tests/snapshot_producao.py -o meu.json

Depois:
    python tests/ambiente_teste.py --snapshot tests/snapshot.json
    python tests/harness.py --memoria --snapshot tests/snapshot.json -k entrega

O que é lido (e SÓ lido — este script não escreve nada em produção):
  cardapio/*                    itens, preços, disponibilidade
  configuracoes/bot             bairros_entrega, taxa, chave PIX, horário, mensagens...
  configuracoes/sistema         telefone/endereço da loja
  itens_aprendizado/*           apelidos de itens ensinados pela equipe
  bairros_aprendizado/*         respostas da equipe sobre bairros

NÃO lê pedidos, históricos de conversa nem dados de clientes.
Usa a credencial do .env (FIREBASE_CREDENCIAL_PATH), igual ao bot.
"""
import argparse
import json
import os
import sys
from datetime import datetime

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(RAIZ)

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("-o", "--saida", default=os.path.join("tests", "snapshot.json"))
args = parser.parse_args()

if os.environ.get("FIRESTORE_EMULATOR_HOST"):
    sys.exit("FIRESTORE_EMULATOR_HOST está definido — este script lê a PRODUÇÃO; desfaça a variável antes.")

from dotenv import load_dotenv  # noqa: E402
load_dotenv()
cred_path = os.environ.get("FIREBASE_CREDENCIAL_PATH")
if not cred_path or not os.path.exists(cred_path):
    sys.exit(f"Credencial do Firebase não encontrada (FIREBASE_CREDENCIAL_PATH={cred_path!r}). Confira o .env.")

import firebase_admin  # noqa: E402
from firebase_admin import credentials, firestore  # noqa: E402

firebase_admin.initialize_app(credentials.Certificate(cred_path))
db = firestore.client()


def _serializavel(v):
    if hasattr(v, "isoformat"):
        return v.isoformat()
    return v


def _doc(d):
    return {k: _serializavel(v) for k, v in (d.to_dict() or {}).items()}


COLECOES = ["cardapio", "itens_aprendizado", "bairros_aprendizado"]
snapshot = {
    "gerado_em": datetime.now().isoformat(timespec="seconds"),
    "projeto": getattr(firebase_admin.get_app(), "project_id", None),
    "colecoes": {},
    "documentos": {},
}
for c in COLECOES:
    docs = list(db.collection(c).stream())
    snapshot["colecoes"][c] = {d.id: _doc(d) for d in docs}
    print(f"  {c:<22} {len(docs):>3} docs")
for caminho in ("configuracoes/bot", "configuracoes/sistema"):
    d = db.document(caminho).get()
    snapshot["documentos"][caminho] = _doc(d) if d.exists else None
    print(f"  {caminho:<22} {'ok' if d.exists else 'NÃO EXISTE'}")

os.makedirs(os.path.dirname(args.saida) or ".", exist_ok=True)
with open(args.saida, "w", encoding="utf-8") as f:
    json.dump(snapshot, f, ensure_ascii=False, indent=2)

bot_cfg = snapshot["documentos"].get("configuracoes/bot") or {}
print(f"\nSnapshot salvo em {args.saida}")
print(f"  bairros_entrega: {bot_cfg.get('bairros_entrega')}")
print(f"  taxa_entrega: {bot_cfg.get('taxa_entrega')} | modelo: {bot_cfg.get('modelo')} | chave_pix: {'definida' if bot_cfg.get('chave_pix') else 'VAZIA'}")
print("  (a chave PIX real está no arquivo — não versione o snapshot.json)")
