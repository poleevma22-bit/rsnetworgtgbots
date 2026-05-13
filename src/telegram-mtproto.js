// MTProto integration via gramjs.
// Two-step auth: start (sendCode) -> confirm (signIn with code [+ password]).
// On confirm, we persist the StringSession and start a long-running client that
// records incoming DMs as leads.
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram/index.js";
import { randomBytes } from "node:crypto";
import {
  insertMtproto, insertMtprotoPending, getMtprotoPending, deleteMtprotoPending,
  getMtprotoSession, getAccount, deleteAccount, listMtprotoAccounts,
  upsertLead, updateAccountStatus
} from "./db.js";

export class MtprotoError extends Error {
  constructor(message, status = 400, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const apiId = Number(process.env.TG_API_ID || 0);
const apiHash = process.env.TG_API_HASH || "";

// Live clients keyed by bots.id, e.g. "mt-12345"
const liveClients = new Map();

function ensureCreds() {
  if (!apiId || !apiHash) {
    throw new MtprotoError("TG_API_ID/TG_API_HASH не настроены в env сервиса", 500);
  }
}

function makeClient(sessionString = "") {
  ensureCreds();
  const session = new StringSession(sessionString);
  return new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
    useWSS: false,
    deviceModel: "rsnetworgtgbots",
    systemVersion: "1.0",
    appVersion: "0.1"
  });
}

export async function startAuth({ phone }) {
  ensureCreds();
  // Country-agnostic normalisation: strip spaces, dashes, parens, dots before validating.
  const normalized = typeof phone === "string" ? phone.replace(/[\s\-().]/g, "") : "";
  if (!normalized || !/^\+?\d{8,16}$/.test(normalized)) {
    throw new MtprotoError(
      "Введите номер телефона в международном формате, например +447700900000",
      422
    );
  }
  phone = normalized;
  const client = makeClient();
  await client.connect();
  let sent;
  try {
    sent = await client.sendCode({ apiId, apiHash }, phone);
  } catch (e) {
    await client.disconnect().catch(() => {});
    throw new MtprotoError(`sendCode failed: ${e.message}`, 502);
  }
  const sessionString = client.session.save();
  await client.disconnect().catch(() => {});

  const tempId = `mtp-${randomBytes(8).toString("hex")}`;
  insertMtprotoPending({
    id: tempId,
    phone,
    phoneCodeHash: sent.phoneCodeHash,
    apiId,
    apiHash,
    sessionString
  });
  return { tempId, phoneCodeHash: sent.phoneCodeHash, isCodeViaApp: sent.isCodeViaApp ?? null };
}

export async function confirmAuth({ tempId, code, password }) {
  const pending = getMtprotoPending(tempId);
  if (!pending) throw new MtprotoError("Сессия авторизации не найдена или истекла", 404);

  const client = makeClient(pending.session_string || "");
  await client.connect();

  let me;
  try {
    me = await client.invoke(new Api.auth.SignIn({
      phoneNumber: pending.phone,
      phoneCodeHash: pending.phone_code_hash,
      phoneCode: String(code)
    }));
  } catch (e) {
    if (e?.errorMessage === "SESSION_PASSWORD_NEEDED" || /SESSION_PASSWORD_NEEDED/.test(e?.message || "")) {
      if (!password) {
        await client.disconnect().catch(() => {});
        return { needsPassword: true };
      }
      // gramjs signInWithPassword requires password/onError as async thunks.
      // When onError returns true, gramjs swallows the original error and
      // throws a generic "AUTH_USER_CANCEL" — so we capture the real cause
      // via onError and surface it on the outer rejection.
      let underlyingError = null;
      try {
        me = await client.signInWithPassword(
          { apiId, apiHash },
          {
            password: async () => password,
            onError: async (err) => {
              underlyingError = err;
              console.error("[mtproto] 2FA SRP error:", err?.errorMessage || err?.message || err);
              return true; // stop retrying; we surface the saved error below.
            }
          }
        );
      } catch (e2) {
        await client.disconnect().catch(() => {});
        const detail =
          underlyingError?.errorMessage ||
          underlyingError?.message ||
          e2?.errorMessage ||
          e2?.message ||
          "unknown";
        throw new MtprotoError(`2FA failed: ${detail}`, 401);
      }
    } else {
      await client.disconnect().catch(() => {});
      throw new MtprotoError(`signIn failed: ${e.message}`, 401, e?.errorMessage);
    }
  }

  // Resolve self
  const self = await client.getMe().catch(() => null);
  const sessionString = client.session.save();
  await client.disconnect().catch(() => {});

  const id = `mt-${self?.id?.toString() || Date.now()}`;
  if (getAccount(id)) {
    deleteMtprotoPending(tempId);
    throw new MtprotoError("Этот аккаунт уже подключён", 409);
  }
  insertMtproto({
    id,
    apiId,
    phone: pending.phone,
    sessionString,
    telegramId: self?.id?.toString(),
    username: self?.username || null,
    firstName: self?.firstName || self?.first_name || null,
    status: "connected",
    health: "ok"
  });
  deleteMtprotoPending(tempId);

  await startWorker(id).catch(err => console.error("[mtproto] worker start failed", id, err.message));
  return { account: getAccount(id) };
}

