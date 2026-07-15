@echo off
REM ============================================================
REM  GestorChef - Demo em 1 clique (Windows)
REM  Sobe o emulador (com persistencia), semeia na 1a vez e
REM  abre o painel no navegador.
REM ============================================================
setlocal
cd /d "%~dp0"

echo.
echo === GestorChef :: Ambiente de Demo ===
echo.

REM 1) Instala dependencias se necessario (firebase-tools + firebase-admin)
if not exist "node_modules" (
  echo Instalando dependencias (so na primeira vez)...
  call npm install || goto :erro
)

set "DATA=emulator-data"
set "FBCFG=--project pizzain-40973 --config ..\dashboard\firebase.json"

REM 2) Sobe o emulador (importa dados se ja existirem; sempre exporta ao sair)
if exist "%DATA%\firebase-export-metadata.json" (
  echo Iniciando emulador e carregando dados salvos...
  start "GestorChef Emulador" cmd /k npx firebase %FBCFG% emulators:start --import=.\%DATA% --export-on-exit=.\%DATA%
  set "SEMEAR=0"
) else (
  echo Primeira execucao: iniciando emulador limpo...
  start "GestorChef Emulador" cmd /k npx firebase %FBCFG% emulators:start --export-on-exit=.\%DATA%
  set "SEMEAR=1"
)

echo Aguardando o emulador subir...
timeout /t 14 /nobreak >nul

REM 3) Semeia os dados de demonstracao na primeira execucao
if "%SEMEAR%"=="1" (
  echo Populando dados de demonstracao...
  call npm run seed
)

REM 4) Abre o painel
start "" http://localhost:5000

echo.
echo ============================================================
echo  Painel:        http://localhost:5000
echo  Emulator UI:   http://localhost:4000
echo  Login:         demo@gestorchef.com  /  123456
echo.
echo  (Opcional) Simulacao ao vivo: abra outro terminal e rode  npm run sim
echo  Para PARAR: feche a janela "GestorChef Emulador" (os dados sao salvos).
echo ============================================================
echo.
pause
exit /b 0

:erro
echo.
echo [ERRO] Falha ao instalar dependencias. Verifique o Node.js e a internet.
pause
exit /b 1
