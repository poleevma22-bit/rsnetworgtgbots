import "dotenv/config";
import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import xlsx from "xlsx";
import { store, getSnapshot } from "./data.js";
import { validateAutomationPolicy } from "./safety.js";
import {
  insertDatabase, updateAccountSettings, updateLeadComment,
  listAccounts, getAccount,
  getSessionByToken, putSession, deleteSession, purgeExpiredSessions
} from "./db.js";
import {
  connectBot, disconnectBot, getWebhookInfo, handleIncomingUpdate,
  syncAllWebhooks, BotApiError
} from "./telegram-bot.js";
import {
  startAuth, confirmAuth, disconnectMtproto, bootAllWorkers, MtprotoError
} from "./telegram-mtproto.js";
import {
  startBroadcast, cancelBroadcast, listBroadcasts, getBroadcast,
  resumeRunningBroadcasts, BroadcastError
} from "./broadcast.js";
import {
  startConversationWorker, handleInboundMessage as handleConversationInbound
} from "./conversation.js";
import { setInboundHook } from "./telegram-mtproto.js";
import {
  listThreadsByBroadcast, getThreadHistory,
  createGroup, listGroups, getGroup, updateGroup, deleteGroup,
  addGroupMember, removeGroupMember, listGroupMembers
} from "./db.js";

const root = normalize(join(fileURLToPath(new URL(".", import.meta.url)), ".."));
const publicDir = join(root, "public");
const dataDir = join(root, "data");
const usersPath = join(dataDir, "users.json");
const port = Number(process.env.PORT || 4173);
const publicBaseUrl = process.env.PUBLIC_BASE_URL || "";

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png"
};

// Sessions are now persisted in SQLite (see db.js sessions table) so that
// pm2/process restarts don't log every user out. Kept the variable name
// removed; use getSessionByToken/putSession/deleteSession instead.
const aiRequestLog = new Map();
// Garbage-collect expired sessions hourly.
setInterval(() => { try { purgeExpiredSessions(); } catch {} }, 60 * 60 * 1000).unref?.();
const demoAdmin = {
  email: "admin@rs.local",
  password: "admin12345"
};

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function normalizeTelegramContacts(text = "") {
  const source = String(text);
  const matches = [
    ...source.matchAll(/(?:^|[\s,;])@([a-zA-Z0-9_]{5,32})\b/g),
    ...source.matchAll(/(?:https?:\/\/)?t\.me\/([a-zA-Z0-9_]{5,32})\b/g)
  ];
  return [...new Set(matches.map((match) => `@${match[1]}`))];
}

function extractTextFromWorkbook(base64 = "") {
  const buffer = Buffer.from(base64, "base64");
  const workbook = xlsx.read(buffer, { type: "buffer" });
  return workbook.SheetNames.map((sheetName) => {
    const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "" });
    return rows.flat().join("\n");
  }).join("\n");
}

function parseTelegramContacts({ contacts = "", fileBase64 = "", filename = "" } = {}) {
  const isWorkbook = /\.(xlsx|xls)$/i.test(filename);
  const text = isWorkbook && fileBase64 ? extractTextFromWorkbook(fileBase64) : contacts;
  const rawRows = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const validContacts = normalizeTelegramContacts(text);
  return {
    total: Math.max(rawRows.length, validContacts.length),
    valid: validContacts.length,
    rejected: Math.max(rawRows.length - validContacts.length, 0),
    sample: validContacts.slice(0, 5),
    contacts: validContacts
  };
}

function resolveTimerProfile(timerProfile = "wait_60s") {
  const profiles = {
    wait_60s: { replyDelaySeconds: 60, repeatIntervalMinutes: null },
    wait_5m: { replyDelaySeconds: 300, repeatIntervalMinutes: null },
    wait_10m: { replyDelaySeconds: 600, repeatIntervalMinutes: null },
    wait_15m: { replyDelaySeconds: 900, repeatIntervalMinutes: null },
    wait_30m: { replyDelaySeconds: 1800, repeatIntervalMinutes: null },
    repeat_2d: { replyDelaySeconds: 60, repeatIntervalMinutes: 2880 },
    repeat_7d: { replyDelaySeconds: 60, repeatIntervalMinutes: 10080 },
    repeat_14d: { replyDelaySeconds: 60, repeatIntervalMinutes: 20160 },
    repeat_30d: { replyDelaySeconds: 60, repeatIntervalMinutes: 43200 }
  };
  return profiles[timerProfile] || profiles.wait_60s;
}

