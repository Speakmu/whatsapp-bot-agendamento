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


# ---------------- _soa_como_negativa_entrega ----------------
def test_negativa_entrega_direta_detecta():
    # Caso real de produção: bairro "nao_encontrado" e a IA negou entrega
    # em vez de escalar pra equipe.
    assert bot._soa_como_negativa_entrega(
        "Nós não realizamos entregas no bairro Esmeralda em São Sebastião do Paraíso no momento."
    )
    assert bot._soa_como_negativa_entrega("Infelizmente não entregamos nessa região.")


def test_escalacao_bairro_nao_detecta_negativa():
    assert not bot._soa_como_negativa_entrega(
        "Vou confirmar com a equipe se entregamos nesse bairro e te aviso."
    )


def test_pergunta_sobre_bairro_nao_detecta_negativa():
    assert not bot._soa_como_negativa_entrega("Não entregamos nesse bairro, mas quer tentar outro endereço?")


def test_negativa_entrega_texto_vazio():
    assert not bot._soa_como_negativa_entrega("")
    assert not bot._soa_como_negativa_entrega(None)


# ---------------- _soa_como_cancelamento ----------------
def test_cancelamento_direto_detecta():
    # Caso real de produção: cliente pediu "Cancela", a IA respondeu isso
    # sem chamar cancelar_pedido, e o pedido continuou ativo/foi pra cozinha.
    assert bot._soa_como_cancelamento("O pedido foi cancelado. Se mudar de ideia, é só chamar.")
    assert bot._soa_como_cancelamento("Cancelei seu pedido, tudo certo.")


def test_escalacao_cancelamento_nao_detecta():
    assert not bot._soa_como_cancelamento("Vou confirmar o cancelamento com a equipe e te aviso.")


def test_pergunta_sobre_cancelamento_nao_detecta():
    assert not bot._soa_como_cancelamento("Quer mesmo cancelar o pedido?")


def test_cancelamento_texto_vazio():
    assert not bot._soa_como_cancelamento("")
    assert not bot._soa_como_cancelamento(None)


# ---------------- _soa_como_correcao_pos_fechamento ----------------
def test_correcao_pos_fechamento_detecta():
    # Caso real de produção: pedido fechado (R$65), cliente pediu pra trocar
    # um item, a ferramenta bloqueou mas a IA disse "corrigido" mesmo assim.
    assert bot._soa_como_correcao_pos_fechamento("Corrigi o pedido para incluir a Coxinha Catupiry. Total: R$ 66,00.")
    assert bot._soa_como_correcao_pos_fechamento("Vou abrir outro pedido com esse item, tudo bem.")


def test_escalacao_pos_fechamento_nao_detecta():
    assert not bot._soa_como_correcao_pos_fechamento(
        "Seu pedido anterior já está registrado. Já chamei a equipe pra confirmar essa mudança com você."
    )


def test_correcao_pos_fechamento_texto_vazio():
    assert not bot._soa_como_correcao_pos_fechamento("")
    assert not bot._soa_como_correcao_pos_fechamento(None)


# ---------------- _pedido_recem_fechado ----------------
def test_pedido_recem_fechado_detecta():
    from datetime import datetime, timezone
    r = bot._rascunho_vazio()
    r["ultimo_pedido"] = {"pedido_id": "abc123", "valor_total": 65.0, "fechado_em": datetime.now(timezone.utc)}
    assert bot._pedido_recem_fechado(r) is not None


def test_pedido_recem_fechado_sem_pedido():
    r = bot._rascunho_vazio()
    assert bot._pedido_recem_fechado(r) is None


def test_pedido_recem_fechado_ha_muito_tempo():
    from datetime import datetime, timezone, timedelta
    r = bot._rascunho_vazio()
    r["ultimo_pedido"] = {"pedido_id": "abc123", "valor_total": 65.0,
                           "fechado_em": datetime.now(timezone.utc) - timedelta(hours=2)}
    assert bot._pedido_recem_fechado(r) is None


# ---------------- _resolver_variante_ambigua ----------------
_CARDAPIO_COXINHA = [
    {"id": "id-frango", "codigo": "cFra", "nome": "coxinha frango", "nome_exibicao": "Coxinha Frango", "preco": 7.5},
    {"id": "id-catup", "codigo": "cCat", "nome": "coxinha de frango com catupiry", "nome_exibicao": "Coxinha Catupiry", "preco": 8.5},
]


def test_variante_ambigua_pergunta_quando_mensagem_nao_especifica():
    # Caso real de produção: cliente pediu "coxinha de frango com catupiry",
    # a IA resolveu pra Coxinha Frango normal sem perguntar nada.
    item_certo, opcoes = bot._resolver_variante_ambigua(_CARDAPIO_COXINHA[0], _CARDAPIO_COXINHA, "quero uma coxinha")
    assert item_certo is None
    assert len(opcoes) == 2


def test_variante_ambigua_corrige_quando_mensagem_especifica_a_outra():
    # IA resolveu errado (frango normal) mas o cliente disse "catupiry" —
    # corrige pra variação certa em vez de só perguntar de novo.
    item_certo, opcoes = bot._resolver_variante_ambigua(
        _CARDAPIO_COXINHA[0], _CARDAPIO_COXINHA, "quero uma coxinha de frango com catupiry"
    )
    assert item_certo is not None and item_certo["id"] == "id-catup"
    assert opcoes is None


def test_variante_ambigua_confirma_quando_ja_bateu_com_a_resolvida():
    item_certo, opcoes = bot._resolver_variante_ambigua(
        _CARDAPIO_COXINHA[1], _CARDAPIO_COXINHA, "quero uma coxinha com catupiry"
    )
    assert item_certo is not None and item_certo["id"] == "id-catup"
    assert opcoes is None


def test_variante_ambigua_nao_dispara_pra_item_sem_grupo():
    pastel = {"id": "id-pastel", "codigo": "pCar", "nome": "pastel de carne", "nome_exibicao": "Pastel de Carne", "preco": 8.0}
    item_certo, opcoes = bot._resolver_variante_ambigua(pastel, _CARDAPIO_COXINHA + [pastel], "quero um pastel")
    assert item_certo is None and opcoes is None


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


# ---------------- _ultima_resposta_pediu_confirmacao ----------------
def test_pediu_confirmacao_de_fechar_pedido_detecta():
    hist = [{"role": "assistant", "content": "Seu total é R$ 30,00. Posso fechar o pedido?"}]
    assert bot._ultima_resposta_pediu_confirmacao(hist)


def test_confirmacao_de_bairro_nao_conta_como_pedir_fechar():
    # Caso real de produção: bot pergunta "Confirma o bairro?" com o carrinho
    # já completo — um "sim" respondendo a ISSO não pode fechar o pedido.
    hist = [{"role": "assistant", "content": "Entregamos no Jardim Europa. Confirma o bairro?"}]
    assert not bot._ultima_resposta_pediu_confirmacao(hist)


def test_confirmacao_de_endereco_nao_conta_como_pedir_fechar():
    hist = [{"role": "assistant", "content": "Confere o endereço: Rua Malta, 135?"}]
    assert not bot._ultima_resposta_pediu_confirmacao(hist)


def test_sem_interrogacao_nao_conta():
    hist = [{"role": "assistant", "content": "Posso fechar o pedido."}]
    assert not bot._ultima_resposta_pediu_confirmacao(hist)


# ---------------- primeiro_nome ----------------
def test_primeiro_nome():
    assert bot.primeiro_nome("Murilo Amorim") == "Murilo"
    assert bot.primeiro_nome("") == "Cliente"
