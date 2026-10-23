import os
import shutil
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]
LIBRARY_DIR = Path(os.environ.get("KARAOKE_LIBRARY_DIR", ROOT_DIR / "library"))
DB_PATH = Path(os.environ.get("KARAOKE_DB", ROOT_DIR / "library.db"))
MODEL_DIR = Path(os.environ.get("KARAOKE_MODEL_DIR", Path.home() / ".cache" / "audio-separator"))

SEPARATOR_MODEL = os.environ.get("KARAOKE_MODEL", "model_bs_roformer_ep_317_sdr_12.9755.ckpt")
SEPARATOR_OVERLAP = int(os.environ.get("KARAOKE_OVERLAP", 2))  # model default is 4; 2 is ~2x faster, ~0.1 dB SDR
WHISPER_MODEL = os.environ.get("KARAOKE_WHISPER_MODEL", "large-v3")
MAX_DURATION_SEC = int(os.environ.get("KARAOKE_MAX_DURATION", 15 * 60))
STEM_BITRATE = "256k"
PEAK_BUCKETS = 2400
STEMS = ("vocals", "instrumental")

LIBRARY_DIR.mkdir(parents=True, exist_ok=True)
MODEL_DIR.mkdir(parents=True, exist_ok=True)

FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
