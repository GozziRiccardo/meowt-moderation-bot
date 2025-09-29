// src/moderate.ts
/* Multi-provider moderation: Perspective (Jigsaw) + OpenAI fallback */

export type ModResult = {
  flagged: boolean;
  reasons: string[];
  provider: "perspective" | "openai" | "none";
  scores?: PerspectiveScores; // included for logging/debugging
};

const PERSPECTIVE_API_KEY = process.env.PERSPECTIVE_API_KEY ?? "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const OPENAI_MODEL = process.env.OPENAI_MOD_MODEL ?? "omni-moderation-latest";

// Order can be changed via env, e.g. "openai,perspective"
const ORDER = (process.env.MOD_PROVIDER_ORDER ?? "perspective,openai")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean) as Array<"perspective" | "openai">;

// Optional single-language hint; if unset we let Perspective auto-detect.
const PERSPECTIVE_LANG = (process.env.PERSPECTIVE_LANG ?? "").trim() || undefined;

// --- Perspective API helper ---

export type PerspectiveScores = {
  toxicity: number;
  severe_toxicity: number;
  insult: number;
  threat: number;
  identity_attack: number;
  sexually_explicit: number;
  profanity: number;
};

async function callPerspective(
  text: string,
  langHint?: string
): Promise<PerspectiveScores | null> {
  if (!PERSPECTIVE_API_KEY) return null;

  // Safety clip (Perspective supports long text, but keep it sane)
  const clipped = text.slice(0, 8000);

  const body = {
    comment: { text: clipped },
    languages: langHint ? [langHint] : undefined,
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
    const t = await res.text().catch(() => "");
    console.warn("Perspective error:", res.status, t);
    return null;
  }

  const data = await res.json();
  const g = (k: string) => data?.attributeScores?.[k]?.summaryScore?.value ?? 0;

  return {
    toxicity: g("TOXICITY"),
    severe_toxicity: g("SEVERE_TOXICITY"),
    insult: g("INSULT"),
    threat: g("THREAT"),
    identity_attack: g("IDENTITY_ATTACK"),
    sexually_explicit: g("SEXUALLY_EXPLICIT"),
    profanity: g("PROFANITY"),
  };
}

// Thresholds (tunable via env). Defaults reflect the policy we discussed.
const THRESH = {
  // single-attribute hard triggers
  severe: Number(process.env.PERSPECTIVE_SEVERE_THRESHOLD ?? "0.85"),
  toxicity: Number(process.env.PERSPECTIVE_TOXICITY_THRESHOLD ?? "0.92"),
  identity: Number(process.env.PERSPECTIVE_IDENTITY_THRESHOLD ?? "0.85"),
  threat: Number(process.env.PERSPECTIVE_THREAT_THRESHOLD ?? "0.80"),
  sexual: Number(process.env.PERSPECTIVE_SEXUAL_THRESHOLD ?? "0.92"),
  // weighted combo trigger (fires when several are moderately high)
  combo: Number(process.env.PERSPECTIVE_COMBO_THRESHOLD ?? "2.4"),
};

function perspectiveDecision(scores: PerspectiveScores): { block: boolean; reasons: string[] } {
  const r: string[] = [];

  if (scores.severe_toxicity >= THRESH.severe) r.push(`SEVERE_TOXICITY=${scores.severe_toxicity.toFixed(2)}`);
  if (scores.identity_attack >= THRESH.identity) r.push(`IDENTITY_ATTACK=${scores.identity_attack.toFixed(2)}`);
  if (scores.threat >= THRESH.threat) r.push(`THREAT=${scores.threat.toFix
