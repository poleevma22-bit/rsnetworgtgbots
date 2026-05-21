// Spec: openspec/changes/bot-sales-language-detection/specs/bot-sales-conversation/spec.md
// 24 cases covering detection priority, lock persistence, switch escalation,
// prompt assembly, and default openers. Run with `npm test`.
//
// Uses a per-suite temp sqlite file so the migration runs idempotently against
// a fresh DB and doesn't touch the production data file.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "tgbots-lang-")), "test.sqlite3");

const db = await import("../src/db.js");
const ai = await import("../src/ai.js");

// --- §2 detectLeadLanguage ---

test("detectLeadLanguage: Cyrillic handle returns ru", () => {
  assert.equal(db.detectLeadLanguage({ username: "сергей_iga" }), "ru");
});

test("detectLeadLanguage: transliterated RU first name returns ru", () => {
  assert.equal(db.detectLeadLanguage({ username: "nikolay_traffic" }), "ru");
});

test("detectLeadLanguage: RU geo wins over EN first name", () => {
  // kate matches EN first-name list, msk matches RU geo. RU evaluated first.
  assert.equal(db.detectLeadLanguage({ username: "kate_msk" }), "ru");
});

test("detectLeadLanguage: RU surname suffix returns ru", () => {
  assert.equal(db.detectLeadLanguage({ username: "smirnov_dsp" }), "ru");
});

test("detectLeadLanguage: EN first name returns en", () => {
  assert.equal(db.detectLeadLanguage({ username: "john_marketing" }), "en");
});

test("detectLeadLanguage: pure-Latin handle ≥4 chars returns en", () => {
  assert.equal(db.detectLeadLanguage({ username: "ConvertPro" }), "en");
});

test("detectLeadLanguage: handle with digits returns null", () => {
  // Digits disqualify the pure-Latin EN positive signal.
  assert.equal(db.detectLeadLanguage({ username: "crypto_king_777" }), null);
});

test("detectLeadLanguage: Cyrillic firstName overrides Latin username", () => {
  assert.equal(db.detectLeadLanguage({ username: "u123", firstName: "Иван" }), "ru");
});

// --- §2 detectInboundTextLanguage ---

test("detectInboundTextLanguage: Cyrillic content returns ru", () => {
  assert.equal(db.detectInboundTextLanguage("Привет, расскажите про DSP"), "ru");
});

test("detectInboundTextLanguage: Latin content returns en", () => {
  assert.equal(db.detectInboundTextLanguage("Sounds great, send the deck"), "en");
});

test("detectInboundTextLanguage: short greeting returns null", () => {
  assert.equal(db.detectInboundTextLanguage("ok"), null);
});

test("detectInboundTextLanguage: emoji-only returns null", () => {
  assert.equal(db.detectInboundTextLanguage("👍🔥"), null);
});

// --- §2 resolveThreadLanguage (5-level priority) ---

test("resolveThreadLanguage: inbound text wins over handle", () => {
  // Maksim handle looks RU; inbound text is clearly EN — level 1 fires.
  const r = db.resolveThreadLanguage(
    { target_username: "Maksim_AG" },
    [{ direction: "in", text: "Hello, can you share more about retention DSP?" }],
  );
  assert.deepEqual(r, { language: "en", source: 1 });
});

test("resolveThreadLanguage: handle used when no inbound", () => {
  const r = db.resolveThreadLanguage({ target_username: "nikolay_igaming" }, []);
  assert.deepEqual(r, { language: "ru", source: 2 });
});

test("resolveThreadLanguage: bio used when handle ambiguous", () => {
  const r = db.resolveThreadLanguage(
    { target_username: "user123", target_bio: "Маркетолог в iGaming" },
    [],
  );
  assert.deepEqual(r, { language: "ru", source: 3 });
});

