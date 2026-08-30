#!/usr/bin/env bash
# Clone and provision the Galaxium Travels demo app into sandbox/galaxium-travels.
#
# The app is NOT committed to this repository — see sandbox/README.md for why.
# This script is the reproducible substitute for a vendored copy. It is
# idempotent: re-running it updates the clone and re-syncs dependencies.
#
# Usage:  ./sandbox/setup.sh [--skip-frontend] [--skip-backend]

set -euo pipefail

UPSTREAM="https://github.com/IBM/galaxium-travels.git"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${SCRIPT_DIR}/galaxium-travels"

SKIP_FRONTEND=0
SKIP_BACKEND=0
for arg in "$@"; do
  case "$arg" in
    --skip-frontend) SKIP_FRONTEND=1 ;;
    --skip-backend)  SKIP_BACKEND=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# --- prerequisites ----------------------------------------------------------
need() {
  command -v "$1" >/dev/null 2>&1 || { echo "error: '$1' is required but not on PATH" >&2; exit 1; }
}
need git
[ "$SKIP_BACKEND" -eq 1 ]  || need python3 2>/dev/null || need python
[ "$SKIP_FRONTEND" -eq 1 ] || need npm

# Prefer python3, fall back to python (Windows/Git Bash ships it as `python`).
PY=python3
command -v python3 >/dev/null 2>&1 || PY=python

# --- clone ------------------------------------------------------------------
if [ -d "${TARGET}/.git" ]; then
  say "Updating existing clone at sandbox/galaxium-travels"
  git -C "$TARGET" pull --ff-only
else
  say "Cloning ${UPSTREAM}"
  # core.longpaths is required on Windows: the Java hold service has paths
  # that exceed the 260-character MAX_PATH limit and checkout fails without it.
  git clone -c core.longpaths=true --depth 1 "$UPSTREAM" "$TARGET"
fi

# --- backend (Python / FastAPI, port 8001) ----------------------------------
if [ "$SKIP_BACKEND" -eq 0 ]; then
  say "Provisioning backend (Python / FastAPI)"
  BE="${TARGET}/booking_system_backend"
  [ -d "${BE}/.venv" ] || "$PY" -m venv "${BE}/.venv"

  # venv layout differs between Windows (Scripts/) and POSIX (bin/).
  if [ -x "${BE}/.venv/Scripts/python.exe" ]; then
    VENV_PY="${BE}/.venv/Scripts/python.exe"
  else
    VENV_PY="${BE}/.venv/bin/python"
  fi

  "$VENV_PY" -m pip install --quiet --upgrade pip
  "$VENV_PY" -m pip install --quiet -r "${BE}/requirements.txt"
fi

# --- frontend (React / Vite, port 5173) -------------------------------------
if [ "$SKIP_FRONTEND" -eq 0 ]; then
  say "Provisioning frontend (React / Vite)"
  ( cd "${TARGET}/booking_system_frontend" && npm install )
fi

say "Done. Start it with:"
cat <<'USAGE'

  # terminal 1 — backend on http://localhost:8001
  cd sandbox/galaxium-travels/booking_system_backend
  ./.venv/Scripts/python.exe server.py     # Windows
  ./.venv/bin/python server.py             # macOS / Linux

  # terminal 2 — frontend on http://localhost:5173
  cd sandbox/galaxium-travels/booking_system_frontend
  npm run dev                              # NOTE: "dev", not "start"

  # smoke test
  curl http://localhost:8001/flights

USAGE
