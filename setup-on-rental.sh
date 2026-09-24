#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
echo "[unicred] Node deps…"
if ! command -v node >/dev/null; then
  echo "Install Node 20+ first (e.g. apt install -y nodejs npm, or nvm)"
  exit 1
fi
npm install --omit=dev
chmod +x mine.mjs verify-hash.mjs setup-on-rental.sh cuda/build.sh 2>/dev/null || true
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "[unicred] Created .env — edit PRIVATE_KEYS"
fi
echo "[unicred] Verifying hash vs chain…"
node verify-hash.mjs || true
if command -v nvcc >/dev/null; then
  echo "[unicred] Building CUDA…"
  bash cuda/build.sh || echo "[unicred] CUDA build failed — CPU mode still works"
else
  echo "[unicred] nvcc missing — CPU-only for now"
fi
echo
echo "READY:"
echo "  nano .env   # PRIVATE_KEYS=0x...,0x..."
echo "  node mine.mjs --benchmark --cpu-only"
echo "  tmux new -s unicred"
echo "  node mine.mjs --auto-submit --max-mints 10"
