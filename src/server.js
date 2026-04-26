import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import xlsx from "xlsx";
import { store, getSnapshot } from "./data.js";
import { validateAutomationPolicy } from "./safety.js";

const root = normalize(join(fileURLToPath(new URL(".", import.meta.url)), ".."));
const publicDir = join(root, "public");
const dataDir = join(root, "data");
const usersPath = join(dataDir, "users.json");
const port = Number(process.env.PORT || 4173);

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

const sessions = new Map();
const aiRequestLog = new Map();
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
  const holds = store.leads.filter((lead) => lead.stageId === "stage-hold");
  if (!holds.length) return "Hold пустой: зависших сделок сейчас нет.";
  return holds
    .map((lead) => {
      const account = store.accounts.find((item) => item.id === lead.accountId);
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
  return sessions.get(token) || null;
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
  return {
    configured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    publicWebhookUrl: process.env.PUBLIC_WEBHOOK_URL || "",
    hasSecret: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET),
    webhookPath: "/api/telegram/webhook"
  };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handleApi(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "GET" && url.pathname === "/api/snapshot") {
    if (!getSessionUser(request)) {
      sendJson(response, 401, { ok: false, error: "Требуется вход" });
      return;
    }
    sendJson(response, 200, getSnapshot());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/session") {
    const user = getSessionUser(request);
    sendJson(response, 200, { ok: true, authenticated: Boolean(user), user });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/register") {
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
    sessions.set(token, { id: user.id, email: user.email, role: user.role || "user" });
    response.setHeader("Set-Cookie", `rs_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
    sendJson(response, 201, { ok: true, user: { id: user.id, email: user.email, role: user.role || "user" } });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/login") {
    const body = await readBody(request);
    const email = String(body.email || "").trim().toLowerCase();
    const users = await ensureDemoAdmin();
    const user = users.find((item) => item.email === email);
    if (!user || !verifyPassword(String(body.password || ""), user.passwordHash)) {
      sendJson(response, 401, { ok: false, error: "Неверный email или пароль." });
      return;
    }

    const token = randomBytes(32).toString("hex");
    sessions.set(token, { id: user.id, email: user.email, role: user.role || "user" });
    response.setHeader("Set-Cookie", `rs_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
    sendJson(response, 200, { ok: true, user: { id: user.id, email: user.email, role: user.role || "user" } });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/logout") {
    const token = parseCookies(request.headers.cookie || "").rs_session;
    if (token) sessions.delete(token);
    response.setHeader("Set-Cookie", "rs_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/telegram/webhook") {
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (expectedSecret && request.headers["x-telegram-bot-api-secret-token"] !== expectedSecret) {
      sendJson(response, 403, { ok: false, error: "Invalid Telegram webhook secret" });
      return;
    }
    const update = await readBody(request);
    store.telegramUpdates.push({
      id: `tg-update-${Date.now()}`,
      updateId: update.update_id,
      chatId: update.message?.chat?.id,
      username: update.message?.from?.username ? `@${update.message.from.username}` : "",
      text: update.message?.text || "",
      receivedAt: new Date().toISOString()
    });
    sendJson(response, 200, { ok: true });
    return;
  }

  if (!getSessionUser(request)) {
    sendJson(response, 401, { ok: false, error: "Требуется вход" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/clients") {
    sendJson(response, 200, { ok: true, clients: store.clients });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/clients") {
    const body = await readBody(request);
    const name = String(body.name || "").trim();
    if (!name) {
      sendJson(response, 422, { ok: false, error: "Укажите название клиента." });
      return;
    }
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

  if (request.method === "GET" && url.pathname === "/api/telegram/status") {
    sendJson(response, 200, { ok: true, telegram: telegramConfig() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/telegram/set-webhook") {
    const config = telegramConfig();
    if (!config.configured || !config.publicWebhookUrl) {
      sendJson(response, 422, { ok: false, error: "Нужны TELEGRAM_BOT_TOKEN и PUBLIC_WEBHOOK_URL в env сервера." });
      return;
    }
    const webhookUrl = `${config.publicWebhookUrl.replace(/\/$/, "")}${config.webhookPath}`;
    const result = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: process.env.TELEGRAM_WEBHOOK_SECRET || undefined,
        allowed_updates: ["message"]
      })
    });
    const payload = await result.json();
    sendJson(response, result.ok ? 200 : 502, { ok: result.ok, telegram: payload, webhookUrl });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/accounts") {
    const body = await readBody(request);
    const timer = resolveTimerProfile(body.timerProfile);
    const policy = validateAutomationPolicy({
      replyDelaySeconds: body.replyDelaySeconds || timer.replyDelaySeconds,
      typingSeconds: 5,
      workingHoursPerDay: body.workingHoursPerDay || 6,
      outreachMode: "opt_in"
    });
    if (!policy.ok) {
      sendJson(response, 422, { ok: false, errors: policy.errors });
      return;
    }

    const account = {
      id: body.id || `tg-${Date.now()}`,
      name: body.name || body.id || "Telegram account",
      handle: body.handle || "",
      avatarUrl: body.avatarUrl || "",
      status: "pending",
      health: "review",
      connector: body.connector || "Telegram API app",
      databaseId: body.databaseId,
      salesSkill: body.salesSkill || "first_contact",
      timerProfile: body.timerProfile || "wait_60s",
      promptText: body.promptText || "",
      replyDelaySeconds: Number(body.replyDelaySeconds || timer.replyDelaySeconds),
      repeatIntervalMinutes: timer.repeatIntervalMinutes,
      typingSeconds: 5,
      workingHoursPerDay: Number(body.workingHoursPerDay || 6),
      messagesSent: 0
    };

    store.accounts.push(account);
    sendJson(response, 201, { ok: true, account });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/prompts") {
    const body = await readBody(request);
    const prompt = {
      id: `prompt-${Date.now()}`,
      title: body.title,
      businessCase: body.businessCase,
      messageTemplates: String(body.messageTemplates || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
      priorityRules: body.priorityRules || ""
    };
    store.prompts.push(prompt);
    sendJson(response, 201, { ok: true, prompt });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/stages") {
    const body = await readBody(request);
    const stage = { id: `stage-${Date.now()}`, title: body.title, color: body.color || "#334155" };
    store.stages.push(stage);
    sendJson(response, 201, { ok: true, stage });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/imports") {
    const body = await readBody(request);
    const contacts = parseTelegramContacts({
      contacts: body.contacts || body.csv || "",
      fileBase64: body.fileBase64 || "",
      filename: body.filename || "telegram-contacts.txt"
    });
    const item = {
      id: `db-${Date.now()}`,
      filename: body.filename || "telegram-contacts.txt",
      total: contacts.total,
      valid: contacts.valid,
      rejected: contacts.rejected,
      sample: contacts.sample,
      contacts: contacts.contacts,
      createdAt: new Date().toISOString()
    };
    store.databases.push(item);
    if (body.accountId) {
      const account = store.accounts.find((entry) => entry.id === body.accountId);
      if (account) account.databaseId = item.id;
    }
    sendJson(response, 201, { ok: true, import: item });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/bindings") {
    const body = await readBody(request);
    const account = store.accounts.find((item) => item.id === body.accountId);
    if (!account) {
      sendJson(response, 404, { ok: false, error: "Аккаунт не найден" });
      return;
    }

    account.promptId = body.promptId;
    account.databaseId = body.databaseId;
    account.scriptNote = body.scriptNote || account.scriptNote || "";
    sendJson(response, 200, { ok: true, account });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/account-settings") {
    const body = await readBody(request);
    const account = store.accounts.find((item) => item.id === body.accountId);
    if (!account) {
      sendJson(response, 404, { ok: false, error: "Аккаунт не найден" });
      return;
    }

    const timer = resolveTimerProfile(body.timerProfile || account.timerProfile);
    const policy = validateAutomationPolicy({
      replyDelaySeconds: timer.replyDelaySeconds,
      typingSeconds: 5,
      workingHoursPerDay: body.workingHoursPerDay || account.workingHoursPerDay || 6,
      outreachMode: "opt_in"
    });
    if (!policy.ok) {
      sendJson(response, 422, { ok: false, errors: policy.errors });
      return;
    }

    account.salesSkill = body.salesSkill || account.salesSkill || "first_contact";
    account.timerProfile = body.timerProfile || account.timerProfile || "wait_60s";
    account.promptText = body.promptText || "";
    account.replyDelaySeconds = timer.replyDelaySeconds;
    account.repeatIntervalMinutes = timer.repeatIntervalMinutes;
    account.typingSeconds = 5;
    account.workingHoursPerDay = Number(body.workingHoursPerDay || account.workingHoursPerDay || 6);
    sendJson(response, 200, { ok: true, account });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/leads/comment") {
    const body = await readBody(request);
    const lead = store.leads.find((item) => item.id === body.leadId);
    if (!lead) {
      sendJson(response, 404, { ok: false, error: "Сделка не найдена" });
      return;
    }

    lead.comment = body.comment || "";
    sendJson(response, 200, { ok: true, lead });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/ai-summary") {
    const user = getSessionUser(request);
    const limit = checkAiRateLimit(user);
    if (!limit.ok) {
      sendJson(response, 429, { ok: false, error: limit.error });
      return;
    }
    const body = await readBody(request);
    const account = store.accounts.find((item) => item.id === body.accountId);
    if (!account) {
      sendJson(response, 404, { ok: false, error: "Аккаунт не найден" });
      return;
    }

    const leads = store.leads.filter((lead) => lead.accountId === account.id);
    const answered = leads.filter((lead) => lead.lastReplyAt).length;
    const summary = `${account.id}: ${leads.length} сделок, ${answered} с ответом. ${leads.map((lead) => `${lead.telegram} - ${lead.status}`).join(" ")}`;
    sendJson(response, 200, { ok: true, summary, question: body.question || "" });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/ai/hold-summary") {
    const user = getSessionUser(request);
    const limit = checkAiRateLimit(user);
    if (!limit.ok) {
      sendJson(response, 429, { ok: false, error: limit.error });
      return;
    }
    sendJson(response, 200, { ok: true, summary: buildHoldSummary() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/ai/chat") {
    const user = getSessionUser(request);
    const limit = checkAiRateLimit(user);
    if (!limit.ok) {
      sendJson(response, 429, { ok: false, error: limit.error });
      return;
    }
    const body = await readBody(request);
    const question = String(body.question || "").trim();
    const accountId = String(body.accountId || "").trim();
    const account = store.accounts.find((item) => item.id === accountId);
    const leads = account ? store.leads.filter((lead) => lead.accountId === account.id) : store.leads;
    const hold = leads.filter((lead) => lead.stageId === "stage-hold").length;
    const answered = leads.filter((lead) => lead.lastReplyAt).length;
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
    sendJson(response, 500, { ok: false, error: error.message });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(port, () => {
    console.log(`Telegram CRM Console: http://localhost:${port}`);
  });
}
