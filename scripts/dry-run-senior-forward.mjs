// Smoke for senior-forward routing logic. Tests *only* the DB helpers
// (isAccountEscalationOperator + findOldestEscalatedThread) without invoking
// handleInboundMessage — that would actually try to send a Telegram DM to a
// non-existent fake user. We trust the small conversation.js wiring that
// uses these helpers (it was reviewed manually).
//
// Run on the server:  cd /opt/tgbots && node scripts/dry-run-senior-forward.mjs

import {
  findOrCreateThread, updateThread, getThread, listGroups, deleteAccount,
  appendThreadMessage, findOldestEscalatedThread, isAccountEscalationOperator,
  db,
} from "../src/db.js";

const ACCOUNT_ID = "mt-7780532990";

function assertEq(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "✅" : "❌"} ${label}\n   actual:   ${JSON.stringify(actual)}\n   expected: ${JSON.stringify(expected)}`);
  if (!pass) process.exitCode = 1;
}

const group = listGroups().find((g) => g.escalation_username === "ConvertAgainSales");
if (!group) { console.error("No group with escalation_username=ConvertAgainSales"); process.exit(1); }
console.log(`Using group ${group.id} (escalation @${group.escalation_username})\n`);

// 1) isAccountEscalationOperator matches by handle (case-insensitive, leading @ stripped).
assertEq("operator @ConvertAgainSales recognized", isAccountEscalationOperator(ACCOUNT_ID, "ConvertAgainSales"), true);
assertEq("operator with @ prefix recognized",       isAccountEscalationOperator(ACCOUNT_ID, "@convertagainsales"), true);
assertEq("operator with different case recognized", isAccountEscalationOperator(ACCOUNT_ID, "CONVERTAGAINSALES"), true);
assertEq("random sender NOT recognized as operator",isAccountEscalationOperator(ACCOUNT_ID, "to_be_king"), false);

// 2) findOldestEscalatedThread: create two fake escalated threads, oldest first.
const before = Date.now();
const t1 = findOrCreateThread({ accountId: ACCOUNT_ID, broadcastId: null, targetUsername: "smoke_oldest_42", targetTelegramId: "" });
appendThreadMessage({ threadId: t1.id, direction: "in", text: "test inbound 1" });
updateThread(t1.id, { state: "escalated" });
const ts1 = getThread(t1.id).updated_at;
await new Promise((r) => setTimeout(r, 50));

const t2 = findOrCreateThread({ accountId: ACCOUNT_ID, broadcastId: null, targetUsername: "smoke_newest_43", targetTelegramId: "" });
appendThreadMessage({ threadId: t2.id, direction: "in", text: "test inbound 2" });
updateThread(t2.id, { state: "escalated" });
const ts2 = getThread(t2.id).updated_at;

console.log(`\nCreated two fake escalated threads: oldest ${t1.id} @${ts1}, newest ${t2.id} @${ts2}`);
const oldest = findOldestEscalatedThread(ACCOUNT_ID);
assertEq("oldest escalated thread is the first one",
  oldest ? { id: oldest.id, target: oldest.target_username } : null,
  { id: t1.id, target: "smoke_oldest_42" });

// 3) After we resolve oldest, the next call should return the second.
updateThread(t1.id, { state: "active" });
const next = findOldestEscalatedThread(ACCOUNT_ID);
assertEq("after resolving oldest, next escalation surfaces",
  next ? { id: next.id, target: next.target_username } : null,
  { id: t2.id, target: "smoke_newest_43" });

// 4) After resolving both, no pending.
updateThread(t2.id, { state: "active" });
const none = findOldestEscalatedThread(ACCOUNT_ID);
assertEq("no pending escalations after both resolved", none, null);

// 5) Cleanup the fake threads (use raw SQL since db.js has no public deleter).
db.prepare("DELETE FROM conversation_messages WHERE thread_id IN (?, ?)").run(t1.id, t2.id);
db.prepare("DELETE FROM conversation_threads WHERE id IN (?, ?)").run(t1.id, t2.id);
console.log("\n(cleaned up fake threads)");
console.log(process.exitCode ? "\nFAIL — see above" : "\nALL PASS");
