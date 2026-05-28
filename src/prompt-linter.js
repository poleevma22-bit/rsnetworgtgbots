// prompt-linter.js
//
// Runtime detector for the two LLM failure modes we have evidence of:
//   1. Repetition — bot sends a near-duplicate of a recent outbound.
//   2. Contradiction — bot's reply rejects an entity the assembled system
//      prompt explicitly lists as a client/partner.
//
// Pure functions, no DB access, no I/O. Designed to be unit-tested with
// fixture data via node --test.

const REPETITION_THRESHOLD = 0.85;
const MAX_HISTORY_COMPARE = 3;

// --- Trigram Jaccard helpers ---

function trigrams(text) {
  const cleaned = String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (cleaned.length < 3) return new Set();
  const grams = new Set();
  for (let i = 0; i <= cleaned.length - 3; i++) {
    grams.add(cleaned.slice(i, i + 3));
  }
  return grams;
}

function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const item of setA) if (setB.has(item)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// --- Claim extraction (contradiction detector) ---

// Patterns that introduce a list of clients / partners in the system prompt.
// The captured group MUST be the right-hand side of the claim — the tokens
// we treat as "things we say we work with".
const CLAIM_PATTERNS = [
  /мы\s+работаем\s+с\s+([^.\n]+)/giu,
  /(?:среди\s+)?(?:наших?\s+)?клиент(?:ы|ов)?\s*:?\s*([^.\n]+)/giu,
  /([\p{L}\p{M}0-9_ .'-]+?)\s+(?:—|-|это)\s+(?:наш|наши)\s+клиент/giu,
  /we\s+work\s+with\s+([^.\n]+)/gi,
  /(?:our\s+)?clients?\s*:?\s*([^.\n]+)/gi,
  /([\p{L}0-9_ .'-]+?)\s+is\s+(?:our|a)\s+client/giu,
];

// Stopwords that show up on the right-hand side but aren't entities.
const CLAIM_STOPWORDS = new Set([
  "и", "а", "но", "также", "тоже", "ещё", "наш", "наши", "все", "других",
  "et", "and", "or", "etc", "such", "as", "well", "more", "others",
  "the", "a", "an",
]);

function extractClaimedEntities(assembledPrompt) {
  const text = String(assembledPrompt || "");
  const out = new Set();
  for (const pattern of CLAIM_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const rhs = (match[1] || "").trim();
      if (!rhs) continue;
      // Split on commas / and / "и" / "&" / semicolons to get individual tokens.
      const parts = rhs.split(/[,;]|\s+и\s+|\s+and\s+|\s+&\s+/i);
      for (const part of parts) {
        const cleaned = part.trim().replace(/^[«"'""„]+|[»"'""„.!?]+$/g, "").trim();
        if (!cleaned) continue;
        if (cleaned.length < 3) continue;
        const lower = cleaned.toLowerCase();
        if (CLAIM_STOPWORDS.has(lower)) continue;
        // Take only the first 1-3 words of each token (avoids absorbing the
        // rest of a sentence when there's no clear delimiter).
        const trimmed = cleaned.split(/\s+/).slice(0, 3).join(" ");
        out.add(trimmed);
      }
    }
  }
  return Array.from(out);
}

// --- Counter-claim detection ---

// Build a regex that matches the entity as a whole word (Unicode aware).
function entityRegex(entity) {
  const escaped = entity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // (?<![\p{L}\p{M}\p{N}_]) and (?![\p{L}\p{M}\p{N}_]) emulate \b for Unicode.
  return new RegExp(
    `(?<![\\p{L}\\p{M}\\p{N}_])${escaped}(?![\\p{L}\\p{M}\\p{N}_])`,
    "iu"
  );
}

const REJECTION_PATTERNS_AFTER = [
  /не\s+подойд[её]т/iu,
  /нам\s+не\s+подход(?:ит|ят)/iu,
  /(?:это|тут|здесь)\s+не\s+(?:имеет\s+смысла|подходит)/iu,
  /не\s+для\s+(?:нас|вас)/iu,
  /(?:is\s+)?not\s+for\s+(?:us|you)/i,
  /doesn'?t\s+(?:work|fit|apply)/i,
  /we\s+don'?t\s+work\s+with/i,
];

const REJECTION_PATTERNS_BEFORE = [
  /мы\s+не\s+работаем\s+с/iu,
  /мы\s+не\s+(?:берём|беремся|занимаемся)/iu,
  /we\s+don'?t\s+work\s+with/i,
  /we\s+do\s+not\s+(?:work|engage)\s+with/i,
];

function replyRejectsEntity(reply, entity) {
  if (!reply || !entity) return false;
  // Entity must appear in the reply at all (word-boundary).
  const entityRe = entityRegex(entity);
  if (!entityRe.test(reply)) {
    // Also try a token-level match (single most distinctive word) for
    // multi-word entities like "Alpha Affiliates" → also catch "Alpha"
    // or "Affiliates" individually if either appears.
    const tokens = entity.split(/\s+/).filter((t) => t.length >= 4);
    const anyTokenMatch = tokens.some((t) => entityRegex(t).test(reply));
    if (!anyTokenMatch) return false;
  }
  // Now check whether a rejection pattern appears in the same reply.
  for (const re of REJECTION_PATTERNS_AFTER) {
    if (re.test(reply)) return true;
  }
  for (const re of REJECTION_PATTERNS_BEFORE) {
    if (re.test(reply)) return true;
  }
  return false;
}

// --- Public API ---

/**
 * @param {{ reply: string, history?: Array<{direction:string,text:string}>, assembledPrompt?: string }} input
 * @returns {{ findings: Array<{type:string,severity:string,detail:string}> }}
 */
export function lintReply(input) {
  try {
    const { reply, history = [], assembledPrompt = "" } = input || {};
    const findings = [];
    if (typeof reply !== "string" || reply.trim() === "") {
      return { findings };
    }

    // 1. Repetition detector
    const candidateGrams = trigrams(reply);
    const recentOutbounds = history
      .filter((m) => m && m.direction === "out" && typeof m.text === "string")
      .slice(-MAX_HISTORY_COMPARE);
    let bestSim = 0;
    let bestIndex = -1;
    for (let i = 0; i < recentOutbounds.length; i++) {
      const sim = jaccard(candidateGrams, trigrams(recentOutbounds[i].text));
      if (sim > bestSim) { bestSim = sim; bestIndex = i; }
    }
    if (bestSim >= REPETITION_THRESHOLD && bestIndex >= 0) {
      findings.push({
        type: "repetition",
        severity: "block",
        detail: `matches outbound at index ${bestIndex} (similarity ${bestSim.toFixed(2)})`,
      });
    }

    // 2. Contradiction detector
    const entities = extractClaimedEntities(assembledPrompt);
    for (const entity of entities) {
      if (replyRejectsEntity(reply, entity)) {
        findings.push({
          type: "contradiction",
          severity: "block",
          detail: `asserted '${entity}' as client in prompt but reply rejects it`,
        });
        // One contradiction is enough — escalate, don't pile on.
        break;
      }
    }

    return { findings };
  } catch {
    // Defensive: a linter bug must never block a reply.
    return { findings: [] };
  }
}

// Exported helpers for tests.
export const __internals = {
  trigrams, jaccard, extractClaimedEntities, replyRejectsEntity, entityRegex,
};
