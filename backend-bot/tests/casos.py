# -*- coding: utf-8 -*-
"""Casos de teste do bot — um por incidente real documentado nos comentários
do app.py, mais alguns fluxos básicos que precisam continuar funcionando.

Formato de cada caso:
  nome        identificador curto (vira nome no relatório)
  mensagens   lista de mensagens do CLIENTE, na ordem (o bot responde cada uma)
  espera      dict de asserções sobre o estado final (ver harness.py:avaliar):
      pedidos                  int  — quantos pedidos devem existir pro telefone
      tipo_entrega             "ENTREGA" | "RETIRADA"
      taxa_entrega             float
      valor_total              float (tolerância 0.01)
      itens_contem             lista de trechos que DEVEM aparecer no nome de algum item
      itens_nao_contem         lista de trechos que NÃO podem aparecer em nenhum item
      quantidade               {trecho_do_item: qtd}
      endereco_tem_numero      True — endereço precisa ter dígito (se houver pedido)
      bairro                   str — campo 'bairro' do pedido
      nome_cliente_valido      True — nome não pode ser None/"None"/""
      resposta_contem          lista de trechos (case-insensitive) que precisam aparecer
                               em ALGUMA resposta do bot na conversa
      resposta_nao_contem      idem, que NÃO podem aparecer em NENHUMA resposta
      resposta_sem_preco       True — a ÚLTIMA resposta não pode conter "R$" (lista inventada)

Os nomes de item batem com o cardápio semeado em seed_emulador.py.
As asserções de texto (resposta_*) são heurísticas — um caso que falhar só
nelas merece leitura manual antes de ser contado como erro.
"""

# Sequência de fechamento reutilizada (o bot pergunta uma coisa por vez).
FECHA_RETIRADA_DINHEIRO = ["só isso", "retirada", "dinheiro", "sim"]
FECHA_ENTREGA_CENTRO_CARTAO = ["só isso", "entrega", "Centro", "Rua das Flores, 123", "cartão", "sim"]

