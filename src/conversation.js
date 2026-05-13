// Conversation worker — drives two kinds of follow-up actions on broadcast
// threads:
//   - ai_reply: a client has written back; after the reply-ignore window
//     elapses we generate an AI response using the broadcast's sales context
//     and send it from the same MTProto account.
//   - repeat: a client never replied; after the broadcast's repeat_interval
//     we re-send the original anchor message.
//
// State lives in the conversation_threads + conversation_messages tables;
// the broadcast_jobs row supplies sales_script / dialog_scenarios /
// terminology / typing / repeat config.

import {
  getThread,
  listReadyThreads,
  scheduleThreadAction,
  clearThreadAction,
  appendThreadMessage,
  getThreadHistory,
  updateThread,
  getBroadcastJob,
  listBroadcastJobs,
  findOrCreateThread,
  getGroup,
} from "./db.js";
import { sendDirectMessage } from "./telegram-mtproto.js";
import { generateSalesReply } from "./ai.js";

const TICK_MS = 30_000;          // worker poll cadence
const REPEAT_TICK_MS = 5 * 60_000; // repeat-sweep cadence

let workerTimer = null;
let repeatTimer = null;

export function startConversationWorker() {
  if (workerTimer) return;
  workerTimer = setInterval(() => { tickReadyThreads().catch(logErr("tickReadyThreads")); }, TICK_MS);
  if (typeof workerTimer.unref === "function") workerTimer.unref();
  // Run once on boot in case threads piled up while we were down.
  setTimeout(() => { tickReadyThreads().catch(logErr("tickReadyThreads")); }, 2_000);

  repeatTimer = setInterval(() => { sweepRepeats().catch(logErr("sweepRepeats")); }, REPEAT_TICK_MS);
  if (typeof repeatTimer.unref === "function") repeatTimer.unref();
  setTimeout(() => { sweepRepeats().catch(logErr("sweepRepeats")); }, 10_000);

  console.log("[conversation] worker started (tick=30s, repeat-sweep=5min)");
}

function logErr(label) {
  return (err) => console.error(`[conversation] ${label}:`, err?.message || err);
}

async function tickReadyThreads() {
  const ready = listReadyThreads(Date.now(), 20);
  if (ready.length === 0) return;
  for (const thread of ready) {
    try {
      await processThread(thread);
    } catch (err) {
      console.error(`[conversation] processThread ${thread.id} failed:`, err?.message || err);
      // Push the next action out by 10 min to back off.
      scheduleThreadAction(thread.id, Date.now() + 10 * 60_000, thread.next_action_type, null);
    }
  }
}

async function processThread(thread) {
  const type = thread.next_action_type;
  if (type === "ai_reply") return processAiReply(thread);
  if (type === "repeat") return processRepeat(thread);
  // Unknown action — just clear so we stop polling.
  clearThreadAction(thread.id);
}

async function processAiReply(thread) {
  const broadcast = thread.broadcast_id ? getBroadcastJob(thread.broadcast_id) : null;
  const group = broadcast?.group_id ? getGroup(broadcast.group_id) : null;
  // Pull history and craft the response.
  const history = getThreadHistory(thread.id, 40);
  const { text, model } = await generateSalesReply({
    salesScript: broadcast?.sales_script || "",
    dialogScenarios: broadcast?.dialog_scenarios || "",
    terminology: broadcast?.terminology || "",
    taskType: broadcast?.task_type || "cold",
    groupPrompt: group?.group_prompt || "",
    firstMessageText: broadcast?.message_text || "",
    history,
  });
  console.log(`[conversation] ${thread.id} ai-reply via ${model}: ${text.slice(0, 80)}`);

  // Send with the same typing simulation we use for broadcasts.
  const typingMin = broadcast?.typing_min_ms ?? 5000;
  const typingMax = broadcast?.typing_max_ms ?? 10000;
  const target = thread.target_username || thread.target_telegram_id;
  if (!target) {
    clearThreadAction(thread.id);
    return;
  }
  const result = await sendDirectMessage(thread.account_id, target, text, {
    typingMinMs: typingMin,
    typingMaxMs: typingMax,
  });
  appendThreadMessage({
    threadId: thread.id,
    direction: "out",
    text,
    telegramMessageId: result?.messageId,
  });
  clearThreadAction(thread.id);
}

