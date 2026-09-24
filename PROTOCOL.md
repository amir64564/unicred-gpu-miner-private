# UNICRED PoW protocol (from unicred.fun public JS + live contract)

## Chain
| | |
|---|---|
| Network | Unichain mainnet |
| Chain ID | **130** |
| NFT | **`0xf60de24F228dc7Ca6fF025958d2eE3A956ED88E5`** |
| $CRED | `0x0FBc2Fc1366D5BA517E6ca5A304c10359F554E0D` |
| DOMAIN | `0xd38d03374ffe0ab0595a37e26339a924c9bf9d87e54292dabb07b3bddb3cc04e` |
| Explorer | https://uniscan.xyz |
| RPCs | `https://mainnet.unichain.org`, `https://unichain-rpc.publicnode.com`, `https://unichain.drpc.org` |

## Exact hash (abi.encode, 192 bytes — NOT encodePacked)
```
challenge = keccak256(abi.encode(blockhash(anchorBlock), prevWork))
digest    = keccak256(abi.encode(DOMAIN, uint256(130), address(nft), challenge, miner, nonce))
require(uint256(digest) < targetFor(miner))
```
Verified: site keccak_core.digestHex == ethers abi.encode == on-chain digestOf(blockHash, prev, miner, nonce).

Midstate: first 136 bytes of the 192-byte message are fixed per job → one keccak-f, then only block-2 per nonce.

## Submit
```
mine(uint256 anchorBlock, uint256 nonce, uint256 maxPrice) payable
```
- Site: anchorBlock = tip - 3 (ANCHOR_WINDOW=250)
- value = maxPrice = live priceOf(totalMinted+1) — miner re-reads every submit
- One mint per block; each mint updates prevWork → all searches restart

## Live economics (eth_call)
| Constant | Value |
|---|---|
| TARGET_PACE | 10s |
| RETARGET_EVERY | 8 |
| FAILSAFE_EVERY | 300s |
| STREAK_COOL / MAX | 10 / 16 |
| PRICE_BASE / STEP | 0.002 ETH |
| EPOCH_SIZE | 404 |
| MAX_SUPPLY | 4444 |
| startBits | 28 |

priceOf(id) = PRICE_BASE * (floor((id-1)/EPOCH_SIZE)+1)

## Algorithm
**Keccak-256** (Ethereum). Best on high-throughput NVIDIA (4090/5090/H100).
