#!/usr/bin/env node
import { ethers } from 'ethers';
import { prepare, digestHex, nonceHex } from './lib/keccak_core.mjs';
import { minerAbi, CHAIN_ID, NFT, DOMAIN, RPCS } from './lib/config.mjs';

const provider = new ethers.JsonRpcProvider(process.env.UNICRED_RPC || RPCS[0], CHAIN_ID, {
  staticNetwork: true, batchMaxCount: 1,
});
const c = new ethers.Contract(NFT, minerAbi, provider);
const coder = ethers.AbiCoder.defaultAbiCoder();

const miner = '0x1111111111111111111111111111111111111111';
const nonceHigh = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0000000000000000';
const hiWord = 0x12345678;
const ctr = 0x9abcdef0;
const nonce = nonceHex(nonceHigh, hiWord, ctr);

const st = await c.state(ethers.ZeroAddress);
const tip = Number(st.blockNumber);
const anchor = tip - 3;
const blk = await provider.getBlock(anchor);
const challenge = ethers.keccak256(coder.encode(['bytes32', 'bytes32'], [blk.hash, st.prev]));
const prep = prepare({
  domain: DOMAIN, chainId: CHAIN_ID, contract: NFT,
  anchorHash: challenge, miner, nonceHigh,
});
const core = digestHex(prep, hiWord, ctr);
const local = ethers.keccak256(coder.encode(
  ['bytes32', 'uint256', 'address', 'bytes32', 'address', 'uint256'],
  [DOMAIN, BigInt(CHAIN_ID), NFT, challenge, miner, BigInt(nonce)],
));
const onchain = await c.digestOf(blk.hash, st.prev, miner, nonce);
const price = await c.priceOf(st.minted + 1n);
const ok = core.toLowerCase() === local.toLowerCase() && local.toLowerCase() === onchain.toLowerCase();
console.log(JSON.stringify({
  ok, core, local, onchain, nonce, anchor,
  minted: st.minted.toString(),
  livePriceEth: ethers.formatEther(price),
  chainId: CHAIN_ID, address: NFT,
}, null, 2));
process.exit(ok ? 0 : 1);
