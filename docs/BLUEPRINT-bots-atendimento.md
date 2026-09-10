# Blueprint — Bot de atendimento com IA que fecha pedido sem errar

Metodologia extraída do trabalho no Gestor Chef (bot WhatsApp da Lileamar Salgados,
Python + Flask + OpenAI + Firestore). Serve para qualquer bot de atendimento com LLM
que precisa executar uma transação (pedido, agendamento, cadastro, chamado) a partir
de uma conversa. As fases são independentes e cada uma pode ir para produção sozinha.

---

## 0. Princípios (o que muda o resultado)

1. **Regra em código, não em prompt.** Regra em prompt tem 90–97% de adesão; com 15
   regras a chance de uma conversa inteira sem violar nenhuma cai rápido. Regra em
   código tem 100%. Cada incidente que virou "NUNCA faça X" no prompt é candidato a
   virar um `if` no servidor.
2. **O estado vive no servidor, não na memória da IA.** Carrinho, entrega, pagamento,
   etapa: documento no banco, mutado por ferramentas pequenas. A IA lê o estado, nunca
   o reconstrói do histórico.
3. **Entidades por ID, não por nome.** O catálogo (cardápio, serviços, agenda) entra
   no prompt com um código por item; a IA escolhe o código; o servidor resolve por
   igualdade exata. Nada de fuzzy match no caminho da transação.
4. **A IA pode encadear ferramentas.** Loop de tool calls (até N rodadas), nunca
   "uma chamada com ferramentas + uma sem".
5. **Medir antes de mudar.** Log append-only de cada turno; conjunto de casos de
   regressão construído dos incidentes reais; número de aprovação antes e depois de
   cada mudança.
6. **Ambiente de teste que não toca produção**, com dados reais quando preciso
   (snapshot somente leitura).
7. **Confirmação explícita do cliente é evento de negócio.** "Sim" a "posso fechar?"
   fecha — no servidor, se a IA não fechar.

---

## 1. Diagnóstico (antes de mexer em qualquer coisa)

Leia o código inteiro do bot e responda por escrito:

| Pergunta | Sinal de problema |
|---|---|
| Onde vive o pedido/transação em andamento? | Só no histórico de mensagens |
| Como um nome dito pelo cliente vira um registro? | Fuzzy match / substring / "o mais parecido" |
| Quantas chamadas de LLM por mensagem e a 2ª tem ferramentas? | Exatamente duas, a 2ª sem tools |
| Quantas linhas do system prompt são "NUNCA/JAMAIS" nascidas de incidentes? | Dezenas |
| Existe trava de duplicidade? Compara o quê com o quê? | Compara valores calculados de jeitos diferentes |
| Existe alguma "retentativa forçada" (tool_choice fixo) disparada por heurística de texto? | Sim → pode criar transação sem consentimento |
| O histórico é truncado/sobrescrito? Há log permanente? | Sem log → sem dataset, sem custo medido |
| Quantas leituras de banco por mensagem só para config? | > 1 |
| Quanto custa uma conversa (tokens × preço)? | Ninguém sabe |

Os comentários do código que dizem "já aconteceu em produção" são o seu primeiro
conjunto de testes. Liste todos.

---

## 2. Fase 0 — Parar o sangramento (meio dia)

Mudanças pequenas, sem tocar no fluxo da conversa.

- **Log append-only** (`conversas_log`): um doc por mensagem do cliente com
  ferramentas chamadas (args + resultado), tokens de entrada/saída, número de
  chamadas ao LLM, duração, erro, modelo, `observacao`. Best-effort (nunca derruba o
  atendimento). É a fonte do dataset e do custo real.
- **Remover qualquer ação forçada disparada por heurística de texto.** Substituir por
  texto seguro + aviso ao painel. Pior caso vira uma pergunta redundante, nunca uma
  transação fantasma.
- **Corrigir travas que comparam grandezas diferentes** (ex.: subtotal da IA vs total
  com taxa do banco). Gravar o campo comparável.
- **Ler config uma vez por mensagem** e repassar por parâmetro.

Entrega: diff pequeno, testes de unidade para cada função pura tocada.

---

## 3. Fase 1 — Ambiente de teste e harness (1 dia)

### 3.1 Camadas

