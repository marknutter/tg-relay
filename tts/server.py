"""
tg-relay-tts sidecar — F5-TTS voice synthesis HTTP server.

Runs as a persistent local service. The tg-relay daemon POSTs text here when
Claude chooses to reply by voice. Returns synthesized WAV bytes for the
daemon to wrap as an ogg/opus Telegram voice note.

Reference audio is resolved per-channel:
  1. ~/.claude/channels/telegram-<name>/reference.wav + reference.txt
  2. ~/.cache/tg-relay-tts/reference.wav + reference.txt (global fallback)
  3. None → HTTP 404, daemon falls back to text reply

Memory: the F5-TTS model (~4 GB resident on the MPS GPU / unified memory) is
loaded LAZILY on the first synth, held warm only briefly so a burst of replies
reuses it, then EVICTED after TG_RELAY_TTS_IDLE_EVICT_SEC of idle to return the
RAM. First synth after idle pays a ~15s cold load; the daemon's timeout (5 min)
covers it. This keeps voice from costing ~4 GB of warm RAM 24/7 on a 16 GB box.
"""

import gc
import io
import json
import logging
import os
import sys
import threading
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response, JSONResponse
from pydantic import BaseModel

# F5-TTS imports. These pull in torch + vocos + a lot of machinery — ~15s load.
from f5_tts.api import F5TTS
import soundfile as sf

# ── Config ──────────────────────────────────────────────────────────────────

HOME = Path.home()
CHANNELS_ROOT = HOME / ".claude" / "channels"
GLOBAL_REF_DIR = HOME / ".cache" / "tg-relay-tts"
DEFAULT_NFE_STEP = int(os.environ.get("TG_RELAY_TTS_NFE_STEP", "6"))
DEFAULT_MODEL = os.environ.get("TG_RELAY_TTS_MODEL", "F5TTS_v1_Base")
# Evict the model after this many seconds of no synth requests (0 = never evict,
# i.e. the old always-warm behavior). Default 120s: a back-and-forth of voice
# replies stays warm, then the ~4 GB is released ~2 min after the last one.
IDLE_EVICT_SEC = int(os.environ.get("TG_RELAY_TTS_IDLE_EVICT_SEC", "120"))

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] %(message)s",
)
log = logging.getLogger("tg-relay-tts")

# ── Model lifecycle (lazy load + idle eviction) ──────────────────────────────
# The model is NOT loaded at startup. get_tts() loads it on demand under the
# lock; the background evictor frees it after IDLE_EVICT_SEC idle. The lock is
# held through inference so the evictor never frees mid-synth.

_tts = None
_tts_lock = threading.RLock()
_last_used = 0.0


def get_tts():
    """Return the F5-TTS model, loading it (under lock) if not resident."""
    global _tts, _last_used
    with _tts_lock:
        if _tts is None:
            log.info(f"loading F5-TTS model: {DEFAULT_MODEL}")
            t0 = time.time()
            _tts = F5TTS(model=DEFAULT_MODEL)
            log.info(f"model loaded in {time.time() - t0:.1f}s, device={_tts.device}")
        _last_used = time.time()
        return _tts


def _evict_model():
    """Drop the model and free its GPU/unified memory."""
    global _tts
    with _tts_lock:
        if _tts is None:
            return
        log.info("evicting idle F5-TTS model to free memory")
        _tts = None
    gc.collect()
    try:
        import torch
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()
    except Exception as err:
        log.warning(f"mps empty_cache failed: {err}")


def _evictor_loop():
    """Background thread: evict the model once it's been idle past the TTL."""
    if IDLE_EVICT_SEC <= 0:
        return
    while True:
        time.sleep(min(30, IDLE_EVICT_SEC))
        with _tts_lock:
            loaded = _tts is not None
            idle = time.time() - _last_used
        if loaded and idle >= IDLE_EVICT_SEC:
            _evict_model()


threading.Thread(target=_evictor_loop, daemon=True, name="tts-evictor").start()

