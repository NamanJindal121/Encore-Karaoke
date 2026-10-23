import json
import logging
import queue
import shutil
import threading
import time

from . import db
from .config import LIBRARY_DIR
from .pipeline import download, encode, lyrics, peaks, separate

log = logging.getLogger(__name__)

# Live progress for in-flight jobs: {song_id: {"status", "progress", "error"}}
_state: dict[str, dict] = {}
_state_lock = threading.Lock()
# Items are ("song", id) for the full pipeline or ("lyrics", id) to (re)build lyrics only.
_queue: "queue.Queue[tuple[str, str]]" = queue.Queue()
# Seconds of processing per second of audio, refined after each job; drives progress estimates.
_sep_rate = [0.27]
_lyrics_rate = [0.15]


def song_dir(song_id: str):
    return LIBRARY_DIR / song_id


def _update(song_id: str, status: str, progress: float = 0.0, error: str | None = None, persist: bool = True):
    with _state_lock:
        prev = _state.get(song_id)
        _state[song_id] = {"status": status, "progress": round(progress, 3), "error": error}
    if persist and (prev is None or prev["status"] != status or status in db.TERMINAL):
        db.set_status(song_id, status, error)


def get_state(song_id: str) -> dict | None:
    with _state_lock:
        s = _state.get(song_id)
        if s:
            return dict(s)
    song = db.get(song_id)
    if not song:
        return None
    return {"status": song["status"], "progress": 1.0 if song["status"] == "ready" else 0.0, "error": song["error"]}


def song_state(song_id: str) -> dict | None:
    """Like get_state, but a ready song stays ready while a lyrics-only job runs on it."""
    song = db.get(song_id)
    if song and song["status"] == "ready":
        return {"status": "ready", "progress": 1.0, "error": None}
    return get_state(song_id)


def lyrics_status(song_id: str) -> str:
    """ready | pending | missing"""
    if (song_dir(song_id) / "lyrics.json").exists():
        return "ready"
    state = get_state(song_id)
    if state and state["status"] not in db.TERMINAL:
        return "pending"
    return "missing"


def enqueue(meta: dict) -> dict:
    """Queue a song unless it's already ready or in flight. Returns current state."""
    existing = db.get(meta["id"])
    if existing and existing["status"] not in db.TERMINAL:
        return get_state(meta["id"])
    if existing and existing["status"] == "ready" and (song_dir(meta["id"]) / "peaks.json").exists():
        return get_state(meta["id"])
    db.upsert({**meta, "status": "queued"})
    _update(meta["id"], "queued")
    _queue.put(("song", meta["id"]))
    return get_state(meta["id"])


def enqueue_lyrics(song_id: str) -> dict:
    """Queue a lyrics-only job for a ready song. Its DB status stays 'ready' throughout."""
    state = get_state(song_id)
    if state and state["status"] not in db.TERMINAL:
        return state
    (song_dir(song_id) / "lyrics.json").unlink(missing_ok=True)
    _update(song_id, "lyrics", 0.0, persist=False)
    _queue.put(("lyrics", song_id))
    return get_state(song_id)


def _estimate(song_id: str, status: str, audio_sec: float, rate: list[float], persist: bool):
    """Tick estimated progress for a stage that has no progress callback. Returns a stop function."""
    t0 = time.time()
    done = threading.Event()

    def tick():
        while not done.wait(0.5):
            _update(song_id, status, min((time.time() - t0) / (audio_sec * rate[0]), 0.97), persist=False)

    _update(song_id, status, 0.0, persist=persist)
    threading.Thread(target=tick, daemon=True).start()

    def stop():
        done.set()
        elapsed = time.time() - t0
        rate[0] = elapsed / audio_sec
        return elapsed

    return stop


def build_lyrics(song_id: str, vocals, info: dict | None = None, persist: bool = True):
    """Write lyrics.json. Never raises: a song without lyrics is still a playable song."""
    song = db.get(song_id)
    audio_sec = float((song and song["duration"]) or (info or {}).get("duration") or 240)
    stop = _estimate(song_id, "lyrics", audio_sec, _lyrics_rate, persist)
    try:
        out = lyrics.build(vocals, song["title"], song["channel"], song["duration"], info)
    except Exception:  # noqa: BLE001
        log.exception("[%s] lyrics failed", song_id)
        out = {"source": "none", "lines": []}
    finally:
        elapsed = stop()
    (song_dir(song_id) / "lyrics.json").write_text(json.dumps(out, ensure_ascii=False))
    log.info("[%s] lyrics (%s, %d lines) in %.1fs", song_id, out["source"], len(out["lines"]), elapsed)


def process(song_id: str):
    """Run the full pipeline for one song. Raises on failure."""
    out = song_dir(song_id)
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()

    _update(song_id, "downloading", 0.0)
    wav, info = download.download_audio(song_id, out, lambda p: _update(song_id, "downloading", p))
    info = info or {}
    log.info("[%s] downloaded in %.1fs", song_id, time.time() - t0)

    audio_sec = float(info.get("duration") or 240)
    stop = _estimate(song_id, "separating", audio_sec, _sep_rate, persist=True)
    try:
        stems = separate.separate(wav, out)
    finally:
        elapsed = stop()
    log.info("[%s] separated in %.1fs (%.2fs per audio second)", song_id, elapsed, _sep_rate[0])

    _update(song_id, "encoding", 0.0)
    result = {}
    for i, (stem, path) in enumerate(stems.items()):
        p, duration = peaks.compute(path)
        result[stem] = p
        result["duration"] = duration
        encode.to_aac(path, out / f"{stem}.m4a")
        _update(song_id, "encoding", (i + 1) / len(stems))
    (out / "peaks.json").write_text(json.dumps(result))

    separate.free_gpu_cache()
    build_lyrics(song_id, stems["vocals"], info)

    for leftover in [wav, *stems.values()]:
        leftover.unlink(missing_ok=True)
    log.info("[%s] done in %.1fs", song_id, time.time() - t0)
    return info


def _worker():
    while True:
        kind, song_id = _queue.get()
        try:
            if kind == "lyrics":
                build_lyrics(song_id, song_dir(song_id) / "vocals.m4a", persist=False)
            else:
                process(song_id)
                _update(song_id, "ready", 1.0)
        except Exception as e:  # noqa: BLE001 — surface any failure to the UI
            log.exception("[%s] %s job failed", song_id, kind)
            if kind == "song":  # a failed lyrics-only job leaves the song playable
                _update(song_id, "error", 0.0, str(e).splitlines()[0][:300] if str(e) else type(e).__name__)
        finally:
            with _state_lock:
                _state.pop(song_id, None)
            _queue.task_done()


def start_worker():
    threading.Thread(target=_worker, name="karaoke-worker", daemon=True).start()
    # Load the model in the background so the first song doesn't pay for it.
    threading.Thread(target=separate.warmup, name="model-warmup", daemon=True).start()


def remove(song_id: str):
    shutil.rmtree(song_dir(song_id), ignore_errors=True)
    db.delete(song_id)
