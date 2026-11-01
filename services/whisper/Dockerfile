FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 HF_HOME=/cache/huggingface

WORKDIR /srv
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app.py .
RUN useradd -r -u 10001 -m whisper && mkdir -p /cache /tmp/uploads && chown -R whisper /cache /srv /tmp/uploads
USER whisper
EXPOSE 8000
# One process: a transcription already uses every thread it is given, and requests take turns (see app.py).
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
