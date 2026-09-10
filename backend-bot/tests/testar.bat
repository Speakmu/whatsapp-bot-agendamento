@echo off
setlocal
echo [testar] iniciando...
cd /d "%~dp0.."
set "LOG=%~dp0ultimo_teste.log"
echo ===== %date% %time% ===== > "%LOG%"
echo pasta: %CD% >> "%LOG%"

if exist venv\Scripts\activate.bat (
  call venv\Scripts\activate.bat
  echo [ok] venv ativado >> "%LOG%"
) else (
  echo [aviso] pasta venv nao encontrada, usando o Python do sistema >> "%LOG%"
)

set "PY=python"
python --version >nul 2>&1
if errorlevel 1 set "PY=py"
%PY% --version >> "%LOG%" 2>&1
if errorlevel 1 (
  echo ERRO: Python nao encontrado no PATH. Instale o Python ou ative o venv.
  echo ERRO: Python nao encontrado no PATH. >> "%LOG%"
  pause
  exit /b 1
)

if not exist .env (
  echo ERRO: arquivo .env nao encontrado em %CD%
  echo ERRO: arquivo .env nao encontrado em %CD% >> "%LOG%"
  pause
  exit /b 1
)

%PY% -c "import mockfirestore" >nul 2>&1
if errorlevel 1 (
  echo [instalando] mock-firestore
  echo [instalando] mock-firestore >> "%LOG%"
  %PY% -m pip install mock-firestore >> "%LOG%" 2>&1
)
%PY% -c "import flask, openai, firebase_admin, thefuzz, dotenv" >> "%LOG%" 2>&1
if errorlevel 1 (
  echo [instalando] dependencias do bot ^(requirements.txt^)
  echo [instalando] dependencias do bot >> "%LOG%"
  %PY% -m pip install -r requirements.txt >> "%LOG%" 2>&1
)

echo. >> "%LOG%"
echo ----- iniciando ambiente de teste ----- >> "%LOG%"
echo argumentos: %* >> "%LOG%"
%PY% tests\ambiente_teste.py %* 2>> "%LOG%"
set "RC=%ERRORLEVEL%"
echo. >> "%LOG%"
echo ----- encerrou com codigo %RC% ----- >> "%LOG%"
if not "%RC%"=="0" (
  echo.
  echo O ambiente encerrou com erro ^(codigo %RC%^). Conteudo do log:
  echo ------------------------------------------------------------
  type "%LOG%"
)
echo.
echo Log completo em: %LOG%
pause
