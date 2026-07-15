#!/usr/bin/env bash
# ============================================================
#  GestorChef - Demo em 1 comando (Mac/Linux)
#  Sobe o emulador (com persistência), semeia na 1ª vez e
#  abre o painel no navegador.
# ============================================================
set -e
cd "$(dirname "$0")"

echo "=== GestorChef :: Ambiente de Demo ==="

# 1) Dependências
if [ ! -d node_modules ]; then
  echo "Instalando dependências (só na primeira vez)..."
  npm install
fi

DATA="emulator-data"
FBCFG="--project pizzain-40973 --config ../dashboard/firebase.json"

# 2) Sobe o emulador em background (importa se já houver dados; sempre exporta ao sair)
if [ -f "$DATA/firebase-export-metadata.json" ]; then
  echo "Iniciando emulador e carregando dados salvos..."
  npx firebase $FBCFG emulators:start --import=./$DATA --export-on-exit=./$DATA &
  SEMEAR=0
else
  echo "Primeira execução: iniciando emulador limpo..."
  npx firebase $FBCFG emulators:start --export-on-exit=./$DATA &
  SEMEAR=1
fi
EMU_PID=$!

echo "Aguardando o emulador subir..."
sleep 14

# 3) Semeia na primeira execução
if [ "$SEMEAR" = "1" ]; then
  echo "Populando dados de demonstração..."
  npm run seed || true
fi

# 4) Abre o painel
( command -v xdg-open >/dev/null && xdg-open http://localhost:5000 ) || \
( command -v open >/dev/null && open http://localhost:5000 ) || \
echo "Abra manualmente: http://localhost:5000"

cat <<EOF

============================================================
 Painel:      http://localhost:5000
 Emulator UI: http://localhost:4000
 Login:       demo@gestorchef.com  /  123456

 (Opcional) Simulação ao vivo: em outro terminal -> npm run sim
 Para PARAR: Ctrl+C aqui (os dados são salvos automaticamente).
============================================================
EOF

wait $EMU_PID
