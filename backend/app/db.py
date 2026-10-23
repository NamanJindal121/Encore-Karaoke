import sqlite3
import threading
import time
from contextlib import contextmanager

from .config import DB_PATH

_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS songs (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    channel     TEXT,
    duration    REAL,
    thumbnail   TEXT,
    status      TEXT NOT NULL,
    error       TEXT,
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL
);
"""

TERMINAL = ("ready", "error")


@contextmanager
def connect():
    with _lock:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()


def init():
    with connect() as conn:
        conn.executescript(SCHEMA)
        # Anything mid-flight when the server died will never finish.
        conn.execute(
            "UPDATE songs SET status='error', error='Interrupted — retry to process again', updated_at=? "
            "WHERE status NOT IN ('ready', 'error')",
            (time.time(),),
        )


def get(song_id: str) -> dict | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM songs WHERE id=?", (song_id,)).fetchone()
    return dict(row) if row else None


def get_many(ids: list[str]) -> dict[str, dict]:
    if not ids:
        return {}
    with connect() as conn:
        rows = conn.execute(
            f"SELECT * FROM songs WHERE id IN ({','.join('?' * len(ids))})", ids
        ).fetchall()
    return {r["id"]: dict(r) for r in rows}


def list_all() -> list[dict]:
    with connect() as conn:
        rows = conn.execute("SELECT * FROM songs ORDER BY updated_at DESC").fetchall()
    return [dict(r) for r in rows]


def upsert(song: dict):
    now = time.time()
    with connect() as conn:
        conn.execute(
            """INSERT INTO songs (id, title, channel, duration, thumbnail, status, error, created_at, updated_at)
               VALUES (:id, :title, :channel, :duration, :thumbnail, :status, NULL, :now, :now)
               ON CONFLICT(id) DO UPDATE SET
                 title=excluded.title, channel=excluded.channel, duration=excluded.duration,
                 thumbnail=excluded.thumbnail, status=excluded.status, error=NULL, updated_at=:now""",
            {**song, "now": now},
        )


def set_status(song_id: str, status: str, error: str | None = None):
    with connect() as conn:
        conn.execute(
            "UPDATE songs SET status=?, error=?, updated_at=? WHERE id=?",
            (status, error, time.time(), song_id),
        )


def delete(song_id: str):
    with connect() as conn:
        conn.execute("DELETE FROM songs WHERE id=?", (song_id,))
