// E2E funnel walker for the @mmmarketng thread. Synthesises each stage
// transition via direct DB mutations + the production classifier path, so
// we can verify the full CRM funnel without sending real Telegram messages.
//
// Steps (each prints expected vs actual lead stage):
//
//   1. Cold pitch sent, no reply yet           → stage-1  Новый контакт
//   2. Client replies "Привет, есть оффер?"    → stage-2  Квалификация
//   3. Client asks "Сколько стоит DSP?" + AI
//      emits [[ESCALATE]] → bumpEscalation,
//      state → 'escalated'                     → stage-3  Презентация
//   4. Client asks "Дай оффер" + AI emits
//      [[OFFER_SENT]] → markThreadOfferSent    → stage-offer Оффер отправлен
//   5. @ConvertAgainSales replies + senior-
//      forward returns thread to state='active'→ stage-4  Согласование
//   6. Operator manually flips to onboarding   → stage-onboarding
//   7. Operator manually flips to Выиграно     → stage-5  Выиграно
//
// Run on the server:
//   cd /opt/tgbots && node scripts/funnel-walk.mjs

import {
  db, classifyThreadStage, syncLeadFromThread,
  bumpThreadEscalationCount, markThreadOfferSent,
  setLeadManualStage,
} from "../src/db.js";

const TARGET = "mmmarketng";
const thread = db.prepare("SELECT * FROM conversation_threads WHERE target_username = ?").get(TARGET);
if (!thread) { console.error(`Thread for @${TARGET} not found — run reset first.`); process.exit(1); }
const THREAD_ID = thread.id;
console.log(`Walking funnel on thread ${THREAD_ID} (@${TARGET})\n`);

function appendMsg(direction, text) {
  const now = Date.now();
  db.prepare("INSERT INTO conversation_messages (thread_id, direction, text, sent_at) VALUES (?, ?, ?, ?)")
    .run(THREAD_ID, direction, text, now);
  if (direction === "in") {
    db.prepare("UPDATE conversation_threads SET inbound_count = inbound_count + 1, last_inbound_at = ?, updated_at = ? WHERE id = ?").run(now, now, THREAD_ID);
  } else {
    db.prepare("UPDATE conversation_threads SET outbound_count = outbound_count + 1, last_outbound_at = ?, updated_at = ? WHERE id = ?").run(now, now, THREAD_ID);
  }
}

function snap() {
  const t = db.prepare("SELECT * FROM conversation_threads WHERE id = ?").get(THREAD_ID);
  syncLeadFromThread(THREAD_ID);
  const l = db.prepare("SELECT stage_id, status FROM leads WHERE chat_id = ?").get(THREAD_ID);
  return { thread: t, classified: classifyThreadStage(t), lead: l };
}

function step(num, label, expected, mutate) {
  console.log(`── Step ${num}: ${label}`);
  mutate();
  const s = snap();
  const ok = s.classified === expected && s.lead?.stage_id === expected;
  console.log(`   thread: state=${s.thread.state} inbound=${s.thread.inbound_count} outbound=${s.thread.outbound_count} esc=${s.thread.escalation_count} offer=${s.thread.offer_sent_at ? "yes" : "no"} manual=${s.thread.manual_stage_id || "—"}`);
  console.log(`   classifier → ${s.classified}, lead.stage_id → ${s.lead?.stage_id} (${s.lead?.status})`);
  console.log(`   expected ${expected}: ${ok ? "✅" : "❌"}\n`);
  return ok;
}

let allOk = true;

allOk &= step(1, "Cold pitch отправлен ботом, клиент молчит", "stage-1", () => {
  appendMsg("out", "Привет! Я Митчелл из ConvertAgain. Мы помогаем брендам зарабатывать на retention. Какие инструменты используете?");
});

allOk &= step(2, "Клиент ответил «Привет, есть оффер?»", "stage-2", () => {
  appendMsg("in", "Привет, есть оффер?");
  appendMsg("out", "Привет! Да, у нас retention-ремаркетинг на YouTube/DSP/Meta. Подскажите, какие сейчас инструменты используете?");
});

allOk &= step(3, "Клиент спрашивает цену → AI эскалирует", "stage-3", () => {
  appendMsg("in", "Сколько стоит DSP на 1 ГЕО?");
  appendMsg("out", "Передаю вопрос старшему менеджеру, он рассчитает под ваши объёмы.");
  bumpThreadEscalationCount(THREAD_ID);
  db.prepare("UPDATE conversation_threads SET state = 'escalated', updated_at = ? WHERE id = ?").run(Date.now(), THREAD_ID);
});

allOk &= step(4, "Клиент просит оффер → AI шлёт оффер-текст + маркер", "stage-offer", () => {
  appendMsg("in", "Дай оффер");
  appendMsg("out", "Готов прислать наш one-pager... [ОФФЕР-ТЕКСТ]");
  appendMsg("out", "[attachment] convertagain_brand.png");
  appendMsg("out", "[attachment] convertagain_sales_brief.pdf");
  markThreadOfferSent(THREAD_ID);
});

allOk &= step(5, "@ConvertAgainSales ответил → форвард клиенту, state → active", "stage-4", () => {
  appendMsg("out", "Цена 5000 USDT/мес за 1 ГЕО при минимальном объёме. Готов созвон в среду в 14:00 GMT+3.");
  db.prepare("UPDATE conversation_threads SET state = 'active', updated_at = ? WHERE id = ?").run(Date.now(), THREAD_ID);
});

allOk &= step(6, "Оператор вручную двигает лид в Онбординг", "stage-onboarding", () => {
  setLeadManualStage(THREAD_ID, "stage-onboarding");
});

allOk &= step(7, "Оператор отмечает как Выиграно", "stage-5", () => {
  setLeadManualStage(THREAD_ID, "stage-5");
});

console.log(allOk ? "\n=== ALL 7 STEPS PASSED ✅ ===" : "\n=== SOME STEPS FAILED ❌ ===");

// Final history dump
const msgs = db.prepare("SELECT direction, text FROM conversation_messages WHERE thread_id = ? ORDER BY sent_at").all(THREAD_ID);
console.log(`\nFinal thread history (${msgs.length} messages):`);
for (const m of msgs) console.log(`   ${m.direction === "in" ? "<<" : ">>"} ${m.text.slice(0, 90)}${m.text.length > 90 ? "…" : ""}`);

process.exit(allOk ? 0 : 1);
