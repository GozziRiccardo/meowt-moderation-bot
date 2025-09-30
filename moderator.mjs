// moderator.mjs — drop-in
import { createPublicClient, createWalletClient, http, parseAbi, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

// If you prefer your JSON ABI file:
import gameAbiJson from "./src/abi/BillboardGame.json" assert { type: "json" };
const GAME_ABI = (gameAbiJson.abi ?? gameAbiJson);

// Minimal fields used in this script must exist in the ABI:
// - activeMessageId()
// - messages(uint256) -> { id, author, stake, startTime, B0, uri, contentHash, likes, dislikes, feePot, resolved, nuked, ... }
// - modFlagged(uint256) -> bool
// - setModerationFlag(uint256,bool)

const {
  RPC_URL,
  GAME_ADDRESS,
  BOT_PRIVATE_KEY,
  PERSPECTIVE_API_KEY,
} = process.env;

if (!RPC_URL || !GAME_ADDRESS || !BOT_PRIVATE_KEY || !PERSPECTIVE_API_KEY) {
  console.error("Missing one of RPC_URL, GAME_ADDRESS, BOT_PRIVATE_KEY, PERSPECTIVE_API_KEY");
  process.exit(1);
}

// ---------- viem clients ----------
const account = privateKeyToAccount(`0x${BOT_PRIVATE_KEY.replace(/^0x/, "")}`);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });
const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(RPC_URL) });

// ---------- URI resolvers (match dapp behavior) ----------
const IPFS_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
];

function looksHttp(u = "") { return u.startsWith("http://") || u.startsWith("https://"); }

async function fetchText(url) {
  try {
    const r = await fetch(url, { redirect: "follow" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } catch (e) {
    throw new Error(`fetch failed: ${url} (${e?.message || e})`);
  }
}

async function resolveUriToText(uri = "") {
  if (!uri) return "";

  // inline text: meow:text:<urlencoded>
  const MEOW_PREFIX = "meow:text:";
  if (uri.startsWith(MEOW_PREFIX)) {
    try {
      return decodeURIComponent(uri.slice(MEOW_PREFIX.length));
    } catch (e) {
      console.warn("decodeURIComponent failed for meow:text:", e?.message || e);
      return "";
    }
  }

  // data: plain base64
  const DATA_PREFIX = "data:text/plain;base64,";
  if (uri.startsWith(DATA_PREFIX)) {
    try {
      const b64 = uri.slice(DATA_PREFIX.length);
      return Buffer.from(b64, "base64").toString("utf8");
    } catch (e) {
      console.warn("base64 decode failed:", e?.message || e);
      return "";
    }
  }

  // ipfs://... -> try a few gateways
  if (uri.startsWith("ipfs://")) {
    const cidPath = uri.slice("ipfs://".length).replace(/^ipfs\//, "");
    for (const gw of IPFS_GATEWAYS) {
      try {
        const text = await fetchText(gw + cidPath);
        if (text) return text;
      } catch { /* try next */ }
    }
    console.warn("All IPFS gateways failed for", uri);
    return "";
  }

  // http(s)://...
  if (looksHttp(uri)) {
    try {
      return await fetchText(uri);
    } catch (e) {
      console.warn("HTTP fetch failed:", e?.message || e);
      return "";
    }
  }

  // Unknown scheme
  return "";
}

// ---------- Perspective ----------
async function perspectiveScores(text) {
  const url = `https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze?key=${encodeURIComponent(PERSPECTIVE_API_KEY)}`;
  const body = {
    comment: { text },
    languages: ["en"],
    requestedAttributes: {
      TOXICITY: {}, SEVERE_TOXICITY: {}, INSULT: {}, PROFANITY: {},
      // add other attributes if you like
    },
    doNotStore: true,
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Perspective error ${r.status}: ${t}`);
  }
  const json = await r.json();
  const g = (name) => json.attributeScores?.[name]?.summaryScore?.value ?? 0;
  return {
    TOXICITY: g("TOXICITY"),
    SEVERE_TOXICITY: g("SEVERE_TOXICITY"),
    INSULT: g("INSULT"),
    PROFANITY: g("PROFANITY"),
  };
}

// simple policy thresholds (tune as you like)
const THRESH = {
  TOXICITY:        0.85,
  SEVERE_TOXICITY: 0.70,
  INSULT:          0.80,
  PROFANITY:       0.80,
};

function violates(scores) {
  return (
    scores.SEVERE_TOXICITY >= THRESH.SEVERE_TOXICITY ||
    scores.TOXICITY        >= THRESH.TOXICITY ||
    scores.INSULT          >= THRESH.INSULT ||
    scores.PROFANITY       >= THRESH.PROFANITY
  );
}

// ---------- contract helpers ----------
async function readActiveAndMessage() {
  const id = await publicClient.readContract({
    address: getAddress(GAME_ADDRESS),
    abi: GAME_ABI,
    functionName: "activeMessageId",
    args: [],
  });
  const idBig = BigInt(id || 0n);
  if (idBig === 0n) return { id: 0n, msg: null };

  const msg = await publicClient.readContract({
    address: getAddress(GAME_ADDRESS),
    abi: GAME_ABI,
    functionName: "messages",
    args: [idBig],
  });
  return { id: idBig, msg };
}

async function alreadyFlagged(id) {
  try {
    return await publicClient.readContract({
      address: getAddress(GAME_ADDRESS),
      abi: GAME_ABI,
      functionName: "modFlagged",
      args: [id],
    });
  } catch {
    return false;
  }
}

async function setFlag(id, flagged) {
  const hash = await walletClient.writeContract({
    address: getAddress(GAME_ADDRESS),
    abi: GAME_ABI,
    functionName: "setModerationFlag",
    args: [id, flagged],
    account,
  });
  console.log("setModerationFlag tx:", hash);
  // wait is optional; contract auto-resolves active posts when flagged = true
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

// ---------- main ----------
(async () => {
  try {
    const { id, msg } = await readActiveAndMessage();
    console.log("activeMessageId =", id.toString());
    if (!id || id === 0n || !msg) {
      console.log("No active message. Done.");
      return;
    }

    const uri = (msg.uri ?? msg[5] ?? "").toString();
    const text = (await resolveUriToText(uri)).trim();

    if (!text) {
      console.log(`no retrievable text for URI=${uri}. Skipping.`);
      return;
    }

    console.log("Sample text (first 120):", JSON.stringify(text.slice(0, 120)));

    const scores = await perspectiveScores(text);
    console.log("Perspective scores:", scores);

    if (!(await alreadyFlagged(id)) && violates(scores)) {
      console.log("❗Violates thresholds. Flagging…");
      await setFlag(id, true);
      console.log("✅ Flagged & (if active) auto-nuked.");
    } else {
      console.log("No action needed.");
    }
  } catch (e) {
    console.error("Moderator failed:", e?.stack || e?.message || e);
    process.exitCode = 1;
  }
})();
