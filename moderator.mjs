#!/usr/bin/env node
// Moderator bot (Perspective via Service Account / ADC, with API-key fallback)
// - Reads active message from GAME
// - Extracts text (supports meow:text:, data:, ipfs://, http(s))
// - Scores with Perspective
// - If above thresholds -> calls setModerationFlag(id, true)
// Requires env: GAME_ADDRESS, RPC_URL, BOT_PRIVATE_KEY
// Auth selection: prefers ADC (GOOGLE_APPLICATION_CREDENTIALS / GCP_SA_KEY). Falls back to PERSPECTIVE_API_KEY if set and ADC not present.

import { GoogleAuth } from 'google-auth-library';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import abi from './src/abi/BillboardGame.json' with { type: 'json' };

const GAME = process.env.GAME_ADDRESS;
const RPC  = process.env.RPC_URL;
const PK   = process.env.BOT_PRIVATE_KEY;
const PERSPECTIVE_API_KEY = process.env.PERSPECTIVE_API_KEY || '';

if (!GAME || !RPC || !PK) {
  console.error('Missing env. Need GAME_ADDRESS, RPC_URL, BOT_PRIVATE_KEY');
  process.exit(1);
}

const account = (() => {
  const k = PK.startsWith('0x') ? PK : (`0x${PK}`);
  return privateKeyToAccount(k);
})();

const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
const walletClient = createWalletClient({ chain: baseSepolia, transport: http(RPC), account });

// Perspective endpoint + required OAuth scopes
const ENDPOINT = 'https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze';
// Perspective expects an OAuth token; userinfo.email is the key scope it checks.
// cloud-platform is fine to include and often already allowed by org policy.
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

async function perspectiveScores(text) {
  const body = {
    comment: { text },
    doNotStore: true,
    languages: ['en'],
    requestedAttributes: {
      TOXICITY: {},
      INSULT: {},
      THREAT: {},
      SEXUALLY_EXPLICIT: {},
      PROFANITY: {},
      IDENTITY_ATTACK: {},
    },
  };

  // Prefer ADC (service account) if present; otherwise fall back to API key if provided.
  const preferADC = !!process.env.GOOGLE_APPLICATION_CREDENTIALS || !!process.env.GCP_SA_KEY;
  log('Perspective auth mode:', preferADC ? 'ADC' : (PERSPECTIVE_API_KEY ? 'API_KEY' : 'ADC'));

  let res;
  if (!preferADC && PERSPECTIVE_API_KEY) {
    // API key path
    res = await fetch(`${ENDPOINT}?key=${PERSPECTIVE_API_KEY}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } else {
    // OAuth via ADC (Service Account JSON)
    const auth = new GoogleAuth({ scopes: PERSPECTIVE_SCOPES });
    const client = await auth.getClient();
    const { token } = await client.getAccessToken();
    if (!token) throw new Error('GoogleAuth could not obtain access token.');

    // (Optional) print granted scopes for debugging
    try {
      const ti = await client.getTokenInfo(token);
      if (ti?.scopes) log('Perspective token scopes:', ti.scopes);
    } catch {
      // Some SA tokens may not support token info; safe to ignore
    }

    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Perspective error ${res.status}: ${JSON.stringify(json, null, 2)}`);
  }

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