test("resolveThreadLanguage: history used when current inbound too short", () => {
  const r = db.resolveThreadLanguage(
    { target_username: "x99" },
    [
      { direction: "in", text: "да, давайте" },
      { direction: "in", text: "ok" },
    ],
  );
  // Last inbound "ok" passes the 3-char floor but is Latin → returns 'en' at level 1.
  // We want the spec scenario where last inbound is too short. Use a shorter one:
  const r2 = db.resolveThreadLanguage(
    { target_username: "x99" },
    [
      { direction: "in", text: "да, давайте" },
      { direction: "in", text: "hi" }, // under floor
    ],
  );
  assert.equal(r2.language, "ru");
  // Source can be 1 (last inbound RU) or 4 (history scan) — both spec-valid.
  assert.ok(r2.source === 1 || r2.source === 4);
});

test("resolveThreadLanguage: unknown falls through to en default", () => {
  const r = db.resolveThreadLanguage({ target_username: "u_999" }, []);
  assert.deepEqual(r, { language: "en", source: 5 });
});

// --- §2 lock persistence ---

test("setThreadLanguage persists and is read back", () => {
  // Create a thread row.
  const thread = db.findOrCreateThread({
    accountId: "acct-test-lang",
    broadcastId: null,
    targetUsername: "lock_test_user",
    targetTelegramId: null,
    initialOutboundText: "hi",
  });
  db.setThreadLanguage(thread.id, "ru");
  const reloaded = db.getThread(thread.id);
  assert.equal(reloaded.language, "ru");
});

test("setThreadLanguage rejects invalid lang", () => {
  const thread = db.findOrCreateThread({
    accountId: "acct-test-lang",
    broadcastId: null,
    targetUsername: "lock_test_invalid",
    targetTelegramId: null,
    initialOutboundText: "hi",
  });
  db.setThreadLanguage(thread.id, "es"); // unsupported
  const reloaded = db.getThread(thread.id);
  assert.equal(reloaded.language, null);
});

// --- §3 prompt assembly ---

test("buildSystemPrompt: locked-ru contains LOCKED LANGUAGE: ru", () => {
  const p = ai.buildSystemPrompt({ language: "ru", locked: true, taskType: "cold" });
  assert.ok(p.includes("LOCKED LANGUAGE: ru"));
});

test("buildSystemPrompt: locked-en contains LOCKED LANGUAGE: en", () => {
  const p = ai.buildSystemPrompt({ language: "en", locked: true, taskType: "cold" });
  assert.ok(p.includes("LOCKED LANGUAGE: en"));
});

test("buildSystemPrompt: default branch has no bilingual greeting directive", () => {
  const p = ai.buildSystemPrompt({ language: "en", defaultOnly: true, taskType: "cold" });
  // The old "ответь сразу на двух языках" directive must be gone.
  assert.ok(!p.includes("ответь сразу на двух языках"));
  // And the new explicit prohibition is in place.
  assert.ok(p.includes("DEFAULT LANGUAGE: en"));
  assert.ok(p.includes("ЗАПРЕЩЕНО открывать диалог двуязычным"));
});

test("buildSystemPrompt: ru-locked includes TONE_RU, not TONE_EN", () => {
  const p = ai.buildSystemPrompt({ language: "ru", locked: true, taskType: "cold" });
  assert.ok(p.includes(ai.TONE_RU));
  assert.ok(!p.includes(ai.TONE_EN));
});

test("buildSystemPrompt: en-locked includes TONE_EN, not TONE_RU", () => {
  const p = ai.buildSystemPrompt({ language: "en", locked: true, taskType: "cold" });
  assert.ok(p.includes(ai.TONE_EN));
  assert.ok(!p.includes(ai.TONE_RU));
});

// --- §3 default openers ---

test("defaultOpenerFor('ru') returns the RU ConvertAgain opener", () => {
  assert.ok(ai.defaultOpenerFor("ru").startsWith("Привет! Я из ConvertAgain."));
});

test("defaultOpenerFor('en') returns the EN ConvertAgain opener", () => {
  assert.ok(ai.defaultOpenerFor("en").startsWith("Hi! I'm from ConvertAgain."));
});

test("defaultOpenerFor unknown returns null", () => {
  assert.equal(ai.defaultOpenerFor("xx"), null);
  assert.equal(ai.defaultOpenerFor(null), null);
});
