# Worker: FastAPI + Postgres job loop. Parsing, analysis, agent runs, xlsx writing, embeddings, email.
FROM python:3.12-slim-bookworm

# LibreOffice (headless calc only) converts .xls → .xlsx; fonts so converted sheets keep metrics.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libreoffice-calc-nogui fonts-dejavu-core fonts-liberation2 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    MIGRATIONS_DIR=/app/db/migrations DATA_DIR=/data/files HOME=/tmp
WORKDIR /app/worker

COPY worker/pyproject.toml ./
RUN pip install --upgrade pip && python -c "import tomllib,subprocess,sys; d=tomllib.load(open('pyproject.toml','rb'))['project']['dependencies']; subprocess.check_call([sys.executable,'-m','pip','install',*d])"
COPY worker/app ./app
COPY db/migrations /app/db/migrations

ARG BUILD_HASH=dev
ENV BUILD_HASH=${BUILD_HASH}

RUN useradd --system --uid 10001 --home /tmp app && mkdir -p /data/files && chown -R app /data/files
USER app
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=4).status==200 else 1)"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--timeout-keep-alive", "75"]
