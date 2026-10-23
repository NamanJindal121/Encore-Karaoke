#!/usr/bin/env bash
# Run backend (FastAPI, :8000) and frontend (Vite, :5173) together. Ctrl+C stops both.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

trap 'kill 0' EXIT INT TERM

(cd "$ROOT/backend" && uv run uvicorn app.main:app --host 127.0.0.1 --port 8000) &
(cd "$ROOT/frontend" && npm run dev -- --host 127.0.0.1) &

wait