| Camada | Precisa de | Custo | Detecta |
|---|---|---|---|
| Unidade (`pytest`) | nada | 0 | regressão em funções puras |
| Fluxo com LLM de mentira + banco em memória | `mock-firestore` | 0 | regressão de encanamento (rota → ferramenta → banco) |
| Chat interativo (LLM real, banco em memória, envio bloqueado) | chave do LLM | centavos | comportamento, à mão |
| Harness (LLM real, N casos × R rodadas) | chave do LLM | US$ 0,5–20 | comportamento, medido |
| Harness contra emulador do banco | + emulador | idem | índices/regras do banco |

### 3.2 Componentes

- **`firestore_memoria.py`** (ou equivalente do seu banco): substitui o cliente do
  banco por um em memória; cobre `merge`, batch, sentinelas (`DELETE_FIELD`,
  `Increment`, `SERVER_TIMESTAMP`), kwargs como `timeout=`. Importa o app com o SDK do
  banco substituído por dublê (nem credencial é lida).
- **Bloqueio do canal**: `send_message` vira `print`. Nenhuma mensagem sai.
- **`seed_*.py`**: catálogo fictício desenhado para reproduzir os incidentes (variantes
  parecidas, item esgotado, item só-balcão, apelidos), config (bairros, taxa, PIX de
  teste, telefone), horário/férias desligados.
- **`snapshot_producao.py`**: lê produção **somente leitura** (catálogo, configs,
  apelidos) e grava JSON. O ambiente carrega o JSON no lugar do seed. Não traz
  pedidos nem conversas. Contém segredos (PIX) → `.gitignore`. Regerar a cada mudança
  no painel. Por padrão ignora férias/horário reais (`--respeitar-horario` para testar
  essas mensagens).
- **`ambiente_teste.py`**: REPL no terminal (+ página web opcional) com comandos de
  inspeção: `/pedido` (documento completo com checagem "conta fecha"), `/rascunho`,
  `/log` (ferramentas, tokens, duração do turno), `/cardapio` (como a IA vê),
  `/esgotar` `/repor` `/sobalcao`, `/manual` `/bot`, `/novo`, `/exportar`.
  Na abertura, avisa apelidos que apontam para item invisível.
- **`casos.py`**: um caso por incidente real + fluxos básicos. Formato: lista de
  mensagens do cliente + asserções sobre o **estado gravado** (quantidade de
  transações, itens, quantidades, total, taxa, endereço com dígito, nome válido) e,
  como heurística, sobre texto (`resposta_contem` / `resposta_nao_contem`).
- **`harness.py`**: roda cada caso R vezes com telefone único, avalia, imprime ✅/❌ com
  motivo, grava JSON com conversas, pedidos e **ferramentas por turno**. Flags:
  `--memoria`, `--modelo`, `--snapshot`, `-k filtro`, `-r N`.
- **`.bat`/atalhos**: instalam dependências, gravam log, pausam em erro. Fim de linha
  CRLF, só ASCII.

### 3.3 Regras de leitura do harness

- **Critério de parada é taxa por conversa com falha segura, não "todos os casos
  verdes".** "19/19 em 3 rodadas" exige 57 conversas perfeitas seguidas de um modelo
  probabilístico; entre 96% e 98% o resultado oscila em ±1 conversa por rodada e
  perseguir a última é gastar dinheiro sem aprender nada. Pare quando (a) nenhuma falha
  é de tipo perigoso (valor errado, item inventado, pedido duplicado) e (b) as que
  restam são "pedido não fechou, bot pediu confirmação de novo" — o cliente responde
  mais uma vez e fecha.

- Aprovado = passou em todas as R rodadas. 2/3 é instabilidade, não aprovação.
- Falha em asserção de **estado** é erro real. Falha só em asserção de **texto**
  merece leitura manual (substring "temos X" casa com "não temos X"; acentos).
- Cliente simulado por LLM superestima a produção em 10–20 pontos; use só para
  regressão em volume, depois que os casos manuais passam.

---

## 4. Fase 2 — Loop de ferramentas (meio dia)

```python
for rodada in range(1, MAX + 1):
    resp = llm(messages, tools, tool_choice="auto")
    if not resp.tool_calls:
        final = resp.content; break
    messages.append(resp); executar cada tool_call; messages.append(resultados)
else:
    final = llm(messages, tools, tool_choice="none").content   # estourou: fecha em texto
```

