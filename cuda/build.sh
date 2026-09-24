#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v nvcc >/dev/null 2>&1; then
  echo "nvcc not found — install CUDA toolkit"
  exit 1
fi
ARCH_FLAGS=""
if command -v nvidia-smi >/dev/null 2>&1; then
  CC=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1 | tr -d ' ' || true)
  if [[ -n "${CC:-}" ]]; then
    SM=${CC/./}
    ARCH_FLAGS="-arch=sm_${SM}"
  fi
fi
if [[ -z "$ARCH_FLAGS" ]]; then
  ARCH_FLAGS="-gencode arch=compute_89,code=sm_89 -gencode arch=compute_90,code=sm_90 -gencode arch=compute_120,code=sm_120"
fi
echo "[cuda] nvcc -O3 $ARCH_FLAGS"
nvcc -O3 -std=c++17 $ARCH_FLAGS unicred_cuda.cu -o unicred-cuda
echo "[cuda] built $(pwd)/unicred-cuda"
