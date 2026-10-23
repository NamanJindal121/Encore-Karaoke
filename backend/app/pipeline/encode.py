import subprocess
from pathlib import Path

from ..config import FFMPEG, STEM_BITRATE


def to_aac(src: Path, dest: Path):
    subprocess.run(
        [FFMPEG, "-y", "-loglevel", "error", "-i", str(src),
         "-c:a", "aac", "-b:a", STEM_BITRATE, "-movflags", "+faststart", str(dest)],
        check=True,
    )
