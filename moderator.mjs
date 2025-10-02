#!/usr/bin/env node
// Moderator bot (Perspective via ADC / API-key fallback) with language-aware attribute retries.
// - Reads active message from GAME
// - Extracts text (meow:text:, data:, ipfs://, http(s))
// - Scores with Perspective (auto-language). If an attribute isn't supported for the detected
//   language, we drop it and retry.
// - If above thresholds -> calls setModerationFlag(id, true)

import { GoogleAuth } from 'google-auth-library';
import { createPublicClient, createWalletClient, http, webSocket } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import abi from './src/abi/BillboardGame.json' with { type: 'json' };

const GAME = process.env.GAME_ADDRESS;
const RPC  = process.env.RPC_URL;
const PK   = process.env.BOT_PRIVATE_KEY;
const PERSPECTIVE_API_KEY = process.env.PERSPECTIVE_API_KEY || '';
const CHAIN_ID = Number(process.env.CHAIN_ID || '8453'); // Base mainnet default

if (!GAME || !RPC || !PK) {
  console.error('Missing env. Need GAME_ADDRESS, RPC_URL, BOT_PRIVATE_KEY');
  process.exit(1);
}

const account = (() => {
  const k = PK.startsWith('0x') ? PK : `0x${PK}`;
  return privateKeyToAccount(k);
})();

// Minimal chain object so viem is happy regardless of RPC host
const chain = {
  id: CHAIN_ID,
  name: `chain-${CHAIN_ID}`,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC], webSocket: RPC.startsWith('wss') ? [RPC] : [] } }
};

const transport = RPC.startsWith('wss') ? webSocket(RPC) : http(RPC);
const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({ chain, transport, account });

// Perspective endpoint + required OAuth scopes
const ENDPOINT = 'https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze';
const PERSPECTIVE_SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/cloud-platform',
];

// ------- small helpers -------
function log(...a) { console.log(...a); }
function err(...a) { console.error(...a); }

