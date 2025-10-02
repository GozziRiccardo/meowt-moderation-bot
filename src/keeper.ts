// src/keeper.ts
import { JsonRpcProvider, WebSocketProvider, Wallet, Contract } from 'ethers';
import { GAME_ABI } from './abi.js';
import { CONFIG } from './config.js';
import { moderateText } from './moderate.js';

// ---- Env / Config normalization ----
const RPC = (CONFIG.rpcUrl ?? process.env.RPC_URL ?? '').trim();
if (!RPC) throw new Error('RPC_URL (or CONFIG.rpcUrl) is missing');

const CHAIN_ID = Number(CONFIG.chainId ?? process.env.CHAIN_ID ?? '8453'); // Base mainnet default
if (!Number.isFinite(CHAIN_ID)) throw new Error('CHAIN_ID must be a number');

let pk = (CONFIG.privateKey ?? process.env.BOT_PRIVATE_KEY ?? '').trim();
if (!pk) throw new Error('BOT_PRIVATE_KEY / CONFIG.privateKey is missing');
if (!pk.startsWith('0x')) pk = '0x' + pk;
if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
  throw new Error('BOT_PRIVATE_KEY must be a 0x-prefixed 64-hex string (32 bytes).');
}

const GAME_ADDR = (CONFIG.gameAddress ?? process.env.GAME_ADDRESS ?? '').trim();
if (!/^0x[0-9a-fA-F]{40}$/.test(GAME_ADDR)) {
  throw new Error('GAME_ADDRESS is missing or not a valid 0x address');
}

// Provider: pick WebSocket when using wss://
const provider =
  RPC.startsWith('wss')
    ? new WebSocketProvider(RPC, { chainId: CHAIN_ID, name: 'base' })
    : new JsonRpcProvider(RPC, { chainId: CHAIN_ID, name: 'base' });

const wallet = new Wallet(pk, provider);
const game = new Contract(GAME_ADDR as `0x${string}`, GAME_ABI, wallet);

// Small helpers
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isHttp = (u: string) => u.startsWith('http://') || u.startsWith('https://');
const isIpfs = (u: string) => u.startsWith('ipfs://');
const isMeowText = (u: string) => u.startsWith('meow:text:');

function ipfsToHttp(u: string): string {
  const rest = u.replace(/^ipfs:\/\//, '').replace(/^ipfs\//, '');
  return `https://ipfs.io/ipfs/${rest}`;
}

async function fetchTextFromUri(uri: string): Promise<string | null> {
  try {
    const url = isIpfs(uri) ? ipfsToHttp(uri) : uri;
    if (!isHttp(url)) return null;

    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10_000);

    const res = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return null;

    const ct = res.headers.get('content-type') || '';
    // Even if CT isn't a texty type, many gateways still serve text — we'll try anyway.
    const text = await res.text();
    return (text || '').slice(0, 10_000);
  } catch {
    return null;
  }
}

async function fetchMeowTextByHash(hashHex: string): Promise<string | null> {
  if (!CONFIG.modApiUrl) return null;
  try {
    const base = CONFIG.modApiUrl.replace(/\/$/, '');
    const url = `${base}/content?hash=${encodeURIComponent(hashHex)}`;
    const res = await fetch(url, {
      headers: CONFIG.modApiKey ? { Authorization: `Bearer ${CONFIG.modApiKey}` } : undefined
    });
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as any;
    const text = (json?.text ?? '') as string;
    return (text || '').slice(0, 10_000) || null;
  } catch {
    return null;
  }
}

async function resolveMessageText(uri: string, contentHash: string): Promise<string | null> {
  if (isMeowText(uri)) return await fetchMeowTextByHash(contentHash);
  if (isHttp(uri) || isIpfs(uri)) return await fetchTextFromUri(uri);
  return null;
}

async function main() {
  // Sanity: network + signer
  const [net, addr] = await Promise.all([provider.getNetwork(), wallet.getAddress()]);
  if (net.chainId !== BigInt(CHAIN_ID)) {
    throw new Error(`RPC chainId ${net.chainId} != expected ${CHAIN_ID}`);
  }
  console.log(`Keeper connected to chainId=${net.chainId.toString()} as ${addr}`);

  // Ensure there is bytecode at GAME address
  const code = await provider.getCode(GAME_ADDR as `0x${string}`);
  if (code === '0x') {
    throw new Error(`No contract code at ${GAME_ADDR} (check GAME_ADDRESS / chain)`);
  }

  const activeId: bigint = await game.activeMessageId();
  if (activeId === 0n) {
    console.log('No active message. Done.');
    return;
  }

  const m = await game.messages(activeId);
  if (m.resolved) {
    console.log(`Message ${activeId} already resolved. Done.`);
    return;
  }

  const uri: string = m.uri;
  const contentHash: string = m.contentHash; // 0x...
  const text = await resolveMessageText(uri, contentHash);

  if (!text || !text.trim()) {
    console.log(`Message ${activeId}: no retrievable text for URI=${uri}. Skipping.`);
    return;
  }

  const mod = await moderateText(text);
  console.log(`Moderation result for ${activeId}:`, mod);

  if (mod.flagged) {
    console.log(`Flagging on-chain… (reasons: ${mod.reasons.join(', ')})`);
    const tx = await game.setModerationFlag(activeId, true);
    console.log('tx sent:', tx.hash);
    const rec = await tx.wait();
    console.log('tx mined in block', rec.blockNumber);
    await sleep(CONFIG.rateLimitMs);
  } else {
    console.log(`Message ${activeId} passed moderation.`);
  }
}

main().catch((e) => {
  console.error('keeper error:', e);
  process.exitCode = 1;
});