function buildHoldSummary() {
  const snap = getSnapshot();
  const holds = snap.leads.filter((lead) => lead.stageId === "stage-hold");
  if (!holds.length) return "Hold пустой: зависших сделок сейчас нет.";
  return holds
    .map((lead) => {
      const account = snap.accounts.find((item) => item.id === lead.accountId);
      const nextPing = lead.nextPingAt ? new Date(lead.nextPingAt).toLocaleDateString("ru-RU") : "пинг не назначен";
      return `${lead.telegram} / ${account?.id || "без аккаунта"}: ${lead.status} Следующий пинг: ${nextPing}. Комментарий: ${lead.comment || "нет"}.`;
    })
    .join(" ");
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim().split("="))
      .filter((pair) => pair.length === 2)
      .map(([key, value]) => [key, decodeURIComponent(value)])
  );
}

function getSessionUser(request) {
  const token = parseCookies(request.headers.cookie || "").rs_session;
  if (!token) return null;
  return getSessionByToken(token);
}

function checkAiRateLimit(user) {
  if (user?.role === "admin") return { ok: true };
  const key = user?.id || user?.email || "anonymous";
  const now = Date.now();
  const previous = aiRequestLog.get(key) || 0;
  const intervalMs = 15 * 60 * 1000;
  if (now - previous < intervalMs) {
    const waitMinutes = Math.ceil((intervalMs - (now - previous)) / 60000);
    return { ok: false, error: `AI помощник доступен раз в 15 минут. Повторите запрос через ${waitMinutes} мин.` };
  }
  aiRequestLog.set(key, now);
  return { ok: true };
}

async function loadUsers() {
  try {
    return JSON.parse(await readFile(usersPath, "utf8"));
  } catch {
    return [];
  }
}

async function saveUsers(users) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(usersPath, JSON.stringify(users, null, 2), "utf8");
}

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = Buffer.from(hashPassword(password, salt).split(":")[1], "hex");
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

async function ensureDemoAdmin() {
  const users = await loadUsers();
  const existing = users.find((user) => user.email === demoAdmin.email);
  if (existing) {
    existing.passwordHash = hashPassword(demoAdmin.password);
    existing.role = "admin";
    existing.clientId = "client-rs-network";
    await saveUsers(users);
    return users;
  }
  users.push({
    id: "user-demo-admin",
    email: demoAdmin.email,
    passwordHash: hashPassword(demoAdmin.password),
    role: "admin",
    clientId: "client-rs-network",
    createdAt: new Date().toISOString()
  });
  await saveUsers(users);
  return users;
}

function telegramConfig() {
  const accounts = listAccounts();
  return {
    configured: accounts.length > 0,
    botApiCount: accounts.filter((a) => a.connector === "Bot API").length,
    mtprotoCount: accounts.filter((a) => a.connector === "Telegram API app").length,
    publicBaseUrl,
    webhookPath: "/api/telegram/webhook/:botId",
    hasMtprotoCreds: Boolean(process.env.TG_API_ID && process.env.TG_API_HASH)
  };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { return {}; }
}

function reportError(response, error) {
  const status =
    error?.status ||
    error?.statusCode ||
    (error instanceof BroadcastError ? 422 : 500);
  sendJson(response, status, { ok: false, error: error?.message || "Internal error", code: error?.code });
}

