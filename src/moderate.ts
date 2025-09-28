// src/moderate.ts
/* Multi-provider moderation: Perspective (Jigsaw) + OpenAI fallback */

type ModResult = {
  flagged: boolean;
  reasons: string[];
  provider: "perspective" | "openai" | "none";
};

const PERSPECTIVE_API_KEY = process.env.PERSPECTIVE_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const ORDER = (process.env.MOD_PROVIDER_ORDER || "perspective,openai")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean) as Array<"perspective" | "openai">;

// Tunables
const PERSPECTIVE_THRESHOLD = Number(process.env.PERSPECTIVE_THRESHOLD || "0.83"); // toxicity
const PERSPECTIVE_SEVERE_THRESHOLD = Number(process.env.PERSPECTIVE_SEVERE_THRESHOLD || "0.50");
const OPENAI_MODEL = process.env.OPENAI_MOD_MODEL || "omni-moderation-latest";

// ---- Providers ----
async function analyzeWithPerspective(text: string): Promise<ModResult> {
  if (!PERSPECTIVE_API_KEY) return { flagged: false, reasons: ["no key"], provider: "perspective" };

  const url = `https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze?key=${PERSPECTIVE_API_KEY}`;
  const body = {
    comment: { text },
    languages: ["en"],
    requestedAttributes: {
      TOXICITY: {},
      SEVERE_TOXICITY: {},
      THREAT: {},
      INSULT: {},
      PROFANITY: {},
      SEXUALLY_EXPLICIT: {},
      IDENTITY_ATTACK: {},
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    return { flagged: false, reasons: [`perspective http ${res.status}: ${t}`], provider: "perspective" };
  }
  const json = await res.json();

  function score(attr: string): number {
    return json?.attributeScores?.[attr]?.summaryScore?.value ?? 0;
  }

  const reasons: string[] = [];
  const tox = score("TOXICITY");
  const sev = score("SEVERE_TOXICITY");
  const threat = score("THREAT");
  const insult = score("INSULT");
  const profanity = score("PROFANITY");
  const sexual = score("SEXUALLY_EXPLICIT");
  const ident = score("IDENTITY_ATTACK");

  if (sev >= PERSPECTIVE_SEVERE_THRESHOLD) reasons.push(`SEVERE_TOXICITY=${sev.toFixed(2)}`);
  if (tox >= PERSPECTIVE_THRESHOLD) reasons.push(`TOXICITY=${tox.toFixed(2)}`);
  if (threat >= 0.80) reasons.push(`THREAT=${threat.toFixed(2)}`);
  if (insult >= 0.90) reasons.push(`INSULT=${insult.toFixed(2)}`);
  if (profanity >= 0.95) reasons.push(`PROFANITY=${profanity.toFixed(2)}`);
  if (sexual >= 0.90) reasons.push(`SEXUALLY_EXPLICIT=${sexual.toFixed(2)}`);
  if (ident >= 0.80) reasons.push(`IDENTITY_ATTACK=${ident.toFixed(2)}`);

  return { flagged: reasons.length > 0, reasons, provider: "perspective" };
}

async function analyzeWithOpenAI(text: string): Promise<ModResult> {
  if (!OPENAI_API_KEY) return { flagged: false, reasons: ["no key"], provider: "openai" };

  const res = await fetch("https://api.openai.com/v1/moderations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: OPENAI_MODEL, input: text }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    return { flagged: false, reasons: [`openai http ${res.status}: ${t}`], provider: "openai" };
  }
  const json = await res.json();
  const r = json?.results?.[0];
  if (!r) return { flagged: false, reasons: ["openai: empty"], provider: "openai" };

  const flagged: boolean = !!r.flagged;
  const cats = r.categories ?? {};
  const reasons = Object.keys(cats)
    .filter(k => cats[k])
    .map(k => `OPENAI:${k}`);

  return { flagged, reasons, provider: "openai" };
}

// ---- Orchestrator ----
export async function moderateText(text: string): Promise<ModResult> {
  for (const p of ORDER) {
    try {
      if (p === "perspective") {
        const r = await analyzeWithPerspective(text);
        // If Perspective is unavailable (no key / http error), fall through to next.
        if (r.reasons.includes("no key") || r.reasons[0]?.startsWith("perspective http")) continue;
        return r;
      }
      if (p === "openai") {
        const r = await analyzeWithOpenAI(text);
        if (r.reasons.includes("no key") || r.reasons[0]?.startsWith("openai http")) continue;
        return r;
      }
    } catch (e: any) {
      // swallow and try next provider
    }
  }
  return { flagged: false, reasons: ["no provider configured"], provider: "none" };
}
