"""Find lyrics on LRCLIB and time them against the separated vocals with Whisper."""
import json
import logging
import re
import subprocess
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

from ..config import FFMPEG, WHISPER_MODEL

log = logging.getLogger(__name__)

LRCLIB = "https://lrclib.net/api"
USER_AGENT = "EncoreKaraoke/0.1 (local karaoke app)"

_model = None
_lock = threading.Lock()

# Video-title noise that never belongs to the song name.
_NOISE = re.compile(
    r"\b(official|music|lyric(al)?s?|video|audio|visuali[sz]er|hd|hq|4k|remaster(ed)?|full|song|"
    r"explicit|clean|version|live|mv|m/v|from\s+the\s+.*|with\s+lyrics)\b",
    re.I,
)
_BRACKETS = re.compile(r"[\(\[\{【].*?[\)\]\}】]")


# ---------- Artist / title ----------

def _clean(s: str) -> str:
    s = _BRACKETS.sub(" ", s)
    s = re.sub(r"\b(ft\.?|feat\.?|featuring)\s.*$", " ", s, flags=re.I)
    s = re.sub(r"[\"“”]", " ", s)
    return re.sub(r"\s{2,}", " ", s).strip(" -–—|:,.")


def _channel_artist(channel: str | None) -> str | None:
    if not channel:
        return None
    a = re.sub(r"\s*-\s*Topic$|VEVO$|\s*Official$", "", channel, flags=re.I).strip()
    return a or None


def _norm(s: str) -> str:
    return re.sub(r"[^\w]+", " ", s.casefold()).strip()


def title_segments(title: str) -> list[str]:
    """Candidate song names: each '-', '|', ',' or bracket separated piece of the title, noise removed."""
    segs = []
    # Brackets separate too: "Crook - Mere bina (Lyrics Video) Emraan Hashmi" has three pieces.
    for part in re.split(r"\s+[-–—|]\s+|\||,", _BRACKETS.sub(" | ", title)):
        seg = _clean(_NOISE.sub(" ", part))
        if len(seg) >= 2 and seg.casefold() not in (x.casefold() for x in segs):
            segs.append(seg)
    return segs[:4]


# ---------- LRCLIB ----------

def _get(path: str, **params) -> dict | list | None:
    url = f"{LRCLIB}/{path}?{urllib.parse.urlencode({k: v for k, v in params.items() if v})}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code not in (429, 500, 502, 503, 504) or attempt == 3:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == 3:
                raise
        time.sleep(1.5 * 2**attempt)


def _score(c: dict, haystack: str, duration: float | None, lead: str) -> float:
    """How well an LRCLIB record matches the video. Track name in the title is required."""
    track = _norm(_BRACKETS.sub(" ", c.get("trackName") or ""))
    if not track or f" {track} " not in f" {haystack} ":
        return -1
    score = 3.0
    artists = [_norm(a) for a in re.split(r",|&|\band\b|feat\.?", c.get("artistName") or "")]
    if any(a and f" {a} " in f" {haystack} " for a in artists):
        score += 2
        # "Artist - Song" titles: prefer records whose artist is the part before the dash.
        if lead and any(a and f" {a} " in f" {lead} " for a in artists):
            score += 0.5
    if c.get("syncedLyrics"):
        score += 1
    if duration and c.get("duration"):
        score -= min(abs(c["duration"] - duration) / 30, 2)
    return score


