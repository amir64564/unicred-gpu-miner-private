#!/usr/bin/env node
/** Cross-check JS midstate digests vs cuda/unicred_cpu_ref (C port of CUDA kernel). */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { prepare, digestHex, search } from '../lib/keccak_core.mjs';
import { DOMAIN, CHAIN_ID, NFT } from '../lib/config.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'cuda', 'unicred_cpu_ref');
if (!existsSync(bin)) {
  console.error('Build first: gcc -O3 -std=c11 cuda/unicred_cpu_ref.c -o cuda/unicred_cpu_ref');
  process.exit(2);
}

function baseOf(prep) {
  const base = new Uint32Array(50);
  for (let i = 0; i < 50; i++) base[i] = (prep.mid[i] ^ (i < 34 ? prep.tailLanes[i] : 0)) >>> 0;
  return base;
}

let fails = 0;
for (let t = 0; t < 12; t++) {
  const miner = ethers.getAddress('0x' + ethers.hexlify(ethers.randomBytes(20)).slice(2));
  const nonceHigh = ethers.hexlify(ethers.randomBytes(24)) + '0000000000000000';
  const challenge = ethers.hexlify(ethers.randomBytes(32));
  const prep = prepare({ domain: DOMAIN, chainId: CHAIN_ID, contract: NFT, anchorHash: challenge, miner, nonceHigh });
  const base = baseOf(prep);
  const hi = (Math.random() * 0x100000000) >>> 0;
  const ctr = (Math.random() * 0x100000000) >>> 0;
  const js = digestHex(prep, hi, ctr).toLowerCase();
  const r = spawnSync(bin, ['digest', String(hi), String(ctr)], {
    input: Array.from(base).join(' ') + '\n', encoding: 'utf8',
  });
  const c = (r.stdout || '').trim().toLowerCase();
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const nonce = '0x' + nonceHigh.replace(/^0x/, '').slice(0, 48)
    + (hi >>> 0).toString(16).padStart(8, '0')
    + (ctr >>> 0).toString(16).padStart(8, '0');
  const eth = ethers.keccak256(coder.encode(
    ['bytes32', 'uint256', 'address', 'bytes32', 'address', 'uint256'],
    [DOMAIN, BigInt(CHAIN_ID), NFT, challenge, miner, BigInt(nonce)],
  )).toLowerCase();
  if (js !== c || js !== eth) {
    fails++;
    console.error({ t, js, c, eth, hi, ctr });
  }
}
// search agreement
const prep = prepare({
  domain: DOMAIN, chainId: CHAIN_ID, contract: NFT,
  anchorHash: ethers.hexlify(ethers.randomBytes(32)),
  miner: '0x1111111111111111111111111111111111111111',
  nonceHigh: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee0000000000000000',
});
const base = baseOf(prep);
const hi = 0x55aa55aa;
const dig = BigInt(digestHex(prep, hi, 77));
const target = dig + 1n;
const tHi = Number(target >> 224n);
const tLo = Number((target >> 192n) & 0xffffffffn);
const jsHit = search(prep, hi, 0, 200, tHi, tLo);
const r2 = spawnSync(bin, ['search', String(hi), '0', '200', String(tHi), String(tLo)], {
  input: Array.from(base).join(' ') + '\n', encoding: 'utf8',
});
const cHit = Number((r2.stdout || '').trim());
if (jsHit !== cHit) {
  fails++;
  console.error({ jsHit, cHit });
}
console.log(JSON.stringify({ ok: fails === 0, fails, trials: 12 }, null, 2));
process.exit(fails ? 1 : 0);
