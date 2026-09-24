# UNICRED GPU miner — VPS quick start

Simple English. Copy-paste on Ubuntu + NVIDIA CUDA box (4090 / 5090 / H100).

## 1) Install (one command)
```bash
cd /workspace/unicred-miner   # or wherever you cloned
bash setup-on-rental.sh
```

## 2) Put keys
```bash
cp .env.example .env
nano .env
# PRIVATE_KEYS=0xKEY1,0xKEY2,0xKEY3
# Fund each wallet with Unichain ETH (mint price + gas). Current mint ≈ 0.006 ETH — check live.
```

## 3) Benchmark
```bash
node mine.mjs --benchmark --cpu-only
# After CUDA build:
# ./cuda/unicred-cuda   # should print {"event":"ready",...}
```

## 4) Run (keeps going after SSH disconnect)
**Confirm mode (safe default — asks y/n before spending):**
```bash
tmux new -s unicred
node mine.mjs --confirm --max-mints 10
# Ctrl+B then D to detach
```

**Auto-submit (race mode — spends immediately on hit):**
```bash
tmux new -s unicred
node mine.mjs --auto-submit --max-mints 10 --max-price-eth 0.01
```

`--max-price-eth` default = live price × 1.05. Price is re-read from chain every submit.

## 5) Multi-GPU
CUDA binary uses **all** GPUs automatically. No flags needed.

## Stop
```bash
tmux attach -t unicred
# Ctrl+C
```
