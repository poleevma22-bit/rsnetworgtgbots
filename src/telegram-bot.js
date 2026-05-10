// Telegram Bot API integration: connect, validate, setWebhook, ingest updates.
import { randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import {
  insertBotApi, getAccount, deleteAccount, getBotApiToken,
  upsertLead, recordBotUpdate, updateAccountStatus, listBotApiAccounts
} from "./db.js";

const API = "https://api.telegram.org";

// Optional: path to a self-signed cert that Telegram should pin for the
// webhook URL. When set and the file exists, setWebhook uploads it via
// multipart so Telegram trusts our origin without a public CA.
const SELF_SIGNED_CERT_PATH = process.env.SELF_SIGNED_CERT_PATH || "";

export class BotApiError extends Error {
  constructor(message, status = 400, payload) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

async function tg(token, method, body) {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) {
    throw new BotApiError(json.description || `Telegram ${method} failed`, res.status, json);
  }
  return json.result;
}

async function tgMultipart(token, method, fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    form.append(key, value);
  }
  const res = await fetch(`${API}/bot${token}/${method}`, { method: "POST", body: form });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) {
    throw new BotApiError(json.description || `Telegram ${method} failed`, res.status, json);
  }
  return json.result;
}

export async function connectBot({ token, publicBaseUrl }) {
  if (!token || !/^\d+:[\w-]{30,}$/.test(token)) {
    throw new BotApiError("Невалидный bot token. Формат: <id>:<hash>", 422);
  }
  const me = await tg(token, "getMe");
  if (!me.is_bot) throw new BotApiError("Токен не принадлежит боту", 422);

  const id = `bot-${me.id}`;
  if (getAccount(id)) {
    throw new BotApiError(`Бот @${me.username} уже подключён`, 409);
  }

  const webhookSecret = randomBytes(24).toString("hex");
  insertBotApi({
    id,
    token,
    telegramId: me.id,
    username: me.username,
    firstName: me.first_name,
    webhookSecret,
    status: "connected",
    health: "ok"
  });

  // Set webhook if we have a public base URL, otherwise leave for later sync.
  if (publicBaseUrl) {
    try {
      await setWebhookForBot(id, publicBaseUrl);
    } catch (error) {
      updateAccountStatus(id, { status: "review", health: "limited" });
      return { account: getAccount(id), webhookError: error.message };
    }
  } else {
    updateAccountStatus(id, { status: "pending", health: "review" });
  }
  return { account: getAccount(id), webhookError: null };
}

export async function setWebhookForBot(id, publicBaseUrl) {
  const cred = getBotApiToken(id);
  if (!cred) throw new BotApiError("Бот не найден", 404);
  const url = `${publicBaseUrl.replace(/\/$/, "")}/api/telegram/webhook/${id}`;

  let result;
  if (SELF_SIGNED_CERT_PATH && existsSync(SELF_SIGNED_CERT_PATH)) {
    // Upload self-signed cert so Telegram pins our origin.
    const certBlob = new Blob([readFileSync(SELF_SIGNED_CERT_PATH)], { type: "application/x-pem-file" });
    result = await tgMultipart(cred.token, "setWebhook", {
      url,
      secret_token: cred.webhook_secret,
      allowed_updates: JSON.stringify(["message", "edited_message", "callback_query"]),
      certificate: new File([certBlob], "cert.pem", { type: "application/x-pem-file" })
    });
  } else {
    result = await tg(cred.token, "setWebhook", {
      url,
      secret_token: cred.webhook_secret,
      allowed_updates: ["message", "edited_message", "callback_query"]
    });
  }
  updateAccountStatus(id, { status: "connected", health: "ok", lastSeenAt: new Date().toISOString() });
  return { url, result };
}

export async function syncAllWebhooks(publicBaseUrl) {
  const out = [];
  for (const acc of listBotApiAccounts()) {
    try {
      const r = await setWebhookForBot(acc.id, publicBaseUrl);
      out.push({ id: acc.id, ok: true, url: r.url });
    } catch (e) {
      out.push({ id: acc.id, ok: false, error: e.message });
    }
  }
  return out;
}

export async function disconnectBot(id) {
  const cred = getBotApiToken(id);
  if (!cred) throw new BotApiError("Бот не найден", 404);
  try { await tg(cred.token, "deleteWebhook", { drop_pending_updates: false }); } catch {}
  deleteAccount(id);
  return { ok: true };
}

export async function getWebhookInfo(id) {
  const cred = getBotApiToken(id);
  if (!cred) throw new BotApiError("Бот не найден", 404);
  return tg(cred.token, "getWebhookInfo");
}

export function handleIncomingUpdate(botId, secretFromHeader, update) {
  const cred = getBotApiToken(botId);
  if (!cred) throw new BotApiError("Бот не найден", 404);
  if (cred.webhook_secret && secretFromHeader !== cred.webhook_secret) {
    throw new BotApiError("Bad webhook secret", 403);
  }

  const message = update.message || update.edited_message || update.callback_query?.message;
  if (message) {
    const from = update.message?.from || update.edited_message?.from || update.callback_query?.from;
    const text = update.message?.text || update.edited_message?.text || update.callback_query?.data || "";
    const chatId = message.chat?.id;
    upsertLead({
      accountId: botId,
      chatId,
      telegramUserId: from?.id,
      telegramHandle: from?.username ? `@${from.username}` : (from?.first_name || ""),
      message: text,
      direction: "in"
    });
    recordBotUpdate({
      botId,
      updateId: update.update_id,
      chatId,
      username: from?.username ? `@${from.username}` : "",
      text,
      raw: update
    });
  } else {
    recordBotUpdate({ botId, updateId: update.update_id, raw: update });
  }
  updateAccountStatus(botId, { health: "ok", lastSeenAt: new Date().toISOString() });
  return { ok: true };
}
