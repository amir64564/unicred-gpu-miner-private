# unicred-miner

Fast CUDA + CPU miner for [UNICRED](https://unicred.fun/) PoW NFT on **Unichain (chain id 130)**.

- Contract: `0xf60de24F228dc7Ca6fF025958d2eE3A956ED88E5`
- Hash: **keccak256(abi.encode(...))** 192-byte midstate (same as site WebGPU)
- Live `priceOf` on every submit; default `--max-price-eth` = live × 1.05
- `--confirm` (default) or `--auto-submit`
- Multi-wallet rotation via `PRIVATE_KEYS`
- Multi-GPU CUDA when `cuda/unicred-cuda` is built

See **README-VPS.md** for rental setup. See **PROTOCOL.md** for exact PoW.

```bash
npm i
node verify-hash.mjs          # must print ok:true
node mine.mjs --benchmark --cpu-only
bash setup-on-rental.sh       # on GPU VPS
```

**Never commit `.env` or private keys.**