def find_lrclib(title: str, channel: str | None, duration: float | None, info: dict | None = None,
                limit: int = 2) -> list[dict]:
    """Best-matching LRCLIB records, best first."""
    info = info or {}
    haystack = _norm(f"{title} {channel or ''} {info.get('track') or ''} {info.get('artist') or ''}")
    lead = _norm(re.split(r"\s+[-–—]\s+", title, maxsplit=1)[0]) if re.search(r"\s[-–—]\s", title) else ""
    channel_artist = _channel_artist(channel)

    # Common titles ("Yellow", "Hello") only surface the right record when the artist is in the query.
    queries: list[dict] = []
    if info.get("track"):
        queries.append({"track_name": info["track"], "artist_name": info.get("artist") or channel_artist})
    dash = re.split(r"\s+[-–—]\s+", _BRACKETS.sub(" ", title), maxsplit=1)
    if len(dash) == 2:
        a, b = (_clean(_NOISE.sub(" ", x)) for x in dash)
        queries += [{"track_name": b, "artist_name": a}, {"track_name": a, "artist_name": b}]
    for seg in title_segments(title):
        if channel_artist:
            queries.append({"track_name": seg, "artist_name": channel_artist})
        queries.append({"track_name": seg})

    unique = list({json.dumps(q, sort_keys=True): q for q in queries if q.get("track_name")}.values())
    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(pool.map(lambda q: _get("search", **q) or [], unique))

    scored: dict[int, tuple[float, dict]] = {}
    for found in responses:
        for c in found:
            if c.get("instrumental") or not (c.get("syncedLyrics") or c.get("plainLyrics")):
                continue
            sc = _score(c, haystack, duration, lead)
            if sc >= 3 and sc > scored.get(c["id"], (-1, None))[0]:
                scored[c["id"]] = (sc, c)

    ranked = sorted(scored.values(), key=lambda v: -v[0])
    # Several uploads of the same lyrics are common; keep distinct texts only.
    out, seen = [], set()
    for _, c in ranked:
        key = _norm((c.get("plainLyrics") or c.get("syncedLyrics") or "")[:200])
        if key not in seen:
            seen.add(key)
            out.append(c)
        if len(out) == limit:
            break
    return out


_LRC_LINE = re.compile(r"^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$")


def parse_lrc(lrc: str) -> list[dict]:
    lines = []
    for raw in lrc.splitlines():
        m = _LRC_LINE.match(raw.strip())
        if m and m.group(3).strip():
            lines.append({"start": int(m.group(1)) * 60 + float(m.group(2)), "text": m.group(3).strip()})
    for a, b in zip(lines, lines[1:]):
        a["end"] = b["start"]
    if lines:
        lines[-1]["end"] = lines[-1]["start"] + 5
    return lines


# ---------- Whisper ----------

def _get_model():
    global _model
    if _model is None:
        import stable_whisper

        log.info("Loading Whisper model %s", WHISPER_MODEL)
        # faster-whisper with int8 weights: ~2 GB instead of the ~7 GB RAM spike of openai-whisper,
        # which OOM-killed WSL (7.6 GB) next to the separator.
        _model = stable_whisper.load_faster_whisper(WHISPER_MODEL, device="cuda", compute_type="int8_float16")
    return _model


def _language_hint(text: str) -> str | None:
    return {"devanagari": "hi", "arabic": "ur"}.get(_majority_script(text.splitlines()))


