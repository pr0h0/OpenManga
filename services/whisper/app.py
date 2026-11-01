"""Local speech recognition with word timings (faster-whisper on CPU), for matching recorded narration to its text."""

import json
import logging
import os
import tempfile
import threading
import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

MODEL = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
# 0 = every core. Measured on 8 cores: large-v3-turbo int8 transcribes at ~0.55x real time.
THREADS = int(os.environ.get("WHISPER_THREADS", "0"))
MAX_UPLOAD_BYTES = int(os.environ.get("WHISPER_MAX_UPLOAD_MB", "2048")) * 1024 * 1024

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("whisper")
state = {"status": "loading", "detail": "starting", "model": MODEL}
model = None
# A transcription uses every thread; two at once would each run at half speed, so requests take turns.
busy = threading.Lock()


def _load():
    global model
    try:
        from faster_whisper import WhisperModel

        state["detail"] = "downloading/loading model (first start can take a few minutes)"
        t = time.time()
        model = WhisperModel(MODEL, device="cpu", compute_type="int8", cpu_threads=THREADS)
        state.update(status="ready", detail="ok")
        log.info(f"model {MODEL} ready in {time.time() - t:.1f}s")
    except Exception as e:  # pragma: no cover - reported via /health
        state.update(status="error", detail=str(e)[:500])
        log.exception("model load failed")


threading.Thread(target=_load, daemon=True).start()
app = FastAPI(title="Whisper STT", docs_url=None, redoc_url=None)


@app.get("/health")
def health():
    return JSONResponse(state, status_code=200 if state["status"] == "ready" else 503)


@app.post("/transcribe")
async def transcribe(request: Request, language: str | None = None):
    """
    The request body is the audio file (any format ffmpeg reads). The answer is NDJSON, one line per recognised
    stretch as it is transcribed: {"words": [[start, end, word], ...], "end": seconds}, after a first line
    {"duration", "language"} and before a last line {"done": true}; a line {"error"} ends it on failure.
    """
    if state["status"] != "ready":
        return JSONResponse({"error": f"Model not ready: {state['detail']}"}, status_code=503)
    from faster_whisper.tokenizer import _LANGUAGE_CODES

    lang = (language or "").split("-")[0].lower() or None
    if lang not in _LANGUAGE_CODES:
        lang = None  # detect it
    fd, path = tempfile.mkstemp(dir="/tmp/uploads", suffix=".audio")
    size = 0
    try:
        with os.fdopen(fd, "wb") as f:
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    os.unlink(path)
                    return JSONResponse({"error": "Audio file too large"}, status_code=413)
                f.write(chunk)
    except Exception:
        os.unlink(path)
        raise

    def lines():
        try:
            with busy:
                t = time.time()
                segments, info = model.transcribe(
                    path,
                    language=lang,
                    word_timestamps=True,
                    beam_size=1,
                    # Long recordings: without this a misheard stretch can repeat itself for minutes.
                    condition_on_previous_text=False,
                )
                yield json.dumps({"duration": info.duration, "language": info.language}) + "\n"
                for s in segments:
                    words = [[round(w.start, 3), round(w.end, 3), w.word] for w in (s.words or [])]
                    yield json.dumps({"words": words, "end": round(s.end, 3)}, ensure_ascii=False) + "\n"
                log.info(f"transcribed {info.duration:.0f}s in {time.time() - t:.0f}s ({info.language})")
                yield json.dumps({"done": True}) + "\n"
        except Exception as e:
            log.exception("transcription failed")
            yield json.dumps({"error": str(e)[:500]}) + "\n"
        finally:
            os.unlink(path)

    return StreamingResponse(lines(), media_type="application/x-ndjson")
