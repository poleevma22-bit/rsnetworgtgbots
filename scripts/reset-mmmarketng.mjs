// Reset the @mmmarketng thread + its mirror lead back to a clean state
// (stage-1 Новый контакт, никакой истории, никаких счётчиков). Используется
// перед прогоном по funnel-walker'у.
//
// Run on the server:
//   cd /opt/tgbots && node scripts/reset-mmmarketng.mjs

import { db, syncLeadFromThread } from "../src/db.js";

const TARGET = "mmmarketng";
const thread = db.prepare(
  "SELECT * FROM conversation_threads WHERE target_username = ?",
).get(TARGET);
if (!thread) { console.error(`Thread for @${TARGET} not found`); process.exit(1); }

console.log(`Resetting thread ${thread.id} (@${TARGET})…`);

// Wipe messages + reset all counters/flags on the thread.
const msgDel = db.prepare("DELETE FROM conversation_messages WHERE thread_id = ?").run(thread.id);
db.prepare(`
  UPDATE conversation_threads SET
    state            = 'active',
    inbound_count    = 0,
    outbound_count   = 0,
    escalation_count = 0,
    offer_sent_at    = NULL,
    manual_stage_id  = NULL,
    last_inbound_at  = NULL,
    last_outbound_at = NULL,
    next_action_at   = NULL,
    next_action_type = NULL,
    next_action_payload = NULL,
    updated_at       = ?
  WHERE id = ?
`).run(Date.now(), thread.id);

// Re-sync the lead row so the CRM matrix reflects the fresh state.
syncLeadFromThread(thread.id);

const after = db.prepare("SELECT state, inbound_count, outbound_count, escalation_count FROM conversation_threads WHERE id = ?").get(thread.id);
const lead = db.prepare("SELECT stage_id, status FROM leads WHERE chat_id = ?").get(thread.id);
console.log(`Wiped ${msgDel.changes} messages.`);
console.log(`Thread after: ${JSON.stringify(after)}`);
console.log(`Lead after: ${JSON.stringify(lead)}`);
console.log(`\nReady for funnel-walker.`);
