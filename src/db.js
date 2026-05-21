// Persistent storage for accounts/bots/leads.
// Backed by better-sqlite3 (synchronous; fast enough for our size).
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
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

  CREATE TABLE IF NOT EXISTS conversation_threads (
    id                   TEXT PRIMARY KEY,
    account_id           TEXT NOT NULL,
    broadcast_id         TEXT,
    target_username      TEXT,                  -- normalised, no leading @
    target_telegram_id   TEXT,
    state                TEXT NOT NULL DEFAULT 'active',   -- active | completed | failed
    last_inbound_at      INTEGER,
    last_outbound_at     INTEGER,
    next_action_at       INTEGER,               -- ms epoch; null = no pending action
    next_action_type     TEXT,                  -- 'ai_reply' | 'repeat'
    next_action_payload  TEXT,                  -- JSON
    inbound_count        INTEGER NOT NULL DEFAULT 0,
    outbound_count       INTEGER NOT NULL DEFAULT 0,
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_threads_next_action
    ON conversation_threads(next_action_at)
    WHERE next_action_at IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_threads_account_target
    ON conversation_threads(account_id, target_username);

  CREATE TABLE IF NOT EXISTS conversation_messages (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id            TEXT NOT NULL REFERENCES conversation_threads(id) ON DELETE CASCADE,
    direction            TEXT NOT NULL,         -- 'in' | 'out'
    text                 TEXT NOT NULL,
    telegram_message_id  TEXT,
    sent_at              INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_thread
    ON conversation_messages(thread_id, sent_at);

  CREATE TABLE IF NOT EXISTS account_groups (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    group_prompt TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS account_group_members (
    group_id   TEXT NOT NULL REFERENCES account_groups(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    position   INTEGER NOT NULL DEFAULT 0,
    added_at   INTEGER NOT NULL,
    PRIMARY KEY (group_id, account_id)
  );
  CREATE INDEX IF NOT EXISTS idx_group_members_group
    ON account_group_members(group_id, position);

  -- Reusable prompt templates. body uses Mustache-style {{var_name}} placeholders.
  -- defaults_json holds optional fallback values per variable: { var_name: "default" }.
  -- When a group binds a template (account_groups.template_id), the group also
  -- supplies its own template_vars_json overriding the defaults at AI-call time.
  CREATE TABLE IF NOT EXISTS prompt_templates (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    body          TEXT NOT NULL,
    defaults_json TEXT NOT NULL DEFAULT '{}',
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
`);

// Backfill: account_groups gains an optional template_id + per-group variable
// values (rendered into the template body at AI-call time).
try { db.exec(`ALTER TABLE account_groups ADD COLUMN template_id TEXT`); }
catch (e) { if (!/duplicate column name/i.test(String(e?.message || ""))) throw e; }
try { db.exec(`ALTER TABLE account_groups ADD COLUMN template_vars_json TEXT NOT NULL DEFAULT '{}'`); }
catch (e) { if (!/duplicate column name/i.test(String(e?.message || ""))) throw e; }

// Backfill: conversation_threads gains escalation_count (incremented every
// time AI emits [[ESCALATE]] for this thread) and an optional manual_stage_id
// (operator override that beats the auto-classifier). Together with the
// existing state/inbound_count/outbound_count fields these drive the lead
// stage auto-classifier feeding the CRM matrix.
try { db.exec(`ALTER TABLE conversation_threads ADD COLUMN escalation_count INTEGER NOT NULL DEFAULT 0`); }
catch (e) { if (!/duplicate column name/i.test(String(e?.message || ""))) throw e; }
try { db.exec(`ALTER TABLE conversation_threads ADD COLUMN manual_stage_id TEXT`); }
catch (e) { if (!/duplicate column name/i.test(String(e?.message || ""))) throw e; }
// offer_sent_at: set by conversation.js when AI emits the [[OFFER_SENT]] marker
// (or when an outbound contains the group's offer_message text). Flips the CRM
// classifier to stage-offer.
try { db.exec(`ALTER TABLE conversation_threads ADD COLUMN offer_sent_at INTEGER`); }
catch (e) { if (!/duplicate column name/i.test(String(e?.message || ""))) throw e; }
// client_brand: extracted/configured client brand name used to render
// per-lead PDF offers from the Excel templates (LuckyBear-style → BrandX).
try { db.exec(`ALTER TABLE conversation_threads ADD COLUMN client_brand TEXT`); }
catch (e) { if (!/duplicate column name/i.test(String(e?.message || ""))) throw e; }

// Backfill: account_groups gains knowledge_base (terminology + glossary appended
// to AI prompt), offer_message (operator-defined sales offer text the AI
// sends verbatim when the client is ready), and offer_attachments_json
// (array of { filename, mime, storedPath, size } files mtproto sends after
// the offer text lands).
try { db.exec(`ALTER TABLE account_groups ADD COLUMN knowledge_base TEXT NOT NULL DEFAULT ''`); }
catch (e) { if (!/duplicate column name/i.test(String(e?.message || ""))) throw e; }
try { db.exec(`ALTER TABLE account_groups ADD COLUMN offer_message TEXT NOT NULL DEFAULT ''`); }
catch (e) { if (!/duplicate column name/i.test(String(e?.message || ""))) throw e; }
try { db.exec(`ALTER TABLE account_groups ADD COLUMN offer_attachments_json TEXT NOT NULL DEFAULT '[]'`); }
catch (e) { if (!/duplicate column name/i.test(String(e?.message || ""))) throw e; }
try { db.exec(`ALTER TABLE account_groups ADD COLUMN objections TEXT NOT NULL DEFAULT ''`); }
catch (e) { if (!/duplicate column name/i.test(String(e?.message || ""))) throw e; }

// Backfill: broadcast_jobs gains an optional group_id pointing at an account_group.
try { db.exec(`ALTER TABLE broadcast_jobs ADD COLUMN group_id TEXT`); }
catch (e) { if (!/duplicate column name/i.test(String(e?.message || ""))) throw e; }

// Backfill: account_groups gains optional escalation_username (Telegram @handle
// that receives a structured escalation DM when AI gets stuck or the client
// explicitly asks for a live manager).
try { db.exec(`ALTER TABLE account_groups ADD COLUMN escalation_username TEXT NOT NULL DEFAULT ''`); }
catch (e) { if (!/duplicate column name/i.test(String(e?.message || ""))) throw e; }

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
  repeatIntervalMs = 0,
  // v3: optional account-group binding for round-robin sends. account_id stays
  // populated (any one of the group's members) so single-account flows keep
  // working unchanged.
  groupId = null
}) {
  db.prepare(`
    INSERT INTO broadcast_jobs
      (id, account_id, message_text, interval_ms, targets_json, status, created_at, started_at,
       task_type, sales_script, dialog_scenarios, terminology,
       typing_min_ms, typing_max_ms, reply_ignore_min_ms, reply_ignore_max_ms,
       repeat_enabled, repeat_interval_ms, group_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?)
  `).run(
    id, accountId, messageText, intervalMs, JSON.stringify(targets || []), status, createdAt, startedAt ?? null,
    taskType, salesScript, dialogScenarios, terminology,
    typingMinMs, typingMaxMs, replyIgnoreMinMs, replyIgnoreMaxMs,
    repeatEnabled ? 1 : 0, repeatIntervalMs,
    groupId
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
    // AI auto-reply kill-switch (default ON). Honoured by conversation.js.
    aiEnabled: settings.aiEnabled !== false,
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
    // From JOIN with conversation_threads — used by CRM stage modal so the
    // operator can see / edit the client brand that drives PDF rendering.
    clientBrand: row.client_brand || "",
    messages: safeParse(row.messages_json, [])
  };
}

export function listLeads() {
  return db.prepare(`
    SELECT l.*, t.client_brand
    FROM leads l
    LEFT JOIN conversation_threads t ON t.id = l.chat_id
    ORDER BY l.updated_at DESC
  `).all().map(rowToLead);
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

// --- Conversation threads & messages ---

export function findOrCreateThread({
  accountId,
  broadcastId,
  targetUsername,
  targetTelegramId
}) {
  if (!accountId) throw new Error("accountId required");
  const usernameKey = String(targetUsername || "").toLowerCase().replace(/^@/, "");
  // Look up by (account_id, target_username) or (account_id, target_telegram_id).
  const existing = db.prepare(`
    SELECT * FROM conversation_threads
    WHERE account_id = ?
      AND (
        (? != '' AND target_username = ?) OR
        (? != '' AND target_telegram_id = ?)
      )
    ORDER BY created_at DESC
    LIMIT 1
  `).get(
    accountId,
    usernameKey, usernameKey,
    String(targetTelegramId || ""), String(targetTelegramId || "")
  );
  if (existing) return existing;

  const now = Date.now();
  const id = `th-${Math.random().toString(36).slice(2, 10)}-${now.toString(36)}`;
  db.prepare(`
    INSERT INTO conversation_threads
      (id, account_id, broadcast_id, target_username, target_telegram_id, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
  `).run(
    id, accountId, broadcastId || null, usernameKey || null,
    targetTelegramId ? String(targetTelegramId) : null, now, now
  );
  return getThread(id);
}

export function getThread(id) {
  return db.prepare("SELECT * FROM conversation_threads WHERE id = ?").get(id) || null;
}

export function listReadyThreads(now = Date.now(), limit = 50) {
  return db.prepare(`
    SELECT * FROM conversation_threads
    WHERE next_action_at IS NOT NULL
      AND next_action_at <= ?
      AND state IN ('active', 'escalated')
    ORDER BY next_action_at ASC
    LIMIT ?
  `).all(now, limit);
}

export function listThreadsByBroadcast(broadcastId, limit = 200) {
  return db.prepare(`
    SELECT * FROM conversation_threads
    WHERE broadcast_id = ?
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(broadcastId, limit);
}

export function updateThread(id, fields) {
  const cols = ["updated_at = ?"];
  const vals = [Date.now()];
  for (const [k, v] of Object.entries(fields)) {
    cols.push(`${k} = ?`);
    vals.push(v);
  }
  vals.push(id);
  db.prepare(`UPDATE conversation_threads SET ${cols.join(", ")} WHERE id = ?`).run(...vals);
  return getThread(id);
}

export function scheduleThreadAction(id, atMs, type, payload) {
  return updateThread(id, {
    next_action_at: atMs,
    next_action_type: type,
    next_action_payload: payload ? JSON.stringify(payload) : null
  });
}

export function clearThreadAction(id) {
  return updateThread(id, {
    next_action_at: null,
    next_action_type: null,
    next_action_payload: null
  });
}

export function appendThreadMessage({ threadId, direction, text, telegramMessageId }) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO conversation_messages (thread_id, direction, text, telegram_message_id, sent_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(threadId, direction, text, telegramMessageId || null, now);
  // Bump counters and timestamps on the thread.
  if (direction === "in") {
    db.prepare(`
      UPDATE conversation_threads
      SET inbound_count = inbound_count + 1, last_inbound_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, now, threadId);
  } else {
    db.prepare(`
      UPDATE conversation_threads
      SET outbound_count = outbound_count + 1, last_outbound_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, now, threadId);
  }
}

export function getThreadHistory(threadId, limit = 40) {
  return db.prepare(`
    SELECT direction, text, sent_at
    FROM conversation_messages
    WHERE thread_id = ?
    ORDER BY sent_at ASC, id ASC
    LIMIT ?
  `).all(threadId, limit);
}

// --- Account groups ---

function genGroupId() {
  return `grp-${randomBytes(6).toString("hex")}`;
}

export function createGroup({ name, groupPrompt }) {
  const id = genGroupId();
  const now = Date.now();
  db.prepare(
    "INSERT INTO account_groups (id, name, group_prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
  ).run(id, String(name || "").trim() || "Безымянная группа", String(groupPrompt || ""), now, now);
  return getGroup(id);
}

export function getGroup(id) {
  return db.prepare("SELECT * FROM account_groups WHERE id = ?").get(id) || null;
}

export function listGroups() {
  return db.prepare("SELECT * FROM account_groups ORDER BY created_at ASC").all();
}

export function updateGroup(id, fields) {
  const cols = ["updated_at = ?"];
  const vals = [Date.now()];
  if (fields.name !== undefined) { cols.push("name = ?"); vals.push(String(fields.name)); }
  if (fields.groupPrompt !== undefined) { cols.push("group_prompt = ?"); vals.push(String(fields.groupPrompt)); }
  if (fields.escalationUsername !== undefined) {
    cols.push("escalation_username = ?");
    vals.push(String(fields.escalationUsername || "").replace(/^@/, ""));
  }
  if (fields.knowledgeBase !== undefined) { cols.push("knowledge_base = ?"); vals.push(String(fields.knowledgeBase || "")); }
  if (fields.offerMessage !== undefined) { cols.push("offer_message = ?"); vals.push(String(fields.offerMessage || "")); }
  if (fields.objections !== undefined) { cols.push("objections = ?"); vals.push(String(fields.objections || "")); }
  vals.push(id);
  db.prepare(`UPDATE account_groups SET ${cols.join(", ")} WHERE id = ?`).run(...vals);
  return getGroup(id);
}

export function deleteGroup(id) {
  db.prepare("DELETE FROM account_groups WHERE id = ?").run(id);
}

export function addGroupMember(groupId, accountId, position) {
  const pos = Number.isFinite(position)
    ? position
    : (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM account_group_members WHERE group_id = ?").get(groupId)?.p ?? 0);
  db.prepare(
    `INSERT INTO account_group_members (group_id, account_id, position, added_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(group_id, account_id) DO UPDATE SET position = excluded.position`
  ).run(groupId, accountId, pos, Date.now());
  return listGroupMembers(groupId);
}

export function removeGroupMember(groupId, accountId) {
  db.prepare("DELETE FROM account_group_members WHERE group_id = ? AND account_id = ?")
    .run(groupId, accountId);
  return listGroupMembers(groupId);
}

/**
 * Returns the ordered list of account rows that belong to a group.
 * Each row is the bot row from the `bots` table (joined for convenience).
 */
export function listGroupMembers(groupId) {
  return db.prepare(`
    SELECT b.*, m.position
    FROM account_group_members m
    INNER JOIN bots b ON b.id = m.account_id
    WHERE m.group_id = ?
    ORDER BY m.position ASC, m.added_at ASC
  `).all(groupId);
}

/**
 * Returns the oldest (by updated_at) thread currently in 'escalated' state
 * for this account. Used to route an inbound DM from the senior manager
 * back to the client whose escalation was raised first (FIFO).
 */
export function findOldestEscalatedThread(accountId) {
  const row = db.prepare(`
    SELECT * FROM conversation_threads
    WHERE account_id = ? AND state = 'escalated'
    ORDER BY updated_at ASC
    LIMIT 1
  `).get(accountId);
  return row || null;
}

/**
 * True when the account has any group whose escalation_username matches the
 * given Telegram @handle. Lets the inbound handler identify senior-manager
 * messages and route them to the senior-forward flow instead of AI-reply.
 */
export function isAccountEscalationOperator(accountId, username) {
  if (!accountId || !username) return false;
  const u = String(username).toLowerCase().replace(/^@/, "");
  if (!u) return false;
  const row = db.prepare(`
    SELECT 1 FROM account_groups g
    INNER JOIN account_group_members m ON m.group_id = g.id
    WHERE m.account_id = ? AND LOWER(g.escalation_username) = ?
    LIMIT 1
  `).get(accountId, u);
  return Boolean(row);
}

/**
 * Returns the FIRST account group an account belongs to (in insertion order),
 * or null. Used by the conversation worker to look up an account-wide sales
 * persona (group_prompt) for organic inbound DMs that aren't tied to a
 * broadcast.
 */
export function findGroupForAccount(accountId) {
  const row = db.prepare(`
    SELECT g.*
    FROM account_groups g
    INNER JOIN account_group_members m ON m.group_id = g.id
    WHERE m.account_id = ?
    ORDER BY m.added_at ASC
    LIMIT 1
  `).get(accountId);
  return row || null;
}

/** Returns just the account ids of the group's MTProto accounts that are connected. */
export function listGroupConnectedMtprotoAccountIds(groupId) {
  return db.prepare(`
    SELECT b.id
    FROM account_group_members m
    INNER JOIN bots b ON b.id = m.account_id
    WHERE m.group_id = ? AND b.kind = 'mtproto' AND b.status = 'connected'
    ORDER BY m.position ASC, m.added_at ASC
  `).all(groupId).map((r) => r.id);
}

// --- Prompt templates ---

function genTemplateId() {
  return `tpl-${randomBytes(6).toString("hex")}`;
}

// Mustache-style variable extraction. Variable names allow letters, digits,
// underscore, hyphen; whitespace inside the braces is tolerated. Returns
// an ordered unique list of names in first-seen order.
const TEMPLATE_VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_\-]*)\s*\}\}/g;
export function extractTemplateVariables(body) {
  const out = [];
  const seen = new Set();
  for (const m of String(body || "").matchAll(TEMPLATE_VAR_RE)) {
    const name = m[1];
    if (!seen.has(name)) { seen.add(name); out.push(name); }
  }
  return out;
}

// Render a template body with values. Missing variables fall back to their
// template default, else stay as the literal `{{name}}` so it's visible in
// logs that something wasn't bound. Never throws — designed to be called
// inside the AI worker.
export function renderTemplateBody(body, values = {}, defaults = {}) {
  return String(body || "").replace(TEMPLATE_VAR_RE, (match, name) => {
    if (values && Object.prototype.hasOwnProperty.call(values, name) && values[name] != null && values[name] !== "") {
      return String(values[name]);
    }
    if (defaults && Object.prototype.hasOwnProperty.call(defaults, name) && defaults[name] != null && defaults[name] !== "") {
      return String(defaults[name]);
    }
    return match;
  });
}

function rowToTemplate(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    body: row.body,
    defaults: safeParse(row.defaults_json, {}),
    variables: extractTemplateVariables(row.body),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listPromptTemplates() {
  const rows = db.prepare("SELECT * FROM prompt_templates ORDER BY updated_at DESC").all();
  // Count how many groups currently bind each template (for "used by" badges).
  const counts = Object.fromEntries(
    db.prepare("SELECT template_id, COUNT(*) AS n FROM account_groups WHERE template_id IS NOT NULL GROUP BY template_id").all()
      .map((r) => [r.template_id, r.n])
  );
  return rows.map((r) => ({ ...rowToTemplate(r), usedByGroups: counts[r.id] || 0 }));
}

export function getPromptTemplate(id) {
  return rowToTemplate(db.prepare("SELECT * FROM prompt_templates WHERE id = ?").get(id));
}

export function createPromptTemplate({ name, description = "", body = "", defaults = {} } = {}) {
  const id = genTemplateId();
  const now = Date.now();
  db.prepare(
    "INSERT INTO prompt_templates (id, name, description, body, defaults_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, String(name || "").trim() || "Безымянный шаблон", String(description || ""), String(body || ""), JSON.stringify(defaults || {}), now, now);
  return getPromptTemplate(id);
}

export function updatePromptTemplate(id, fields = {}) {
  const cols = ["updated_at = ?"];
  const vals = [Date.now()];
  if (fields.name !== undefined) { cols.push("name = ?"); vals.push(String(fields.name)); }
  if (fields.description !== undefined) { cols.push("description = ?"); vals.push(String(fields.description)); }
  if (fields.body !== undefined) { cols.push("body = ?"); vals.push(String(fields.body)); }
  if (fields.defaults !== undefined) { cols.push("defaults_json = ?"); vals.push(JSON.stringify(fields.defaults || {})); }
  vals.push(id);
  db.prepare(`UPDATE prompt_templates SET ${cols.join(", ")} WHERE id = ?`).run(...vals);
  return getPromptTemplate(id);
}

export function deletePromptTemplate(id) {
  // Detach any groups currently bound so their AI calls fall back to the
  // legacy group_prompt text instead of pointing at a missing template.
  db.prepare("UPDATE account_groups SET template_id = NULL, template_vars_json = '{}' WHERE template_id = ?").run(id);
  return db.prepare("DELETE FROM prompt_templates WHERE id = ?").run(id).changes > 0;
}

// Bind a template (with per-group variable values) to a group. Pass
// templateId=null to clear the binding and fall back to legacy group_prompt.
export function bindGroupTemplate(groupId, { templateId, variables = {} } = {}) {
  db.prepare(
    "UPDATE account_groups SET template_id = ?, template_vars_json = ?, updated_at = ? WHERE id = ?"
  ).run(templateId || null, JSON.stringify(variables || {}), Date.now(), groupId);
  return getGroup(groupId);
}

/**
 * Return the AI prompt text for a group, ready to feed into the model.
 *   1. Core: rendered template body (if template_id) or legacy group_prompt.
 *   2. Append knowledge_base as a "=== База знаний / терминология ===" section
 *      if non-empty. Goes in AFTER the core so it can override or extend.
 *   3. Append offer_message as a "=== Текст оффера ===" section if non-empty,
 *      with instructions to send verbatim when the client is ready and to
 *      append the [[OFFER_SENT]] marker.
 * Used by conversation.js when composing replies.
 */
export function resolveGroupPrompt(group) {
  if (!group) return "";
  let core = "";
  if (group.template_id) {
    const tpl = getPromptTemplate(group.template_id);
    if (tpl) {
      const values = safeParse(group.template_vars_json, {});
      core = renderTemplateBody(tpl.body, values, tpl.defaults);
    }
  }
  if (!core) core = group.group_prompt || "";
  const parts = [core];
  if (group.knowledge_base && String(group.knowledge_base).trim()) {
    parts.push(`\n=== База знаний / терминология ===\n${String(group.knowledge_base).trim()}`);
  }
  if (group.objections && String(group.objections).trim()) {
    parts.push(`\n=== Возражения и кастомные ответы (применяй когда триггер совпадает) ===\n${String(group.objections).trim()}`);
  }
  if (group.offer_message && String(group.offer_message).trim()) {
    parts.push(
      `\n=== Текст оффера (отправь дословно когда клиент готов получить оффер) ===\n${String(group.offer_message).trim()}\n\nКОГДА ТЫ ОТПРАВЛЯЕШЬ ОФФЕР: добавь в самом конце своего сообщения служебный маркер [[OFFER_SENT]] (без причины). Маркер автоматически вырежется из текста, который увидит клиент, а в CRM лид переедет в стадию «Оффер отправлен». Не отправляй оффер по своей инициативе — только когда клиент явно готов слушать (попросил оффер, цену, презентацию, детали продукта).`,
    );
  }
  return parts.join("\n");
}

// --- CRM lead-stage auto-classifier ---

/**
 * Heuristic stage classification from a thread row. Pure function, no I/O.
 *
 *   no inbound at all                   → stage-1  Новый контакт
 *   inbound ≥ 1, escalation_count = 0   → stage-2  Квалификация
 *   escalation_count ≥ 1, state escalat → stage-3  Презентация (бот заТРИГГЕРИЛ оффер/созвон, ждём старшего)
 *   escalation_count ≥ 1, state active  → stage-4  Согласование (старший уже отвечал, перешло живому CRM)
 *
 * Higher stages (stage-onboarding, stage-5 Выиграно, stage-hold, stage-archive)
 * require a deliberate operator flip via manual_stage_id; the auto-classifier
 * never moves leads there.
 */
export function classifyThreadStage(thread) {
  if (!thread) return "stage-1";
  if (thread.manual_stage_id) return thread.manual_stage_id;
  const inb = Number(thread.inbound_count) || 0;
  const esc = Number(thread.escalation_count) || 0;
  const offerSent = Boolean(thread.offer_sent_at);

  // Highest auto-stage first: senior already handled a hot lead → stage-4.
  if (esc >= 1 && thread.state !== "escalated") return "stage-4";
  // Offer was sent (text) and senior hasn't taken over yet → stage-offer.
  if (offerSent) return "stage-offer";
  // Escalated and still waiting on senior → stage-3 (Презентация).
  if (esc >= 1) return "stage-3";
  // Client replied at least once but no offer/escalation yet → Квалификация.
  if (inb >= 1) return "stage-2";
  return "stage-1";
}

/** Mark a thread as having sent the offer (called from conversation.js when AI emits the [[OFFER_SENT]] marker). */
export function markThreadOfferSent(threadId) {
  db.prepare("UPDATE conversation_threads SET offer_sent_at = ?, updated_at = ? WHERE id = ?")
    .run(Date.now(), Date.now(), threadId);
}

/**
 * Mirror a conversation_thread into the legacy `leads` table so the existing
 * CRM matrix UI picks it up. lead.chat_id = thread.id (1:1 mapping); auto-
 * computed stage_id from classifier. Idempotent — safe to call after every
 * thread mutation.
 *
 * Junk-bot inbounds (anonsayrobot, ruletkaa_chat_bot, etc.) are skipped so
 * the CRM doesn't fill up with template-spam Telegram bots.
 */
const JUNK_LEAD_PATTERNS = [
  /bot$/i, /^anonsay/i, /^anonkar/i, /^anonxzx/i, /^ruletkaa?/i,
  /^talkme/i, /^tikible/i, /^ttsave/i,
];
function isJunkLeadHandle(handle) {
  if (!handle) return true;
  const h = String(handle).toLowerCase().replace(/^@/, "");
  return JUNK_LEAD_PATTERNS.some((re) => re.test(h));
}

export function syncLeadFromThread(threadId) {
  const thread = getThread(threadId);
  if (!thread) return null;
  if (isJunkLeadHandle(thread.target_username)) return null;
  // Skip threads that exist only because of senior-operator forwards (the
  // operator is not a CRM lead). The operator's username is on the group's
  // escalation_username field.
  const group = findGroupForAccount(thread.account_id);
  if (group?.escalation_username &&
      String(thread.target_username).toLowerCase() === String(group.escalation_username).toLowerCase()) {
    return null;
  }

  const stageId = classifyThreadStage(thread);
  const handle = thread.target_username ? `@${thread.target_username}` : null;
  const history = getThreadHistory(thread.id, 50);
  const messagesJson = JSON.stringify(history.map((m) => ({
    direction: m.direction, text: m.text, at: m.sent_at,
  })));

  // chat_id = thread.id keeps mapping 1:1. status = current stage label
  // (for quick-glance tooltips in the CRM lead chip).
  const STAGE_LABEL = {
    "stage-1": "Новый контакт",
    "stage-2": "Квалификация",
    "stage-3": "Презентация (оффер/созвон триггер)",
    "stage-offer": "Оффер отправлен",
    "stage-4": "Согласование (передан старшему)",
    "stage-onboarding": "Онбординг",
    "stage-5": "Выиграно",
    "stage-hold": "Hold",
    "stage-archive": "Archive",
  };

  const existing = db.prepare("SELECT id FROM leads WHERE chat_id = ?").get(thread.id);
  if (existing) {
    db.prepare(`
      UPDATE leads SET
        account_id = @account_id,
        telegram_user_id = COALESCE(@telegram_user_id, telegram_user_id),
        telegram_handle = COALESCE(@telegram_handle, telegram_handle),
        stage_id = @stage_id,
        status = @status,
        messages_json = @messages_json,
        last_reply_at = CASE WHEN @last_in > 0 THEN datetime(@last_in/1000, 'unixepoch') ELSE last_reply_at END,
        updated_at = datetime('now')
      WHERE id = @id
    `).run({
      id: existing.id,
      account_id: thread.account_id,
      telegram_user_id: thread.target_telegram_id || null,
      telegram_handle: handle,
      stage_id: stageId,
      status: STAGE_LABEL[stageId] || stageId,
      messages_json: messagesJson,
      last_in: thread.last_inbound_at || 0,
    });
    return existing.id;
  }

  const id = `lead-${thread.id}`;
  db.prepare(`
    INSERT INTO leads
      (id, account_id, telegram_user_id, telegram_handle, chat_id, stage_id, status, messages_json, last_reply_at)
    VALUES
      (@id, @account_id, @telegram_user_id, @telegram_handle, @chat_id, @stage_id, @status, @messages_json,
       CASE WHEN @last_in > 0 THEN datetime(@last_in/1000, 'unixepoch') ELSE NULL END)
  `).run({
    id,
    account_id: thread.account_id,
    telegram_user_id: thread.target_telegram_id || null,
    telegram_handle: handle,
    chat_id: thread.id,
    stage_id: stageId,
    status: STAGE_LABEL[stageId] || stageId,
    messages_json: messagesJson,
    last_in: thread.last_inbound_at || 0,
  });
  return id;
}

/**
 * Operator override: pin a thread's lead to a specific stage regardless of
 * auto-classifier output. Pass null to clear override and resume auto.
 */
export function setLeadManualStage(threadId, stageId) {
  db.prepare("UPDATE conversation_threads SET manual_stage_id = ?, updated_at = ? WHERE id = ?")
    .run(stageId || null, Date.now(), threadId);
  return syncLeadFromThread(threadId);
}

/**
 * Increment the escalation_count on a thread (called from conversation.js
 * before the actual escalateThread DM goes out). Returns the new count.
 */
export function bumpThreadEscalationCount(threadId) {
  db.prepare("UPDATE conversation_threads SET escalation_count = escalation_count + 1, updated_at = ? WHERE id = ?")
    .run(Date.now(), threadId);
  const row = db.prepare("SELECT escalation_count FROM conversation_threads WHERE id = ?").get(threadId);
  return row?.escalation_count || 0;
}

// --- Offer attachments (PNG/JPEG/PDF/PPTX sent after [[OFFER_SENT]]) ---

export function listGroupAttachments(groupId) {
  const row = db.prepare("SELECT offer_attachments_json FROM account_groups WHERE id = ?").get(groupId);
  return safeParse(row?.offer_attachments_json, []);
}

export function addGroupAttachment(groupId, attachment) {
  const current = listGroupAttachments(groupId);
  current.push({
    id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    filename: String(attachment.filename || "file"),
    mime: String(attachment.mime || "application/octet-stream"),
    storedPath: String(attachment.storedPath || ""),
    size: Number(attachment.size) || 0,
    addedAt: Date.now(),
  });
  db.prepare("UPDATE account_groups SET offer_attachments_json = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(current), Date.now(), groupId);
  return current;
}

export function removeGroupAttachment(groupId, attachmentId) {
  const current = listGroupAttachments(groupId).filter((a) => a.id !== attachmentId);
  db.prepare("UPDATE account_groups SET offer_attachments_json = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(current), Date.now(), groupId);
  return current;
}

// --- Language detection from telegram handle / display name ---

/**
 * Heuristic: 'ru' | 'en' | null. Used as a hint passed to AI on first reply
 * so it picks the language before the client has typed anything substantive.
 *
 *   - Cyrillic chars anywhere → 'ru'
 *   - Latin handle containing common Russian transliteration patterns → 'ru'
 *   - Otherwise → null (AI follows its own bilingual rule, defaults to EN)
 */
const RU_TRANSLIT_PATTERNS = [
  /ivan|dmit|sergey|sergei|alex|nikolay|nikolai|vlad|yuri|yury|andrey|andrei|maks|maxim|pavel|petr|peter|denis|kirill/i,
  /smirnov|ivanov|petrov|sokolov|kuznetsov|popov|volkov|fedorov|morozov|orlov|kozlov|novikov|makarov|lebedev/i,
  /msk|mosc|moskva|spb|piter|kyiv|kiev|minsk|odessa|odesa/i,
];
const CYRILLIC_RE = /[Ѐ-ӿ]/;

export function detectLeadLanguage({ username, firstName, lastName } = {}) {
  const haystack = [username, firstName, lastName].filter(Boolean).join(" ");
  if (!haystack) return null;
  if (CYRILLIC_RE.test(haystack)) return "ru";
  if (RU_TRANSLIT_PATTERNS.some((re) => re.test(haystack))) return "ru";
  return null; // unknown — let AI defaults handle it
}

// --- Per-lead client brand (used when rendering offer PDFs) ---

export function setThreadClientBrand(threadId, brand) {
  db.prepare("UPDATE conversation_threads SET client_brand = ?, updated_at = ? WHERE id = ?")
    .run(brand ? String(brand).trim() : null, Date.now(), threadId);
  syncLeadFromThread(threadId);
}

/**
 * Quick heuristic: turn a Telegram handle into a probable brand name.
 *   "betongame_egor"     → "Betongame"
 *   "luckybear_official" → "Luckybear"
 *   "spinbetter"         → "Spinbetter"
 *   "marketing_dima"     → null (looks like a role, not a brand)
 * Used as a fallback when no explicit brand is stored.
 */
const ROLE_SUFFIXES = /_(egor|dima|max|maks|olya|ivan|sergey|sales|support|team|official|cmo|ceo|manager|sales\b)$/i;
const ROLE_NAMES = /^(marketing|sales|support|admin|info|hello|hi|test)$/i;
export function inferBrandFromUsername(username) {
  if (!username) return null;
  let u = String(username).replace(/^@/, "").trim();
  if (!u) return null;
  if (ROLE_NAMES.test(u)) return null;
  u = u.replace(ROLE_SUFFIXES, "");
  // Avoid all-numeric or too-short results.
  if (u.length < 4 || /^[0-9_]+$/.test(u)) return null;
  // Title-case the first segment.
  const first = u.split(/[_-]/)[0];
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

/** Returns the brand to use for offer rendering on this thread:
 *  1. Explicit client_brand set on thread (operator or AI extracted)
 *  2. Heuristic inferred from target_username
 *  3. "Your Brand" fallback (placeholder in PDFs)
 */
export function resolveClientBrand(thread) {
  if (!thread) return "Your Brand";
  if (thread.client_brand && thread.client_brand.trim()) return thread.client_brand.trim();
  return inferBrandFromUsername(thread.target_username) || "Your Brand";
}
