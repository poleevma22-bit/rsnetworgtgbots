// Persistent storage for accounts/bots/leads.
// Backed by better-sqlite3 (synchronous; fast enough for our size).
import Database from "better-sqlite3";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const root = normalize(join(fileURLToPath(new URL(".", import.meta.url)), ".."));
const dataDir = join(root, "data");
mkdirSync(dataDir, { recursive: true });
const dbPath = process.env.DB_PATH || join(dataDir, "tgbots.sqlite3");

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS bots (
    id              TEXT PRIMARY KEY,
    kind            TEXT NOT NULL,           -- 'bot_api' | 'mtproto'
    token           TEXT,                    -- bot_api token (encrypted at rest? store plain for now)
    api_id          INTEGER,                 -- mtproto
    phone           TEXT,                    -- mtproto
    session_string  TEXT,                    -- mtproto serialized session
    telegram_id     TEXT,                    -- numeric Telegram user/bot id
    username        TEXT,                    -- @handle without @
    first_name      TEXT,
    webhook_secret  TEXT,                    -- bot_api: secret_token to validate incoming
    status          TEXT NOT NULL DEFAULT 'pending',  -- connected|pending|review|disabled
    health          TEXT NOT NULL DEFAULT 'review',   -- ok|limited|review|down
    settings_json   TEXT NOT NULL DEFAULT '{}',
    last_seen_at    TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS leads (
    id              TEXT PRIMARY KEY,
    account_id      TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    telegram_user_id TEXT,
    telegram_handle  TEXT,                   -- @username or display
    chat_id         TEXT,
    stage_id        TEXT NOT NULL DEFAULT 'stage-1',
    status          TEXT,
    comment         TEXT,
    next_ping_at    TEXT,
    last_reply_at   TEXT,
    messages_json   TEXT NOT NULL DEFAULT '[]',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_leads_account ON leads(account_id);
  CREATE INDEX IF NOT EXISTS idx_leads_chat    ON leads(account_id, chat_id);

  CREATE TABLE IF NOT EXISTS databases (
    id              TEXT PRIMARY KEY,
    filename        TEXT NOT NULL,
    total           INTEGER NOT NULL DEFAULT 0,
    valid           INTEGER NOT NULL DEFAULT 0,
    rejected        INTEGER NOT NULL DEFAULT 0,
    sample_json     TEXT NOT NULL DEFAULT '[]',
    contacts_json   TEXT NOT NULL DEFAULT '[]',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bot_updates (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id          TEXT REFERENCES bots(id) ON DELETE CASCADE,
    update_id       INTEGER,
    chat_id         TEXT,
    username        TEXT,
    text            TEXT,
    raw_json        TEXT,
    received_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_updates_bot ON bot_updates(bot_id, received_at DESC);

  CREATE TABLE IF NOT EXISTS mtproto_pending (
    id              TEXT PRIMARY KEY,        -- short random temp id
    phone           TEXT NOT NULL,
    phone_code_hash TEXT NOT NULL,
    api_id          INTEGER NOT NULL,
    api_hash        TEXT NOT NULL,
    session_string  TEXT,                    -- partial after sendCode
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_json   TEXT NOT NULL,
    created_at  INTEGER NOT NULL,            -- epoch ms
    expires_at  INTEGER NOT NULL             -- epoch ms
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS broadcast_jobs (
    id                  TEXT PRIMARY KEY,
    account_id          TEXT NOT NULL,
    message_text        TEXT NOT NULL,
    interval_ms         INTEGER NOT NULL,
    targets_json        TEXT NOT NULL,           -- JSON [{ target, status, error?, sentAt? }]
    status              TEXT NOT NULL,           -- running | done | cancelled | failed
    cursor              INTEGER NOT NULL DEFAULT 0,
    sent_count          INTEGER NOT NULL DEFAULT 0,
    failed_count        INTEGER NOT NULL DEFAULT 0,
    last_error          TEXT,
    created_at          INTEGER NOT NULL,
    started_at          INTEGER,
    finished_at         INTEGER,
    -- v2 fields (Phase 1: task type, sales context, behavioural defaults)
    task_type           TEXT NOT NULL DEFAULT 'cold',  -- ping | cold | warm
    sales_script        TEXT NOT NULL DEFAULT '',      -- long prompt with examples
    dialog_scenarios    TEXT NOT NULL DEFAULT '',      -- expected client replies + branches
    terminology         TEXT NOT NULL DEFAULT '',      -- domain glossary used by AI later
    typing_min_ms       INTEGER NOT NULL DEFAULT 5000,
    typing_max_ms       INTEGER NOT NULL DEFAULT 10000,
    reply_ignore_min_ms INTEGER NOT NULL DEFAULT 60000,
    reply_ignore_max_ms INTEGER NOT NULL DEFAULT 120000,
    repeat_enabled      INTEGER NOT NULL DEFAULT 0,    -- 0/1
    repeat_interval_ms  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_broadcast_status ON broadcast_jobs(status, created_at DESC);
`);

// --- Migration: backfill v2 columns on existing broadcast_jobs rows. ALTER ADD COLUMN
// is idempotent if we trap the "duplicate column" error, so this is safe to re-run.
const __BROADCAST_V2_COLS = [
  ["task_type", "TEXT NOT NULL DEFAULT 'cold'"],
  ["sales_script", "TEXT NOT NULL DEFAULT ''"],
  ["dialog_scenarios", "TEXT NOT NULL DEFAULT ''"],
  ["terminology", "TEXT NOT NULL DEFAULT ''"],
  ["typing_min_ms", "INTEGER NOT NULL DEFAULT 5000"],
  ["typing_max_ms", "INTEGER NOT NULL DEFAULT 10000"],
  ["reply_ignore_min_ms", "INTEGER NOT NULL DEFAULT 60000"],
  ["reply_ignore_max_ms", "INTEGER NOT NULL DEFAULT 120000"],
  ["repeat_enabled", "INTEGER NOT NULL DEFAULT 0"],
  ["repeat_interval_ms", "INTEGER NOT NULL DEFAULT 0"]
];
for (const [col, decl] of __BROADCAST_V2_COLS) {
  try { db.exec(`ALTER TABLE broadcast_jobs ADD COLUMN ${col} ${decl}`); }
  catch (e) { if (!/duplicate column name/i.test(String(e?.message || ""))) throw e; }
}

// --- Sessions (persistent so pm2 restarts don't log everyone out) ---

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function getSessionByToken(token) {
  if (!token) return null;
  const row = db.prepare("SELECT user_json, expires_at FROM sessions WHERE token = ?").get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return null;
  }
  return safeParse(row.user_json, null);
}

export function putSession(token, user) {
  const now = Date.now();
  db.prepare(
    "INSERT INTO sessions (token, user_json, created_at, expires_at) VALUES (?, ?, ?, ?)" +
      " ON CONFLICT(token) DO UPDATE SET user_json=excluded.user_json, expires_at=excluded.expires_at"
  ).run(token, JSON.stringify(user), now, now + SESSION_TTL_MS);
}

export function deleteSession(token) {
  if (!token) return;
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export function purgeExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
}

// --- Broadcasts ---

export function insertBroadcastJob({
  id, accountId, messageText, intervalMs, targets, status, createdAt, startedAt,
  // v2 fields — all optional, sensible defaults match the SQL DEFAULTs.
  taskType = "cold",
  salesScript = "",
  dialogScenarios = "",
  terminology = "",
  typingMinMs = 5000,
  typingMaxMs = 10000,
  replyIgnoreMinMs = 60000,
  replyIgnoreMaxMs = 120000,
  repeatEnabled = false,
  repeatIntervalMs = 0
}) {
  db.prepare(`
    INSERT INTO broadcast_jobs
      (id, account_id, message_text, interval_ms, targets_json, status, created_at, started_at,
       task_type, sales_script, dialog_scenarios, terminology,
       typing_min_ms, typing_max_ms, reply_ignore_min_ms, reply_ignore_max_ms,
       repeat_enabled, repeat_interval_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?)
  `).run(
    id, accountId, messageText, intervalMs, JSON.stringify(targets || []), status, createdAt, startedAt ?? null,
    taskType, salesScript, dialogScenarios, terminology,
    typingMinMs, typingMaxMs, replyIgnoreMinMs, replyIgnoreMaxMs,
    repeatEnabled ? 1 : 0, repeatIntervalMs
  );
  return getBroadcastJob(id);
}

export function getBroadcastJob(id) {
  return db.prepare("SELECT * FROM broadcast_jobs WHERE id = ?").get(id) || null;
}

export function listBroadcastJobs(limit = 50) {
  return db.prepare("SELECT * FROM broadcast_jobs ORDER BY created_at DESC LIMIT ?").all(limit);
}

export function listActiveBroadcastJobs() {
  return db.prepare("SELECT * FROM broadcast_jobs WHERE status = 'running' ORDER BY created_at DESC").all();
}

export function updateBroadcastJob(id, fields) {
  const cols = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    cols.push(`${k} = ?`);
    vals.push(v);
  }
  if (!cols.length) return getBroadcastJob(id);
  vals.push(id);
  db.prepare(`UPDATE broadcast_jobs SET ${cols.join(", ")} WHERE id = ?`).run(...vals);
  return getBroadcastJob(id);
}

export function markBroadcastFinished(id, status) {
  db.prepare("UPDATE broadcast_jobs SET status = ?, finished_at = ? WHERE id = ?")
    .run(status, Date.now(), id);
  return getBroadcastJob(id);
}

// --- Helpers ---

function nowIso() {
  return new Date().toISOString();
}

function rowToAccount(row) {
  if (!row) return null;
  const settings = safeParse(row.settings_json, {});
  return {
    id: row.id,
    kind: row.kind,
    name: settings.name || row.first_name || row.username || row.id,
    handle: row.username ? `@${row.username}` : "",
    avatarUrl: settings.avatarUrl || "",
    status: row.status,
    health: row.health,
    connector: row.kind === "bot_api" ? "Bot API" : "Telegram API app",
    databaseId: settings.databaseId || null,
    salesSkill: settings.salesSkill || "first_contact",
    timerProfile: settings.timerProfile || "wait_60s",
    promptText: settings.promptText || "",
    replyDelaySeconds: settings.replyDelaySeconds ?? 60,
    repeatIntervalMinutes: settings.repeatIntervalMinutes ?? null,
    typingSeconds: settings.typingSeconds ?? 5,
    workingHoursPerDay: settings.workingHoursPerDay ?? 6,
    messagesSent: settings.messagesSent ?? 0,
    telegramId: row.telegram_id,
    phone: row.phone || null,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at
  };
}

function safeParse(text, fallback) {
  try { return text ? JSON.parse(text) : fallback; } catch { return fallback; }
}

// --- Bots / accounts API ---

export function listAccounts() {
  return db.prepare("SELECT * FROM bots ORDER BY created_at ASC").all().map(rowToAccount);
}

export function getAccount(id) {
  return rowToAccount(db.prepare("SELECT * FROM bots WHERE id = ?").get(id));
}

export function findBotByTelegramId(telegramId) {
  return rowToAccount(db.prepare("SELECT * FROM bots WHERE telegram_id = ? AND kind = 'bot_api'").get(String(telegramId)));
}

export function insertBotApi({ id, token, telegramId, username, firstName, webhookSecret, status = "connected", health = "ok" }) {
  db.prepare(`
    INSERT INTO bots (id, kind, token, telegram_id, username, first_name, webhook_secret, status, health, settings_json, last_seen_at, updated_at)
    VALUES (@id, 'bot_api', @token, @telegram_id, @username, @first_name, @webhook_secret, @status, @health, '{}', @last_seen_at, @updated_at)
  `).run({
    id, token, telegram_id: String(telegramId), username, first_name: firstName,
    webhook_secret: webhookSecret, status, health, last_seen_at: nowIso(), updated_at: nowIso()
  });
  return getAccount(id);
}

export function insertMtproto({ id, apiId, phone, sessionString, telegramId, username, firstName, status = "connected", health = "ok" }) {
  db.prepare(`
    INSERT INTO bots (id, kind, api_id, phone, session_string, telegram_id, username, first_name, status, health, settings_json, last_seen_at, updated_at)
    VALUES (@id, 'mtproto', @api_id, @phone, @session_string, @telegram_id, @username, @first_name, @status, @health, '{}', @last_seen_at, @updated_at)
  `).run({
    id, api_id: apiId, phone, session_string: sessionString,
    telegram_id: telegramId ? String(telegramId) : null,
    username, first_name: firstName, status, health,
    last_seen_at: nowIso(), updated_at: nowIso()
  });
  return getAccount(id);
}

export function updateAccountStatus(id, { status, health, lastSeenAt }) {
  db.prepare(`
    UPDATE bots SET
      status = COALESCE(@status, status),
      health = COALESCE(@health, health),
      last_seen_at = COALESCE(@last_seen_at, last_seen_at),
      updated_at = @updated_at
    WHERE id = @id
  `).run({ id, status: status ?? null, health: health ?? null, last_seen_at: lastSeenAt ?? null, updated_at: nowIso() });
  return getAccount(id);
}

export function updateAccountSettings(id, partial) {
  const row = db.prepare("SELECT settings_json FROM bots WHERE id = ?").get(id);
  if (!row) return null;
  const current = safeParse(row.settings_json, {});
  const merged = { ...current, ...partial };
  db.prepare("UPDATE bots SET settings_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(merged), nowIso(), id);
  return getAccount(id);
}

export function deleteAccount(id) {
  return db.prepare("DELETE FROM bots WHERE id = ?").run(id).changes > 0;
}

export function getBotApiToken(id) {
  const row = db.prepare("SELECT token, webhook_secret FROM bots WHERE id = ? AND kind = 'bot_api'").get(id);
  return row || null;
}

export function getMtprotoSession(id) {
  const row = db.prepare("SELECT session_string, api_id, phone FROM bots WHERE id = ? AND kind = 'mtproto'").get(id);
  return row || null;
}

export function listMtprotoAccounts() {
  return db.prepare("SELECT * FROM bots WHERE kind = 'mtproto' ORDER BY created_at ASC").all().map(rowToAccount);
}

export function listBotApiAccounts() {
  return db.prepare("SELECT * FROM bots WHERE kind = 'bot_api' ORDER BY created_at ASC").all().map(rowToAccount);
}

// --- Leads ---

function rowToLead(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    telegram: row.telegram_handle || (row.telegram_user_id ? `id:${row.telegram_user_id}` : ""),
    telegramUserId: row.telegram_user_id,
    chatId: row.chat_id,
    stageId: row.stage_id,
    status: row.status || "",
    comment: row.comment || "",
    nextPingAt: row.next_ping_at,
    lastReplyAt: row.last_reply_at,
    messages: safeParse(row.messages_json, [])
  };
}

export function listLeads() {
  return db.prepare("SELECT * FROM leads ORDER BY updated_at DESC").all().map(rowToLead);
}

export function findLeadByChat(accountId, chatId) {
  return rowToLead(db.prepare("SELECT * FROM leads WHERE account_id = ? AND chat_id = ?").get(accountId, String(chatId)));
}

export function upsertLead({ accountId, chatId, telegramUserId, telegramHandle, message, direction = "in" }) {
  const existing = findLeadByChat(accountId, chatId);
  const messages = existing ? existing.messages : [];
  if (message) messages.push({ direction, text: message, at: nowIso() });
  if (existing) {
    db.prepare(`
      UPDATE leads SET
        telegram_user_id = COALESCE(@telegram_user_id, telegram_user_id),
        telegram_handle = COALESCE(@telegram_handle, telegram_handle),
        last_reply_at = CASE WHEN @direction = 'in' THEN @now ELSE last_reply_at END,
        messages_json = @messages,
        updated_at = @now
      WHERE id = @id
    `).run({
      id: existing.id,
      telegram_user_id: telegramUserId ? String(telegramUserId) : null,
      telegram_handle: telegramHandle || null,
      direction,
      messages: JSON.stringify(messages.slice(-50)),
      now: nowIso()
    });
    return findLeadByChat(accountId, chatId);
  }
  const id = `lead-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`
    INSERT INTO leads (id, account_id, telegram_user_id, telegram_handle, chat_id, stage_id, messages_json, last_reply_at)
    VALUES (@id, @account_id, @telegram_user_id, @telegram_handle, @chat_id, 'stage-1', @messages, CASE WHEN @direction = 'in' THEN @now ELSE NULL END)
  `).run({
    id,
    account_id: accountId,
    telegram_user_id: telegramUserId ? String(telegramUserId) : null,
    telegram_handle: telegramHandle || null,
    chat_id: String(chatId),
    direction,
    messages: JSON.stringify(messages.slice(-50)),
    now: nowIso()
  });
  return findLeadByChat(accountId, chatId);
}

export function updateLeadComment(leadId, comment) {
  db.prepare("UPDATE leads SET comment = ?, updated_at = ? WHERE id = ?").run(comment || "", nowIso(), leadId);
  return rowToLead(db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId));
}

// --- Databases (contact uploads) ---

function rowToDatabase(row) {
  if (!row) return null;
  return {
    id: row.id,
    filename: row.filename,
    total: row.total,
    valid: row.valid,
    rejected: row.rejected,
    sample: safeParse(row.sample_json, []),
    createdAt: row.created_at
  };
}

export function listDatabases() {
  return db.prepare("SELECT * FROM databases ORDER BY created_at DESC").all().map(rowToDatabase);
}

export function insertDatabase({ id, filename, total, valid, rejected, sample, contacts }) {
  db.prepare(`
    INSERT INTO databases (id, filename, total, valid, rejected, sample_json, contacts_json)
    VALUES (@id, @filename, @total, @valid, @rejected, @sample, @contacts)
  `).run({
    id, filename, total, valid, rejected,
    sample: JSON.stringify(sample || []),
    contacts: JSON.stringify(contacts || [])
  });
  return rowToDatabase(db.prepare("SELECT * FROM databases WHERE id = ?").get(id));
}

// --- Bot updates audit ---

export function recordBotUpdate({ botId, updateId, chatId, username, text, raw }) {
  db.prepare(`
    INSERT INTO bot_updates (bot_id, update_id, chat_id, username, text, raw_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(botId, updateId ?? null, chatId ? String(chatId) : null, username || null, text || null, JSON.stringify(raw || {}));
}

export function recentBotUpdates(limit = 20) {
  return db.prepare("SELECT * FROM bot_updates ORDER BY received_at DESC LIMIT ?").all(limit);
}

// --- MTProto pending auth ---

export function insertMtprotoPending({ id, phone, phoneCodeHash, apiId, apiHash, sessionString }) {
  db.prepare(`
    INSERT INTO mtproto_pending (id, phone, phone_code_hash, api_id, api_hash, session_string)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, phone, phoneCodeHash, apiId, apiHash, sessionString || null);
}

export function getMtprotoPending(id) {
  return db.prepare("SELECT * FROM mtproto_pending WHERE id = ?").get(id);
}

export function deleteMtprotoPending(id) {
  db.prepare("DELETE FROM mtproto_pending WHERE id = ?").run(id);
}
