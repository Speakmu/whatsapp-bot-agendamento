@echo off
setlocal
echo [testar-dados-reais] iniciando...
cd /d "%~dp0.."
echo pasta: %CD%
echo Atualizando o retrato da producao (somente leitura, nao grava nada)...
python tests\snapshot_producao.py
if errorlevel 1 (
  if exist tests\snapshot.json (
    echo Nao consegui atualizar; usando o retrato antigo que ja existe.
  ) else (
    echo Falhou ao gerar o retrato. Veja a mensagem acima.
    pause
    exit /b 1
  )
)
rem Modelo de teste com limite alto: o gpt-4o tem so 30 mil tokens por minuto e disputa com o bot real.
rem Para outro modelo: testar-dados-reais.bat --modelo gpt-4o
call "%~dp0testar.bat" --snapshot tests\snapshot.json --modelo gpt-4.1-mini %*
if errorlevel 1 pause
