import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const deployment = JSON.parse(readFileSync(join(root, 'deployment.json'), 'utf8'));
export const minerAbi = JSON.parse(readFileSync(join(root, 'miner.abi.json'), 'utf8'));

export const CHAIN_ID = deployment.chainId;
export const NFT = deployment.address;
export const DOMAIN = deployment.domain;
export const RPCS = (deployment.rpcs || []).filter((u) => typeof u === 'string' && u.startsWith('http'));
export const EXPLORER = deployment.explorer || 'https://uniscan.xyz';
export const ANCHOR_BACK = 3;
export const ANCHOR_REFRESH = 150;
export const ANCHOR_MAX_SEND = 240;
