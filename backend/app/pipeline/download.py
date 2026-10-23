from pathlib import Path
from typing import Callable

import yt_dlp

from ..config import FFMPEG, MAX_DURATION_SEC


class DownloadError(Exception):
    pass


def fetch_info(video_id: str) -> dict:
    with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "skip_download": True}) as ydl:
        return ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)


def download_audio(video_id: str, dest_dir: Path, on_progress: Callable[[float], None]) -> tuple[Path, dict]:
    """Download the best audio stream and convert it to dest_dir/original.wav."""

    def hook(d):
        if d["status"] == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            if total:
                on_progress(min(d.get("downloaded_bytes", 0) / total, 1.0))

    opts = {
        "quiet": True,
        "no_warnings": True,
        "format": "bestaudio/best",
        "outtmpl": str(dest_dir / "original.%(ext)s"),
        "ffmpeg_location": FFMPEG,
        "progress_hooks": [hook],
        "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "wav"}],
        "match_filter": yt_dlp.utils.match_filter_func(f"duration <= {MAX_DURATION_SEC}"),
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=True)

    wav = dest_dir / "original.wav"
    if not wav.exists():
        if info and (info.get("duration") or 0) > MAX_DURATION_SEC:
            raise DownloadError(f"Video is longer than {MAX_DURATION_SEC // 60} minutes")
        raise DownloadError("Download failed — no audio produced")
    return wav, info
