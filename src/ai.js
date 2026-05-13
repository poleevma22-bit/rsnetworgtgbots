// AI bridge for adaptive sales replies. Routes through OpenRouter — the same
// gateway the openclaw bot uses — so we get a single billing surface and
// model-pick flexibility. Set OPENROUTER_MODEL to override the default.

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || "anthropic/claude-haiku-4-5";

function buildSystemPrompt({ salesScript, dialogScenarios, terminology, taskType }) {
  const parts = [
    `Ты — продавец, который ведёт переписку в Telegram через автоматизацию rsnetwork.pro.`,
    `Тип задачи: ${taskType || "cold"} (ping = короткое напоминание, cold = первое касание, warm = прогретый лид).`,
    `Стиль: коротко, по-человечески, без копи-паста, без капса, без эмодзи-спама. Максимум 2–3 предложения на ответ.`,
    `Никогда не упоминай, что ты бот или AI. Если клиент спросит — отшучивайся как менеджер.`,
  ];
  if (salesScript?.trim()) {
    parts.push(`\n=== Скрипт продаж (примеры стиля и сценариев) ===\n${salesScript.trim()}`);
  }
  if (dialogScenarios?.trim()) {
    parts.push(`\n=== Возможные сценарии диалога ===\n${dialogScenarios.trim()}`);
  }
  if (terminology?.trim()) {
    parts.push(`\n=== Терминология / словарь понятий ===\n${terminology.trim()}`);
  }
  parts.push(
    `\nКогда отвечаешь — никогда не пиши служебные заметки, не оборачивай ответ в кавычки.`,
    `Возвращай только сам текст сообщения, который надо отправить клиенту, без префиксов.`,
  );
  return parts.join("\n");
}

/**
 * Generate the next reply to a client based on full sales context + thread history.
 *
 * @param {object} params
 * @param {string} params.salesScript
 * @param {string} params.dialogScenarios
 * @param {string} params.terminology
 * @param {string} params.taskType
 * @param {Array<{direction: 'in'|'out', text: string}>} params.history
 * @param {string} params.firstMessageText – the original outbound (anchor) message
 * @returns {Promise<{ text: string, model: string }>}
 */
export async function generateSalesReply({
  salesScript,
  dialogScenarios,
  terminology,
  taskType,
  history,
  firstMessageText,
}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  const system = buildSystemPrompt({ salesScript, dialogScenarios, terminology, taskType });

  // Frame the conversation as user/assistant turns. The first outbound (the
  // broadcast hook) acts as the assistant's opening line.
  const messages = [{ role: "system", content: system }];
  if (firstMessageText) {
    messages.push({ role: "assistant", content: firstMessageText });
  }
  const seen = new Set();
  for (const m of history || []) {
    // Skip duplicate of firstMessageText if it's also the first outbound in history.
    const key = `${m.direction}:${m.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    messages.push({
      role: m.direction === "in" ? "user" : "assistant",
      content: m.text,
    });
  }

  const body = {
    model: DEFAULT_MODEL,
    messages,
    max_tokens: 400,
    temperature: 0.7,
  };

  const resp = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "http-referer": "https://rsnetwork.pro",
      "x-title": "rsnetwork-tgbots",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`OpenRouter ${resp.status}: ${text.slice(0, 300)}`);
  }
  const json = await resp.json();
  const text = json?.choices?.[0]?.message?.content?.trim?.();
  if (!text) {
    throw new Error("OpenRouter returned empty content");
  }
  return { text, model: json?.model || DEFAULT_MODEL };
}
