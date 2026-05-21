// Reproduces the exact dialog that failed: bot answered abstractly on
// pricing and "accepted" a call agreement without escalation. Each scenario
// passes a multi-turn history so the AI sees the same context the live bot did.
//
// Run on the server:  cd /opt/tgbots && node scripts/dry-run-failing-flows.mjs

import "dotenv/config";
import { findGroupForAccount, getAccount, resolveGroupPrompt } from "../src/db.js";
import { generateSalesReply } from "../src/ai.js";

// Load env if dotenv didn't.
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
const account = getAccount(ACCOUNT_ID);
const group = findGroupForAccount(ACCOUNT_ID);
const rendered = resolveGroupPrompt(group);
console.log(`Group: ${group.name} (escalation=@${group.escalation_username})`);
console.log(`Template binding: tpl=${group.template_id} (${rendered.length} chars)\n`);

const FLOWS = [
  {
    label: "FLOW A — pricing после cold pitch",
    history: [
      { direction: "out", text: "Привет! Я Митчелл, менеджер ConvertAgain. Мы помогаем iGaming-брендам зарабатывать больше на старых игроках через ретеншн-ремаркетинг на YouTube, DSP и Meta. В среднем клиенты получают +20-30% к депозитам. Подскажите, какие инструменты вы сейчас используете для удержания игроков?" },
      { direction: "in", text: "Сколько стоит dsp на 1 гео?" },
    ],
  },
  {
    label: "FLOW B — клиент назначает время созвона",
    history: [
      { direction: "out", text: "Цены зависят от объёмов трафика. Давайте созвонимся, обсудим детали — когда удобно?" },
      { direction: "in", text: "Давай завтра в 19 по мск" },
    ],
  },
  {
    label: "FLOW C — клиент в принципе согласен на созвон",
    history: [
      { direction: "out", text: "Наш DSP покрывает все ГЕО кроме санкционных. Удобно созвониться чтобы я подобрал под вас?" },
      { direction: "in", text: "Ок давай созвонимся" },
    ],
  },
  {
    label: "FLOW D — технический s2s payload",
    history: [
      { direction: "in", text: "Какой формат payload передаётся через ваш s2s — JSON или query-string?" },
    ],
  },
  {
    label: "FLOW E — NDA и договор",
    history: [
      { direction: "in", text: "Ок, готовы стартовать. Пришлите NDA и реквизиты для договора." },
    ],
  },
  {
    label: "FLOW F (negative) — нестандартный вопрос БЕЗ MUST-триггера (НЕ должен эскалировать)",
    history: [
      { direction: "in", text: "А вы откуда команда, из какой страны работаете?" },
    ],
  },
];

let pass = 0, fail = 0;
for (const f of FLOWS) {
  console.log(`\n══ ${f.label}`);
  for (const m of f.history) console.log(`   ${m.direction.toUpperCase()}: ${m.text.slice(0, 100)}`);
  try {
    const { text, model } = await generateSalesReply({
      salesScript: "", dialogScenarios: "", terminology: "",
      taskType: "cold", groupPrompt: rendered, firstMessageText: "",
      history: f.history,
    });
    const hasEsc = /\[\[ESCALATE/i.test(text);
    const clientText = text.replace(/\[\[ESCALATE(?::[^\]]+)?\]\]/i, "").trim();
    const wantEsc = !f.label.includes("negative");
    const ok = hasEsc === wantEsc;
    console.log(`   BOT: ${clientText}`);
    console.log(`   ${ok ? "✅" : "❌"} expected escalate=${wantEsc}, got=${hasEsc} · model=${model}`);
    if (ok) pass++; else fail++;
  } catch (err) {
    console.error(`   ERROR: ${err?.message || err}`);
    fail++;
  }
}
console.log(`\n=== ${pass}/${pass + fail} pass ===`);
process.exit(fail ? 1 : 0);
