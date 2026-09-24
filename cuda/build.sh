#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# Common CUDA locations on Vast/Clore/official images
for d in /usr/local/cuda/bin /usr/local/cuda-12/bin /usr/local/cuda-13/bin; do
  if [[ -x "$d/nvcc" ]]; then
    export PATH="$d:$PATH"
    break
  fi
done

if ! command -v nvcc >/dev/null 2>&1; then
  echo "nvcc not found — install CUDA toolkit (or use CPU mode)"
  exit 1
fi
echo "[cuda] $(nvcc --version | tail -1)"

ARCH_FLAGS=""
if command -v nvidia-smi >/dev/null 2>&1; then
  CC=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1 | tr -d ' ' || true)
  if [[ -n "${CC:-}" ]]; then
    SM=${CC/./}
    ARCH_FLAGS="-arch=sm_${SM}"
    echo "[cuda] detected compute_cap=${CC} → ${ARCH_FLAGS}"
  fi
fi

build_with() {
  echo "[cuda] nvcc -O3 $*"
  # shellcheck disable=SC2086
  nvcc -O3 -std=c++17 "$@" unicred_cuda.cu -o unicred-cuda
}

if [[ -n "$ARCH_FLAGS" ]]; then
  build_with $ARCH_FLAGS
else
  # Fat binary for common rental GPUs: 4090 (89), H100 (90), 5090/Blackwell (120).
  # Older toolkits may not know sm_120 — fall back.
  if build_with \
      -gencode arch=compute_89,code=sm_89 \
      -gencode arch=compute_90,code=sm_90 \
      -gencode arch=compute_120,code=sm_120; then
    :
  else
    echo "[cuda] sm_120 not supported by this nvcc — retrying without it"
    build_with \
      -gencode arch=compute_89,code=sm_89 \
      -gencode arch=compute_90,code=sm_90 \
      -gencode arch=compute_86,code=sm_86
  fi
fi
echo "[cuda] built $(pwd)/unicred-cuda"
