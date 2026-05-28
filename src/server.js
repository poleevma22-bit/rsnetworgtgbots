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
  addGroupMember, removeGroupMember, listGroupMembers,
  listPromptTemplates, getPromptTemplate, createPromptTemplate,
  updatePromptTemplate, deletePromptTemplate, bindGroupTemplate,
  extractTemplateVariables,
  listGroupAttachments, addGroupAttachment, removeGroupAttachment,
  setLeadManualStage, syncLeadFromThread,
  setThreadClientBrand,
  resolveGroupPromptWithBreakdown,
  resolveGroupPrompt,
  countMessagesByDirection, countMessagesContaining, countOfferSentThreads,
  getMtprotoAccountsWithSessionAge,
  createTestThread, appendThreadMessage,
  resolveThreadLanguage,
} from "./db.js";
import { execSync } from "node:child_process";
import { lintReply } from "./prompt-linter.js";
import { generateSalesReply } from "./ai.js";

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
      let group = createGroup({
        name: body.name,
        groupPrompt: body.groupPrompt,
        salesPersona: body.salesPersona,
        productPitch: body.productPitch,
        technicalPrompt: body.technicalPrompt,
        qualificationQuestions: body.qualificationQuestions,
      });
      // Settings that aren't part of createGroup's signature (escalation,
      // offer, etc.) flow through the same update path.
      const followups = {
        ...(body.escalationUsername !== undefined ? { escalationUsername: body.escalationUsername } : {}),
        ...(body.knowledgeBase !== undefined ? { knowledgeBase: body.knowledgeBase } : {}),
        ...(body.offerMessage !== undefined ? { offerMessage: body.offerMessage } : {}),
        ...(body.objections !== undefined ? { objections: body.objections } : {}),
        ...(body.offerLink !== undefined ? { offerLink: body.offerLink } : {}),
      };
      if (Object.keys(followups).length > 0) {
        group = updateGroup(group.id, followups);
      }
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
      ...(body.escalationUsername !== undefined ? { escalationUsername: body.escalationUsername } : {}),
      ...(body.knowledgeBase !== undefined ? { knowledgeBase: body.knowledgeBase } : {}),
      ...(body.offerMessage !== undefined ? { offerMessage: body.offerMessage } : {}),
      ...(body.objections !== undefined ? { objections: body.objections } : {}),
      ...(body.offerLink !== undefined ? { offerLink: body.offerLink } : {}),
      ...(body.salesPersona !== undefined ? { salesPersona: body.salesPersona } : {}),
      ...(body.productPitch !== undefined ? { productPitch: body.productPitch } : {}),
      ...(body.technicalPrompt !== undefined ? { technicalPrompt: body.technicalPrompt } : {}),
      ...(body.qualificationQuestions !== undefined ? { qualificationQuestions: body.qualificationQuestions } : {}),
    });
    if (!group) { sendJson(response, 404, { ok: false, error: "Group not found" }); return; }
    sendJson(response, 200, { ok: true, group });
    return;
  }

  // POST /api/groups/:id/preview → { assembled, sections } — used by the
  // admin "Собранный системный промпт" preview panel.
  const groupPreviewMatch = path.match(/^\/api\/groups\/([^/]+)\/preview$/);
  if (request.method === "POST" && groupPreviewMatch) {
    const group = getGroup(groupPreviewMatch[1]);
    if (!group) { sendJson(response, 404, { ok: false, error: "Group not found" }); return; }
    const { assembled, sections } = resolveGroupPromptWithBreakdown(group);
    sendJson(response, 200, { ok: true, assembled, sections });
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

  // --- Prompt templates ---

  if (request.method === "GET" && path === "/api/telegram/templates") {
    sendJson(response, 200, { ok: true, templates: listPromptTemplates() });
    return;
  }

  if (request.method === "POST" && path === "/api/telegram/templates") {
    const body = await readBody(request);
    if (!String(body.name || "").trim()) { sendJson(response, 422, { ok: false, error: "Введите название шаблона." }); return; }
    try {
      const tpl = createPromptTemplate({
        name: body.name,
        description: body.description || "",
        body: body.body || "",
        defaults: body.defaults || {},
      });
      sendJson(response, 200, { ok: true, template: tpl });
    } catch (e) { reportError(response, e); }
    return;
  }

  // POST /api/telegram/templates/preview — extract {{vars}} from a body
  // without persisting anything. Used by the editor to live-render the chip row.
  if (request.method === "POST" && path === "/api/telegram/templates/preview") {
    const body = await readBody(request);
    const variables = extractTemplateVariables(body.body || "");
    sendJson(response, 200, { ok: true, variables });
    return;
  }

  const templateMatch = path.match(/^\/api\/telegram\/templates\/([^/]+)$/);
  if (request.method === "GET" && templateMatch) {
    const tpl = getPromptTemplate(templateMatch[1]);
    if (!tpl) { sendJson(response, 404, { ok: false, error: "Шаблон не найден" }); return; }
    sendJson(response, 200, { ok: true, template: tpl });
    return;
  }
  if (request.method === "PATCH" && templateMatch) {
    const body = await readBody(request);
    const tpl = updatePromptTemplate(templateMatch[1], {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.body !== undefined ? { body: body.body } : {}),
      ...(body.defaults !== undefined ? { defaults: body.defaults } : {}),
    });
    if (!tpl) { sendJson(response, 404, { ok: false, error: "Шаблон не найден" }); return; }
    sendJson(response, 200, { ok: true, template: tpl });
    return;
  }
  if (request.method === "DELETE" && templateMatch) {
    deletePromptTemplate(templateMatch[1]);
    sendJson(response, 200, { ok: true });
    return;
  }

  // POST /api/telegram/groups/:id/template — bind/unbind template + vars.
  // Body: { templateId: string|null, variables?: { var_name: value, ... } }
  const groupTemplateMatch = path.match(/^\/api\/telegram\/groups\/([^/]+)\/template$/);
  if (request.method === "POST" && groupTemplateMatch) {
    const body = await readBody(request);
    if (!getGroup(groupTemplateMatch[1])) { sendJson(response, 404, { ok: false, error: "Group not found" }); return; }
    if (body.templateId && !getPromptTemplate(body.templateId)) {
      sendJson(response, 422, { ok: false, error: "templateId не существует" });
      return;
    }
    const group = bindGroupTemplate(groupTemplateMatch[1], {
      templateId: body.templateId || null,
      variables: body.variables || {},
    });
    sendJson(response, 200, { ok: true, group });
    return;
  }

  // --- Offer attachments (PNG/JPEG/PDF/PPTX uploaded via base64-in-JSON) ---

  const groupAttListMatch = path.match(/^\/api\/telegram\/groups\/([^/]+)\/attachments$/);
  if (request.method === "GET" && groupAttListMatch) {
    if (!getGroup(groupAttListMatch[1])) { sendJson(response, 404, { ok: false, error: "Group not found" }); return; }
    sendJson(response, 200, {
      ok: true,
      attachments: listGroupAttachments(groupAttListMatch[1]).map(({ storedPath, ...rest }) => rest),
    });
    return;
  }

  if (request.method === "POST" && groupAttListMatch) {
    const groupId = groupAttListMatch[1];
    if (!getGroup(groupId)) { sendJson(response, 404, { ok: false, error: "Group not found" }); return; }
    const body = await readBody(request);
    const filename = String(body.filename || "").trim();
    const mime = String(body.mime || "application/octet-stream").trim();
    const contentBase64 = String(body.contentBase64 || "");
    if (!filename || !contentBase64) {
      sendJson(response, 422, { ok: false, error: "filename + contentBase64 required" });
      return;
    }
    // Allowlist of mime types the UI advertises.
    const ALLOWED = /^(image\/(png|jpeg|gif|webp)|application\/(pdf|vnd\.openxmlformats-officedocument\.presentationml\.presentation|vnd\.ms-powerpoint))$/;
    if (!ALLOWED.test(mime)) {
      sendJson(response, 422, { ok: false, error: `Mime ${mime} не поддерживается (только PNG/JPEG/GIF/WEBP/PDF/PPT/PPTX)` });
      return;
    }
    const buf = Buffer.from(contentBase64, "base64");
    if (buf.length > 20 * 1024 * 1024) {
      sendJson(response, 422, { ok: false, error: "Файл больше 20 MB" });
      return;
    }
    // Store on disk under data/attachments/{groupId}/{ts}-{safeName}.
    const { mkdirSync: mkdir, writeFileSync } = await import("node:fs");
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
    const dir = join(dataDir, "attachments", groupId);
    mkdir(dir, { recursive: true });
    const storedPath = join(dir, `${Date.now()}-${safeName}`);
    writeFileSync(storedPath, buf);
    const attachments = addGroupAttachment(groupId, { filename, mime, storedPath, size: buf.length });
    sendJson(response, 200, { ok: true, attachments: attachments.map(({ storedPath: _sp, ...rest }) => rest) });
    return;
  }

  const groupAttItemMatch = path.match(/^\/api\/telegram\/groups\/([^/]+)\/attachments\/([^/]+)$/);
  if (request.method === "DELETE" && groupAttItemMatch) {
    const [_, groupId, attId] = groupAttItemMatch;
    if (!getGroup(groupId)) { sendJson(response, 404, { ok: false, error: "Group not found" }); return; }
    const before = listGroupAttachments(groupId).find((a) => a.id === attId);
    const attachments = removeGroupAttachment(groupId, attId);
    if (before?.storedPath) {
      try {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(before.storedPath);
      } catch (err) { console.warn(`[attachment] could not unlink ${before.storedPath}: ${err?.message}`); }
    }
    sendJson(response, 200, { ok: true, attachments: attachments.map(({ storedPath: _sp, ...rest }) => rest) });
    return;
  }

  // --- Junk-lead cleanup (removes leads with bot-like handles + leads
  //     not backed by a real conversation_thread) ---
  if (request.method === "POST" && path === "/api/leads/cleanup") {
    const { db } = await import("./db.js");
    const junkLike = `LOWER(telegram_handle) GLOB '*bot' OR ` +
      `LOWER(telegram_handle) GLOB '@*bot' OR ` +
      `LOWER(telegram_handle) GLOB '*anonsay*' OR ` +
      `LOWER(telegram_handle) GLOB '*anonkar*' OR ` +
      `LOWER(telegram_handle) GLOB '*anonxzx*' OR ` +
      `LOWER(telegram_handle) GLOB '*ruletkaa*' OR ` +
      `LOWER(telegram_handle) GLOB '*talkme*' OR ` +
      `LOWER(telegram_handle) GLOB '*tikible*' OR ` +
      `LOWER(telegram_handle) GLOB '*ttsave*'`;
    const r1 = db.prepare(`DELETE FROM leads WHERE ${junkLike}`).run();
    // Also drop leads not anchored to a thread (legacy demo rows).
    const r2 = db.prepare(`DELETE FROM leads WHERE chat_id NOT IN (SELECT id FROM conversation_threads)`).run();
    sendJson(response, 200, { ok: true, removed: { junk: r1.changes, orphan: r2.changes } });
    return;
  }

  // --- Manual CRM stage flip (operator override on a lead/thread) ---
  // POST /api/leads/stage  body: { threadId, stageId, clientBrand? }
  //   stageId=""     → clear manual override (resume auto-classification)
  //   clientBrand="" → clear brand (resume auto-infer from username)
  if (request.method === "POST" && path === "/api/leads/stage") {
    const body = await readBody(request);
    const threadId = String(body.threadId || "").trim();
    const stageId = String(body.stageId || "").trim() || null;
    if (!threadId) { sendJson(response, 422, { ok: false, error: "threadId required" }); return; }
    setLeadManualStage(threadId, stageId);
    if (body.clientBrand !== undefined) {
      setThreadClientBrand(threadId, String(body.clientBrand).trim() || null);
    }
    sendJson(response, 200, { ok: true });
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
    // Per-account overrides for AI reply latency + typing simulation. Used
    // to drop Sunsh5151 to a 10s reply window for end-to-end testing
    // without inventing a new timer profile. If absent → fall back to the
    // categorical timer profile (legacy behaviour).
    const explicitReplyDelay = body.replyDelay != null && String(body.replyDelay).trim() !== ""
      ? Math.max(0, Math.floor(Number(body.replyDelay)))
      : null;
    const effectiveReplyDelaySeconds = explicitReplyDelay != null && Number.isFinite(explicitReplyDelay)
      ? explicitReplyDelay
      : timer.replyDelaySeconds;
    const explicitTypingSeconds = body.typingSeconds != null && String(body.typingSeconds).trim() !== ""
      ? Math.max(0, Math.floor(Number(body.typingSeconds)))
      : null;
    const effectiveTypingSeconds = explicitTypingSeconds ?? account.typingSeconds ?? 5;
    const policy = validateAutomationPolicy({
      replyDelaySeconds: effectiveReplyDelaySeconds,
      typingSeconds: effectiveTypingSeconds,
      workingHoursPerDay: body.workingHoursPerDay || account.workingHoursPerDay || 6,
      outreachMode: "opt_in"
    });
    if (!policy.ok) { sendJson(response, 422, { ok: false, errors: policy.errors }); return; }
    const updated = updateAccountSettings(body.accountId, {
      salesSkill: body.salesSkill || account.salesSkill || "first_contact",
      timerProfile: body.timerProfile || account.timerProfile || "wait_60s",
      promptText: body.promptText ?? account.promptText ?? "",
      replyDelaySeconds: effectiveReplyDelaySeconds,
      repeatIntervalMinutes: timer.repeatIntervalMinutes,
      typingSeconds: effectiveTypingSeconds,
      // aiEnabled defaults to true; only flip when caller passes a value.
      aiEnabled: body.aiEnabled === undefined
        ? (account.aiEnabled !== false)
        : Boolean(body.aiEnabled),
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

  // GET /api/health/snapshot → operational overview for the admin dashboard.
  if (request.method === "GET" && path === "/api/health/snapshot") {
    try {
      const snap = await buildHealthSnapshot();
      sendJson(response, 200, snap);
    } catch (e) { reportError(response, e); }
    return;
  }

  // POST /api/health/check → active liveness probe (SQLite + mtproto + OpenRouter).
  if (request.method === "POST" && path === "/api/health/check") {
    try {
      const result = await runHealthCheck();
      sendJson(response, 200, result);
    } catch (e) { reportError(response, e); }
    return;
  }

  // POST /api/playground/run → run a hypothetical inbound through the full
  // reply pipeline without touching real Telegram.
  if (request.method === "POST" && path === "/api/playground/run") {
    const body = await readBody(request);
    try {
      const result = await runPlayground({
        groupId: String(body.groupId || "").trim(),
        accountId: String(body.accountId || "").trim(),
        inboundText: String(body.inboundText || "").trim(),
      });
      sendJson(response, result.status, result.payload);
    } catch (e) { reportError(response, e); }
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
    const ext = extname(safePath);
    const headers = { "content-type": contentTypes[ext] || "application/octet-stream" };
    // index.html (or any directly-served HTML) must always be fresh so the
    // page never points at stale `app.js?v=...` references. JS/CSS get long
    // cache since they're versioned via ?v=YYYYMMDD-N query string.
    if (ext === ".html" || pathname === "/" || pathname === "/index.html") {
      headers["cache-control"] = "no-store, must-revalidate";
      headers.pragma = "no-cache";
      headers.expires = "0";
    } else if (ext === ".js" || ext === ".css") {
      headers["cache-control"] = "public, max-age=300";
    }
    response.writeHead(200, headers);
    response.end(file);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

// --- Health snapshot + checks ---

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function readPm2Tail(lines = 50) {
  // Defensive: pm2 might not be on PATH for the user the bot runs as, and
  // the log file format may change. Catch everything; return [] on failure.
  try {
    const raw = execSync(`pm2 logs tg-bots --nostream --lines ${lines} --raw 2>&1`, {
      encoding: "utf8",
      timeout: 4000,
      maxBuffer: 1024 * 1024,
    });
    // Reverse so newest is at top. Trim noise lines (pm2 banner) by skipping
    // empty lines and the "/root/.pm2/logs/..." headers.
    return raw.split("\n")
      .filter((l) => l && !l.startsWith("/root/.pm2/logs/") && !l.startsWith("[PM2]"))
      .slice(-lines)
      .reverse()
      .map((text) => {
        let level = "info";
        if (/error|fail|crash|❌/i.test(text)) level = "error";
        else if (/warn|⚠️/i.test(text)) level = "warn";
        // Approximate timestamp from current time — pm2 raw output doesn't
        // reliably timestamp lines, so we punt and let the UI display "now".
        return { ts: new Date().toISOString(), level, text };
      });
  } catch {
    return null; // signal failure to caller
  }
}

async function buildHealthSnapshot() {
  const nowMs = Date.now();
  const since = nowMs - ONE_DAY_MS;

  const accounts = getMtprotoAccountsWithSessionAge();

  const inbound24h = countMessagesByDirection({ sinceMs: since, direction: "in" });
  const outbound24h = countMessagesByDirection({ sinceMs: since, direction: "out" });
  const escalations24h = countMessagesContaining({ sinceMs: since, needle: "[[ESCALATE", direction: "out" });
  const offerSent24h = countOfferSentThreads({ sinceMs: since });

  let lintRepetition = 0, lintContradiction = 0, openrouterErrors = 0;
  const tailMaybe = readPm2Tail(200); // wider scan for counter aggregation
  if (tailMaybe) {
    for (const entry of tailMaybe) {
      if (entry.text.includes("[lint]")) {
        if (entry.text.includes("repetition")) lintRepetition += 1;
        if (entry.text.includes("contradiction")) lintContradiction += 1;
      }
      if (/OpenRouter\s+(40\d|5\d\d|returned empty)/i.test(entry.text)) {
        openrouterErrors += 1;
      }
    }
  }

  const tail = tailMaybe ? tailMaybe.slice(0, 50) : [];

  const alerts = [];
  for (const acct of accounts) {
    if (acct.session_age_days > 25) {
      alerts.push({
        severity: "warn",
        message: `Сессия @${acct.username || acct.id} истекает через ~${Math.max(1, 30 - acct.session_age_days)} дн.`,
      });
    }
    if (acct.health === "limited" || acct.health === "down") {
      alerts.push({
        severity: "critical",
        message: `Аккаунт @${acct.username || acct.id} в состоянии ${acct.health}`,
      });
    }
  }
  if (openrouterErrors > 0) {
    alerts.push({
      severity: "critical",
      message: `OpenRouter вернул ${openrouterErrors} ошибок за 24ч, проверь ключ и лимиты`,
    });
  }
  // Zero-escalations during business hours (MSK 09:00-18:00, Mon-Fri).
  const nowMsk = new Date(nowMs + 3 * 60 * 60 * 1000); // UTC → MSK
  const hour = nowMsk.getUTCHours();
  const dow = nowMsk.getUTCDay(); // 0=Sun
  const inBusinessHours = dow >= 1 && dow <= 5 && hour >= 9 && hour < 18;
  if (inBusinessHours && escalations24h === 0 && inbound24h > 5) {
    alerts.push({
      severity: "warn",
      message: `За день ${inbound24h} входящих, ноль эскалаций, проверь промпт`,
    });
  }
  if (!tailMaybe) {
    alerts.push({ severity: "warn", message: "Log tail unavailable" });
  }
  alerts.sort((a, b) => (a.severity === "critical" ? -1 : 1) - (b.severity === "critical" ? -1 : 1));

  return {
    accounts,
    counters_24h: {
      inbound: inbound24h,
      outbound: outbound24h,
      escalations: escalations24h,
      offer_sent: offerSent24h,
      lint_findings: { repetition: lintRepetition, contradiction: lintContradiction },
      openrouter_errors: openrouterErrors,
    },
    tail,
    alerts,
  };
}

async function runHealthCheck() {
  const checks = [];
  // 1. SQLite
  const t1 = Date.now();
  try {
    // Cheap query through an existing exported path.
    listGroups();
    checks.push({ name: "sqlite", ok: true, ms: Date.now() - t1 });
  } catch (e) {
    checks.push({ name: "sqlite", ok: false, ms: Date.now() - t1, error: e?.message || String(e) });
  }
  // 2. Each mtproto session (probe via the existing mtproto module; we don't
  // have a direct authorization probe exposed, so we approximate by checking
  // the bot row's health was recently 'ok'.)
  for (const acct of getMtprotoAccountsWithSessionAge()) {
    checks.push({
      name: `mtproto:${acct.id}`,
      ok: acct.health === "ok",
      ms: 0,
      ...(acct.health === "ok" ? {} : { error: `health=${acct.health}` }),
    });
  }
  // 3. OpenRouter tiny test
  const t3 = Date.now();
  try {
    const apiKey = process.env.OPENROUTER_API_KEY || "";
    if (!apiKey) {
      checks.push({ name: "openrouter", ok: false, ms: 0, error: "OPENROUTER_API_KEY not set" });
    } else {
      const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 5,
        }),
      });
      if (resp.ok) {
        checks.push({ name: "openrouter", ok: true, ms: Date.now() - t3 });
      } else {
        const txt = await resp.text().catch(() => "");
        checks.push({
          name: "openrouter", ok: false, ms: Date.now() - t3,
          error: `HTTP ${resp.status}: ${txt.slice(0, 120)}`,
        });
      }
    }
  } catch (e) {
    checks.push({ name: "openrouter", ok: false, ms: Date.now() - t3, error: e?.message || String(e) });
  }
  const failed = checks.filter((c) => !c.ok).length;
  return {
    ok: failed === 0,
    checks,
    summary: failed === 0 ? "All checks passed" : `${failed} of ${checks.length} checks failed`,
  };
}

