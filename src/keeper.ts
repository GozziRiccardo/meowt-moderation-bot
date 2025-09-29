import { ethers } from "ethers";
import { GAME_ABI } from "./abi.js";
import { CONFIG } from "./config.js";
import { moderateText } from "./moderate.js";

// Small helpers
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const isHttp = (u: string) => u.startsWith("http://") || u.startsWith("https://");
const isIpfs = (u: string) => u.startsWith("ipfs://");
const isMeowText = (u: string) => u.startsWith("meow:text:");

function ipfsToHttp(u: string): string {
  const rest = u.replace("ipfs://", "");
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

    const ct = res.headers.get("content-type") || "";
    if (!/text\/plain|text\/html|application\/json/i.test(ct)) {
      // gateways can be sloppy; still try to read it
    }
    const text = await res.text();
    return (text || "").slice(0, 10000);
  } catch {
    return null;
  }
}

async function fetchMeowTextByHash(hashHex: string): Promise<string | null> {
  if (!CONFIG.modApiUrl) return null;
  try {
    const url = `${CONFIG.modApiUrl.replace(/\/$/, "")}/content?hash=${encodeURIComponent(hashHex)}`;
    const res = await fetch(url, {
      headers: CONFIG.modApiKey ? { Authorization: `Bearer ${CONFIG.modApiKey}` } : undefined
    });
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as any;
    const text = (json?.text ?? "") as string;
    return (text || "").slice(0, 10000) || null;
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
  const provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl, CONFIG.chainId || undefined);

  // Sanity: ensure there's bytecode at the address (helps catch a wrong GAME_ADDRESS)
  const code = await provider.getCode(CONFIG.gameAddress as `0x${string}`);
  if (code === "0x") {
    throw new Error(`No contract code at ${CONFIG.gameAddress} (check GAME_ADDRESS / chain)`);
  }

  const wallet = new ethers.Wallet(CONFIG.privateKey, provider);
  const game = new ethers.Contract(CONFIG.gameAddress, GAME_ABI, wallet);

  const activeId: bigint = await game.activeMessageId();
  if (activeId === 0n) {
    console.log("No active message. Done.");
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
    console.log(`Flagging on-chain… (reasons: ${mod.reasons.join(", ")})`);
    const tx = await game.setModerationFlag(activeId, true);
    console.log("tx sent:", tx.hash);
    const rec = await tx.wait();
    console.log("tx mined in block", rec.blockNumber);
    await sleep(CONFIG.rateLimitMs);
  } else {
    console.log(`Message ${activeId} passed moderation.`);
  }
}

main().catch((e) => {
  console.error("keeper error:", e);
  process.exitCode = 1;
});
