// Run with: node --test /opt/tgbots/test/prompt-linter.test.js
import { test } from "node:test";
import assert from "node:assert/strict";

import { lintReply, __internals } from "../src/prompt-linter.js";

const { trigrams, jaccard, extractClaimedEntities, replyRejectsEntity } = __internals;

test("trigrams: empty for short input", () => {
  assert.equal(trigrams("").size, 0);
  assert.equal(trigrams("ab").size, 0);
  assert.equal(trigrams("abc").size, 1);
});

test("jaccard: identical strings", () => {
  assert.equal(jaccard(trigrams("hello world"), trigrams("hello world")), 1);
});

test("jaccard: disjoint strings", () => {
  const a = trigrams("xxx");
  const b = trigrams("yyy");
  assert.equal(jaccard(a, b), 0);
});

test("lintReply: empty findings for clean reply", () => {
  const r = lintReply({
    reply: "Привет! Расскажите про ваш бизнес.",
    history: [],
    assembledPrompt: "Ты менеджер по продажам.",
  });
  assert.deepEqual(r.findings, []);
});

test("lintReply: defensive return on garbage input", () => {
  assert.deepEqual(lintReply(null).findings, []);
  assert.deepEqual(lintReply({}).findings, []);
  assert.deepEqual(lintReply({ reply: "" }).findings, []);
});

test("lintReply: verbatim repeat flagged", () => {
  const r = lintReply({
    reply: "Привет, расскажите про вашу компанию подробнее, это важно для оффера.",
    history: [
      { direction: "in", text: "Привет" },
      { direction: "out", text: "Привет, расскажите про вашу компанию подробнее, это важно для оффера." },
    ],
    assembledPrompt: "",
  });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].type, "repetition");
  assert.equal(r.findings[0].severity, "block");
});

test("lintReply: different wording passes", () => {
  const r = lintReply({
    reply: "Кратко: какие инструменты у вас уже работают?",
    history: [
      { direction: "out", text: "Привет, расскажите про вашу компанию подробнее, это важно для оффера." },
    ],
    assembledPrompt: "",
  });
  assert.equal(r.findings.length, 0);
});

test("lintReply: inbound match not flagged as repetition", () => {
  const r = lintReply({
    reply: "Да, мы работаем с DSP и Meta.",
    history: [
      { direction: "in", text: "Да, мы работаем с DSP и Meta." },
    ],
    assembledPrompt: "",
  });
  assert.equal(r.findings.filter((f) => f.type === "repetition").length, 0);
});

test("extractClaimedEntities: parses 'мы работаем с X'", () => {
  const e = extractClaimedEntities("Мы работаем с Alpha Affiliates, SpinBetter и Boomerang");
  // Should pick up at least Alpha Affiliates / SpinBetter / Boomerang.
  assert.ok(e.length >= 2, `expected ≥2 entities, got ${JSON.stringify(e)}`);
});

test("replyRejectsEntity: catches 'X не подойдёт'", () => {
  assert.equal(replyRejectsEntity("Альфа не подойдёт", "Альфа"), true);
  assert.equal(replyRejectsEntity("мы не работаем с Альфа", "Альфа"), true);
  assert.equal(replyRejectsEntity("Альфа отлично подойдёт", "Альфа"), false);
});

test("lintReply: direct entity-name contradiction caught", () => {
  // Rule-based detector requires the same entity TOKEN to appear in both
  // the prompt claim and the reply's rejection. This is the contract.
  const r = lintReply({
    reply: "К сожалению, SpinBetter нам не подходит.",
    history: [],
    assembledPrompt:
      "Среди наших клиентов: Alpha Affiliates, SpinBetter, Boomerang.",
  });
  const hasContradiction = r.findings.some((f) => f.type === "contradiction" && f.severity === "block");
  assert.ok(hasContradiction, `expected contradiction finding, got ${JSON.stringify(r.findings)}`);
});

// Known limitation (documented): semantic-category contradictions like
// "Alpha Affiliates" (specific) in prompt vs "аффилейт" (generic) in reply
// are NOT caught by the rule-based linter. The v1 escalation path (LLM
// emits [[ESCALATE]] when stuck) is the fallback for that class of issue.

test("lintReply: substring not matched (word boundary)", () => {
  const r = lintReply({
    reply: "Алфавит не подойдёт",
    history: [],
    assembledPrompt: "Мы работаем с Алфа",
  });
  // "Алфа" should NOT match inside "Алфавит" if word-boundary works.
  const hasContradiction = r.findings.some((f) => f.type === "contradiction");
  assert.equal(hasContradiction, false);
});
