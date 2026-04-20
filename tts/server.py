"""
tg-relay-tts sidecar — F5-TTS voice synthesis HTTP server.

Runs as a persistent local service. The tg-relay daemon POSTs text here when
Claude chooses to reply by voice. Returns synthesized WAV bytes for the
daemon to wrap as an ogg/opus Telegram voice note.

Reference audio is resolved per-channel:
  1. ~/.claude/channels/telegram-<name>/reference.wav + reference.txt
  2. ~/.cache/tg-relay-tts/reference.wav + reference.txt (global fallback)
  3. None → HTTP 404, daemon falls back to text reply

The model (F5TTS_v1_Base) is loaded once at startup and kept warm.
"""

import io
import logging
import os
import sys
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

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] %(message)s",
)
log = logging.getLogger("tg-relay-tts")

# ── Model (loaded at startup, held warm) ────────────────────────────────────

log.info(f"loading F5-TTS model: {DEFAULT_MODEL}")
tts = F5TTS(model=DEFAULT_MODEL)
log.info(f"model loaded, device={tts.device}")

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

# ── HTTP API ────────────────────────────────────────────────────────────────

app = FastAPI(title="tg-relay-tts")


class SynthesizeRequest(BaseModel):
    text: str
    channel: str
    nfe_step: int | None = None


@app.get("/health")
def health():
    return {"status": "ok", "device": str(tts.device), "model": DEFAULT_MODEL}


@app.post("/synthesize")
def synthesize(req: SynthesizeRequest):
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
    nfe = req.nfe_step or DEFAULT_NFE_STEP
    log.info(f"synthesize channel={req.channel} nfe={nfe} text={req.text[:60]!r}")

    try:
        wav, sr, _ = tts.infer(
            ref_file=str(ref_audio),
            ref_text=ref_text,
            gen_text=req.text,
            nfe_step=nfe,
            show_info=lambda *_: None,  # silence stdout chatter
            progress=None,
        )
    except Exception as err:
        log.exception("synthesis failed")
        raise HTTPException(500, f"synthesis failed: {err}")

    buf = io.BytesIO()
    sf.write(buf, wav, sr, format="WAV", subtype="PCM_16")
    buf.seek(0)
    return Response(content=buf.read(), media_type="audio/wav")


# ── Entrypoint ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("TG_RELAY_TTS_PORT", "8077"))
    host = os.environ.get("TG_RELAY_TTS_HOST", "127.0.0.1")
    log.info(f"starting on {host}:{port}")
    uvicorn.run(app, host=host, port=port, log_level="warning")
