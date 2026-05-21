// Dry-run: feed common inbound shapes into the same AI prompt path the live
// worker uses, without sending any Telegram message. Prints the model's reply
// + whether it emitted the [[ESCALATE]] marker. Lets us verify the seeded
// ConvertAgain script + escalation rules are wired before exposing the bot to
// real prospects.

import "dotenv/config";
import { findGroupForAccount, getAccount, resolveGroupPrompt } from "../src/db.js";
import { generateSalesReply } from "../src/ai.js";
// Fallback: also try /opt/tgbots/.env if dotenv didn't find one at CWD.
if (!process.env.OPENROUTER_API_KEY) {
  try {
    const fs = await import("node:fs");
    const text = fs.readFileSync("/opt/tgbots/.env", "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}
}

const ACCOUNT_ID = "mt-7780532990";

const SCENARIOS = [
  {
    label: "Холодный лид, спрашивает кто",
    inbound: "Привет, а вы кто?",
  },
  {
    label: "Лид перечисляет свои инструменты",
    inbound: "У нас уже есть свой отдел ретеншна, пользуемся CRM и email-рассылками.",
  },
  {
    label: "Лид спрашивает точную цену (out-of-script → должен эскалировать)",
    inbound: "Сколько конкретно стоит подключение DSP на 1 ГЕО в USDT в месяц?",
  },
  {
    label: "Лид прямо просит человека",
    inbound: "Позовите живого менеджера, я с ботами не разговариваю.",
  },
  {
    label: "Лид обвиняет в боте",
    inbound: "Ты бот?",
  },
  {
    label: "Лид готов к договору (out-of-script → должен эскалировать)",
    inbound: "Хорошо, пришлите NDA и давайте подписывать договор, бюджет 50k USDT.",
  },
  {
    label: "Нестандартный вопрос НЕ требующий цены (бот пробует ответить как продажник)",
    inbound: "А вы поддерживаете Tier-3 ГЕО типа Бангладеш или Намибии?",
  },
  {
    label: "Технический нюанс s2s (требует эскалации)",
    inbound: "Какой именно формат payload передаётся через s2s — JSON, postback с query-параметрами или GraphQL?",
  },
  {
    label: "Дружелюбный непрофильный вопрос (продажник должен мягко вернуть к теме)",
    inbound: "Привет, у вас классный продукт. А вы вообще откуда команда, из какой страны работаете?",
  },
];

const account = getAccount(ACCOUNT_ID);
const group = findGroupForAccount(ACCOUNT_ID);
if (!account) { console.error(`account ${ACCOUNT_ID} not found`); process.exit(1); }
if (!group) { console.error(`account ${ACCOUNT_ID} has no group`); process.exit(1); }
const rendered = resolveGroupPrompt(group);
console.log(`Using account ${account.id} (${account.handle}) and group "${group.name}" (escalation=@${group.escalation_username || "(none)"})`);
console.log(`template binding: ${group.template_id ? `tpl=${group.template_id} (rendered ${rendered.length} chars)` : `none → legacy group_prompt (${group.group_prompt.length} chars)`}\n`);

for (const sc of SCENARIOS) {
  process.stdout.write(`\n── ${sc.label}\n   IN : ${sc.inbound}\n`);
  try {
    const { text, model } = await generateSalesReply({
      salesScript: "",
      dialogScenarios: "",
      terminology: "",
      taskType: "cold",
      groupPrompt: rendered,
      firstMessageText: "",
      history: [{ direction: "in", text: sc.inbound }],
    });
    const hasEsc = /\[\[ESCALATE/i.test(text);
    const clientText = text.replace(/\[\[ESCALATE(?::[^\]]+)?\]\]/i, "").trim();
    console.log(`   OUT: ${clientText}`);
    console.log(`   ${hasEsc ? "🚨 ESCALATE marker emitted" : "·· no escalation"} · model=${model}`);
  } catch (err) {
    console.error(`   ERROR: ${err?.message || err}`);
  }
}
console.log("\ndone.");
