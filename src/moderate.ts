import { ethers } from "ethers";
import ABI from "./abi/BillboardGame.json";
import { CONFIG } from "./config";

// ---- ENV ----
const GAME_ADDRESS = env("GAME_ADDRESS");
const RPC_URL = env("RPC_URL");
const BOT_PRIVATE_KEY = env("BOT_PRIVATE_KEY");
const PERSPECTIVE_API_KEY = env("PERSPECTIVE_API_KEY");

function env(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required env: ${name}`);
  }
  return v.trim();
}

// ---- Ethers setup ----
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(BOT_PRIVATE_KEY, provider);
const game = new ethers.Contract(GAME_ADDRESS, ABI, wallet);

// ---- Helpers ----
async function resolveTextFromUri(uri: string): Promise<string | null> {
  try {
    if (uri.startsWith("meow:text:")) {
      const raw = uri.slice("meow:text:".length);
      // allow both plain and URI-encoded
      try { return decodeURIComponent(raw); } catch { return raw; }
    }
    if (uri.startsWith("data:text/plain;base64,")) {
      const b64 = uri.slice("data:text/plain;base64,".length);
      const bin = Buffer.from(b64, "base64");
      return bin.toString("utf8").slice(0, CONFIG.maxBytesToFetch);
    }
    if (uri.startsWith("ipfs://")) {
      const cid = uri.replace("ipfs://", "");
      const url = CONFIG.ipfsGateway.replace(/\/+$/, "") + "/" + cid;
      return await fetchText(url);
    }
    if (uri.startsWith("http://") || uri.startsWith("https://")) {
      return await fetchText(uri);
    }
    // Unknown scheme -> skip
    return null;
  } catch (e) {
    console.error("resolveTextFromUri error:", e);
    return null;
  }
}

async function fetchText(url: string): Promise<string | null> {
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) return null;
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("text") && !ct.includes("json")) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.slice(0, CONFIG.maxBytesToFetch).toString("utf8");
}

type PerspectiveScores = Record<string, number>;

async function analyzeWithPerspective(text: string): Promise<PerspectiveScores> {
  // Build attributes list from thresholds keys
  const requestedAttributes = Object.fromEntries(
    Object.keys(CONFIG.thresholds).map(k => [k, {}])
  );

  const body = {
    comment: { text },
    requestedAttributes,
    doNotStore: true,
    languages: ["en"] // Perspective can auto-detect, but pin to en for stability; add more if needed.
  };

  const url = `https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze?key=${encodeURIComponent(PERSPECTIVE_API_KEY)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Perspective API error: ${res.status} ${t}`);
  }
  const data = await res.json();

  const scores: PerspectiveScores = {};
  for (const [k, v] of Object.entries<any>(data.attributeScores || {})) {
    const sum = (v.summaryScore && typeof v.summaryScore.value === "number")
      ? v.summaryScore.value : 0;
    scores[k] = sum;
  }
  return scores;
}

function shouldFlag(scores: PerspectiveScores): { flag: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const [attr, threshold] of Object.entries(CONFIG.thresholds)) {
    const val = scores[attr] ?? 0;
    if (val >= threshold) reasons.push(`${attr}=${val.toFixed(2)}≥${threshold}`);
  }
  return { flag: reasons.length > 0, reasons };
}

// ---- Main ----
(async () => {
  console.log(`[bot] address: ${wallet.address}`);
  const signer = await game.moderationSigner();
  if (signer.toLowerCase() !== wallet.address.toLowerCase()) {
    console.warn(`[warn] Contract moderationSigner is ${signer}, NOT this wallet. Set it with setModeration(...). Exiting.`);
    return;
  }

  const id: bigint = await game.activeMessageId();
  console.log(`[info] activeMessageId: ${id}`);
  if (id === 0n) return;

  const flaggedOnChain: boolean = await game.modFlagged(id);
  if (flaggedOnChain) { console.log(`[info] already flagged. exit.`); return; }

  const m = await game.messages(id);
  const uri: string = m.uri;
  console.log(`[info] uri: ${uri}`);

  const text = await resolveTextFromUri(uri);
  if (!text || !text.trim()) {
    console.log(`[info] no text resolved; skipping`);
    return;
  }

  console.log(`[info] analyzing ${Math.min(text.length, 120)} chars:\n"${text.slice(0, 120)}${text.length>120?"…":""}"`);
  const scores = await analyzeWithPerspective(text);
  console.log(`[info] scores:`, scores);

  const { flag, reasons } = shouldFlag(scores);
  if (!flag) {
    console.log(`[info] OK — below thresholds.`);
    return;
  }

  console.log(`[moderation] Thresholds exceeded: ${reasons.join(", ")}`);
  if (CONFIG.dryRun) {
    console.log(`[dry-run] Would call setModerationFlag(${id}, true)`);
    return;
    }

  const tx = await game.setModerationFlag(id, true);
  console.log(`[tx] sent: ${tx.hash}`);
  const rc = await tx.wait(1);
  console.log(`[tx] confirmed in block ${rc.blockNumber}`);
})().catch(err => {
  console.error(`[fatal]`, err);
  process.exit(1);
});
