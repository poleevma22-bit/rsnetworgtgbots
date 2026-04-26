import test from "node:test";
import assert from "node:assert/strict";
import { validateAutomationPolicy, summarizeDialog } from "../src/safety.js";

test("automation policy rejects unsafe timing", () => {
  const result = validateAutomationPolicy({
    replyDelaySeconds: 1,
    typingSeconds: 1,
    workingHoursPerDay: 20,
    outreachMode: "cold_mass"
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 4);
});

test("automation policy accepts conservative opt-in settings", () => {
  const result = validateAutomationPolicy({
    replyDelaySeconds: 90,
    typingSeconds: 12,
    workingHoursPerDay: 6,
    outreachMode: "opt_in"
  });

  assert.equal(result.ok, true);
});

test("summary compresses dialog context", () => {
  const summary = summarizeDialog([
    { direction: "out", text: "Здравствуйте" },
    { direction: "in", text: "Нужен расчет" }
  ]);

  assert.match(summary, /1 входящих, 1 исходящих/);
});