CASOS = [
    # ---------- fluxos básicos (têm que continuar passando sempre) ----------
    {
        "nome": "retirada_simples",
        "mensagens": ["oi", "Murilo", "quero 2 pastel de carne"] + FECHA_RETIRADA_DINHEIRO,
        "espera": {"pedidos": 1, "tipo_entrega": "RETIRADA", "taxa_entrega": 0,
                   "valor_total": 16.00, "itens_contem": ["Pastel de Carne"],
                   "quantidade": {"Pastel de Carne": 2}},
    },
    {
        "nome": "entrega_com_taxa",
        "mensagens": ["oi", "Murilo", "1 coxinha de frango"] + FECHA_ENTREGA_CENTRO_CARTAO,
        "espera": {"pedidos": 1, "tipo_entrega": "ENTREGA", "taxa_entrega": 5.00,
                   "valor_total": 11.50, "bairro": "Centro", "endereco_tem_numero": True},
    },

    # ---------- incidentes reais (comentários do app.py) ----------
    {
        # "coca cola ZERO lata 350ml" casava com "coca cola lata 350ml"
        "nome": "coca_zero_nao_vira_coca_normal",
        "mensagens": ["oi", "Murilo", "quero 1 coca zero lata"] + FECHA_RETIRADA_DINHEIRO,
        "espera": {"pedidos": 1, "itens_contem": ["Zero"], "itens_nao_contem": ["600"],
                   "quantidade": {"Zero": 1}},
    },
    {
        # "enroladinho de salsicha" NÃO existe no cardápio (existe "Salsicha", com
        # esse apelido ensinado pela equipe). O fuzzy antigo casou com
        # "enroladinho de presunto e queijo" (86%). Esperado: item Salsicha, 2 un.
        "nome": "enroladinho_salsicha_vira_salsicha_pelo_apelido",
        "mensagens": ["oi", "Murilo", "2 enroladinho de salsicha"] + FECHA_RETIRADA_DINHEIRO,
        "espera": {"pedidos": 1, "itens_contem": ["Salsicha"], "itens_nao_contem": ["Presunto", "Enroladinho"],
                   "quantidade": {"Salsicha": 2}, "valor_total": 13.00},
    },
    {
        # cliente pediu "pastel de salsicha", fuzzy achou "Salsicha" avulsa e o
        # bot confirmou "temos o pastel de salsicha"
        "nome": "pastel_salsicha_nao_inventado",
        "mensagens": ["oi", "Murilo", "tem pastel de salsicha?"],
        # ("temos pastel de salsicha" também casa com "NÃO temos pastel de salsicha" — por isso
        #  só as formas afirmativas)
        "espera": {"pedidos": 0,
                   "resposta_nao_contem": ["sim, temos pastel de salsicha", "temos o pastel de salsicha",
                                           "temos sim pastel de salsicha", "pastel de salsicha por r$",
                                           "pastel de salsicha custa", "pastel de salsicha: r$"]},
    },
    {
        # pedido de entrega saiu como RETIRADA e a taxa sumiu do total
        "nome": "entrega_nao_vira_retirada",
        "mensagens": ["oi", "Murilo", "1 esfirra de carne", "não", "entrega", "San Genaro",
                      "Av. Brasil, 45", "pix", "sim"],
        "espera": {"pedidos": 1, "tipo_entrega": "ENTREGA", "taxa_entrega": 5.00, "valor_total": 11.00},
    },
    {
        # "Nada mais" + "Pode sim" → dois pedidos reais
        "nome": "confirmacao_dupla_nao_duplica_retirada",
        "mensagens": ["oi", "Murilo", "1 coxinha de frango", "nada mais", "retirada", "dinheiro",
                      "pode sim", "confirma", "isso"],
        "espera": {"pedidos": 1},
    },
    {
        # a trava de duplicidade comparava estimativa SEM taxa com total COM taxa —
        # em entrega nunca batia. Este é o caso que a Fase 0 corrige.
        "nome": "confirmacao_dupla_nao_duplica_entrega",
        "mensagens": ["oi", "Murilo", "1 coxinha de frango", "nada mais", "entrega", "Centro",
                      "Rua das Flores, 123", "dinheiro", "pode sim", "confirma", "isso"],
        "espera": {"pedidos": 1, "tipo_entrega": "ENTREGA"},
    },
    {
        # bot usava registrar_pedido pra DESCREVER o pedido → duplicava
        "nome": "consultar_pedido_nao_duplica",
        "mensagens": ["oi", "Murilo", "1 coxinha de frango"] + FECHA_RETIRADA_DINHEIRO
                     + ["qual o valor do meu pedido?", "o que eu pedi mesmo?"],
        "espera": {"pedidos": 1},
    },
    {
        # pedido registrado com endereco_completo = só o bairro
        "nome": "endereco_so_bairro_nao_registra",
        "mensagens": ["oi", "Murilo", "1 coxinha de frango", "só isso", "entrega", "Centro",
                      "no centro mesmo", "dinheiro", "sim"],
        "espera": {"endereco_tem_numero": True},
    },
    {
        # bot inventava um telefone parecido quando não tinha o da loja
        "nome": "telefone_loja_nao_inventado",
        "mensagens": ["oi", "qual o telefone de vocês?"],
        "espera": {"pedidos": 0, "resposta_contem": ["3531-0000"]},
    },
    {
        # "Cliente: None" gravado quando a IA mandava a string "None"
        "nome": "nome_cliente_nunca_none",
        "mensagens": ["oi", "1 coxinha de frango", "só isso", "retirada", "dinheiro", "sim",
                      "prefiro não informar meu nome, pode fechar assim", "sim"],
        "espera": {"nome_cliente_valido": True},
    },
    {
        # item desativado por estoque não pode ser aceito
        "nome": "item_indisponivel_nao_entra",
        "mensagens": ["oi", "Murilo", "quero 2 kibe"] + FECHA_RETIRADA_DINHEIRO,
        "espera": {"itens_nao_contem": ["Kibe"]},
    },
    {
        # disponivel_online=False: vende no balcão, não no WhatsApp
        "nome": "item_so_balcao_nao_entra",
        "mensagens": ["oi", "Murilo", "quero 1 bolinho de bacalhau"] + FECHA_RETIRADA_DINHEIRO,
        "espera": {"itens_nao_contem": ["Bacalhau"]},
    },
    {
        # conversa longa: o carrinho saía da janela de contexto antes do fechamento
        "nome": "carrinho_sobrevive_conversa_longa",
        "mensagens": ["oi", "Murilo", "quais salgados vocês tem?", "quanto é a coxinha?",
                      "quero 2 coxinha de frango", "tem bebida?", "1 guaraná lata",
                      "vocês entregam no centro?", "qual o horário de vocês?",
                      "e pastel, tem de queijo?", "quero 1 pastel de queijo",
                      "só isso", "entrega", "Centro", "Rua das Flores, 123", "pix", "sim"],
        "espera": {"pedidos": 1, "itens_contem": ["Coxinha", "Guaran", "Pastel de Queijo"],
                   "quantidade": {"Coxinha": 2}},
    },
    {
        # categoria inexistente: bot inventava lista com preços plausíveis
        "nome": "categoria_inexistente_sem_lista_inventada",
        "mensagens": ["oi", "tem sobremesa?"],
        "espera": {"pedidos": 0, "resposta_sem_preco": True},
    },
    {
        # "Passos" é cidade vizinha, não bairro — não escalar, não confirmar entrega
        "nome": "cidade_vizinha_nao_entrega",
        "mensagens": ["oi", "vocês entregam em Passos?"],
        "espera": {"pedidos": 0, "resposta_nao_contem": ["entregamos aí sim", "entregamos em passos",
                                                         "sim, entregamos"]},
    },
    {
        # "são genaro" perdia pro fuzzy contra "São Judas Tadeu" por causa do acento
        "nome": "bairro_com_acento_reconhecido",
        "mensagens": ["oi", "entregam no são genaro?"],
        # o bot às vezes reescreve "San Genaro" como "São Genaro" — o que importa é ter
        # reconhecido o bairro certo e não um dos falsos positivos do fuzzy
        "espera": {"pedidos": 0, "resposta_contem": ["genaro"],
                   "resposta_nao_contem": ["são judas", "jardim são josé", "não entregamos"]},
    },
    {
        # chave PIX de exemplo "abc1231234567" era passada como real
        "nome": "chave_pix_configurada_nao_exemplo",
        "mensagens": ["oi", "Murilo", "1 coxinha de frango", "só isso", "retirada", "pix", "sim"],
        "espera": {"pedidos": 1, "resposta_contem": ["pix-teste@lileamar.com.br"],
                   "resposta_nao_contem": ["abc1231234567"]},
    },
]
