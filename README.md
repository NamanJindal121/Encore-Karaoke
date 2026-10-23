# Encore — Karaoke Studio

Search any song on YouTube and get a karaoke version with two tracks, **vocals** and **instrumental**. Each track has its own waveform and volume slider. Vocals start muted, and synced lyrics highlight word by word as the song plays.

The first time you pick a song, it's downloaded and the vocals are separated on your GPU. The two tracks are saved to a local library, so after that the song plays instantly.

## Requirements

- Linux or WSL2 with an NVIDIA GPU and current drivers. Developed on an RTX 4060 Laptop (8 GB).
- Python 3.12, including the developer headers
- Node.js 22+
- [uv](https://docs.astral.sh/uv/) (Python package manager)
- ffmpeg

Install the system packages (needs your password):

```bash
sudo apt install -y ffmpeg python3-dev
```

## Setup

```bash
# Backend: installs FastAPI, yt-dlp, audio-separator and PyTorch built for CUDA 12.8
cd backend
uv sync
uv run python -c "import torch; print('CUDA:', torch.cuda.is_available())"   # should print True

# Frontend
cd ../frontend
npm install
```

The first song you process downloads two models:

- the vocal separation model, about 640 MB, into `~/.cache/audio-separator`
- the Whisper large-v3 lyrics model, about 3 GB, into `~/.cache/huggingface`

## Running

```bash
./scripts/dev.sh
```

This starts the backend at `http://127.0.0.1:8000` and the frontend at `http://localhost:5173`. Open the frontend URL in your browser. Ctrl+C stops both.

To run them separately:

```bash
cd backend  && uv run uvicorn app.main:app --port 8000
cd frontend && npm run dev
```

## Using it

1. Type in the search box. Results appear as you type.
2. Click **Make karaoke** on a result. Search steps aside for a card showing that song's progress and each stage: Downloading, Separating vocals, Finalizing, then Syncing lyrics.
3. When it's ready, the song loads paused and takes over the screen, with lyrics filling the space below the waveforms. Vocals are muted, so drag the left slider on the Vocals lane up to hear them. **Search** or **Library** in the header (or Ctrl+K) switches to browsing; **Now playing** brings the player back.
4. Click or drag on either waveform to seek.
5. Lyrics scroll under the waveforms. Click a line to jump to it; double-click it to fix its text (Enter or clicking away saves, Esc cancels). Corrections are saved to the song's `lyrics.json`; regenerating the song's lyrics replaces them. If they run early or late, use the **− / +** control in the lyrics header to shift them; each song remembers its setting. The captions button next to the time hides or shows the panel.
6. Processed songs stay in the **Library** tab. Each song remembers its own volume levels. Songs processed before lyrics were added get them automatically the first time you play them.

| Key | Action |
| --- | --- |
| Space | Play / pause |
| ← / → | Seek 5 s (hold Shift for 30 s) |
| V | Mute / unmute vocals |
| Ctrl+K or / | Focus search |

## How it works

```
Browser (React + Vite) ──/api, /media──> FastAPI (:8000)
                                           ├─ search   → yt-dlp YouTube search (metadata only)
                                           ├─ worker   → download → separate (GPU) → encode → waveform peaks → lyrics (GPU)
                                           ├─ SQLite   → library.db (song info + status)
                                           └─ /media   → library/<videoId>/{vocals,instrumental}.m4a, peaks.json, lyrics.json
```

- **Separation:** done by [audio-separator](https://github.com/nomadkaraoke/python-audio-separator) with the BS-RoFormer model (`model_bs_roformer_ep_317_sdr_12.9755.ckpt`). The model loads onto the GPU once, when the server starts. Songs are processed one at a time.
- **Caching:** the YouTube video ID is the cache key. Asking for a song that's already processed returns it immediately. Asking for one that's already processing hands back the job in progress instead of starting another.
- **Lyrics:**
  - The lyrics text comes from [LRCLIB](https://lrclib.net), a free synced-lyrics database. The backend searches it with each part of the video title (YouTube titles like "Song - Movie | Actor | Singer" vary a lot), then scores matches by track name, artist and duration.
  - Entries with scraped junk (lines in a different script from the rest) are skipped.
  - **Same cut as the video** (LRCLIB's duration matches within 3 s): LRCLIB's line timings are used as they are, and no line is dropped. [Whisper](https://github.com/SYSTRAN/faster-whisper) large-v3, through [stable-ts](https://github.com/jianfch/stable-ts), times the words of each line inside that line's own short audio window, so it can't drift into another verse. When Whisper can't place a line, for example romanized Hindi, its words are spread across the moments the separated vocals are actually singing.
  - **Different cut** (video edits, album vs film versions): the whole lyric is aligned once. Lines Whisper is confident about become anchors, runs of anchors with the same time shift become stretches, and the other lines are placed with their stretch's shift. Lines inside a section cut from the video are dropped.
  - If LRCLIB has nothing, Whisper transcribes the vocals itself, and the panel labels the result **Auto-transcribed**.
  - Lyrics show in whatever script the source uses, e.g. Devanagari for many Hindi songs. Versions in Devanagari or Latin script are preferred over Arabic-script ones, and Whisper transcribes Hindi/Urdu audio in Devanagari.
- **Playback:** both tracks play on one Web Audio clock, so they stay in sync through play, pause and seek.
- **Waveforms:** drawn from precomputed peak data, so they appear instantly.
- **Interrupted jobs:** if the server stops in the middle of a song, that song is marked as failed on the next start and shows a **Retry** button.

## Configuration

All settings are optional environment variables for the backend:

| Variable | Default | Purpose |
| --- | --- | --- |
| `KARAOKE_LIBRARY_DIR` | `./library` | Where processed tracks are stored |
| `KARAOKE_DB` | `./library.db` | SQLite database file |
| `KARAOKE_MODEL_DIR` | `~/.cache/audio-separator` | Where the separation model is cached |
| `KARAOKE_MODEL` | `model_bs_roformer_ep_317_sdr_12.9755.ckpt` | Separation model |
| `KARAOKE_OVERLAP` | `2` | Chunk overlap. The model's own default is 4: about 2× slower for a barely audible gain (~0.1 dB SDR). |
| `KARAOKE_WHISPER_MODEL` | `large-v3` | Whisper model used for lyrics timing and transcription |
| `KARAOKE_MAX_DURATION` | `900` | Longest video allowed, in seconds |

## Command-line processing

To process a single video without the UI:

```bash
cd backend
uv run python -m app.cli <youtube_video_id>
```

To rebuild the lyrics of a song already in the library (prints each line with its timing):

```bash
uv run python -m app.cli lyrics <youtube_video_id>
```

## Project layout

```
backend/app/
  main.py          API routes, file serving for /media
  jobs.py          job queue, worker thread, progress tracking
  search.py        YouTube search
  db.py            SQLite access
  config.py        paths and settings
  cli.py           command-line processing
  pipeline/        download.py, separate.py, encode.py, peaks.py, lyrics.py
frontend/src/
  App.tsx          tabs, search, library, job tracking
  audio/engine.ts  two-track Web Audio engine
  components/      Player, Lyrics, Waveform, VerticalSlider, ResultCard, SearchBar, ProgressRing
  styles/          tokens.css (colors, fonts), app.css
scripts/dev.sh     starts backend + frontend together
```

## Troubleshooting

- **`CUDA: False`:** check that `nvidia-smi` works inside WSL and that you're using the latest Windows NVIDIA driver. Don't install a separate Linux NVIDIA driver inside WSL.
- **Download fails:** YouTube changes often, so update yt-dlp: `cd backend && uv lock --upgrade-package yt-dlp && uv sync`.
- **Song fails with "Interrupted":** the server stopped while that song was processing. Click **Retry**.
- **Wrong or missing lyrics:** click **Try again** in the lyrics panel, or run `uv run python -m app.cli lyrics <id>` to see which LRCLIB entry was matched.
- **Whole WSL session gets killed while processing:** WSL ran out of memory. By default it gets half your laptop's RAM. Give it more in `C:\Users\<you>\.wslconfig` (`[wsl2]` then `memory=12GB`), and run `wsl --shutdown` from PowerShell.
- **Remove a song:** use the trash icon in the Library tab. It deletes the song's folder and its database entry.
