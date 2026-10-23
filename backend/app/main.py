import asyncio
import json
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import db, jobs, search
from .pipeline import lyrics
from .config import LIBRARY_DIR, MAX_DURATION_SEC

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.init()
    jobs.start_worker()
    yield


app = FastAPI(title="Karaoke", lifespan=lifespan)


def _song_payload(song: dict) -> dict:
    payload = {**song, **(jobs.song_state(song["id"]) or {})}
    if payload["status"] == "ready":
        payload["stems"] = {s: f"/media/{song['id']}/{s}.m4a" for s in ("vocals", "instrumental")}
    return payload


@app.get("/api/search")
async def api_search(q: str):
    q = q.strip()
    if not q:
        return []
    try:
        results = await run_in_threadpool(search.search, q)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"YouTube search failed: {e}") from e
    known = db.get_many([r["id"] for r in results])
    for r in results:
        state = jobs.song_state(r["id"]) if r["id"] in known else None
        r["status"] = state["status"] if state else None
        r["progress"] = state["progress"] if state else 0
        r["too_long"] = bool(r["duration"] and r["duration"] > MAX_DURATION_SEC)
    return results


@app.get("/api/songs")
def api_songs():
    return [_song_payload(s) for s in db.list_all()]


@app.get("/api/songs/{song_id}")
def api_song(song_id: str):
    song = db.get(song_id)
    if not song:
        raise HTTPException(404, "Song not found")
    payload = _song_payload(song)
    peaks_file = jobs.song_dir(song_id) / "peaks.json"
    if payload["status"] == "ready" and peaks_file.exists():
        payload["peaks"] = json.loads(peaks_file.read_text())
    payload["lyrics_status"] = jobs.lyrics_status(song_id)
    lyrics_file = jobs.song_dir(song_id) / "lyrics.json"
    payload["lyrics"] = json.loads(lyrics_file.read_text()) if payload["lyrics_status"] == "ready" else None
    return payload


class LineEdit(BaseModel):
    text: str


@app.put("/api/songs/{song_id}/lyrics/lines/{index}")
def api_edit_line(song_id: str, index: int, edit: LineEdit):
    if jobs.lyrics_status(song_id) != "ready":
        raise HTTPException(409, "Lyrics aren't ready")
    text = " ".join(edit.text.split())
    if not text:
        raise HTTPException(400, "A lyric line can't be empty")
    path = jobs.song_dir(song_id) / "lyrics.json"
    data = json.loads(path.read_text())
    if not 0 <= index < len(data["lines"]):
        raise HTTPException(404, "No such line")
    line = lyrics.edit_line(data, index, text)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False))
    tmp.replace(path)  # atomic: a crash mid-write can't corrupt the file
    return line


@app.post("/api/songs/{song_id}/lyrics")
def api_lyrics(song_id: str):
    song = db.get(song_id)
    if not song or song["status"] != "ready":
        raise HTTPException(409, "Song isn't ready yet")
    return jobs.enqueue_lyrics(song_id)


class SongRequest(BaseModel):
    id: str
    title: str
    channel: str | None = None
    duration: float | None = None
    thumbnail: str | None = None


@app.post("/api/songs")
def api_create(req: SongRequest):
    if len(req.id) != 11:
        raise HTTPException(400, "Invalid YouTube id")
    if req.duration and req.duration > MAX_DURATION_SEC:
        raise HTTPException(400, f"Songs longer than {MAX_DURATION_SEC // 60} minutes aren't supported")
    jobs.enqueue(req.model_dump())
    return _song_payload(db.get(req.id))


@app.delete("/api/songs/{song_id}")
def api_delete(song_id: str):
    state = jobs.get_state(song_id)
    if state and state["status"] not in db.TERMINAL:
        raise HTTPException(409, "Song is still processing")
    jobs.remove(song_id)
    return {"ok": True}


@app.get("/api/songs/{song_id}/events")
async def api_events(song_id: str):
    if not db.get(song_id):
        raise HTTPException(404, "Song not found")

    async def stream():
        last = None
        while True:
            state = jobs.get_state(song_id)
            if state != last:
                yield f"data: {json.dumps(state)}\n\n"
                last = state
            if not state or state["status"] in db.TERMINAL:
                return
            await asyncio.sleep(0.4)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


app.mount("/media", StaticFiles(directory=LIBRARY_DIR), name="media")
