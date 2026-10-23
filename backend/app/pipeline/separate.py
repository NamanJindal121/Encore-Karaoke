import logging
import shutil
import threading
from pathlib import Path

from ..config import LIBRARY_DIR, MODEL_DIR, SEPARATOR_MODEL, SEPARATOR_OVERLAP

log = logging.getLogger(__name__)

WORK_DIR = LIBRARY_DIR / "_work"

_separator = None
_lock = threading.Lock()


def _get_separator():
    """Load the model once and keep it resident on the GPU."""
    global _separator
    if _separator is None:
        from audio_separator.separator import Separator

        WORK_DIR.mkdir(parents=True, exist_ok=True)
        sep = Separator(
            model_file_dir=str(MODEL_DIR),
            output_dir=str(WORK_DIR),
            output_format="WAV",
            use_autocast=True,
            mdxc_params={"segment_size": 256, "override_model_segment_size": False,
                         "batch_size": 1, "overlap": SEPARATOR_OVERLAP, "pitch_shift": 0},
            log_level=logging.WARNING,
        )
        log.info("Loading separator model %s", SEPARATOR_MODEL)
        sep.load_model(model_filename=SEPARATOR_MODEL)
        _separator = sep
    return _separator


def warmup():
    with _lock:
        _get_separator()


def free_gpu_cache():
    """Release the separator's cached activations so Whisper has room on the GPU."""
    import torch

    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def separate(wav: Path, dest_dir: Path) -> dict[str, Path]:
    """Split wav into vocals/instrumental WAVs inside dest_dir."""
    with _lock:
        sep = _get_separator()
        prefix = dest_dir.name
        outputs = sep.separate(
            str(wav),
            custom_output_names={"Vocals": f"{prefix}_vocals", "Instrumental": f"{prefix}_instrumental"},
        )

    result = {}
    for out in outputs:
        src = Path(out)
        if not src.is_absolute():
            src = WORK_DIR / src
        stem = "vocals" if src.stem.endswith("_vocals") else "instrumental"
        target = dest_dir / f"{stem}.wav"
        shutil.move(src, target)
        result[stem] = target
    if set(result) != {"vocals", "instrumental"}:
        raise RuntimeError(f"Separator produced unexpected outputs: {outputs}")
    return result