Registrar `observacao="limite_rodadas_ferramenta"` quando estourar. Manter a rede de
segurança "texto diz registrado sem ter registrado" → texto seguro + aviso ao painel
(nunca ação forçada).

---

## 5. Fase 3 — Catálogo com ID no prompt (1 dia)

- `carregar_catalogo()` com cache curto (20 s) e **código curto** por item (menor
  prefixo único do id, mínimo 4 chars).
- Bloco no system prompt: por categoria, `[cod] Nome — R$ preço`, `(ESGOTADO)` quando
  indisponível, itens fora do canal omitidos, ingredientes fora (custo; ferramenta
  `detalhar_item` sob demanda).
- **Bloco separado de apelidos**: `"como o cliente diz" → é o item [cod] Nome`. Uma
  nota entre parênteses no meio de 80 linhas é ignorada pelo modelo; um bloco no fim
  não.
- Ferramentas recebem `item_id`; o servidor resolve por id/código/prefixo único;
  inexistente = erro, nunca "o mais parecido". Ferramentas de listagem/consulta por
  nome saem da lista.
- Regra 0 do prompt vira "o catálogo acima é a única verdade" (35 linhas no lugar de
  110).

Armadilha real: item pausado no canal (`disponivel_online=false`) não entra no prompt
→ apelido dele também não → bot diz "não temos". O ambiente de teste avisa isso na
abertura; o painel é o lugar de resolver.

---

## 6. Fase 4 — Rascunho no servidor e fechamento (2–3 dias)

### 6.1 Estado

`rascunhos/{cliente}`: `itens[]`, `tipo_entrega`, `bairro`, `endereco`,
`forma_pagamento`, `nome_cliente`, `observacao`, `resumo_visto_em`, `atualizado_em`,
`pedido_id`, `fechado_em`. Rascunho fechado conta como vazio (pedido seguinte começa
do zero).

### 6.2 Ferramentas (todas devolvem o estado inteiro com totais + `falta_para_fechar`)

`adicionar_item(item_id, qtd)` · `remover_item(item_id, qtd?)` ·
`definir_entrega(tipo, bairro?, endereco?)` · `definir_pagamento(forma)` ·
`definir_nome(nome)` · `definir_observacao(texto)` · `ver_resumo()` ·
`fechar_pedido()` **sem parâmetros** · `item_nao_encontrado(nome)` (avisa o painel para
ensinar apelido) · `detalhar_item(item_id)` · `consultar_meu_pedido()`.

### 6.3 Regras que viraram código

- `fechar_pedido` recusa com motivo legível se: vazio; sem tipo de entrega; entrega sem
  bairro reconhecido ou endereço sem dígito; sem pagamento; **o pedido mudou depois do
  último resumo mostrado**.
- Idempotência: segunda confirmação em < 5 min devolve o mesmo pedido
  (`ja_estava_fechado`). Setters com o mesmo valor **não** contam como alteração
  (o modelo pequeno "reconfirma" no turno do sim).
- Nome **não** bloqueia: fecha como "Cliente" se ninguém informou. Bloquear por nome
  custou 13/19 casos com o modelo pequeno.
- Férias/horário checados no fechamento.
- Documento final gravado com os mesmos campos que o painel/KDS/estoque já leem.

### 6.4 Prompt

- Bloco "PEDIDO EM ANDAMENTO (do servidor)" a cada mensagem: itens, entrega,
  pagamento, nome, total, o que falta.
- Seção de fechamento em ~25 linhas: adicionar na hora; "mais alguma coisa?"; entrega
  → pagamento → resumo → "posso fechar?" → `fechar_pedido` no "sim"; nunca dizer
  "registrado" sem `ok`; todo R$ vem de função.
- Nome: `definir_nome` no instante em que o cliente se apresenta; pedir junto com a
  confirmação do resumo; nunca "nome completo".
- Template do prompt: de ~20 mil para ~7,5 mil caracteres.

### 6.5 Fechamento determinístico

