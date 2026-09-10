# Testes do bot (backend-bot)

Nada aqui toca a produção: o Firestore é em memória (ou o emulador) e o
envio de WhatsApp é bloqueado. Só a OpenAI é real, quando indicado.

## Conversar com o bot (ambiente de teste)

```bash
cd backend-bot
pip install mock-firestore              # 1ª vez
python tests/ambiente_teste.py          # chat no terminal
python tests/ambiente_teste.py --web    # + página em http://localhost:5055/teste
python tests/ambiente_teste.py --modelo gpt-4o-mini
```
No Windows: duplo clique em `tests\testar.bat`. Precisa só do `.env` com
`OPENAI_API_KEY`. Comandos dentro do chat: `/pedidos`, `/log` (ferramentas,
tokens, tempo do último turno), `/cardapio`, `/esgotar X`, `/manual`, `/novo`,
`/exportar`, `/sair`.

## Camadas de teste

| Arquivo | O que testa | Precisa de | Comando |
|---|---|---|---|
| `test_unidade.py` | funções puras (heurística de confirmação, normalização, horário, férias) | nada | `python -m pytest tests/test_unidade.py -q` |
| `test_fluxo_mock.py` | encanamento `/chat_app` → ferramentas → Firestore, com OpenAI de mentira e Firestore em memória | `pip install mock-firestore` | `python -m pytest tests/test_fluxo_mock.py -q` |
| `harness.py --memoria` | o bot DE VERDADE (OpenAI real), 19 casos de `casos.py`, Firestore em memória | `.env` + mock-firestore | `python tests/harness.py --memoria -r 3` |
| `harness.py` | idem, contra o emulador do Firestore (maior fidelidade: índices, regras) | emulador rodando + `.env` | `python tests/harness.py -r 3` |

Rode sempre a partir da pasta `backend-bot`. `firestore_memoria.py` é o
Firestore em memória compartilhado por todos (cobre `merge`, batch,
`DELETE_FIELD`, `Increment`, `SERVER_TIMESTAMP`).

## Harness (regressão real)

```bash
# terminal 1
cd dashboard
firebase emulators:start --only firestore --project salgadinhos-lileamar

# terminal 2
cd backend-bot
python tests/harness.py            # 1 rodada
python tests/harness.py -r 3       # aprova um caso só se passar nas 3 rodadas
python tests/harness.py -k dupla -v   # filtra por nome e mostra a conversa
```

O harness aponta o app pro emulador antes de importar e aborta se não houver
nada escutando na porta — não tem caminho pra cair na produção. O relatório
completo (cada resposta do bot + o pedido gravado) fica em `tests/relatorios/`.

`python tests/harness.py --memoria --modelo gpt-4o-mini` troca o modelo só
no teste (a config de produção não é tocada) — é assim que se compara custo ×
acerto entre modelos na Fase 5.

## Casos

Cada caso em `casos.py` é um incidente real documentado nos comentários do
`app.py` (ou um fluxo básico). O cardápio e a config que os casos esperam
estão em `seed_emulador.py`. Asserções de **estado** (pedido gravado, itens,
taxa, total) são confiáveis; asserções de **texto** (`resposta_contem` etc.)
são heurísticas — um caso que falha só nelas merece leitura manual antes de
contar como erro.

## Baseline

Antes de qualquer refatoração, rode `-r 3` contra o bot atual e guarde o
relatório. Esse número é o que cada fase seguinte precisa superar.
