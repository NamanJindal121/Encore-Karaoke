import yt_dlp

_OPTS = {
    "quiet": True,
    "no_warnings": True,
    "skip_download": True,
    "extract_flat": "in_playlist",
}


def _thumbnail(entry: dict) -> str | None:
    thumbs = entry.get("thumbnails") or []
    if thumbs:
        # Prefer a mid-size thumbnail; the largest ones are heavy for a results list.
        sized = [t for t in thumbs if t.get("width")]
        if sized:
            sized.sort(key=lambda t: t["width"])
            for t in sized:
                if t["width"] >= 320:
                    return t["url"]
            return sized[-1]["url"]
        return thumbs[-1].get("url")
    return f"https://i.ytimg.com/vi/{entry['id']}/hqdefault.jpg"


def search(query: str, limit: int = 12) -> list[dict]:
    with yt_dlp.YoutubeDL(_OPTS) as ydl:
        info = ydl.extract_info(f"ytsearch{limit}:{query}", download=False)
    results = []
    for e in info.get("entries") or []:
        if not e or not e.get("id") or e.get("live_status") == "is_live":
            continue
        # Flat search also returns channels/playlists; keep plain videos only.
        if e.get("ie_key") not in (None, "Youtube") or len(e["id"]) != 11:
            continue
        results.append(
            {
                "id": e["id"],
                "title": e.get("title") or "Untitled",
                "channel": e.get("channel") or e.get("uploader"),
                "duration": e.get("duration"),
                "thumbnail": _thumbnail(e),
            }
        )
    return results