async function processRepeat(thread) {
  const broadcast = thread.broadcast_id ? getBroadcastJob(thread.broadcast_id) : null;
  if (!broadcast || !broadcast.repeat_enabled || !broadcast.message_text) {
    clearThreadAction(thread.id);
    return;
  }
  // Only repeat if the client has not replied at all.
  if (thread.inbound_count > 0) {
    clearThreadAction(thread.id);
    return;
  }
  const target = thread.target_username || thread.target_telegram_id;
  if (!target) { clearThreadAction(thread.id); return; }

  console.log(`[conversation] ${thread.id} repeating broadcast ${broadcast.id}`);
  const result = await sendDirectMessage(thread.account_id, target, broadcast.message_text, {
    typingMinMs: broadcast.typing_min_ms,
    typingMaxMs: broadcast.typing_max_ms,
  });
  appendThreadMessage({
    threadId: thread.id,
    direction: "out",
    text: broadcast.message_text,
    telegramMessageId: result?.messageId,
  });
  // Schedule the next repeat one interval out.
  scheduleThreadAction(thread.id, Date.now() + broadcast.repeat_interval_ms, "repeat", null);
}

// Called by telegram-mtproto.js when an inbound DM lands on a connected
// MTProto account. Decides whether to treat it as a sales reply and
// schedule an AI response.
export function handleInboundMessage({ accountId, fromUsername, fromTelegramId, text }) {
  if (!accountId || !text) return null;

  // Find the most recent broadcast that targeted this @username.
  const matchedBroadcast = findBroadcastForTarget(accountId, fromUsername);

  const thread = findOrCreateThread({
    accountId,
    broadcastId: matchedBroadcast?.id ?? null,
    targetUsername: fromUsername || "",
    targetTelegramId: fromTelegramId || "",
  });
  appendThreadMessage({ threadId: thread.id, direction: "in", text });

  // Only auto-reply if we have a sales context (i.e. this thread is part of
  // a broadcast). Otherwise just record the message and let a human handle it.
  if (!matchedBroadcast) return thread;

  // Schedule AI reply after the reply-ignore window.
  const minMs = matchedBroadcast.reply_ignore_min_ms ?? 60_000;
  const maxMs = Math.max(minMs, matchedBroadcast.reply_ignore_max_ms ?? 120_000);
  const delay = minMs + Math.floor(Math.random() * Math.max(1, maxMs - minMs));
  scheduleThreadAction(thread.id, Date.now() + delay, "ai_reply", null);
  return thread;
}

function findBroadcastForTarget(accountId, fromUsername) {
  if (!fromUsername) return null;
  const handle = fromUsername.replace(/^@/, "").toLowerCase();
  // Iterate recent broadcasts and pick the newest one whose targets include
  // this handle. ~50 row scan, fine for our scale.
  for (const job of listBroadcastJobs(50)) {
    if (job.account_id !== accountId) continue;
    try {
      const targets = JSON.parse(job.targets_json) || [];
      if (targets.some((t) => String(t?.target || "").toLowerCase() === handle)) {
        return job;
      }
    } catch { /* skip malformed */ }
  }
  return null;
}

// Called by broadcast.js after a successful initial send. Materialises the
// thread so the worker can later attach replies, and schedules the first
// repeat if the broadcast has repeat enabled.
export function registerOutboundSend({
  accountId,
  broadcastId,
  targetUsername,
  messageText,
  messageId,
  repeatEnabled,
  repeatIntervalMs,
}) {
  const thread = findOrCreateThread({
    accountId,
    broadcastId,
    targetUsername: targetUsername || "",
    targetTelegramId: "",
  });
  appendThreadMessage({
    threadId: thread.id,
    direction: "out",
    text: messageText,
    telegramMessageId: messageId || null,
  });
  if (repeatEnabled && repeatIntervalMs > 0) {
    scheduleThreadAction(thread.id, Date.now() + repeatIntervalMs, "repeat", null);
  }
  return thread;
}

// Manual sweep over running broadcast jobs to schedule repeats that may have
// been missed (e.g. for jobs created before the worker shipped). Periodic
// safety net.
async function sweepRepeats() {
  const now = Date.now();
  for (const job of listBroadcastJobs(50)) {
    if (!job.repeat_enabled || !job.repeat_interval_ms) continue;
    if (job.status !== "running" && job.status !== "done") continue;
    let targets;
    try { targets = JSON.parse(job.targets_json) || []; } catch { continue; }
    for (const t of targets) {
      if (t.status !== "sent" || !t.target) continue;
      const handle = String(t.target).toLowerCase().replace(/^@/, "");
      const thread = findOrCreateThread({
        accountId: job.account_id,
        broadcastId: job.id,
        targetUsername: handle,
        targetTelegramId: "",
      });
      if (thread.inbound_count > 0) continue;
      if (thread.next_action_at) continue;
      const lastOut = thread.last_outbound_at || t.sentAt || job.created_at;
      const nextAt = lastOut + job.repeat_interval_ms;
      if (nextAt <= now + 60_000) {
        // Due now or very soon — schedule.
        scheduleThreadAction(thread.id, Math.max(now + 5_000, nextAt), "repeat", null);
      }
    }
  }
}