Se a última fala do bot perguntou "posso fechar?" (radicais `fech|confer|confirm|
finaliz|conclu|registr` + "?") **ou exibiu o total** ("Total … R$"), o cliente respondeu
com confirmação curta (`sim|pode|confere|isso|ok|fecha…`), nada falta, nada mudou desde
o resumo, e a IA **não** chamou `fechar_pedido` → o servidor fecha e responde com o
total. Um "sim" a outra pergunta não fecha. (É o oposto da retentativa forçada: aqui há
consentimento explícito e estado conhecido.)

### 6.6 Slots preenchidos pelo servidor (a lição das últimas rodadas)

O modelo pequeno **entende** a resposta do cliente mas nem sempre **chama** a função.
Cada slot do fluxo ganhou um preenchimento determinístico antes da IA, que só age no
ponto exato do fluxo e com carrinho não vazio:

| Cliente responde | Condição | Servidor faz |
|---|---|---|
| "retirada" / "entrega" | tipo vazio | `definir_entrega(tipo)` |
| "San Genaro" (sem dígito, ≤ 40 chars, bate com a lista) | entrega sem bairro | `definir_entrega(bairro)` |
| "Av. Brasil, 45" (dígito + letras, ≤ 80 chars, não cita item) | entrega com bairro, sem endereço | `definir_entrega(endereco)` |
| "pix" / "dinheiro" / "no cartão" | qualquer | `definir_pagamento` |
| "sim" depois do resumo/total | nada falta | `fechar_pedido` |

E o inverso — guardas contra o que a IA inventa: `definir_pagamento` só é aceito se a
forma apareceu em alguma fala do **cliente**; `adicionar_item` de item que já está no
carrinho é ignorado quando a mensagem cita **outro** item (o mini readicionava o carrinho
inteiro); `verificar_bairro_entrega` com "atende" no meio do fechamento grava o bairro;
`fechar_pedido` em < 5 min com carrinho vazio **ou idêntico** ao pedido fechado devolve
`ja_estava_fechado` e limpa a remontagem. A lista de bairros atendidos vai no prompt
(o mini respondia "não entregamos" de cabeça sem consultar).

Ordem que funcionou: cada rodada do harness expõe **um** slot pulado; a correção é
sempre no servidor, com um teste offline reproduzindo o turno exato do relatório.

---

## 7. Fase 5 — Modelo e custo (meio dia)

- Só depois do prompt encolher.
- `harness --modelo X -r 3` para 2–3 modelos; comparar aprovação × custo por conversa
  (`conversas_log.tokens_entrada` × preço).
- O valor gravado pelo painel no banco **vence** o padrão do código; trocar no painel
  só depois do deploy do código novo. Modelos "mini" custam 10–20× menos e, com prompt
  curto + regras no servidor, aprovam os mesmos casos de defesa.

---

## 8. Deploy

1. `git checkout -b fase-N` antes de cada fase; `pytest` (0 custo) verde.
2. Harness `-r 3` com o modelo que **vai** para produção; guardar o JSON como baseline.
   Testar o modelo que não será usado é custo sem retorno.
3. Deploy do código. Depois, trocar modelo no painel para o que foi testado.
4. Primeira semana: ler `conversas_log` (turnos com `observacao` ≠ null, erros,
   `fechamento_deterministico`), e itens marcados no painel para virar apelido.
5. Cada incidente novo → caso novo em `casos.py` **antes** da correção.

---

## 9. Armadilhas registradas (custaram tempo)

- Seed fictício com item que não existe na loja → teste validava a coisa errada.
  O seed deve espelhar a realidade do caso (apelido → item real).
- Snapshot desatualizado depois de mudar o painel. Regerar sempre.
- Item pausado no canal invisível para o bot (e para os apelidos).
- Heurística de texto com substring negativa ("temos X" dentro de "não temos X").
- Ordem de leitura de coleção em memória não é a de inserção → ordenar por
  timestamp antes de pegar "o último".
- `.bat`: fim de linha LF, sem `pause`, sem log → "não abre janela".
- Arquivos gravados por ferramenta assíncrona: conferir tamanho/hash no destino antes
  de dizer que gravou.
- Modelo pequeno: pergunta duas coisas de uma vez, pula "mais alguma coisa?",
  reconfirma valores no turno do "sim", pede "nome completo", inventa a forma de
  pagamento, "consulta" o bairro em vez de defini-lo, remonta o carrinho inteiro ao
  receber um segundo "confirma", termina a resposta do PIX sem perguntar "posso
  fechar?". Cada um desses tem contramedida no servidor, não só no prompt (seção 6.6).
