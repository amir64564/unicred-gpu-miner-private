#!/usr/bin/env node
/**
 * UNICRED PoW miner (Unichain)
 *
 *   node mine.mjs --confirm
 *   node mine.mjs --auto-submit --max-mints 5
 *   node mine.mjs --max-price-eth 0.01
 *   node mine.mjs --benchmark --cpu-only
 *   node mine.mjs --dry-run
 *
 * Price is ALWAYS re-read via priceOf(totalMinted+1) at submit time.
 * Default --max-price-eth = livePrice * 1.05.
 * PRIVATE_KEYS in .env (comma-separated); rotated after each win.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { ethers } from 'ethers';
import { prepare, digestHex, nonceHex, search } from './lib/keccak_core.mjs';
import {
  minerAbi, CHAIN_ID, NFT, DOMAIN, RPCS, EXPLORER,
  ANCHOR_BACK, ANCHOR_REFRESH, ANCHOR_MAX_SEND,
} from './lib/config.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CUDA_BIN = join(ROOT, 'cuda', 'unicred-cuda');
const SELF = fileURLToPath(import.meta.url);

function loadEnv() {
  const p = join(ROOT, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    if (process.env[m[1]] == null) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function parseArgs(argv) {
  const o = {
    confirm: true, autoSubmit: false, cpuOnly: false, benchmark: false, dryRun: false,
    threads: Math.max(1, cpus().length), maxMints: Infinity, maxPriceEth: null,
    reportMs: 2000, pollMs: 800, help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--auto-submit') { o.autoSubmit = true; o.confirm = false; }
    else if (a === '--confirm') { o.confirm = true; o.autoSubmit = false; }
    else if (a === '--cpu-only') o.cpuOnly = true;
    else if (a === '--benchmark') o.benchmark = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--threads') o.threads = Math.max(1, Number(argv[++i]) || o.threads);
    else if (a === '--max-mints') o.maxMints = Math.max(0, Number(argv[++i]) || 0);
    else if (a === '--max-price-eth') o.maxPriceEth = Number(argv[++i]);
    else if (a === '--report-ms') o.reportMs = Number(argv[++i]) || 2000;
    else if (a === '--poll-ms') o.pollMs = Number(argv[++i]) || 800;
    else if (a === '-h' || a === '--help') o.help = true;
  }
  return o;
}

function privateKeys() {
  const raw = process.env.PRIVATE_KEYS || process.env.PRIVATE_KEY || '';
  return raw.split(/[,\s]+/).map((s) => s.trim()).filter((s) => /^0x[0-9a-fA-F]{64}$/.test(s));
}

function makeProviders() {
  const urls = [process.env.UNICRED_RPC, ...RPCS].filter(Boolean);
  return urls.map((url) => new ethers.JsonRpcProvider(url, CHAIN_ID, { staticNetwork: true, batchMaxCount: 1 }));
}

async function withRpc(providers, fn) {
  let last;
  for (const p of providers) {
    try { return await fn(p); } catch (e) { last = e; }
  }
  throw last || new Error('all RPCs failed');
}

function bitsOf(target) {
  if (target <= 0n) return 256;
  let t = target, b = 0;
  while (t > 0n) { t >>= 1n; b++; }
  return 256 - b;
}

function fmtHps(h) {
  if (h >= 1e9) return (h / 1e9).toFixed(2) + ' GH/s';
  if (h >= 1e6) return (h / 1e6).toFixed(2) + ' MH/s';
  if (h >= 1e3) return (h / 1e3).toFixed(2) + ' KH/s';
  return Math.round(h) + ' H/s';
}

function askYes(q) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(/^y(es)?$/i.test((a || '').trim())); }));
}

function nft(provider) {
  return new ethers.Contract(NFT, minerAbi, provider);
}

// ---- worker thread: hash a nonce range ----
if (!isMainThread) {
  const { mid, tailLanes, targetHi, targetLo, hiWord, start, count } = workerData;
  const job = { mid: Int32Array.from(mid), tailLanes: Int32Array.from(tailLanes) };
  const hit = search(job, hiWord, start, count, targetHi, targetLo);
  parentPort.postMessage({ hit, scanned: count });
} else {
loadEnv();

async function cpuSearchBatch(prep, targetHi, targetLo, hiWord, start, count, threads) {
  const mid = Array.from(prep.mid);
  const tailLanes = Array.from(prep.tailLanes);
  const per = Math.ceil(count / threads);
  const tasks = [];
  let left = count;
  let offset = start;
  for (let t = 0; t < threads && left > 0; t++) {
    const n = Math.min(per, left);
    const startOff = offset >>> 0;
    tasks.push(new Promise((resolve, reject) => {
      const w = new Worker(SELF, {
        workerData: { mid, tailLanes, targetHi, targetLo, hiWord, start: startOff, count: n },
      });
      w.on('message', resolve);
      w.on('error', reject);
      w.on('exit', (c) => { if (c !== 0) reject(new Error('worker exit ' + c)); });
    }));
    offset = (offset + n) >>> 0;
    left -= n;
  }
  return Promise.all(tasks);
}

class CudaPool {
  constructor(bin) {
    this.bin = bin;
    this.proc = null;
    this.buf = '';
    this.ready = false;
    this.onFound = null;
    this.onHashrate = null;
  }
  start() {
    this.proc = spawn(this.bin, ['--json'], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.event === 'ready') this.ready = true;
          else if (msg.event === 'found') this.onFound?.(msg);
          else if (msg.event === 'hashrate') this.onHashrate?.(msg);
        } catch { /* ignore */ }
      }
    });
    this.proc.on('exit', () => { this.ready = false; this.proc = null; });
    return true;
  }
  send(obj) {
    if (!this.proc?.stdin) return;
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }
  setJob(job) { this.send({ cmd: 'job', ...job }); }
  stop() { try { this.send({ cmd: 'stop' }); this.proc?.kill('SIGTERM'); } catch { /* */ } }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('See header comment in mine.mjs for flags.');
    return;
  }

  const providers = makeProviders();
  const coder = ethers.AbiCoder.defaultAbiCoder();

  const snap0 = await withRpc(providers, (p) => nft(p).state(ethers.ZeroAddress));
  const livePrice = await withRpc(providers, (p) => nft(p).priceOf(snap0.minted + 1n));
  const livePriceEth = Number(ethers.formatEther(livePrice));
  if (args.maxPriceEth == null || Number.isNaN(args.maxPriceEth)) {
    args.maxPriceEth = Number((livePriceEth * 1.05).toFixed(6));
  }

  console.log(`[unicred] chain=${CHAIN_ID} nft=${NFT}`);
  console.log(`[unicred] minted=${snap0.minted} livePrice=${ethers.formatEther(livePrice)} ETH maxPriceEth=${args.maxPriceEth}`);
  console.log(`[unicred] yourTargetBits≈${bitsOf(snap0.yourTarget).toFixed(1)} baseBits≈${bitsOf(snap0.baseTarget).toFixed(1)}`);
  console.log(`[unicred] mode=${args.autoSubmit ? 'AUTO-SUBMIT' : 'CONFIRM'} dryRun=${args.dryRun}`);

  const keys = privateKeys();
  const wallets = keys.map((k) => ({ key: k, address: new ethers.Wallet(k).address }));
  let walletIdx = 0;
  const pickWallet = () => (wallets.length ? wallets[walletIdx % wallets.length] : null);
  if (!args.benchmark && wallets.length === 0) {
    console.warn('[unicred] No PRIVATE_KEYS — find-only (will not submit)');
  }

  if (args.benchmark) {
    const rnd = (n) => ethers.hexlify(ethers.randomBytes(n));
    const prep = prepare({
      domain: DOMAIN, chainId: CHAIN_ID, contract: NFT,
      anchorHash: rnd(32), miner: rnd(20), nonceHigh: rnd(32),
    });
    const BATCH = 200_000;
    const t0 = Date.now();
    await cpuSearchBatch(prep, 0, 0, 0x11111111, 0, BATCH, args.threads);
    const dt = (Date.now() - t0) / 1000;
    console.log(`[benchmark] CPU ${fmtHps(BATCH / dt)} over ${dt.toFixed(2)}s threads=${args.threads}`);
    return;
  }

  let cuda = null;
  if (!args.cpuOnly && existsSync(CUDA_BIN)) {
    cuda = new CudaPool(CUDA_BIN);
    cuda.start();
    console.log('[unicred] CUDA:', CUDA_BIN);
  } else {
    console.log(`[unicred] CPU threads=${args.threads}`);
  }

  let wins = 0;
  let job = null;
  let jobSeq = 0;
  let hashesWindow = 0;
  let windowAt = Date.now();
  let lastMinted = -1;
  let submitting = false;
  const gpuRates = {};

  async function refresh() {
    const who = pickWallet()?.address || ethers.ZeroAddress;
    const st = await withRpc(providers, (p) => nft(p).state(who));
    return {
      minted: Number(st.minted),
      price: st.price,
      prev: st.prev,
      baseTarget: st.baseTarget,
      target: st.yourTarget,
      field: Number(st.field),
      yours: Number(st.yours),
      block: Number(st.blockNumber),
      mintedThisBlock: st.mintedThisBlock,
    };
  }

  async function buildJob(st, minerAddr) {
    const anchor = st.block - ANCHOR_BACK;
    const blk = await withRpc(providers, (p) => p.getBlock(anchor));
    if (!blk?.hash) throw new Error('no hash for anchor ' + anchor);
    const challenge = ethers.keccak256(coder.encode(['bytes32', 'bytes32'], [blk.hash, st.prev]));
    const nonceHigh = ethers.hexlify(ethers.randomBytes(32));
    const prep = prepare({
      domain: DOMAIN, chainId: CHAIN_ID, contract: NFT,
      anchorHash: challenge, miner: minerAddr, nonceHigh,
    });
    const targetHi = Number(st.target >> 224n);
    const targetLo = Number((st.target >> 192n) & 0xffffffffn);
    const base = new Uint32Array(50);
    for (let i = 0; i < 50; i++) base[i] = (prep.mid[i] ^ (i < 34 ? prep.tailLanes[i] : 0)) >>> 0;
    return {
      id: ++jobSeq, anchor, prev: st.prev, target: st.target, miner: minerAddr,
      nonceHigh, challenge, blockHash: blk.hash, prep,
      targetHi, targetLo, base: Array.from(base),
    };
  }

  async function verifyAndSubmit(j, hiWord, ctr) {
    if (submitting) return;
    submitting = true;
    try {
      const nonce = nonceHex(j.nonceHigh, hiWord, ctr);
      const dig = digestHex(j.prep, hiWord, ctr);
      if (BigInt(dig) >= j.target) {
        console.log('[unicred] prefilter FP, continue');
        return;
      }
      const onchain = await withRpc(providers, (p) => nft(p).digestOf(j.blockHash, j.prev, j.miner, nonce));
      if (onchain.toLowerCase() !== dig.toLowerCase()) {
        console.error('[unicred] local/on-chain digest mismatch — abort');
        return;
      }
      if (BigInt(onchain) >= j.target) return;

      // LIVE price every submit
      const stNow = await withRpc(providers, (p) => nft(p).state(j.miner));
      if (stNow.prev !== j.prev) {
        console.log('[unicred] prevWork changed — drop');
        return;
      }
      const price = await withRpc(providers, (p) => nft(p).priceOf(stNow.minted + 1n));
      const priceEth = Number(ethers.formatEther(price));
      if (priceEth > args.maxPriceEth) {
        console.error(`[unicred] live price ${priceEth} > max ${args.maxPriceEth} — skip`);
        return;
      }
      if (Number(stNow.blockNumber) - j.anchor > ANCHOR_MAX_SEND) {
        console.log('[unicred] anchor expired — drop');
        return;
      }

      const sol = {
        at: new Date().toISOString(),
        anchor: j.anchor, nonce, digest: dig, miner: j.miner,
        price: price.toString(), priceEth, mintedBefore: stNow.minted.toString(),
      };
      mkdirSync(join(ROOT, 'solutions'), { recursive: true });
      writeFileSync(join(ROOT, 'solutions', `sol-${Date.now()}.json`), JSON.stringify(sol, null, 2));
      writeFileSync(join(ROOT, 'last-solution.json'), JSON.stringify(sol, null, 2));
      console.log(`\n*** HIT *** nonce=${nonce}\n    digest=${dig}\n    livePrice=${priceEth} ETH miner=${j.miner} anchor=${j.anchor}`);

      if (args.dryRun || wallets.length === 0) {
        console.log('[unicred] dry-run / no keys — saved, not submitting');
        return;
      }

      let go = args.autoSubmit;
      if (args.confirm && !args.autoSubmit) {
        go = await askYes(`Submit mine() paying ${priceEth} ETH? [y/N] `);
      }
      if (!go) { console.log('[unicred] skipped'); return; }

      const winfo = wallets.find((w) => w.address.toLowerCase() === j.miner.toLowerCase()) || pickWallet();
      const provider = providers[0];
      const wallet = new ethers.Wallet(winfo.key, provider);
      const c = nft(provider).connect(wallet);
      const fee = await provider.getFeeData();
      const tip = (fee.maxPriorityFeePerGas && fee.maxPriorityFeePerGas > 0n) ? fee.maxPriorityFeePerGas : 1_000_000n;
      const maxFee = (fee.maxFeePerGas && fee.maxFeePerGas > tip * 2n) ? fee.maxFeePerGas : tip * 20n;

      await c.mine.staticCall(j.anchor, nonce, price, { value: price });
      const tx = await c.mine(j.anchor, nonce, price, {
        value: price, gasLimit: 450_000n, maxPriorityFeePerGas: tip, maxFeePerGas: maxFee,
      });
      console.log(`[unicred] tx ${tx.hash} waiting…`);
      const rc = await tx.wait();
      console.log(`[unicred] CONFIRMED block=${rc.blockNumber} ${EXPLORER}/tx/${tx.hash}`);
      wins++;
      walletIdx++;
      if (wins >= args.maxMints) {
        console.log('[unicred] max-mints reached');
        process.exit(0);
      }
    } catch (e) {
      console.error('[unicred] submit error:', e.shortMessage || e.message);
    } finally {
      submitting = false;
    }
  }

  if (cuda) {
    cuda.onFound = (msg) => {
      if (!job || msg.jobId !== job.id) return;
      verifyAndSubmit(job, (msg.hiWord >>> 0), (msg.ctr >>> 0));
    };
    cuda.onHashrate = (msg) => {
      gpuRates[msg.gpu ?? 0] = msg.hps || 0;
      hashesWindow += msg.batch || 0;
    };
  }

  setInterval(() => {
    const now = Date.now();
    const dt = (now - windowAt) / 1000;
    const hps = dt > 0 ? hashesWindow / dt : 0;
    hashesWindow = 0;
    windowAt = now;
    const g = Object.entries(gpuRates).map(([i, r]) => `GPU${i}:${fmtHps(r)}`).join(' ');
    console.log(`[status] ${fmtHps(hps)} ${g} wins=${wins} minted=${lastMinted} job=#${job?.id ?? '-'} bits≈${job ? bitsOf(job.target).toFixed(1) : '-'}`);
  }, args.reportMs);

  let hiWord = (Math.random() * 0x100000000) >>> 0;
  let ctr = 0;

  for (;;) {
    try {
      const st = await refresh();
      if (st.minted !== lastMinted) {
        if (lastMinted >= 0) console.log(`[unicred] #${st.minted} mined on-chain — new race`);
        lastMinted = st.minted;
      }
      const minerAddr = pickWallet()?.address || '0x1111111111111111111111111111111111111111';
      const stale = !job
        || job.prev !== st.prev
        || job.target !== st.target
        || job.miner.toLowerCase() !== minerAddr.toLowerCase()
        || st.block - job.anchor > ANCHOR_REFRESH
        || st.mintedThisBlock;

      if (stale && !st.mintedThisBlock) {
        job = await buildJob(st, minerAddr);
        hiWord = (Math.random() * 0x100000000) >>> 0;
        ctr = 0;
        console.log(`[unicred] job #${job.id} anchor=${job.anchor} miner=${minerAddr.slice(0, 10)}… bits≈${bitsOf(job.target).toFixed(1)} streak=${st.yours}/${st.field}`);
        if (cuda) {
          cuda.setJob({
            jobId: job.id, base: job.base,
            tHi: job.targetHi >>> 0, tLo: job.targetLo >>> 0, hiWord,
          });
        }
      }

      if (!job || submitting || st.mintedThisBlock) {
        await new Promise((r) => setTimeout(r, args.pollMs));
        continue;
      }
      if (cuda && cuda.ready) {
        await new Promise((r) => setTimeout(r, args.pollMs));
        continue;
      }

      const BATCH = 50_000 * args.threads;
      if (ctr > 0xffffffff - BATCH) { hiWord = (Math.random() * 0x100000000) >>> 0; ctr = 0; }
      const myJob = job;
      const results = await cpuSearchBatch(myJob.prep, myJob.targetHi, myJob.targetLo, hiWord, ctr, BATCH, args.threads);
      if (job !== myJob) continue;
      let scanned = 0;
      for (const r of results) {
        scanned += r.scanned;
        if (r.hit >= 0) {
          hashesWindow += scanned;
          await verifyAndSubmit(myJob, hiWord, r.hit >>> 0);
          break;
        }
      }
      hashesWindow += scanned;
      ctr = (ctr + BATCH) >>> 0;
    } catch (e) {
      console.error('[unicred] loop:', e.shortMessage || e.message);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
} // end isMainThread
