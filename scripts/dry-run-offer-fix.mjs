// Quick smoke: AI должен на "Дай оффер" вернуть оффер-текст + [[OFFER_SENT]],
// БЕЗ [[ESCALATE]] и БЕЗ замены текста на "Передам коллегам".

import "dotenv/config";
import { findGroupForAccount, resolveGroupPrompt } from "../src/db.js";
import { generateSalesReply } from "../src/ai.js";

if (!process.env.OPENROUTER_API_KEY) {
  const fs = await import("node:fs");
  try {
    for (const line of fs.readFileSync("/opt/tgbots/.env", "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}
}

const ACCOUNT_ID = "mt-7780532990";
const group = findGroupForAccount(ACCOUNT_ID);
const rendered = resolveGroupPrompt(group);
console.log(`Group: ${group.name} (rendered prompt: ${rendered.length} chars)\n`);

const FLOWS = [
  {
    label: "FLOW A — клиент просит оффер",
    history: [
      { direction: "out", text: "Привет! Мы помогаем брендам зарабатывать больше на старых игроках через ретеншн-ремаркетинг. Какие инструменты используете?" },
      { direction: "in", text: "Дай оффер" },
    ],
    expect: { offer: true, escalate: false },
  },
  {
    label: "FLOW B — клиент просит цену (escalation, НЕ оффер)",
    history: [
      { direction: "out", text: "Привет! Мы помогаем брендам с ретеншном." },
      { direction: "in", text: "Сколько стоит DSP на 1 ГЕО?" },
    ],
    expect: { offer: false, escalate: true },
  },
  {
    label: "FLOW C — клиент просит pdf/материалы (offer)",
    history: [
      { direction: "in", text: "Пришлите презентацию или pdf с описанием" },
    ],
    expect: { offer: true, escalate: false },
  },
];

let pass = 0, fail = 0;
for (const f of FLOWS) {
  console.log(`\n══ ${f.label}`);
  for (const m of f.history) console.log(`   ${m.direction.toUpperCase()}: ${m.text.slice(0, 100)}`);
  const { text } = await generateSalesReply({
    salesScript: "", dialogScenarios: "", terminology: "",
    taskType: "cold", groupPrompt: rendered, firstMessageText: "",
    history: f.history,
  });
  const hasOffer = /\[\[OFFER_SENT\]\]/i.test(text);
  const hasEsc = /\[\[ESCALATE/i.test(text);
  const clientText = text.replace(/\[\[(OFFER_SENT|ESCALATE(?::[^\]]+)?)\]\]/gi, "").trim();
  console.log(`   BOT: ${clientText}`);
  const okOffer = hasOffer === f.expect.offer;
  const okEsc = hasEsc === f.expect.escalate;
  const okText = !f.expect.offer || clientText.toLowerCase().includes("one-pager") || clientText.toLowerCase().includes("материал") || clientText.toLowerCase().includes("nda");
  const ok = okOffer && okEsc && okText;
  console.log(`   ${ok ? "✅" : "❌"} offer=${hasOffer}(want ${f.expect.offer}) escalate=${hasEsc}(want ${f.expect.escalate}) ${okText ? "" : "[TEXT NOT MATCHING OFFER]"}`);
  if (ok) pass++; else fail++;
}
console.log(`\n=== ${pass}/${pass + fail} pass ===`);
process.exit(fail ? 1 : 0);