- Ler o harness por caso (aprovado/reprovado) esconde o progresso: 55 → 56 → 55
  conversas de 57 parece "voltou a piorar" e é ruído. Some as conversas.
- Modelos de raciocínio (família GPT-5): tokens de "pensamento" são cobrados como
  saída e aumentam a latência; num bot de pedido, rodar com `reasoning_effort: "none"`
  (parâmetro rejeitado pelos modelos 4o — enviar só quando o modelo aceita).

---

## 10. Checklist para um bot novo

- [ ] Diagnóstico escrito (tabela da seção 1) e lista dos incidentes do código.
- [ ] Log append-only + remoção de ações forçadas + travas corrigidas + config única.
- [ ] Banco em memória + canal bloqueado + seed dos incidentes + snapshot da produção.
- [ ] Chat interativo com `/estado`, `/log`, `/catalogo`, `/exportar`.
- [ ] `casos.py` com todos os incidentes + fluxos básicos; harness com relatório por turno.
- [ ] Baseline medido com o modelo atual.
- [ ] Loop de ferramentas com limite e fechamento em texto.
- [ ] Catálogo com códigos + bloco de apelidos no prompt; ferramentas por id.
- [ ] Rascunho no servidor; `fechar()` sem parâmetros com validações; idempotência;
      setters idempotentes; nome não bloqueia; estado no prompt.
- [ ] Fechamento determinístico na confirmação explícita.
- [ ] Prompt reescrito (< 8 mil caracteres de template).
- [ ] Harness verde ≥ baseline; comparação de modelos; deploy; painel.
- [ ] Rotina: incidente → caso → correção → harness.

---

## 11. Números de referência (Gestor Chef)

| Métrica | Antes | Depois |
|---|---|---|
| Template do system prompt | 20,7 mil chars | 7,5 mil chars |
| Regras "NUNCA/JAMAIS" no prompt | ~40 | ~10 |
| Chamadas LLM por mensagem | 2 fixas (2ª sem tools) | 1–3 (loop, limite 5) |
| Leituras de config por mensagem | 4–5 | 1 |
| Resolução de item | fuzzy ≥ 70% | id exato |
| Estado do pedido | histórico de 24 msgs | documento no servidor |
| Testes sem custo | 0 | 39 |
| Casos de regressão com LLM real | 0 | 19 |
| Custo estimado por pedido (gpt-4o) | ~R$ 4–5 | ~R$ 1,5–2; com mini ~R$ 0,15 |
| Custo de uma rodada do harness (19 casos × 3) | — | gpt-4o ~US$ 20; gpt-4o-mini ~US$ 1,40 |

### Evolução do harness (gpt-4o-mini, 19 casos × 3 rodadas = 57 conversas)

| Rodada | O que mudou antes dela | Casos | Conversas |
|---|---|---|---|
| 1 | Fases 0–4 (rascunho no servidor) | 6/19 | 19 (33%) |
| 2 | Nome não bloqueia; heurísticas de texto | 6/19 | 32 (56%) |
| 3 | Setters idempotentes; fechamento determinístico | 8/19 | 28 (49%) |
| 4 | Gate `precisa_confirmar`; confirmação explícita; slots retirada/pagamento | 16/19 | 53 (93%) |
| 5 | Pagamento só dito pelo cliente; radicais de "fechar"; bairros no prompt; "só o item pedido" | 17/19 | 55 (96%) |
| 6 | Slot de endereço; guarda contra readicionar item | 18/19 | 56 (98%) |
| 7 | Trava de refechamento com carrinho idêntico | 17/19 | 55 (96%) |
| 8 | Slot de bairro; "sim" depois do total fecha; PIX termina com "posso fechar?" | 19/19 | 57 (100%) |

Na rodada final, o servidor fechou o pedido no lugar da IA em 2 conversas
(`fechamento_deterministico`) e a rede de segurança de texto disparou em 3
(`texto_confirmacao_sem_registrar_pedido`) — ambas sem pedido errado. Decisão: deploy
do código já com `gpt-4o-mini` no painel (a combinação testada), gpt-4o como retorno
imediato pelo painel se `conversas_log` mostrar muitas observações.