async function handleApi(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const path = url.pathname;

  // --- Public: snapshot/session/auth ---
  if (request.method === "GET" && path === "/api/snapshot") {
    if (!getSessionUser(request)) {
      sendJson(response, 401, { ok: false, error: "Требуется вход" });
      return;
    }
    sendJson(response, 200, getSnapshot());
    return;
  }

  if (request.method === "GET" && path === "/api/session") {
    const user = getSessionUser(request);
    sendJson(response, 200, { ok: true, authenticated: Boolean(user), user });
    return;
  }

  if (request.method === "POST" && path === "/api/register") {
    const body = await readBody(request);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!email.includes("@") || password.length < 8) {
      sendJson(response, 422, { ok: false, error: "Укажите email и пароль от 8 символов." });
      return;
    }
    const users = await loadUsers();
    if (users.some((user) => user.email === email)) {
      sendJson(response, 409, { ok: false, error: "Пользователь уже существует." });
      return;
    }
    const user = { id: `user-${Date.now()}`, email, passwordHash: hashPassword(password), createdAt: new Date().toISOString() };
    users.push(user);
    await saveUsers(users);
    const token = randomBytes(32).toString("hex");
    putSession(token, { id: user.id, email: user.email, role: user.role || "user" });
    response.setHeader("Set-Cookie", `rs_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
    sendJson(response, 201, { ok: true, user: { id: user.id, email: user.email, role: user.role || "user" } });
    return;
  }

  if (request.method === "POST" && path === "/api/login") {
    const body = await readBody(request);
    const email = String(body.email || "").trim().toLowerCase();
    const users = await ensureDemoAdmin();
    const user = users.find((item) => item.email === email);
    if (!user || !verifyPassword(String(body.password || ""), user.passwordHash)) {
      sendJson(response, 401, { ok: false, error: "Неверный email или пароль." });
      return;
    }
    const token = randomBytes(32).toString("hex");
    putSession(token, { id: user.id, email: user.email, role: user.role || "user" });
    response.setHeader("Set-Cookie", `rs_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
    sendJson(response, 200, { ok: true, user: { id: user.id, email: user.email, role: user.role || "user" } });
    return;
  }

  if (request.method === "POST" && path === "/api/logout") {
    const token = parseCookies(request.headers.cookie || "").rs_session;
    if (token) deleteSession(token);
    response.setHeader("Set-Cookie", "rs_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    sendJson(response, 200, { ok: true });
    return;
  }

  // --- Bot API webhook (PUBLIC: must work without session) ---
  // /api/telegram/webhook/:botId
  if (request.method === "POST" && path.startsWith("/api/telegram/webhook/")) {
    const botId = path.slice("/api/telegram/webhook/".length).split("/")[0];
    const secret = request.headers["x-telegram-bot-api-secret-token"] || "";
    const update = await readBody(request);
    try {
      handleIncomingUpdate(botId, secret, update);
      sendJson(response, 200, { ok: true });
    } catch (e) {
      reportError(response, e);
    }
    return;
  }

  // --- Auth-required below ---
  if (!getSessionUser(request)) {
    sendJson(response, 401, { ok: false, error: "Требуется вход" });
    return;
  }

  if (request.method === "GET" && path === "/api/clients") {
    sendJson(response, 200, { ok: true, clients: store.clients });
    return;
  }

  if (request.method === "POST" && path === "/api/clients") {
    const body = await readBody(request);
    const name = String(body.name || "").trim();
    if (!name) { sendJson(response, 422, { ok: false, error: "Укажите название клиента." }); return; }
    const client = {
      id: `client-${Date.now()}`,
      name,
      brand: body.brand || name,
      status: "active",
      ownerEmail: body.ownerEmail || "",
      createdAt: new Date().toISOString()
    };
    store.clients.push(client);
    sendJson(response, 201, { ok: true, client });
    return;
  }

  // --- Telegram status & sync ---
  if (request.method === "GET" && path === "/api/telegram/status") {
    sendJson(response, 200, { ok: true, telegram: telegramConfig() });
    return;
  }

  if (request.method === "POST" && path === "/api/telegram/sync-webhooks") {
    if (!publicBaseUrl) {
      sendJson(response, 422, { ok: false, error: "PUBLIC_BASE_URL не настроен в env сервиса" });
      return;
    }
    try {
      const result = await syncAllWebhooks(publicBaseUrl);
      sendJson(response, 200, { ok: true, results: result });
    } catch (e) { reportError(response, e); }
    return;
  }

  // --- Bot API CRUD ---
  if (request.method === "POST" && path === "/api/telegram/bots") {
    const body = await readBody(request);
    const token = String(body.token || "").trim();
    try {
      const result = await connectBot({ token, publicBaseUrl });
      sendJson(response, 201, { ok: true, ...result });
    } catch (e) { reportError(response, e); }
    return;
  }

  // GET /api/telegram/bots/:id/webhook-info
  const wiMatch = path.match(/^\/api\/telegram\/bots\/([^/]+)\/webhook-info$/);
  if (request.method === "GET" && wiMatch) {
    try {
      const info = await getWebhookInfo(wiMatch[1]);
      sendJson(response, 200, { ok: true, info });
    } catch (e) { reportError(response, e); }
    return;
  }

  // DELETE /api/telegram/bots/:id
  const delMatch = path.match(/^\/api\/telegram\/bots\/([^/]+)$/);
  if (request.method === "DELETE" && delMatch) {
    try {
      await disconnectBot(delMatch[1]);
      sendJson(response, 200, { ok: true });
    } catch (e) { reportError(response, e); }
    return;
  }

  // --- MTProto ---
  if (request.method === "POST" && path === "/api/telegram/mtproto/start") {
    const body = await readBody(request);
    try {
      const result = await startAuth({ phone: String(body.phone || "").trim() });
      sendJson(response, 200, { ok: true, ...result });
    } catch (e) { reportError(response, e); }
    return;
  }

  if (request.method === "POST" && path === "/api/telegram/mtproto/confirm") {
    const body = await readBody(request);
    try {
      const result = await confirmAuth({
        tempId: String(body.tempId || ""),
        code: String(body.code || ""),
        password: body.password ? String(body.password) : undefined
      });
      sendJson(response, 200, { ok: true, ...result });
    } catch (e) { reportError(response, e); }
    return;
  }

  // DELETE /api/telegram/mtproto/:id
  const mtDelMatch = path.match(/^\/api\/telegram\/mtproto\/([^/]+)$/);
  if (request.method === "DELETE" && mtDelMatch) {
    try {
      await disconnectMtproto(mtDelMatch[1]);
      sendJson(response, 200, { ok: true });
    } catch (e) { reportError(response, e); }
    return;
  }

  // --- Broadcasts ---

  if (request.method === "POST" && path === "/api/telegram/broadcast") {
    const body = await readBody(request);
    try {
      const job = startBroadcast({
        accountId: body.accountId ? String(body.accountId) : undefined,
        groupId: body.groupId ? String(body.groupId) : undefined,
        messageText: String(body.messageText || ""),
        targets: Array.isArray(body.targets) ? body.targets : [],
        intervalMs: body.intervalMs,
        taskType: body.taskType,
        salesScript: body.salesScript,
        dialogScenarios: body.dialogScenarios,
        terminology: body.terminology,
        typingMinMs: body.typingMinMs,
        typingMaxMs: body.typingMaxMs,
        replyIgnoreMinMs: body.replyIgnoreMinMs,
        replyIgnoreMaxMs: body.replyIgnoreMaxMs,
        repeatEnabled: body.repeatEnabled,
        repeatIntervalMs: body.repeatIntervalMs
      });
      sendJson(response, 200, { ok: true, job });
    } catch (e) { reportError(response, e); }
    return;
  }

  if (request.method === "GET" && path === "/api/telegram/broadcast") {
    sendJson(response, 200, { ok: true, jobs: listBroadcasts(50) });
    return;
  }

  const bcMatch = path.match(/^\/api\/telegram\/broadcast\/([^/]+)$/);
  if (request.method === "GET" && bcMatch) {
    const job = getBroadcast(bcMatch[1]);
    if (!job) { sendJson(response, 404, { ok: false, error: "Broadcast not found" }); return; }
    sendJson(response, 200, { ok: true, job });
    return;
  }
  if (request.method === "DELETE" && bcMatch) {
    try {
      const job = cancelBroadcast(bcMatch[1]);
      sendJson(response, 200, { ok: true, job });
    } catch (e) { reportError(response, e); }
    return;
  }

  // --- Account groups ---

  if (request.method === "GET" && path === "/api/telegram/groups") {
    const groups = listGroups().map((g) => ({
      ...g,
      members: listGroupMembers(g.id).map((m) => ({
        id: m.id,
        kind: m.kind,
        username: m.username,
        phone: m.phone,
        status: m.status,
        position: m.position,
      })),
    }));
    sendJson(response, 200, { ok: true, groups });
    return;
  }

  if (request.method === "POST" && path === "/api/telegram/groups") {
    const body = await readBody(request);
    try {
      const group = createGroup({ name: body.name, groupPrompt: body.groupPrompt });
      sendJson(response, 200, { ok: true, group });
    } catch (e) { reportError(response, e); }
    return;
  }

  const groupMatch = path.match(/^\/api\/telegram\/groups\/([^/]+)$/);
  if (request.method === "GET" && groupMatch) {
    const group = getGroup(groupMatch[1]);
    if (!group) { sendJson(response, 404, { ok: false, error: "Group not found" }); return; }
    sendJson(response, 200, {
      ok: true,
      group: { ...group, members: listGroupMembers(group.id) },
    });
    return;
  }
  if (request.method === "PATCH" && groupMatch) {
    const body = await readBody(request);
    const group = updateGroup(groupMatch[1], {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.groupPrompt !== undefined ? { groupPrompt: body.groupPrompt } : {}),
    });
    if (!group) { sendJson(response, 404, { ok: false, error: "Group not found" }); return; }
    sendJson(response, 200, { ok: true, group });
    return;
  }
  if (request.method === "DELETE" && groupMatch) {
    deleteGroup(groupMatch[1]);
    sendJson(response, 200, { ok: true });
    return;
  }

  // POST /api/telegram/groups/:id/members → { accountId }
  const groupMembersMatch = path.match(/^\/api\/telegram\/groups\/([^/]+)\/members$/);
  if (request.method === "POST" && groupMembersMatch) {
    const body = await readBody(request);
    const accountId = String(body.accountId || "").trim();
    if (!accountId) { sendJson(response, 422, { ok: false, error: "accountId required" }); return; }
    if (!getGroup(groupMembersMatch[1])) { sendJson(response, 404, { ok: false, error: "Group not found" }); return; }
    const members = addGroupMember(groupMembersMatch[1], accountId);
    sendJson(response, 200, { ok: true, members });
    return;
  }

  // DELETE /api/telegram/groups/:id/members/:accountId
  const groupMemberMatch = path.match(/^\/api\/telegram\/groups\/([^/]+)\/members\/([^/]+)$/);
  if (request.method === "DELETE" && groupMemberMatch) {
    const members = removeGroupMember(groupMemberMatch[1], groupMemberMatch[2]);
    sendJson(response, 200, { ok: true, members });
    return;
  }

  // GET /api/telegram/broadcast/:id/threads — conversation threads tied to
  // this broadcast, with the last few messages each.
  const bcThreadsMatch = path.match(/^\/api\/telegram\/broadcast\/([^/]+)\/threads$/);
  if (request.method === "GET" && bcThreadsMatch) {
    const broadcastId = bcThreadsMatch[1];
    const threads = listThreadsByBroadcast(broadcastId, 200).map((t) => ({
      id: t.id,
      accountId: t.account_id,
      broadcastId: t.broadcast_id,
      targetUsername: t.target_username,
      targetTelegramId: t.target_telegram_id,
      state: t.state,
      inboundCount: t.inbound_count,
      outboundCount: t.outbound_count,
      lastInboundAt: t.last_inbound_at,
      lastOutboundAt: t.last_outbound_at,
      nextActionAt: t.next_action_at,
      nextActionType: t.next_action_type,
      messages: getThreadHistory(t.id, 30),
    }));
    sendJson(response, 200, { ok: true, threads });
    return;
  }

  // --- Existing endpoints (now backed by db where applicable) ---

  if (request.method === "POST" && path === "/api/account-settings") {
    const body = await readBody(request);
    const account = getAccount(body.accountId);
    if (!account) { sendJson(response, 404, { ok: false, error: "Аккаунт не найден" }); return; }
    const timer = resolveTimerProfile(body.timerProfile || account.timerProfile);
    const policy = validateAutomationPolicy({
      replyDelaySeconds: timer.replyDelaySeconds,
      typingSeconds: 5,
      workingHoursPerDay: body.workingHoursPerDay || account.workingHoursPerDay || 6,
      outreachMode: "opt_in"
    });
    if (!policy.ok) { sendJson(response, 422, { ok: false, errors: policy.errors }); return; }
    const updated = updateAccountSettings(body.accountId, {
      salesSkill: body.salesSkill || account.salesSkill || "first_contact",
      timerProfile: body.timerProfile || account.timerProfile || "wait_60s",
      promptText: body.promptText ?? account.promptText ?? "",
      replyDelaySeconds: timer.replyDelaySeconds,
      repeatIntervalMinutes: timer.repeatIntervalMinutes,
      typingSeconds: 5,
      workingHoursPerDay: Number(body.workingHoursPerDay || account.workingHoursPerDay || 6),
      databaseId: body.databaseId ?? account.databaseId
    });
    sendJson(response, 200, { ok: true, account: updated });
    return;
  }

  if (request.method === "POST" && path === "/api/imports") {
    const body = await readBody(request);
    const contacts = parseTelegramContacts({
      contacts: body.contacts || body.csv || "",
      fileBase64: body.fileBase64 || "",
      filename: body.filename || "telegram-contacts.txt"
    });
    const id = `db-${Date.now()}`;
    const item = insertDatabase({
      id,
      filename: body.filename || "telegram-contacts.txt",
      total: contacts.total,
      valid: contacts.valid,
      rejected: contacts.rejected,
      sample: contacts.sample,
      contacts: contacts.contacts
    });
    if (body.accountId) {
      updateAccountSettings(body.accountId, { databaseId: id });
    }
    sendJson(response, 201, { ok: true, import: item });
    return;
  }

  if (request.method === "POST" && path === "/api/leads/comment") {
    const body = await readBody(request);
    const lead = updateLeadComment(body.leadId, body.comment || "");
    if (!lead) { sendJson(response, 404, { ok: false, error: "Сделка не найдена" }); return; }
    sendJson(response, 200, { ok: true, lead });
    return;
  }

  if (request.method === "POST" && path === "/api/ai-summary") {
    const user = getSessionUser(request);
    const limit = checkAiRateLimit(user);
    if (!limit.ok) { sendJson(response, 429, { ok: false, error: limit.error }); return; }
    const body = await readBody(request);
    const account = getAccount(body.accountId);
    if (!account) { sendJson(response, 404, { ok: false, error: "Аккаунт не найден" }); return; }
    const snap = getSnapshot();
    const leads = snap.leads.filter((lead) => lead.accountId === account.id);
    const answered = leads.filter((lead) => lead.lastReplyAt).length;
    const summary = `${account.id}: ${leads.length} сделок, ${answered} с ответом. ${leads.map((l) => `${l.telegram} - ${l.status}`).join(" ")}`;
    sendJson(response, 200, { ok: true, summary, question: body.question || "" });
    return;
  }

  if (request.method === "POST" && path === "/api/ai/hold-summary") {
    const user = getSessionUser(request);
    const limit = checkAiRateLimit(user);
    if (!limit.ok) { sendJson(response, 429, { ok: false, error: limit.error }); return; }
    sendJson(response, 200, { ok: true, summary: buildHoldSummary() });
    return;
  }

  if (request.method === "POST" && path === "/api/ai/chat") {
    const user = getSessionUser(request);
    const limit = checkAiRateLimit(user);
    if (!limit.ok) { sendJson(response, 429, { ok: false, error: limit.error }); return; }
    const body = await readBody(request);
    const question = String(body.question || "").trim();
    const accountId = String(body.accountId || "").trim();
    const account = accountId ? getAccount(accountId) : null;
    const snap = getSnapshot();
    const leads = account ? snap.leads.filter((lead) => lead.accountId === account.id) : snap.leads;
    const hold = leads.filter((l) => l.stageId === "stage-hold").length;
    const answered = leads.filter((l) => l.lastReplyAt).length;
    const answer = `Системный ответ: ${account ? `${account.id} / ${account.name}` : "все аккаунты"}: ${leads.length} сделок, ${answered} ответов, ${hold} hold. Запрос: ${question || "без уточнения"}.`;
    sendJson(response, 200, { ok: true, answer });
    return;
  }

  sendJson(response, 404, { ok: false, error: "API endpoint not found" });
}

