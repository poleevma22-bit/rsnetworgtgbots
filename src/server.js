import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { store, getSnapshot } from "./data.js";
import { validateAutomationPolicy } from "./safety.js";

const root = normalize(join(fileURLToPath(new URL(".", import.meta.url)), ".."));
const publicDir = join(root, "public");
const port = Number(process.env.PORT || 4173);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg"
};

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function parseTelegramContacts(text = "") {
  const rows = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const validPattern = /^(@[a-zA-Z0-9_]{5,32}|https?:\/\/t\.me\/[a-zA-Z0-9_]{5,32}|t\.me\/[a-zA-Z0-9_]{5,32})$/;
  const valid = rows.filter((line) => validPattern.test(line));
  return { total: rows.length, valid: valid.length, rejected: rows.length - valid.length, sample: valid.slice(0, 5) };
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
    sendJson(response, 200, getSnapshot());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/accounts") {
    const body = await readBody(request);
    const policy = validateAutomationPolicy(body);
    if (!policy.ok) {
      sendJson(response, 422, { ok: false, errors: policy.errors });
      return;
    }

    const account = {
      id: body.id || `tg-${Date.now()}`,
      name: body.name,
      handle: body.handle,
      avatarUrl: body.avatarUrl || "",
      status: "pending",
      health: "review",
      connector: body.connector || "Telegram API app",
      promptId: body.promptId,
      databaseId: body.databaseId,
      replyDelaySeconds: Number(body.replyDelaySeconds),
      typingSeconds: Number(body.typingSeconds),
      workingHoursPerDay: Number(body.workingHoursPerDay),
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
    const contacts = parseTelegramContacts(body.contacts || body.csv || "");
    const item = {
      id: `db-${Date.now()}`,
      filename: body.filename || "telegram-contacts.txt",
      total: contacts.total,
      valid: contacts.valid,
      rejected: contacts.rejected,
      sample: contacts.sample,
      createdAt: new Date().toISOString()
    };
    store.databases.push(item);
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

    const samePromptAccounts = store.accounts.filter((item) => item.id !== account.id && item.promptId === body.promptId);
    if (samePromptAccounts.length && body.exclusiveScript === "true") {
      sendJson(response, 409, { ok: false, error: "Этот скрипт уже закреплен за другим аккаунтом." });
      return;
    }

    account.promptId = body.promptId || account.promptId;
    account.databaseId = body.databaseId || account.databaseId;
    account.scriptNote = body.scriptNote || "";
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
