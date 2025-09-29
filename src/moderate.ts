// src/moderate.ts
/* Multi-provider moderation: Perspective (Jigsaw) + OpenAI fallback */

export type ModResult = {
  flagged: boolean;
  reasons: string[];
  provider: "perspective" | "openai" | "none";
};

const PERSPECTIVE_API_KEY = process.env.PERSPECTIVE_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MOD_MODEL || "omni-moderation-latest";

// Provider order (comma-separated env: "perspective,openai" or "openai,perspective")
const ORDER = (process.env.MOD_PROVIDER_ORDER || "perspective,openai")
  .split(",")
  .map((s: string) => s.trim().toLowerCase())
  .filter(Boolean) as Array<"perspective" | "openai">;

// Tunables for Perspective
const PERSPECTIVE_LANG = process.env.PERSPECTIVE_LANG || "en";
const PERSPECTIVE_THRESHOLD = Number(process.env.PERSPECTIVE_THRESHOLD || "0.83"); // toxicity
const PERSPECTIVE_SEVERE_THRESHOLD = Number(process.env.PERSPECTIVE_SEVERE_THRESHOLD || "0.50");

// -------------------- Perspective helpers --------------------

type PerspectiveScores = {
  TOXICITY: number;
  SEVERE_TOXICITY: number;
  INSULT: number;
  THREAT: number;
  IDENTITY_ATTACK: number;
  SEXUALLY_EXPLICIT: number;
  PROFANITY: number;
};

/** Call Perspective API and return normalized scores 0..1. Returns null on errors/misconfig. */
async function getPerspectiveScores(
  text: string,
  langHint?: string
): Promise<PerspectiveScores | null> {
  if (!PERSPECTIVE_API_KEY) return null;

  // Perspective accepts long inputs, but we clip to be safe
  const clipped = text.slice(0, 8000);

  const body = {
    comment: { text: clipped },
    languages: langHint ? [langHint] : [PERSPECTIVE_LANG],
    doNotStore: true,
    requestedAttributes: {
      TOXICITY: {},
      SEVERE_TOXICITY: {},
      INSULT: {},
      THREAT: {},
      IDENTITY_ATTACK: {},
      SEXUALLY_EXPLICIT: {},
      PROFANITY: {},
    },
  };

  const url = `https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze?key=${PERSPECTIVE_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    // Let orchestrator try the next provider
    return null;
  }

  const data = await res.json();
  const g = (k: string) => data?.attributeScores?.[k]?.summaryScore?.value ?? 0;

  return {
    TOXICITY: g("TOXICITY"),
    SEVERE_TOXICITY: g("SEVERE_TOXICITY"),
    INSULT: g("INSULT"),
    THREAT: g("THREAT"),
    IDENTITY_ATTACK: g("IDENTITY_ATTACK"),
    SEXUALLY_EXPLICIT: g("SEXUALLY_EXPLICIT"),
    PROFANITY: g("PROFANITY"),
  };
}

/** Perspective provider → ModResult */
async function analyzeWithPerspective(text: string): Promise<ModResult> {
  const scores = await getPerspectiveScores(text).catch(() => null);
  if (!scores) {
    return { flagged: false, reasons: ["perspective: unavailable"], provider: "perspective" };
  }

  const reasons: string[] = [];
  if (scores.SEVERE_TOXICITY >= PERSPECTIVE_SEVERE_THRESHOLD) {
    reasons.push(`SEVERE_TOXICITY=${scores.SEVERE_TOXICITY.toFixed(2)}`);
  }
  if (scores.TOXICITY >= PERSPECTIVE_THRESHOLD) {
    reasons.push(`TOXICITY=${scores.TOXICITY.toFixed(2)}`);
  }
  if (scores.THREAT >= 0.80) reasons.push(`THREAT=${scores.THREAT.toFixed(2)}`);
  if (scores.INSULT >= 0.90) reasons.push(`INSULT=${scores.INSULT.toFixed(2)}`);
  if (scores.PROFANITY >= 0.95) reasons.push(`PROFANITY=${scores.PROFANITY.toFixed(2)}`);
  if (scores.SEXUALLY_EXPLICIT >= 0.90) reasons.push(`SEXUALLY_EXPLICIT=${scores.SEXUALLY_EXPLICIT.toFixed(2)}`);
  if (scores.IDENTITY_ATTACK >= 0.80) reasons.push(`IDENTITY_ATTACK=${scores.IDENTITY_ATTACK.toFixed(2)}`);

  return { flagged: reasons.length > 0, reasons, provider: "perspective" };
}

// -------------------- OpenAI provider --------------------

async function analyzeWithOpenAI(text: string): Promise<ModResult> {
  if (!OPENAI_API_KEY) {
    return { flagged: false, reasons: ["openai: no key"], provider: "openai" };
  }

  const res = await fetch("https://api.openai.com/v1/moderations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: OPENAI_MODEL, input: text }),
  }).catch(() => null);

  if (!res || !res.ok) {
    return { flagged: false, reasons: ["openai: unavailable"], provider: "openai" };
  }

  const json = await res.json().catch(() => null);
  const r = json?.results?.[0];
  if (!r) return { flagged: false, reasons: ["openai: empty"], provider: "openai" };

  const flagged: boolean = !!r.flagged;
  const cats = r.categories ?? {};
  const reasons = Object.keys(cats)
    .filter(k => cats[k])
    .map(k => `OPENAI:${k}`);

  return { flagged, reasons, provider: "openai" };
}

// -------------------- Orchestrator --------------------

export async function moderateText(text: string): Promise<ModResult> {
  for (const p of ORDER) {
    try {
      if (p === "perspective") {
        const r = await analyzeWithPerspective(text);
        if (r.reasons.includes("perspective: unavailable")) continue; // fall through
        return r;
      }
      if (p === "openai") {
        const r = await analyzeWithOpenAI(text);
        if (r.reasons.includes("openai: no key") || r.reasons.includes("openai: unavailable")) continue;
        return r;
      }
    } catch {
      // swallow and try next provider
    }
  }
  // No provider configured/available → allow
  return { flagged: false, reasons: ["no provider configured"], provider: "none" };
}