async function handleStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = normalize(join(publicDir, pathname));

  if (!safePath.startsWith(publicDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const file = await readFile(safePath);
    response.writeHead(200, { "content-type": contentTypes[extname(safePath)] || "application/octet-stream" });
    response.end(file);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

export const server = http.createServer(async (request, response) => {
  try {
    if (request.url.startsWith("/api/")) {
      await handleApi(request, response);
    } else {
      await handleStatic(request, response);
    }
  } catch (error) {
    if (error instanceof BotApiError || error instanceof MtprotoError) {
      reportError(response, error);
    } else {
      sendJson(response, 500, { ok: false, error: error.message });
    }
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(port, async () => {
    console.log(`[tgbots] HTTP listening on :${port}, public=${publicBaseUrl || "(unset)"}`);
    try {
      await bootAllWorkers();
      console.log(`[tgbots] mtproto workers booted`);
    } catch (e) {
      console.error(`[tgbots] mtproto boot failed`, e?.message);
    }
    try {
      resumeRunningBroadcasts();
    } catch (e) {
      console.error(`[tgbots] broadcast resume failed`, e?.message);
    }
    // Wire mtproto inbound messages → conversation worker, then start the
    // worker ticker that drives AI replies + repeats.
    setInboundHook(handleConversationInbound);
    try {
      startConversationWorker();
    } catch (e) {
      console.error(`[tgbots] conversation worker boot failed`, e?.message);
    }
  });
}