def _load_16k(path: Path) -> np.ndarray:
    """Mono 16 kHz float32 samples via ffmpeg (faster-whisper's PyAV decoder breaks on av>=15)."""
    raw = subprocess.run(
        [FFMPEG, "-nostdin", "-loglevel", "error", "-i", str(path), "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32)


def _clean_transcript(lines: list[dict], max_words: int = 9) -> list[dict]:
    """Tidy Whisper's song transcripts: drop hallucinated word loops, split over-long lines at the longest pause."""
    out = []
    for line in lines:
        words = []
        for w in line["words"]:
            # Whisper on music sometimes repeats one word over and over; keep at most two in a row.
            if len(words) >= 2 and words[-1]["text"] == words[-2]["text"] == w["text"]:
                continue
            words.append(w)
        pending = [words]
        while pending:
            chunk = pending.pop(0)
            if len(chunk) <= max_words:
                out.append(_line(" ".join(w["text"] for w in chunk), chunk))
                continue
            lo, hi = len(chunk) // 3, len(chunk) - len(chunk) // 3
            cut = max(range(lo, hi), key=lambda i: chunk[i]["start"] - chunk[i - 1]["end"])
            pending[:0] = [chunk[:cut], chunk[cut:]]
    return out


def _merge_fragments(lines: list[dict], max_gap: float = 2.0, max_words: int = 10) -> list[dict]:
    """Whisper splits sung phrases at every breath; join close fragments into karaoke-sized lines.

    A capitalised fragment starts a new line once the current one has a few words, since Whisper
    capitalises new phrases. Scripts without case fall back to the gap and word limits.
    """
    if not any(ch.isupper() for line in lines for ch in line["text"]):
        max_words = min(max_words, 6)  # no capitals to mark phrase starts (e.g. Devanagari): keep lines short
    merged: list[dict] = []
    for line in lines:
        prev = merged[-1] if merged else None
        new_phrase = line["text"][:1].isupper() and len(prev["words"]) >= 3 if prev else True
        if (
            prev
            and not new_phrase
            and line["start"] - prev["end"] < max_gap
            and len(prev["words"]) + len(line["words"]) <= max_words
            and not prev["text"].endswith((".", "?", "!"))
        ):
            prev["words"] += line["words"]
            prev["end"] = line["end"]
            prev["text"] = " ".join(w["text"] for w in prev["words"])
        else:
            merged.append({**line, "words": list(line["words"])})
    return merged


def _detect_language(model, audio: np.ndarray) -> str:
    """Spoken language of the vocals; faster-whisper alignment needs it up front."""
    try:
        lang, prob, _ = model.detect_language(audio, vad_filter=True, language_detection_segments=4)
        log.info("Detected language %s (%.2f)", lang, prob)
        return lang
    except Exception:  # noqa: BLE001
        log.exception("Language detection failed; assuming English")
        return "en"


# Alignment tends to stretch a line's first word back over the pause before it,
# which would light the line up early. Sung words rarely run this long at a line start.
MAX_FIRST_WORD = 1.0


def _words(seg) -> list[dict]:
    words = [
        {"start": round(w.start, 3), "end": round(w.end, 3), "text": w.word.strip(), "p": round(w.probability or 0, 3)}
        for w in seg.words
        if w.word.strip()
    ]
    # One-word lines are often a single held note, so leave those alone.
    if len(words) > 1 and words[0]["end"] - words[0]["start"] > MAX_FIRST_WORD:
        words[0]["start"] = round(words[0]["end"] - 0.5, 3)
    return words


def _plausible(words: list[dict]) -> bool:
    """Reject lines alignment couldn't place (e.g. verses cut from a video edit)."""
    if not words:
        return False
    span = words[-1]["end"] - words[0]["start"]
    avg_p = sum(w["p"] for w in words) / len(words)
    return span >= 0.15 * len(words) and avg_p >= 0.2


def _to_lines(result, filter_bad: bool) -> list[dict]:
    lines = []
    for seg in result.segments:
        words = _words(seg)
        if not words or (filter_bad and not _plausible(words)):
            continue
        lines.append({
            "start": words[0]["start"],
            "end": words[-1]["end"],
            "text": " ".join(w["text"] for w in words),
            "words": [{k: w[k] for k in ("start", "end", "text")} for w in words],
        })
    return lines


def _text_lines(hit: dict) -> tuple[list[dict], list[str]]:
    lrc_lines = parse_lrc(hit["syncedLyrics"]) if hit.get("syncedLyrics") else []
    text = [l["text"] for l in lrc_lines] or [
        l.strip() for l in (hit.get("plainLyrics") or "").splitlines() if l.strip()
    ]
    return lrc_lines, text


# ---------- Script checks ----------

def _script(line: str) -> str | None:
    if re.search(r"[ऀ-ॿ]", line):
        return "devanagari"
    if re.search(r"[؀-ۿ]", line):
        return "arabic"
    if re.search(r"[A-Za-z]", line):
        return "latin"
    return None


def _majority_script(text: list[str]) -> str | None:
    scripts = [sc for sc in map(_script, text) if sc]
    return max(set(scripts), key=scripts.count) if scripts else None


def _is_junk(text: list[str]) -> bool:
    """Some LRCLIB uploads have scraped web-page text mixed in, usually in another script."""
    scripts = [sc for sc in map(_script, text) if sc]
    if not scripts:
        return False
    majority = max(set(scripts), key=scripts.count)
    return sum(sc != majority for sc in scripts) / len(scripts) > 0.1


# Languages Whisper writes in a non-Latin script. Romanized lyrics for them (e.g. Hinglish) are aligned in
# English mode, which handles Latin-script tokens far better; lines it still can't place use vocal activity.
_NON_LATIN_LANGS = {"hi", "ur", "pa", "bn", "mr", "gu", "ta", "te", "kn", "ml", "ne", "si", "ar", "fa",
                    "zh", "ja", "ko", "ru", "uk", "el", "he", "th"}


# ---------- Vocal activity ----------

HZ = 20  # activity frames per second


def _activity(audio: np.ndarray) -> np.ndarray:
    """Per-frame 'someone is singing' mask from the separated vocals."""
    hop = 16000 // HZ
    n = len(audio) // hop
    if n == 0:
        return np.zeros(0, dtype=bool)
    rms = np.sqrt((audio[: n * hop].reshape(n, hop) ** 2).mean(axis=1))
    level = 20 * np.log10(rms + 1e-6)
    return level > np.percentile(level, 95) - 25  # quieter than this is separation residue


def _line_end(start: float, limit: float, active: np.ndarray, n_words: int) -> float:
    """When the singing for a line stops: its last active frame before the next line starts.

    Capped by word count, so a line before a long outro or solo doesn't absorb it.
    """
    limit = min(limit, start + 2.0 + 1.0 * n_words)
    a, b = int(start * HZ), int(limit * HZ)
    hits = np.flatnonzero(active[a:b])
    end = (a + hits[-1] + 1) / HZ + 0.15 if len(hits) else limit
    return min(limit, max(start + 0.6, end))


def _spread(text: str, start: float, end: float, active: np.ndarray) -> list[dict]:
    """Word timings for a line Whisper couldn't place: spread words over its sung frames by length."""
    tokens = text.split()
    a, b = int(start * HZ), max(int(start * HZ) + 1, int(end * HZ))
    window = active[a:b]
    frames = np.flatnonzero(window) if window.mean() >= 0.25 else np.arange(len(window))
    if len(frames) == 0:
        frames = np.arange(len(window))
    weights = np.cumsum([0] + [len(t) + 1 for t in tokens]) / sum(len(t) + 1 for t in tokens)
    times = [(a + frames[min(len(frames) - 1, int(f * (len(frames) - 1)))]) / HZ for f in weights]
    times[0], times[-1] = start, end
    return [
        {"start": round(times[i], 3), "end": round(max(times[i + 1], times[i] + 0.05), 3), "text": tok}
        for i, tok in enumerate(tokens)
    ]


def _line(text: str, words: list[dict]) -> dict:
    return {
        "start": words[0]["start"],
        "end": words[-1]["end"],
        "text": text,
        "words": [{k: w[k] for k in ("start", "end", "text")} for w in words],
    }


# ---------- Alignment strategies ----------

def _align_segments(model, vocals: Path, text: list[str], lang: str) -> list | None:
    """Whisper segments, one per lyric line, or None when alignment fails or can't be trusted."""
    try:
        result = model.align(str(vocals), "\n".join(text), language=lang, original_split=True)
    except Exception:  # noqa: BLE001
        log.exception("Alignment failed")
        return None
    if not result or len(result.segments) != len(text):
        return None
    return result.segments


def _local_words(model, audio: np.ndarray, text: str, start: float, limit: float, lang: str) -> list[dict]:
    """Align one line against only its own slice of audio, so Whisper can't drift to another verse."""
    a = max(0.0, start - 0.3)
    clip = audio[int(a * 16000): int((limit + 0.3) * 16000)]
    if len(clip) < 1600:
        return []
    try:
        result = model.align(clip, text, language=lang, original_split=True)
    except Exception:  # noqa: BLE001
        return []
    if not result:
        return []
    words = [w for seg in result.segments for w in _words(seg)]
    for w in words:
        w["start"], w["end"] = round(w["start"] + a, 3), round(w["end"] + a, 3)
    if not words or sum(w["p"] for w in words) / len(words) < 0.2:
        return []
    # Whisper sometimes piles a line's opening words onto one instant; that timing is useless.
    if sum(w["end"] - w["start"] < 0.08 for w in words) > len(words) / 2:
        return []
    return words


def _backbone(model, audio: np.ndarray, lrc_lines: list[dict], lang: str, active: np.ndarray,
              audio_sec: float) -> tuple[list, int]:
    """LRCLIB timing matches this audio: keep every line, and word-time each one inside its own window."""
    lines, aligned = [], 0
    for i, l in enumerate(lrc_lines):
        limit = lrc_lines[i + 1]["start"] if i + 1 < len(lrc_lines) else min(l["start"] + 8, audio_sec)
        words = _local_words(model, audio, l["text"], l["start"], limit, lang)
        if words:
            aligned += 1
        else:
            words = _spread(l["text"], l["start"], _line_end(l["start"], limit, active, len(l["text"].split())), active)
        if words:
            lines.append(_line(l["text"], words))
    return lines, aligned


def _anchored(lrc_lines: list[dict], segments: list, active: np.ndarray, audio_sec: float) -> tuple[list, int]:
    """LRCLIB is a different cut of the song (video edit, album version): map its timing via anchors.

    Anchors are lines Whisper placed confidently. Runs of anchors with about the same shift (±1.5 s) form stretches;
    lines inside a stretch are placed with its shift, and lines where the shift jumps (a cut) are dropped.
    """
    n = len(lrc_lines)
    words = [_words(seg) for seg in segments]
    anchor = [bool(w) and _plausible(w) for w in words]
    shift = [w[0]["start"] - l["start"] if w else 0.0 for w, l in zip(words, lrc_lines)]

    stretch = [-1] * n
    sid, members = -1, []
    for i in range(n):
        if not anchor[i]:
            continue
        # Cuts move the shift by tens of seconds; alignment jitter is ~1 s.
        if sid < 0 or abs(shift[i] - float(np.median([shift[j] for j in members]))) > 1.5:
            sid, members = sid + 1, []
        members.append(i)
        stretch[i] = sid
    # A stretch needs two agreeing anchors, or one Whisper is very sure of (e.g. a short closing section).
    conf = [sum(w["p"] for w in ws) / len(ws) if ws else 0.0 for ws in words]
    sizes = {s: stretch.count(s) for s in set(stretch) if s >= 0}
    trusted = {s for s in sizes if sizes[s] >= 2 or any(stretch[i] == s and conf[i] >= 0.6 for i in range(n))}
    valid = [anchor[i] and stretch[i] in trusted for i in range(n)]
    shift_of = {s: float(np.median([shift[i] for i in range(n) if stretch[i] == s])) for s in trusted}

    lines = []
    for i, l in enumerate(lrc_lines):
        if valid[i]:
            lines.append(_line(l["text"], words[i]))
            continue
        prev = next((j for j in range(i - 1, -1, -1) if valid[j]), None)
        nxt = next((j for j in range(i + 1, n) if valid[j]), None)
        sides = {stretch[j] for j in (prev, nxt) if j is not None}
        if len(sides) != 1:  # between two different stretches: a cut, or no anchors at all
            continue
        s = shift_of[sides.pop()]
        start = l["start"] + s
        limit = (lrc_lines[i + 1]["start"] + s) if i + 1 < n else min(start + 8, audio_sec)
        if start < 0 or start >= audio_sec - 1:
            continue
        lines.append(_line(l["text"], _spread(l["text"], start, _line_end(start, min(limit, audio_sec), active, len(l["text"].split())), active)))

    # A mapped line that overlaps its predecessor came from a cut section.
    ordered = []
    for line in lines:
        if not ordered or line["start"] >= ordered[-1]["start"] + 0.3:
            ordered.append(line)
    return ordered, sum(valid)


def _from_hit(model, vocals: Path, audio: np.ndarray, active: np.ndarray, hit: dict,
              duration: float | None) -> tuple[dict | None, tuple]:
    """Time one LRCLIB record against this audio. Returns (lyrics, rank); higher ranks fit better.

    rank = (kind, anchors, lines): kind 3 = same cut as the video, 2 = different cut mapped via
    anchors, 1 = unsynced lyrics aligned, 0 = LRCLIB timing used blind.
    """
    lrc_lines, text = _text_lines(hit)
    if not text or _is_junk(text):
        log.info("Skipping %s – %s: %s", hit["artistName"], hit["trackName"], "junk text" if text else "empty")
        return None, ()
    audio_sec = len(audio) / 16000
    spoken = _language_hint("\n".join(text)) or _detect_language(model, audio)
    lang = "en" if _majority_script(text) == "latin" and spoken in _NON_LATIN_LANGS else spoken
    label = f"{hit['artistName']} – {hit['trackName']}"
    base = {"source": "lrclib-aligned", "language": spoken}

    if lrc_lines and duration and hit.get("duration") and abs(hit["duration"] - duration) <= 3:
        lines, aligned = _backbone(model, audio, lrc_lines, lang, active, audio_sec)
        log.info("%s: same cut as video; %d/%d lines word-aligned (lang %s)", label, aligned, len(lines), lang)
        return {**base, "lines": lines}, (3, aligned, len(lines))

    segments = _align_segments(model, vocals, text, lang)

    if lrc_lines and segments:
        lines, anchors = _anchored(lrc_lines, segments, active, audio_sec)
        log.info("%s: different cut; %d anchors, %d/%d lines placed", label, anchors, len(lines), len(lrc_lines))
        return ({**base, "lines": lines}, (2, anchors, len(lines))) if lines else (None, ())

    if segments:  # plain lyrics without timestamps: alignment is all we have
        lines = [_line(t, w) for t, seg in zip(text, segments) if (w := _words(seg)) and _plausible(w)]
        log.info("%s: unsynced lyrics; %d/%d lines aligned", label, len(lines), len(text))
        return ({**base, "lines": lines}, (1, len(lines), len(lines))) if lines else (None, ())

    if lrc_lines:  # different cut and alignment failed: LRCLIB timing as-is, best effort
        lines = [_line(l["text"], _spread(l["text"], l["start"], _line_end(l["start"], l["end"], active, len(l["text"].split())), active))
                 for l in lrc_lines if l["start"] < audio_sec - 1]
        return {**base, "source": "lrclib", "lines": lines}, (0, 0, len(lines))
    return None, ()


def edit_line(lyrics: dict, index: int, text: str) -> dict:
    """Replace one line's text (a user correction). Word timings are kept when the word count is
    unchanged, otherwise the new words are spread over the line's span by length."""
    line = lyrics["lines"][index]
    tokens = text.split()
    if len(tokens) == len(line["words"]):
        words = [{**w, "text": tok} for w, tok in zip(line["words"], tokens)]
    else:
        start, end = line["start"], line["end"]
        weights = np.cumsum([0] + [len(t) + 1 for t in tokens]) / sum(len(t) + 1 for t in tokens)
        times = [float(start + f * (end - start)) for f in weights]
        words = [{"start": round(times[i], 3), "end": round(times[i + 1], 3), "text": tok} for i, tok in enumerate(tokens)]
    lyrics["lines"][index] = {**line, "text": " ".join(tokens), "words": words, "edited": True}
    return lyrics["lines"][index]


def _tidy(lines: list[dict]) -> list[dict]:
    """End every line (and its words) before the next one starts."""
    for line, nxt in zip(lines, lines[1:]):
        if line["end"] > nxt["start"]:
            line["end"] = nxt["start"]
            for w in line["words"]:
                w["end"] = min(w["end"], nxt["start"])
                w["start"] = min(w["start"], w["end"])
    return lines


def build(vocals: Path, title: str, channel: str | None, duration: float | None, info: dict | None = None) -> dict:
    hits: list[dict] = []
    try:
        hits = find_lrclib(title, channel, duration, info)
    except Exception:  # noqa: BLE001 — network trouble shouldn't block Whisper
        log.exception("LRCLIB lookup failed")
    log.info("LRCLIB candidates for %r: %s", title, [f"{h['artistName']} – {h['trackName']}" for h in hits])

    audio = _load_16k(vocals)
    active = _activity(audio)
    duration = duration or len(audio) / 16000

    with _lock:
        model = _get_model()
        # Candidates come best-match first; a later one only wins if it fits this audio better
        # (e.g. the film version vs the album version of a song).
        best, best_rank, best_hit = None, (), None
        # Prefer Devanagari/Latin versions over Arabic-script ones when LRCLIB has both.
        hits.sort(key=lambda h: _majority_script(_text_lines(h)[1]) == "arabic")
        for hit in hits:
            lyrics, rank = _from_hit(model, vocals, audio, active, hit, duration)
            if lyrics and rank > best_rank:
                best, best_rank, best_hit = lyrics, rank, hit
            if best_rank and best_rank[0] == 3:  # same cut as the video: can't do better
                break
        if best:
            artist = ", ".join(dict.fromkeys(a.strip() for a in best_hit["artistName"].split(",")))  # "Adele, Adele"
            return {**best, "artist": artist, "track": best_hit["trackName"], "lines": _tidy(best["lines"])}

        # Spoken Hindi and Urdu are nearly identical; Whisper's guess between them only picks the script.
        spoken = _detect_language(model, audio)
        result = model.transcribe(audio, vad=True, word_timestamps=True,
                                  language="hi" if spoken in ("hi", "ur") else spoken)
        lines = _clean_transcript(_merge_fragments(_to_lines(result, filter_bad=False)))
        if lines:
            return {"source": "whisper", "language": result.language, "artist": None, "track": None, "lines": lines}
    return {"source": "none", "lines": []}
