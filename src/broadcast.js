// Outbound broadcast worker.
// Sends a static message text to a list of @usernames from a connected MTProto
// account with a configurable interval (default = 10 min). State is persisted
// in the broadcast_jobs SQLite table so jobs survive restarts.

import { randomBytes } from "node:crypto";

import {
  insertBroadcastJob,
  getBroadcastJob,
  listBroadcastJobs,
  listActiveBroadcastJobs,
  updateBroadcastJob,
  markBroadcastFinished,
  listGroupConnectedMtprotoAccountIds,
  getGroup,
  detectLeadLanguage
} from "./db.js";
import { sendDirectMessage } from "./telegram-mtproto.js";
import { registerOutboundSend } from "./conversation.js";
import { defaultOpenerFor } from "./ai.js";

// jobId -> NodeJS Timer
const runningTimers = new Map();

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes — quiet pace

export class BroadcastError extends Error {
  constructor(message, statusCode = 422) {
    super(message);
    this.statusCode = statusCode;
  }
}

function normaliseTargets(input) {
  if (!Array.isArray(input)) {
    throw new BroadcastError("targets must be an array");
  }
  const out = [];
  for (const raw of input) {
    const cleaned = String(raw || "").trim().replace(/^@/, "");
    if (!cleaned) continue;
    if (cleaned.length > 64) continue;
    out.push({ target: cleaned, status: "pending" });
  }
  if (out.length === 0) {
    throw new BroadcastError("No valid targets (expecting @usernames)");
  }
  return out;
}

const ALLOWED_TASK_TYPES = new Set(["ping", "cold", "warm"]);

