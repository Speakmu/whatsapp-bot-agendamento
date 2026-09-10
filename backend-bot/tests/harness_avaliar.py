# -*- coding: utf-8 -*-
"""Asserções do harness (função pura, sem rede) — separada pra ser usada
também por tests/test_fluxo_mock.py."""


def _nomes_itens(pedido):
    return [str(i.get("nome") or "") for i in (pedido.get("itens") or [])]


def avaliar(espera, pedidos, respostas):
    """Devolve lista de falhas (vazia = passou)."""
    falhas = []
    todas = "\n".join(respostas).lower()
    ultima = (respostas[-1] if respostas else "").lower()
    p = pedidos[0] if pedidos else None
    itens = _nomes_itens(p) if p else []
    itens_txt = " | ".join(itens).lower()

    if "pedidos" in espera and len(pedidos) != espera["pedidos"]:
        falhas.append(f"pedidos: esperado {espera['pedidos']}, gravados {len(pedidos)}")
    if p:
        if "tipo_entrega" in espera and p.get("tipo_entrega") != espera["tipo_entrega"]:
            falhas.append(f"tipo_entrega: esperado {espera['tipo_entrega']}, gravado {p.get('tipo_entrega')}")
        if "taxa_entrega" in espera and abs(float(p.get("taxa_entrega") or 0) - espera["taxa_entrega"]) > 0.01:
            falhas.append(f"taxa_entrega: esperado {espera['taxa_entrega']}, gravado {p.get('taxa_entrega')}")
        if "valor_total" in espera and abs(float(p.get("valor_total") or 0) - espera["valor_total"]) > 0.01:
            falhas.append(f"valor_total: esperado {espera['valor_total']}, gravado {p.get('valor_total')}")
        if "bairro" in espera and str(p.get("bairro") or "").strip().lower() != espera["bairro"].lower():
            falhas.append(f"bairro: esperado {espera['bairro']}, gravado {p.get('bairro')}")
        for trecho in espera.get("itens_contem", []):
            if trecho.lower() not in itens_txt:
                falhas.append(f"item faltando: '{trecho}' (itens: {itens})")
        for trecho in espera.get("itens_nao_contem", []):
            if trecho.lower() in itens_txt:
                falhas.append(f"item indevido: '{trecho}' (itens: {itens})")
        for trecho, qtd in espera.get("quantidade", {}).items():
            achou = [i for i in (p.get("itens") or []) if trecho.lower() in str(i.get("nome") or "").lower()]
            if not achou:
                falhas.append(f"quantidade: item '{trecho}' não encontrado")
            elif int(achou[0].get("quantidade") or 0) != qtd:
                falhas.append(f"quantidade de '{trecho}': esperado {qtd}, gravado {achou[0].get('quantidade')}")
        if espera.get("endereco_tem_numero") and p.get("tipo_entrega") == "ENTREGA":
            if not any(ch.isdigit() for ch in str(p.get("endereco") or "")):
                falhas.append(f"endereço sem número: '{p.get('endereco')}'")
        if espera.get("nome_cliente_valido"):
            nome = str(p.get("nome_cliente") or "").strip().lower()
            if nome in ("", "none", "null", "n/a"):
                falhas.append(f"nome_cliente inválido: {p.get('nome_cliente')!r}")
    else:
        # sem pedido: asserções que exigem pedido são falha, exceto as que
        # aceitam "ou não registra" (endereco_tem_numero, itens_nao_contem, quantidade)
        for chave in ("tipo_entrega", "taxa_entrega", "valor_total", "bairro", "itens_contem", "nome_cliente_valido"):
            if chave in espera and espera.get("pedidos", 1) != 0:
                falhas.append(f"{chave}: nenhum pedido gravado")
                break

    for trecho in espera.get("resposta_contem", []):
        if trecho.lower() not in todas:
            falhas.append(f"resposta sem '{trecho}'")
    for trecho in espera.get("resposta_nao_contem", []):
        if trecho.lower() in todas:
            falhas.append(f"resposta contém '{trecho}'")
    if espera.get("resposta_sem_preco") and "r$" in ultima:
        falhas.append("última resposta contém 'R$' (lista de preços possivelmente inventada)")
    return falhas