async function fetchWithTimeout(url, opts = {}, ms = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function getTextFromUri(uri) {
  try {
    if (!uri) return null;

    // Inline format: meow:text:<uriEncoded>
    if (uri.startsWith('meow:text:')) {
      return decodeURIComponent(uri.slice('meow:text:'.length));
    }

    // data:text/plain;base64,<...>
    if (uri.startsWith('data:text/plain;base64,')) {
      const b64 = uri.slice('data:text/plain;base64,'.length);
      return Buffer.from(b64, 'base64').toString('utf8');
    }

    // IPFS / HTTP(S)
    const toHttp = (u) =>
      u.startsWith('ipfs://')
        ? `https://ipfs.io/ipfs/${u.slice(7).replace(/^ipfs\//, '')}`
        : u;

    const candidates = uri.startsWith('ipfs://')
      ? [
          toHttp(uri),
          toHttp(uri).replace('ipfs.io', 'cloudflare-ipfs.com'),
          toHttp(uri).replace('ipfs.io', 'gateway.pinata.cloud'),
        ]
      : [uri];

    for (const u of candidates) {
      if (!/^https?:\/\//i.test(u)) continue;
      try {
        const r = await fetchWithTimeout(u, {}, 10000);
        if (!r.ok) continue;
        const text = await r.text();
        if (text && text.trim()) {
          // keep it reasonable for Perspective
          return text.slice(0, 8000);
        }
      } catch {}
    }
  } catch {}
  return null;
}

// -------- Perspective calling with attribute fallback --------
const DEFAULT_ATTRS = [
  'TOXICITY',
  'INSULT',
  'THREAT',
  'SEXUALLY_EXPLICIT',
  'PROFANITY',
  'IDENTITY_ATTACK'
];

function makeBody(text, attrs) {
  const requestedAttributes = Object.fromEntries(attrs.map((a) => [a, {}]));
  return {
    comment: { text },
    doNotStore: true,
    // languages: []   // IMPORTANT: let Perspective auto-detect the language
    requestedAttributes
  };
}

async function sendToPerspective(body) {
  const preferADC = !!process.env.GOOGLE_APPLICATION_CREDENTIALS || !!process.env.GCP_SA_KEY;
  log('Perspective auth mode:', preferADC ? 'ADC' : (PERSPECTIVE_API_KEY ? 'API_KEY' : 'ADC'));

  if (!preferADC && PERSPECTIVE_API_KEY) {
    const res = await fetch(ENDPOINT + `?key=${PERSPECTIVE_API_KEY}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
  } else {
    const auth = new GoogleAuth({ scopes: PERSPECTIVE_SCOPES });
    const client = await auth.getClient();
    const { token } = await client.getAccessToken();
    if (!token) throw new Error('GoogleAuth could not obtain access token.');

    try {
      const ti = await client.getTokenInfo(token);
      if (ti?.scopes) log('Perspective token scopes:', ti.scopes);
    } catch {}

    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body)
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
  }
}

async function perspectiveScores(text) {
  let attrs = [...DEFAULT_ATTRS];

  while (attrs.length) {
    const body = makeBody(text, attrs);
    const { ok, status, json } = await sendToPerspective(body);

    if (ok) {
      const attr = json.attributeScores || {};
      const take = (k) => Number(attr?.[k]?.summaryScore?.value ?? 0);
      return {
        TOXICITY: take('TOXICITY'),
        INSULT: take('INSULT'),
        THREAT: take('THREAT'),
        SEXUALLY_EXPLICIT: take('SEXUALLY_EXPLICIT'),
        PROFANITY: take('PROFANITY'),
        IDENTITY_ATTACK: take('IDENTITY_ATTACK'),
      };
    }

    // Handle language-not-supported-by-attribute errors by dropping the offending attribute and retrying
    if (status === 400 && json?.error?.details) {
      const detail = json.error.details.find(
        (d) => d?.errorType === 'LANGUAGE_NOT_SUPPORTED_BY_ATTRIBUTE' &&
               d?.languageNotSupportedByAttributeError?.attribute
      );
      if (detail) {
        const bad = detail.languageNotSupportedByAttributeError.attribute;
        log(`Perspective: attribute ${bad} not supported for detected language (${detail.languageNotSupportedByAttributeError.detectedLanguages?.join(', ') || 'unknown'}). Dropping and retrying.`);
        attrs = attrs.filter((a) => a !== bad);
        continue;
      }
    }

    // Unknown error → throw with context
    throw new Error(`Perspective error ${status}: ${JSON.stringify(json, null, 2)}`);
  }

  log('Perspective: No supported attributes for this language. Returning zeros.');
  return {
    TOXICITY: 0, INSULT: 0, THREAT: 0, SEXUALLY_EXPLICIT: 0, PROFANITY: 0, IDENTITY_ATTACK: 0
  };
}

function shouldFlag(scores) {
  const s = scores || {};
  return (
    (s.TOXICITY ?? 0) >= 0.85 ||
    (s.INSULT ?? 0) >= 0.80 ||
    (s.THREAT ?? 0) >= 0.70 ||
    (s.SEXUALLY_EXPLICIT ?? 0) >= 0.90 ||
    (s.PROFANITY ?? 0) >= 0.80 ||
    (s.IDENTITY_ATTACK ?? 0) >= 0.75
  );
}

async function main() {
  const connectedId = await publicClient.getChainId();
  log('Connected to chainId =', connectedId);

  // 1) find active id
  const id = await publicClient.readContract({
    address: GAME,
    abi,
    functionName: 'activeMessageId',
    args: [],
  });

  log('activeMessageId =', String(id));
  if (!id || id === 0n) {
    log('No active message. Exiting.');
    return;
  }

  // 2) read message + mod state
  const [msg, flagged] = await Promise.all([
    publicClient.readContract({ address: GAME, abi, functionName: 'messages', args: [id] }),
    publicClient.readContract({ address: GAME, abi, functionName: 'modFlagged', args: [id] }),
  ]);

  const resolved = Boolean(msg?.resolved ?? msg?.[10]);
  const uri      = (msg?.uri ?? msg?.[5] ?? '').toString();

  if (resolved) { log('Already resolved — nothing to do.'); return; }
  if (flagged)  { log('Already flagged — nothing to do.'); return; }

  // 3) extract text
  const text = await getTextFromUri(uri);
  if (!text || !text.trim()) {
    log(`no retrievable text for URI=${uri}. Skipping.`);
    return;
  }
  log('Sample text (first 120):', JSON.stringify(text.slice(0, 120)));

  // 4) score
  const scores = await perspectiveScores(text);
  log('Scores:', scores);

  // 5) decide + flag
  if (!shouldFlag(scores)) {
    log('Below thresholds — not flagging.');
    return;
  }

  log('Above thresholds — flagging...');
  const hash = await walletClient.writeContract({
    address: GAME,
    abi,
    functionName: 'setModerationFlag',
    args: [id, true],
    account,
  });

  log('tx sent:', hash);
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') {
    throw new Error('Flag tx reverted.');
  }
  log('Moderation flag confirmed ✅');
}

main().catch((e) => {
  err('Moderator failed:', e);
  process.exit(1);
});
