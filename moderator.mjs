// bot/moderator.mjs
// Minimal, single-run moderation bot: reads active message, scores via Perspective,
// and flags on-chain if thresholds are exceeded.

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  getContract
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

// ---------- ENV (your secret names) ----------
const {
  RPC_URL,               // GitHub Secret: RPC_URL
  GAME_ADDRESS,          // GitHub Secret: GAME_ADDRESS
  BOT_PRIVATE_KEY,       // GitHub Secret: BOT_PRIVATE_KEY  (must be moderationSigner)
  PERSPECTIVE_API_KEY,   // GitHub Secret: PERSPECTIVE_API_KEY
  // Optional Repo Variables (Actions → Variables)
  TOXICITY_THRESHOLD = "0.85",
  INSULT_THRESHOLD = "0.85",
  PROFANITY_THRESHOLD = "0.85",
  THREAT_THRESHOLD = "0.80",
  PERSPECTIVE_LANG = ""
} = process.env;

// (FYI: OPENAI_API_KEY is not used by this bot.)

if (!RPC_URL || !GAME_ADDRESS || !BOT_PRIVATE_KEY || !PERSPECTIVE_API_KEY) {
  console.error("Missing env: RPC_URL, GAME_ADDRESS, BOT_PRIVATE_KEY, PERSPECTIVE_API_KEY");
  process.exit(1);
}

// ---------- CHAIN ----------
const GAME_ABI = parseAbi([
  "function activeMessageId() view returns (uint256)",
  "function messages(uint256) view returns (uint256 id, address author, uint256 stake, uint256 startTime, uint256 B0, string uri, bytes32 contentHash, uint256 likes, uint256 dislikes, uint256 feePot, bool resolved, bool nuked, uint8 winnerSide, uint256 sharePerVote, uint256 seedFromStake)",
  "function moderationSigner() view returns (address)",
  "function modFlagged(uint256) view returns (bool)",
  "function setModerationFlag(uint256 id, bool flagged) nonpayable"
]);

const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });
const account = privateKeyToAccount(BOT_PRIVATE_KEY);
const wallet = createWalletClient({ chain: baseSepolia, transport: http(RPC_URL), account });

const game = getContract({
  address: GAME_ADDRESS,
  abi: GAME_ABI,
  client: { public: pub, wallet }
});

// ---------- HELPERS ----------
async function fetchTextFromUri(uri) {
  if (!uri) return "";
  try {
    if (uri.startsWith("meow:text:")) {
      return decodeURIComponent(uri.slice("meow:text:".length));
    }
    if (uri.startsWith("data:text/plain;base64,")) {
      const b64 = uri.slice("data:text/plain;base64,".length);
      return Buffer.from(b64, "base64").toString("utf8");
    }
    const toUrl = (u) =>
      u.startsWith("ipfs://")
        ? `https://ipfs.io/ipfs/${u.slice(7).replace(/^ipfs\//, "")}`
        : u;
    const primary = toUrl(uri);
    const alt = [
      primary,
      primary.replace("ipfs.io", "cloudflare-ipfs.com"),
      primary.replace("ipfs.io", "gateway.pinata.cloud")
    ];
    for (const u of alt) {
      try {
        const res = await fetch(u, { method: "GET" });
        if (res.ok) return await res.text();
      } catch {}
    }
  } catch {}
  return "";
}

async function perspectiveScore(text) {
  const doc = text.slice(0, 3000);
  if (!doc.trim()) return null;

  const body = {
    comment: { text: doc },
    requestedAttributes: {
      TOXICITY: {},
      INSULT: {},
      PROFANITY: {},
      THREAT: {}
    },
    doNotStore: true
  };
  if (PERSPECTIVE_LANG) body.languages = [PERSPECTIVE_LANG];

  const url = `https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze?key=${encodeURIComponent(
    PERSPECTIVE_API_KEY
  )}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`Perspective error ${res.status}: ${msg}`);
  }
  const json = await res.json();
  const pick = (k) => json?.attributeScores?.[k]?.summaryScore?.value ?? 0;
  return {
    TOXICITY: pick("TOXICITY"),
    INSULT: pick("INSULT"),
    PROFANITY: pick("PROFANITY"),
    THREAT: pick("THREAT")
  };
}

function shouldFlag(scores) {
  if (!scores) return false;
  const t = parseFloat(TOXICITY_THRESHOLD);
  const i = parseFloat(INSULT_THRESHOLD);
  const p = parseFloat(PROFANITY_THRESHOLD);
  const th = parseFloat(THREAT_THRESHOLD);
  return (
    scores.TOXICITY >= t ||
    scores.INSULT >= i ||
    scores.PROFANITY >= p ||
    scores.THREAT >= th
  );
}

// ---------- MAIN ----------
(async () => {
  try {
    const signer = await game.read.moderationSigner();
    const me = account.address;
    if (signer.toLowerCase() !== me.toLowerCase()) {
      console.warn(`WARNING: BOT_PRIVATE_KEY address ${me} != moderationSigner ${signer}.
Transaction will revert unless this key is owner().`);
    }
  } catch {}

  const id = await game.read.activeMessageId();
  if (!id || id === 0n) { console.log("No active message."); return; }

  const msg = await game.read.messages([id]);
  if (msg.resolved) { console.log(`Message ${id} already resolved.`); return; }

  const already = await game.read.modFlagged([id]);
  if (already) { console.log(`Message ${id} already modFlagged=true.`); return; }

  const text = await fetchTextFromUri(msg.uri);
  console.log(`Scoring id=${id} len=${text.length}`);
  if (!text.trim()) { console.log("Empty/unfetchable text; skipping."); return; }

  const scores = await perspectiveScore(text);
  console.log("Scores:", scores);

  if (!shouldFlag(scores)) { console.log("Below thresholds; not flagging."); return; }

  const hash = await game.write.setModerationFlag([id, true]);
  console.log("setModerationFlag tx =", hash);
})().catch((e) => {
  console.error("Bot error:", e);
  process.exit(1);
});
