FROM python:3.11-slim

WORKDIR /app

# Dependências do sistema pro Pillow/gspread não falharem no build.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Cloud Run injeta PORT em tempo de execução — o Procfile já usava esse
# padrão no Render, só trocamos o entrypoint pra CMD do container.
ENV PORT=8080
# Sem isso, os print() do app ficam no buffer do stdout e podem se perder
# quando a instância desliga por ociosidade (min-instances=0) antes do
# buffer ser esvaziado — dificulta debugar (log "some" no meio do processamento).
ENV PYTHONUNBUFFERED=1
EXPOSE 8080

CMD exec gunicorn app:app --bind 0.0.0.0:$PORT --timeout 120 --workers 1 --threads 8 --log-level info
