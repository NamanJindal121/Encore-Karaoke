from pathlib import Path

import numpy as np
import soundfile as sf

from ..config import PEAK_BUCKETS


def compute(wav: Path, buckets: int = PEAK_BUCKETS) -> tuple[list[float], float]:
    """Per-bucket peak amplitude (0..1) of the mono mix, plus duration in seconds."""
    data, sr = sf.read(str(wav), dtype="float32", always_2d=True)
    mono = np.abs(data).max(axis=1)
    duration = len(mono) / sr
    if len(mono) == 0:
        return [0.0] * buckets, 0.0
    edges = np.linspace(0, len(mono), buckets + 1, dtype=np.int64)
    peaks = np.array([mono[a:b].max() if b > a else 0.0 for a, b in zip(edges[:-1], edges[1:])])
    top = peaks.max()
    if top > 0:
        peaks = peaks / top
    return [round(float(p), 3) for p in peaks], duration
