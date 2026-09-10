# -*- coding: utf-8 -*-
"""Testes de unidade das funções PURAS do app.py — rodam sem rede, sem
OpenAI e sem Firestore (o Firebase Admin é substituído por um dublê antes
do import).

    cd backend-bot
    python -m pytest tests/test_unidade.py -q
"""
import os
import sys
from unittest import mock

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, RAIZ)

# Dublê do Firebase: o app.py inicializa o Admin SDK no import.
os.environ.setdefault("FIREBASE_CREDENCIAL_PATH", "/dev/null")
with mock.patch("firebase_admin.credentials.Certificate", lambda *_a, **_k: object()), \
     mock.patch("firebase_admin.initialize_app", lambda *_a, **_k: None), \
     mock.patch("firebase_admin.firestore.client", lambda *_a, **_k: mock.MagicMock()):
    import app as bot  # noqa: E402


# ---------------- _soa_como_confirmacao ----------------
def test_confirmacao_direta_detecta():
    assert bot._soa_como_confirmacao("Pedido registrado! Já vamos providenciar.")
    assert bot._soa_como_confirmacao("Anotei seu pedido, fica R$ 16,00.")
    assert bot._soa_como_confirmacao("Vou registrar seu pedido agora mesmo.")


def test_pergunta_de_confirmacao_nao_detecta():
    # fluxo normal depois de calcular_pedido: perguntar antes de registrar
    assert not bot._soa_como_confirmacao("Confere? Posso registrar o pedido?")
    assert not bot._soa_como_confirmacao("Seu pedido: 2x Pastel de Carne, total R$ 16,00. Posso confirmar?")


def test_escalacao_para_equipe_nao_detecta():
    # ERA o falso positivo que disparava a retentativa forçada (pedido fantasma)
    assert not bot._soa_como_confirmacao(
        "Vou confirmar com a equipe se entregamos aí e te aviso sobre o pedido."
    )


def test_confirmacao_seguida_de_pergunta_detecta():
    # ERA o buraco da heurística antiga: um "?" em qualquer lugar liberava tudo
    assert bot._soa_como_confirmacao("Pedido registrado! Quer mais alguma coisa?")


def test_texto_vazio():
    assert not bot._soa_como_confirmacao("")
    assert not bot._soa_como_confirmacao(None)


# ---------------- _normalizar_termo ----------------
def test_normalizar_termo_remove_acento_e_espacos():
    assert bot._normalizar_termo("  São  Genaro ") == "sao genaro"
    assert bot._normalizar_termo("Pastéis") == "pasteis"
    assert bot._normalizar_termo(None) == ""


# ---------------- verificar_horario_funcionamento ----------------
def test_horario_desativado_sempre_aberto():
    aberto, _ = bot.verificar_horario_funcionamento({"horario_funcionamento": {"ativo": False}})
    assert aberto


def test_horario_fecha_depois_da_meia_noite():
    cfg = {"horario_funcionamento": {"ativo": True, "dias": {
        d: {"aberto": True, "abre": "18:00", "fecha": "00:30"} for d in bot.ORDEM_DIAS_SEMANA}}}
    from datetime import datetime, timezone, timedelta
    fuso = timezone(timedelta(hours=-3))
    with mock.patch.object(bot, "datetime", wraps=datetime) as dt:
        dt.now.return_value = datetime(2026, 9, 10, 23, 30, tzinfo=fuso)
        assert bot.verificar_horario_funcionamento(cfg)[0]
        dt.now.return_value = datetime(2026, 9, 10, 0, 10, tzinfo=fuso)
        assert bot.verificar_horario_funcionamento(cfg)[0]
        dt.now.return_value = datetime(2026, 9, 10, 12, 0, tzinfo=fuso)
        assert not bot.verificar_horario_funcionamento(cfg)[0]


# ---------------- verificar_ferias ----------------
def test_ferias_formata_data_de_volta():
    from datetime import date
    cfg = {"ferias_ativo": True, "ferias_inicio": "2000-01-01", "ferias_fim": "2999-12-30",
           "ferias_mensagem": "Voltamos {data_volta}."}
    em_ferias, msg = bot.verificar_ferias(cfg)
    assert em_ferias and msg == "Voltamos 31/12/2999."


# ---------------- primeiro_nome ----------------
def test_primeiro_nome():
    assert bot.primeiro_nome("Murilo Amorim") == "Murilo"
    assert bot.primeiro_nome("") == "Cliente"