// --- Playground ---

async function runPlayground({ groupId, accountId, inboundText }) {
  if (!accountId) return { status: 400, payload: { ok: false, error: "Account not found" } };
  const account = getAccount(accountId);
  if (!account) return { status: 400, payload: { ok: false, error: "Account not found" } };
  if (!groupId) return { status: 400, payload: { ok: false, error: "groupId required" } };
  const group = getGroup(groupId);
  if (!group) return { status: 400, payload: { ok: false, error: "Group not found" } };
  if (!inboundText) return { status: 400, payload: { ok: false, error: "inboundText required" } };

  const thread = createTestThread({ accountId });
  appendThreadMessage({ threadId: thread.id, direction: "in", text: inboundText });
  const history = getThreadHistory(thread.id, 40);
  const language = resolveThreadLanguage(thread, history) || "ru";

  const renderedGroupPrompt = resolveGroupPrompt(group);
  const { text: rawText, model } = await generateSalesReply({
    salesScript: "",
    dialogScenarios: "",
    terminology: "",
    taskType: "cold",
    groupPrompt: renderedGroupPrompt,
    firstMessageText: "",
    history,
    language,
    locked: true,
    defaultOnly: false,
  });
  const { findings } = lintReply({ reply: rawText, history, assembledPrompt: renderedGroupPrompt });
  appendThreadMessage({ threadId: thread.id, direction: "out", text: rawText });
  return {
    status: 200,
    payload: { ok: true, reply: rawText, model, language, findings, threadId: thread.id },
  };
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
