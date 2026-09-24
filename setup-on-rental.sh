#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo "[unicred] Preparing rental box…"

# Node 20+ (Vast/Clore CUDA images often ship without Node)
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v 2>/dev/null | tr -d v | cut -d. -f1)" -lt 20 ]]; then
  echo "[unicred] Installing Node.js 20.x…"
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -qq
    sudo apt-get install -y -qq curl ca-certificates gnupg
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y -qq nodejs
  else
    echo "Install Node 20+ manually, then re-run."
    exit 1
  fi
fi
echo "[unicred] node $(node -v) npm $(npm -v)"

# CUDA toolchain on PATH
for d in /usr/local/cuda/bin /usr/local/cuda-12/bin /usr/local/cuda-13/bin; do
  if [[ -x "$d/nvcc" ]]; then
    export PATH="$d:$PATH"
    break
  fi
done

npm install --omit=dev
chmod +x mine.mjs verify-hash.mjs setup-on-rental.sh cuda/build.sh 2>/dev/null || true

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "[unicred] Created .env — edit PRIVATE_KEYS (never commit it)"
fi

echo "[unicred] Verifying hash vs chain…"
node verify-hash.mjs || echo "[unicred] verify-hash failed (RPC?) — continue"

if command -v nvcc >/dev/null 2>&1; then
  echo "[unicred] Building CUDA…"
  bash cuda/build.sh || echo "[unicred] CUDA build failed — CPU mode still works"
else
  echo "[unicred] nvcc missing — CPU-only for now (OK)"
fi

# Optional: CPU reference of the CUDA kernel (no GPU needed)
if command -v gcc >/dev/null 2>&1; then
  gcc -O3 -std=c11 cuda/unicred_cpu_ref.c -o cuda/unicred_cpu_ref 2>/dev/null \
    && echo "[unicred] built cuda/unicred_cpu_ref" || true
fi

if ! command -v tmux >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then
  sudo apt-get install -y -qq tmux || true
fi

echo
echo "READY:"
echo "  nano .env   # PRIVATE_KEYS=0x...,0x..."
echo "  node mine.mjs --benchmark --cpu-only"
echo "  tmux new -s unicred"
echo "  node mine.mjs --auto-submit --max-mints 10"