# ── Reference resolution ────────────────────────────────────────────────────

def resolve_reference(channel: str) -> tuple[Path, str] | None:
    """Return (ref_audio_path, ref_text) for a channel, or None if unavailable."""
    candidates = [
        CHANNELS_ROOT / f"telegram-{channel}",
        GLOBAL_REF_DIR,
    ]
    for base in candidates:
        wav = base / "reference.wav"
        txt = base / "reference.txt"
        if wav.exists() and txt.exists():
            try:
                text = txt.read_text(encoding="utf-8").strip()
                if text:
                    return wav, text
            except Exception as err:
                log.warning(f"failed reading {txt}: {err}")
    return None


def load_channel_config(channel: str) -> dict:
    """Read <channel-dir>/tts.json then global tts.json. Returns merged dict, {} if neither exists."""
    merged: dict = {}
    for base in (GLOBAL_REF_DIR, CHANNELS_ROOT / f"telegram-{channel}"):
        cfg_path = base / "tts.json"
        if not cfg_path.exists():
            continue
        try:
            data = json.loads(cfg_path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                merged.update(data)
        except Exception as err:
            log.warning(f"failed parsing {cfg_path}: {err}")
    return merged

# ── HTTP API ────────────────────────────────────────────────────────────────

app = FastAPI(title="tg-relay-tts")


class SynthesizeRequest(BaseModel):
    text: str
    channel: str
    nfe_step: int | None = None
    speed: float | None = None


@app.get("/health")
def health():
    # Do NOT load the model just to answer a health check.
    with _tts_lock:
        loaded = _tts is not None
        device = str(_tts.device) if loaded else None
    return {
        "status": "ok",
        "model": DEFAULT_MODEL,
        "model_loaded": loaded,
        "device": device,
        "idle_evict_sec": IDLE_EVICT_SEC,
    }


@app.post("/synthesize")
def synthesize(req: SynthesizeRequest):
    global _last_used

    if not req.text.strip():
        raise HTTPException(400, "text must not be empty")

    ref = resolve_reference(req.channel)
    if ref is None:
        log.info(f"no reference audio for channel={req.channel}")
        return JSONResponse(
            status_code=404,
            content={"error": f"no reference.wav/reference.txt for channel '{req.channel}' (and no global fallback)"},
        )

    ref_audio, ref_text = ref
    cfg = load_channel_config(req.channel)
    nfe = req.nfe_step or cfg.get("nfe_step") or DEFAULT_NFE_STEP
    speed = req.speed if req.speed is not None else float(cfg.get("speed", 1.0))
    log.info(f"synthesize channel={req.channel} nfe={nfe} speed={speed} text={req.text[:60]!r}")

    # Hold the lock across load+infer so the evictor can't free mid-synth and
    # concurrent requests serialize on the single GPU model.
    with _tts_lock:
        tts = get_tts()
        try:
            wav, sr, _ = tts.infer(
                ref_file=str(ref_audio),
                ref_text=ref_text,
                gen_text=req.text,
                nfe_step=nfe,
                speed=speed,
                show_info=lambda *_: None,  # silence stdout chatter
                progress=None,
            )
        except Exception as err:
            log.exception("synthesis failed")
            raise HTTPException(500, f"synthesis failed: {err}")
        finally:
            # Start the idle clock from synth completion, not model load.
            _last_used = time.time()

    buf = io.BytesIO()
    sf.write(buf, wav, sr, format="WAV", subtype="PCM_16")
    buf.seek(0)
    return Response(content=buf.read(), media_type="audio/wav")


# ── Entrypoint ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("TG_RELAY_TTS_PORT", "8077"))
    host = os.environ.get("TG_RELAY_TTS_HOST", "127.0.0.1")
    log.info(f"starting on {host}:{port} (lazy load, idle-evict={IDLE_EVICT_SEC}s)")
    uvicorn.run(app, host=host, port=port, log_level="warning")
