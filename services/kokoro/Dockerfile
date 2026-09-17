FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 HF_HOME=/cache/huggingface
RUN apt-get update && apt-get install -y --no-install-recommends espeak-ng libsndfile1 && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY requirements.txt .
# CPU-only torch keeps the image far smaller than the CUDA default.
RUN pip install --index-url https://download.pytorch.org/whl/cpu "torch==2.5.1" \
 && pip install -r requirements.txt \
 && python -m spacy download en_core_web_sm || true

COPY app.py .
RUN useradd -r -u 10001 -m kokoro && mkdir -p /cache && chown -R kokoro /cache /srv
USER kokoro
EXPOSE 8000
# Each worker is its own process with its own model and lock, so N workers synthesize N segments at once.
# Keep KOKORO_WORKERS x OMP_NUM_THREADS <= CPU cores (torch already multi-threads inside a request).
CMD ["sh", "-c", "exec uvicorn app:app --host 0.0.0.0 --port 8000 --workers ${KOKORO_WORKERS:-1}"]
