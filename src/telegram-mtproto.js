// MTProto integration via gramjs.
// Two-step auth: start (sendCode) -> confirm (signIn with code [+ password]).
// On confirm, we persist the StringSession and start a long-running client that
// records incoming DMs as leads.
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram/index.js";
import { NewMessage } from "telegram/events/index.js";
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

// Hook injected by ./conversation.js. Called for every inbound DM observed
// by a connected MTProto user-account. Kept as a late-bound singleton to
// dodge circular-import issues between mtproto/conversation/db.
let inboundHook = null;
export function setInboundHook(fn) {
  inboundHook = typeof fn === "function" ? fn : null;
}

/**
 * Send a one-off direct message from a connected MTProto account.
 * Resolves @username via gramjs (which calls contacts.ResolveUsername under the hood).
 * Phone numbers only work if the recipient is already in the sender's contacts.
 *
 * Options:
 *   typingMinMs / typingMaxMs — bounds for the typing-presence emission BEFORE
 *     the actual send. The exact duration scales with text length (≈70 wpm = ~6
 *     chars/sec) and is clamped into [typingMinMs, typingMaxMs] plus small jitter.
 *     Defaults: 5_000 / 10_000. Pass typingMaxMs=0 to skip typing entirely.
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

  // "Natural-looking" typing simulation before the actual send.
  // Duration is roughly text-length / 6 chars/sec (≈70wpm), clamped into the
  // configured min/max window, plus 0–500 ms of jitter. Below we re-emit the
  // typing action every 4 s (Telegram drops it after ~5 s) and occasionally
  // pause for ~1 s to emulate a human stopping to think.
  const typingMin = Number.isFinite(options.typingMinMs) ? Math.max(0, options.typingMinMs) : 5000;
  const typingMax = Number.isFinite(options.typingMaxMs) ? Math.max(typingMin, options.typingMaxMs) : 10000;
  if (typingMax > 0) {
    const naturalMs = Math.floor((text.length / 6) * 1000);
    const jitter = Math.floor(Math.random() * 500);
    const delay = Math.min(typingMax, Math.max(typingMin, naturalMs + jitter));
    try {
      const peer = await client.getInputEntity(cleaned);
      const TICK_MS = 4000;
      const start = Date.now();
      const tick = async (action) => {
        try {
          await client.invoke(new Api.messages.SetTyping({
            peer,
            action: action ?? new Api.SendMessageTypingAction(),
          }));
        } catch { /* swallow — typing is best-effort */ }
      };
      // Initial typing pulse.
      await tick();
      let pauseChance = 0.15; // 15% chance to insert a "thinking" pause per tick
      while (Date.now() - start < delay) {
        const left = delay - (Date.now() - start);
        await new Promise((r) => setTimeout(r, Math.min(TICK_MS, left)));
        if (Date.now() - start >= delay) break;
        if (Math.random() < pauseChance) {
          // Cancel typing for ~600–1200 ms to emulate stopping briefly.
          await tick(new Api.SendMessageCancelAction());
          await new Promise((r) => setTimeout(r, 600 + Math.floor(Math.random() * 600)));
          if (Date.now() - start >= delay) break;
        }
        await tick();
      }
    } catch (err) {
      console.warn(`[mtproto] typing simulation failed for @${cleaned}: ${err?.message || err}`);
    }
  }

  // gramjs accepts a username string and resolves it internally.
  const result = await client.sendMessage(cleaned, { message: text });
  return { messageId: result?.id?.toString() ?? null };
}

/**
 * Send a file (image, document, pptx) from disk to a target @username.
 * Used by the offer-attachment flow — after the AI emits [[OFFER_SENT]] and
 * the offer text lands, we follow up with each configured file.
 *
 * No typing simulation (Telegram shows "uploading" naturally). Passes the
 * filename through `forceDocument: false` so PNG/JPEG are rendered inline
 * by Telegram clients and PDFs/PPTX go as documents.
 */
export async function sendDirectFile(accountId, target, filePath, options = {}) {
  if (!accountId) throw new MtprotoError("accountId required", 400);
  if (!filePath) throw new MtprotoError("filePath required", 400);
  const cleaned = String(target || "").trim().replace(/^@/, "");
  if (!cleaned) throw new MtprotoError("Empty target", 400);

  await startWorker(accountId);
  const client = liveClients.get(accountId);
  if (!client) throw new MtprotoError(`MTProto client not running for ${accountId}`, 503);

  const isImage = /\.(png|jpe?g|gif|webp)$/i.test(filePath);
  const result = await client.sendFile(cleaned, {
    file: filePath,
    caption: options.caption || "",
    // Images go inline; PDF/PPTX/everything-else as document.
    forceDocument: !isImage,
  });
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

  // Use the NewMessage event filter so we only fire on actual incoming
  // text messages — not service updates, typing notifications, etc.
  // outgoing: false → drop echoes of our own sends.
  const newMessageHandler = async (event) => {
    try {
      const msg = event.message;
      if (!msg || msg.out) return;
      // Skip empty / non-text payloads (stickers without text, photos with no caption, etc.).
      const text = (typeof msg.message === "string" && msg.message.trim()) ? msg.message : "";
      if (!text) {
        console.log(`[mtproto] ${id} inbound non-text msg, skipping (id=${msg.id})`);
        return;
      }

      const senderId = msg.senderId?.toString() || null;
      const peer = msg.peerId;
      const chatId = peer?.userId?.toString() || peer?.chatId?.toString() || peer?.channelId?.toString() || senderId;
      let handle = "";
      let usernameOnly = "";
      try {
        const sender = await msg.getSender();
        usernameOnly = sender?.username ? String(sender.username).toLowerCase() : "";
        handle = sender?.username ? `@${sender.username}` : (sender?.firstName || "");
      } catch (e) {
        console.warn(`[mtproto] ${id} getSender failed: ${e?.message || e}`);
      }
      console.log(`[mtproto] ${id} inbound from senderId=${senderId} username=${usernameOnly || "(none)"} text="${text.slice(0, 80)}"`);

      upsertLead({
        accountId: id,
        chatId,
        telegramUserId: senderId,
        telegramHandle: handle,
        message: text,
        direction: "in"
      });
      updateAccountStatus(id, { health: "ok", lastSeenAt: new Date().toISOString() });

      // Hand the inbound to the conversation worker if one is attached.
      if (typeof inboundHook === "function") {
        try {
          inboundHook({
            accountId: id,
            fromUsername: usernameOnly,
            fromTelegramId: senderId,
            text,
          });
        } catch (e) {
          console.error("[mtproto] inboundHook error", e?.message || e);
        }
      }
    } catch (err) {
      console.error("[mtproto] event handler error", err.message);
    }
  };
  client.addEventHandler(newMessageHandler, new NewMessage({ incoming: true, outgoing: false }));
  console.log(`[mtproto] ${id} event handler attached (NewMessage incoming-only)`);
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
