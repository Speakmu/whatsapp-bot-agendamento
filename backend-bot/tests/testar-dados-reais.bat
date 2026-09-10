@echo off
setlocal
echo [testar-dados-reais] iniciando...
cd /d "%~dp0.."
echo pasta: %CD%
if not exist tests\snapshot.json (
  echo Nao existe tests\snapshot.json. Gerando a partir da producao (somente leitura)...
  python tests\snapshot_producao.py
  if errorlevel 1 (
    echo Falhou ao gerar o snapshot. Veja a mensagem acima.
    pause
    exit /b 1
  )
)
call "%~dp0testar.bat" --snapshot tests\snapshot.json %*
if errorlevel 1 pause
