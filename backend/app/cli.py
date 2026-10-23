"""Command-line tools.

    python -m app.cli <video_id>          process a YouTube video end to end
    python -m app.cli lyrics <video_id>   (re)build lyrics for a song already in the library
"""
import json
import logging
import sys
import time

from . import db, jobs
from .pipeline import download, lyrics

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


def build_lyrics(video_id: str):
    song = db.get(video_id)
    if not song or song["status"] != "ready":
        sys.exit(f"{video_id} is not a ready song in the library")
    t0 = time.time()
    out = lyrics.build(jobs.song_dir(video_id) / "vocals.m4a", song["title"], song["channel"], song["duration"])
    (jobs.song_dir(video_id) / "lyrics.json").write_text(json.dumps(out, ensure_ascii=False))
    print(f"--- {time.time() - t0:.1f}s  source={out['source']}  language={out.get('language')}  lines={len(out['lines'])}")
    for line in out["lines"]:
        print(f"{line['start']:7.2f} {line['end']:7.2f}  {line['text']}")


def main():
    if sys.argv[1] == "lyrics":
        return build_lyrics(sys.argv[2])
    video_id = sys.argv[1]
    db.init()
    info = download.fetch_info(video_id)
    db.upsert({"id": video_id, "title": info.get("title"), "channel": info.get("channel"),
               "duration": info.get("duration"), "thumbnail": info.get("thumbnail"), "status": "queued"})
    t0 = time.time()
    jobs.process(video_id)
    db.set_status(video_id, "ready")
    print(f"Done in {time.time() - t0:.1f}s → {jobs.song_dir(video_id)}")


if __name__ == "__main__":
    main()
