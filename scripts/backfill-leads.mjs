// One-shot: walk existing conversation_threads and create/update mirror lead
// rows so the CRM matrix shows them with auto-classified stage. Idempotent.
//
// Run on the server:
//   cd /opt/tgbots && node scripts/backfill-leads.mjs

import { db, syncLeadFromThread, classifyThreadStage } from "../src/db.js";

const threads = db.prepare("SELECT * FROM conversation_threads ORDER BY updated_at ASC").all();
console.log(`Backfilling ${threads.length} threads into leads table…`);

let created = 0, skipped = 0;
for (const t of threads) {
  const stage = classifyThreadStage(t);
  const leadId = syncLeadFromThread(t.id);
  if (leadId) {
    created++;
    console.log(`  ✓ ${t.id} target=@${t.target_username} → ${stage}`);
  } else {
    skipped++;
  }
}
console.log(`\nDone. Synced: ${created}, skipped (junk/operator): ${skipped}`);