function clampPositive(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function startBroadcast({
  accountId,
  groupId,
  messageText,
  targets,
  intervalMs,
  taskType,
  salesScript,
  dialogScenarios,
  terminology,
  typingMinMs,
  typingMaxMs,
  replyIgnoreMinMs,
  replyIgnoreMaxMs,
  repeatEnabled,
  repeatIntervalMs
}) {
  // Either a single MTProto account or a group of them must be supplied. When
  // a group is supplied we still pin one of its members on the broadcast row
  // (the first one) so legacy single-account code paths keep working.
  let resolvedAccountId = accountId;
  if (groupId) {
    if (!getGroup(groupId)) throw new BroadcastError("Group not found", 404);
    const ids = listGroupConnectedMtprotoAccountIds(groupId);
    if (ids.length === 0) {
      throw new BroadcastError("Group has no connected MTProto accounts");
    }
    resolvedAccountId = ids[0];
  }
  if (!resolvedAccountId) throw new BroadcastError("accountId or groupId required");
  if (!messageText || !String(messageText).trim()) {
    throw new BroadcastError("messageText required");
  }
  const interval = clampPositive(intervalMs, DEFAULT_INTERVAL_MS, 30_000, 24 * 60 * 60 * 1000);
  const tType = ALLOWED_TASK_TYPES.has(String(taskType || "")) ? String(taskType) : "cold";
  const typingMin = clampPositive(typingMinMs, 5_000, 0, 60_000);
  const typingMaxRaw = clampPositive(typingMaxMs, 10_000, typingMin, 60_000);
  const replyMin = clampPositive(replyIgnoreMinMs, 60_000, 0, 30 * 60 * 1000);
  const replyMaxRaw = clampPositive(replyIgnoreMaxMs, 120_000, replyMin, 30 * 60 * 1000);
  const norm = normaliseTargets(targets);
  const id = `bc-${randomBytes(8).toString("hex")}`;
  insertBroadcastJob({
    id,
    accountId: resolvedAccountId,
    groupId: groupId || null,
    messageText: String(messageText),
    intervalMs: interval,
    targets: norm,
    status: "running",
    createdAt: Date.now(),
    startedAt: Date.now(),
    taskType: tType,
    salesScript: String(salesScript || ""),
    dialogScenarios: String(dialogScenarios || ""),
    terminology: String(terminology || ""),
    typingMinMs: typingMin,
    typingMaxMs: typingMaxRaw,
    replyIgnoreMinMs: replyMin,
    replyIgnoreMaxMs: replyMaxRaw,
    repeatEnabled: Boolean(repeatEnabled),
    repeatIntervalMs: clampPositive(repeatIntervalMs, 0, 0, 30 * 24 * 60 * 60 * 1000)
  });
  // Send first one immediately, then schedule the rest at the configured pace.
  schedule(id, 0);
  return getBroadcastJob(id);
}

export function cancelBroadcast(id) {
  const job = getBroadcastJob(id);
  if (!job) throw new BroadcastError("Broadcast not found", 404);
  const handle = runningTimers.get(id);
  if (handle) clearTimeout(handle);
  runningTimers.delete(id);
  if (job.status === "running") {
    markBroadcastFinished(id, "cancelled");
  }
  return getBroadcastJob(id);
}

function schedule(jobId, delayMs) {
  const handle = setTimeout(() => {
    processOne(jobId).catch((err) => {
      console.error("[broadcast] processOne fatal", jobId, err?.message || err);
    });
  }, Math.max(0, delayMs));
  // unref so the timer doesn't hold the process alive on shutdown
  if (typeof handle.unref === "function") handle.unref();
  runningTimers.set(jobId, handle);
}

async function processOne(jobId) {
  const job = getBroadcastJob(jobId);
  if (!job || job.status !== "running") {
    runningTimers.delete(jobId);
    return;
  }
  const targets = JSON.parse(job.targets_json);
  if (job.cursor >= targets.length) {
    markBroadcastFinished(jobId, "done");
    runningTimers.delete(jobId);
    return;
  }
  const idx = job.cursor;
  const entry = targets[idx];

  const updates = { cursor: idx + 1 };
  // Pick the sender account: group → round-robin by cursor, else fall back
  // to the broadcast row's pinned account_id.
  let senderAccountId = job.account_id;
  if (job.group_id) {
    const ids = listGroupConnectedMtprotoAccountIds(job.group_id);
    if (ids.length > 0) {
      senderAccountId = ids[idx % ids.length];
    }
  }
  // Resolve the actual anchor text. Operator-supplied `message_text` always
  // wins. When it's empty AND the task is a cold opener, fall back to the
  // locale-correct default opener (spec: bot-sales-conversation).
  let anchorText = job.message_text;
  if ((!anchorText || !anchorText.trim()) && (job.task_type === "cold" || !job.task_type)) {
    const lang = detectLeadLanguage({ username: entry.target }) || "en";
    anchorText = defaultOpenerFor(lang) || "";
  }

  try {
    const sendResult = await sendDirectMessage(senderAccountId, entry.target, anchorText, {
      typingMinMs: job.typing_min_ms,
      typingMaxMs: job.typing_max_ms
    });
    entry.status = "sent";
    entry.sentAt = Date.now();
    entry.senderAccountId = senderAccountId;
    if (sendResult?.messageId) entry.messageId = sendResult.messageId;
    updates.sent_count = job.sent_count + 1;
    console.log(`[broadcast] ${jobId} sent to @${entry.target} via ${senderAccountId} (${idx + 1}/${targets.length})`);
    // Materialise a conversation thread so the worker can attach replies
    // and schedule repeats. Errors here must not block the broadcast.
    try {
      registerOutboundSend({
        accountId: senderAccountId,
        broadcastId: job.id,
        targetUsername: entry.target,
        messageText: anchorText,
        messageId: sendResult?.messageId,
        repeatEnabled: Boolean(job.repeat_enabled),
        repeatIntervalMs: Number(job.repeat_interval_ms) || 0,
      });
    } catch (e) {
      console.warn(`[broadcast] registerOutboundSend failed for ${entry.target}: ${e?.message || e}`);
    }
  } catch (err) {
    entry.status = "failed";
    entry.error = String(err?.message || err).slice(0, 240);
    updates.failed_count = job.failed_count + 1;
    updates.last_error = entry.error;
    console.error(`[broadcast] ${jobId} failed @${entry.target}: ${entry.error}`);
  }
  updates.targets_json = JSON.stringify(targets);
  updateBroadcastJob(jobId, updates);

  // Schedule next or finalise.
  const fresh = getBroadcastJob(jobId);
  if (!fresh || fresh.status !== "running") {
    runningTimers.delete(jobId);
    return;
  }
  if (fresh.cursor >= targets.length) {
    markBroadcastFinished(jobId, "done");
    runningTimers.delete(jobId);
  } else {
    schedule(jobId, fresh.interval_ms);
  }
}

export function listBroadcasts(limit = 20) {
  return listBroadcastJobs(limit);
}

export function getBroadcast(id) {
  return getBroadcastJob(id);
}

/** Resume any "running" jobs from DB after process boot. */
export function resumeRunningBroadcasts() {
  for (const job of listActiveBroadcastJobs()) {
    if (runningTimers.has(job.id)) continue;
    // Resume after a small grace period so MTProto clients have time to attach.
    schedule(job.id, 5_000);
    console.log(`[broadcast] resumed ${job.id} (${job.sent_count + job.failed_count}/${JSON.parse(job.targets_json).length})`);
  }
}