/**
 * Send a one-off direct message from a connected MTProto account.
 * Resolves @username via gramjs (which calls contacts.ResolveUsername under the hood).
 * Phone numbers only work if the recipient is already in the sender's contacts.
 *
 * Options:
 *   typingMinMs / typingMaxMs — emit a "typing…" status to the peer for
 *     a random duration in this range before actually sending the message.
 *     Defaults: 5_000 / 10_000 (5–10 seconds). Pass 0 to skip.
 */
export async function sendDirectMessage(accountId, target, text, options = {}) {
  if (!accountId) throw new MtprotoError("accountId required", 400);
  if (!text || typeof text !== "string" || !text.trim()) {
    throw new MtprotoError("Message text is empty", 400);
  }
  const cleaned = String(target || "").trim().replace(/^@/, "");
  if (!cleaned) throw new MtprotoError("Empty target", 400);

  // Start (or reuse) the live client for this account.
  await startWorker(accountId);
  const client = liveClients.get(accountId);
  if (!client) {
    throw new MtprotoError(`MTProto client not running for ${accountId}`, 503);
  }

  // Optional "natural-looking" typing simulation before the actual send.
  const typingMin = Number.isFinite(options.typingMinMs) ? Math.max(0, options.typingMinMs) : 5000;
  const typingMax = Number.isFinite(options.typingMaxMs) ? Math.max(typingMin, options.typingMaxMs) : 10000;
  if (typingMax > 0) {
    const delay = Math.floor(typingMin + Math.random() * Math.max(1, typingMax - typingMin));
    try {
      const peer = await client.getInputEntity(cleaned);
      // Re-emit every 4s — gramjs typing action only persists ~5s on Telegram side.
      const tickMs = 4000;
      const start = Date.now();
      const tick = async () => {
        try {
          await client.invoke(new Api.messages.SetTyping({
            peer,
            action: new Api.SendMessageTypingAction()
          }));
        } catch { /* swallow — typing is best-effort */ }
      };
      await tick();
      while (Date.now() - start < delay) {
        const left = delay - (Date.now() - start);
        await new Promise((r) => setTimeout(r, Math.min(tickMs, left)));
        if (Date.now() - start < delay) await tick();
      }
    } catch (err) {
      // Typing errors must NOT block sending. Just log.
      console.warn(`[mtproto] typing simulation failed for @${cleaned}: ${err?.message || err}`);
    }
  }

  // gramjs accepts a username string and resolves it internally.
  const result = await client.sendMessage(cleaned, { message: text });
  return { messageId: result?.id?.toString() ?? null };
}

export async function startWorker(id) {
  const cred = getMtprotoSession(id);
  if (!cred?.session_string) return null;
  if (liveClients.has(id)) return liveClients.get(id);
  ensureCreds();

  const client = makeClient(cred.session_string);
  await client.connect();
  liveClients.set(id, client);

  client.addEventHandler(async (event) => {
    try {
      const msg = event.message;
      if (!msg || msg.out) return;
      const senderId = msg.senderId?.toString() || null;
      const peer = msg.peerId;
      const chatId = peer?.userId?.toString() || peer?.chatId?.toString() || peer?.channelId?.toString() || senderId;
      let handle = "";
      try {
        const sender = await msg.getSender();
        handle = sender?.username ? `@${sender.username}` : (sender?.firstName || "");
      } catch {}
      upsertLead({
        accountId: id,
        chatId,
        telegramUserId: senderId,
        telegramHandle: handle,
        message: msg.message || "",
        direction: "in"
      });
      updateAccountStatus(id, { health: "ok", lastSeenAt: new Date().toISOString() });
    } catch (err) {
      console.error("[mtproto] event handler error", err.message);
    }
  });
  return client;
}

export async function bootAllWorkers() {
  for (const acc of listMtprotoAccounts()) {
    if (acc.status !== "disabled") {
      await startWorker(acc.id).catch(err => console.error("[mtproto] boot worker", acc.id, err.message));
    }
  }
}

export async function disconnectMtproto(id) {
  const client = liveClients.get(id);
  if (client) {
    try { await client.disconnect(); } catch {}
    liveClients.delete(id);
  }
  deleteAccount(id);
  return { ok: true };
}
