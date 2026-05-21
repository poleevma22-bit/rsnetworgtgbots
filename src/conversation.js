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
  getAccount,
  findGroupForAccount,
  resolveGroupPrompt,
  isAccountEscalationOperator,
  findOldestEscalatedThread,
  syncLeadFromThread,
  bumpThreadEscalationCount,
  markThreadOfferSent,
  listGroupAttachments,
  detectLeadLanguage,
  resolveClientBrand,
} from "./db.js";
import { sendDirectFile } from "./telegram-mtproto.js";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

const OFFER_TEMPLATES_DIR = "/opt/tgbots/data/offer-templates";
const OFFER_OUTPUT_DIR = "/opt/tgbots/data/offer-output";

/** Run the Python PDF generator. Returns { ok, path, error } */
function generateOfferPdf(template, brand, outPath) {
  return new Promise((resolve) => {
    const p = spawn("python3", [
      "/opt/tgbots/scripts/generate-offer-pdf.py",
      join(OFFER_TEMPLATES_DIR, template),
      brand,
      outPath,
    ]);
    let stderr = "";
    p.stderr.on("data", (b) => { stderr += b.toString(); });
    p.on("close", (code) => {
      if (code === 0) resolve({ ok: true, path: outPath });
      else resolve({ ok: false, error: stderr || `exit ${code}` });
    });
  });
}

// Sync a thread → CRM lead row, swallowing errors so that classifier hiccups
// never break the AI reply path. The CRM matrix in /opt/tgbots/public reads
// from the `leads` table that this mirrors into.
function syncLead(threadId) {
  try { syncLeadFromThread(threadId); }
  catch (err) { console.error(`[conversation] syncLeadFromThread(${threadId}) failed:`, err?.message || err); }
}

// Repeat-floor: never schedule a follow-up ping to the same client more
// often than once per 7 days, regardless of what the broadcast's
// repeat_interval_ms says. Operator can dial broadcast repeats below this
// for testing, but the sweep will still respect the floor.
const REPEAT_PER_CLIENT_FLOOR_MS = 7 * 24 * 60 * 60 * 1000;
import { sendDirectMessage } from "./telegram-mtproto.js";
import { generateSalesReply } from "./ai.js";

// Known Telegram junk-bot usernames we've seen DMing managed accounts,
// plus a generic "ends with bot" check — Telegram requires bot usernames
// to end with `bot`, so this is a strong signal without false positives
// for real people.
const JUNK_BOT_PATTERNS = [
  /bot$/i,
  /^anonsay/i,
  /^anonkar/i,
  /^anonxzx/i,
  /^ruletkaa?/i,
  /^talkme/i,
  /^tikible/i,
  /^ttsave/i,
];
function looksLikeJunkBot(username) {
  if (!username) return true; // no @ handle → we can't safely DM back, skip
  const u = String(username).toLowerCase().replace(/^@/, "");
  return JUNK_BOT_PATTERNS.some((re) => re.test(u));
}

// Triggers we treat as "client explicitly wants a human" — used as a fallback
// to the AI's own [[ESCALATE]] marker so we catch escalations even when the
// model misses the cue.
const ESCALATE_KEYWORDS = [
  /позов(и|ите)\s+менеджер/i,
  /живо(й|го|му)\s+(менеджер|человек|оператор)/i,
  /хочу\s+(с\s+)?человек/i,
  /реальн\w+\s+(менеджер|человек)/i,
  /перевед(и|ите)\s+на\s+(менеджер|человек)/i,
  /не\s+бот/i,
  /talk\s+to\s+a?\s*(real\s+)?(human|person|manager)/i,
  /(real|live|human)\s+(person|manager|agent)/i,
];
function inboundAsksForHuman(text) {
  if (!text) return false;
  return ESCALATE_KEYWORDS.some((re) => re.test(text));
}

// Strips trailing control markers the AI may have emitted. Two markers:
//   [[ESCALATE]] or [[ESCALATE: reason]] → escalate to senior
//   [[OFFER_SENT]]                       → flip CRM lead to stage-offer
// Both markers are stripped from the text the client sees.
const ESCALATE_MARKER_RE = /\[\[ESCALATE(?::\s*([^\]]+))?\]\]/i;
const OFFER_MARKER_RE = /\[\[OFFER_SENT\]\]/i;
function extractMarkers(text) {
  const escMatch = text.match(ESCALATE_MARKER_RE);
  const offerMatch = text.match(OFFER_MARKER_RE);
  let clientText = text;
  if (escMatch) clientText = clientText.replace(ESCALATE_MARKER_RE, "");
  if (offerMatch) clientText = clientText.replace(OFFER_MARKER_RE, "");
  clientText = clientText.trim();
  return {
    clientText,
    escalation: {
      triggered: Boolean(escMatch),
      reason: (escMatch?.[1] || "").trim() || (escMatch ? "AI отметил, что не справляется." : ""),
    },
    offerSent: Boolean(offerMatch),
  };
}

// Builds the escalation summary that lands in the support operator's DM.
// Intentionally low-tech — last N messages verbatim. Operator can read fast.
function formatEscalationDm({ account, thread, reason, history }) {
  const handle = thread.target_username ? `@${thread.target_username}` : (thread.target_telegram_id || "(unknown)");
  const accountLabel = account?.handle || account?.name || account?.id || "(account)";
  const recent = (history || []).slice(-10).map((m) => {
    const who = m.direction === "in" ? handle : accountLabel;
    return `${who}: ${String(m.text || "").slice(0, 400)}`;
  }).join("\n");
  return [
    `🚨 Эскалация: бот не справляется или клиент попросил человека`,
    `Клиент: ${handle}`,
    `Аккаунт: ${accountLabel}`,
    `Причина: ${reason}`,
    `Тред: ${thread.id}`,
    ``,
    `Последние сообщения:`,
    recent || "(пусто)",
  ].join("\n");
}

/**
 * Resolve effective reply-delay and typing-delay envelopes for an outgoing AI
 * reply on this thread. Precedence: account-level overrides (stored on the
 * bot row via account-settings) → broadcast-level → built-in defaults.
 */
function resolveReplyTiming(account, broadcast) {
  const acctReplySec = Number(account?.replyDelaySeconds) || 0;
  const acctTypingSec = Number(account?.typingSeconds) || 0;
  // We treat the account's replyDelaySeconds as the lower bound; widen to a
  // small window so consecutive replies don't land at the same offset.
  const replyMin = acctReplySec > 0
    ? acctReplySec * 1000
    : (broadcast?.reply_ignore_min_ms ?? 60_000);
  const replyMax = acctReplySec > 0
    ? acctReplySec * 1000 + 30_000
    : (broadcast?.reply_ignore_max_ms ?? 120_000);
  const typingMin = acctTypingSec > 0
    ? acctTypingSec * 1000
    : (broadcast?.typing_min_ms ?? 5_000);
  const typingMax = acctTypingSec > 0
    ? acctTypingSec * 1000 + 4_000
    : (broadcast?.typing_max_ms ?? 10_000);
  return { replyMin, replyMax, typingMin, typingMax };
}

// Lowered from 30s → 5s so an inbound message gets answered close to its
// scheduled time. The old 30s tick added up to 30s of latency on top of
// the account-level replyDelaySeconds — making a "10s reply" feel like ~40s.
const TICK_MS = 5_000;             // worker poll cadence
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

  console.log(`[conversation] worker started (tick=${TICK_MS / 1000}s, repeat-sweep=${REPEAT_TICK_MS / 60_000}min)`);
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
  // CLAIM the action immediately. Worker ticks every 5s but the full AI
  // reply path (generate + typing simulation + send) takes 5-10s. Without
  // this claim, the next tick would see next_action_at still set and fire
  // a duplicate reply. clearThreadAction nulls next_action_at, so the row
  // drops out of listReadyThreads on subsequent ticks.
  clearThreadAction(thread.id);

  const account = getAccount(thread.account_id);
  if (account?.aiEnabled === false) {
    console.log(`[conversation] ${thread.id} ai-reply skipped: account ${thread.account_id} aiEnabled=false`);
    return;
  }
  // Previously we skipped AI on threads in 'escalated' state. That created a
  // bad UX: clients writing follow-up questions got radio silence while we
  // waited on the senior. New design — keep replying. Each MUST-trigger
  // still spawns its own escalation DM (with the new context), so the
  // senior sees a fresh alert per outstanding question. Duplicates are
  // expected and acceptable; senior can pick the most recent.
  const broadcast = thread.broadcast_id ? getBroadcastJob(thread.broadcast_id) : null;
  // Group prompt: prefer the broadcast's bound group, else fall back to the
  // first group the account belongs to (organic-DM persona).
  const group = broadcast?.group_id
    ? getGroup(broadcast.group_id)
    : findGroupForAccount(thread.account_id);

  const history = getThreadHistory(thread.id, 40);
  // Group prompt resolves through the template renderer if the group is
  // bound to a prompt_template (and otherwise returns the legacy
  // group_prompt text). See db.js → resolveGroupPrompt.
  const renderedGroupPrompt = resolveGroupPrompt(group);
  // Language hint: detect from the client's handle so AI picks the right
  // language on the very first reply (esp. helpful when client says just
  // "привет" — too short to language-detect from text alone).
  const langHint = detectLeadLanguage({ username: thread.target_username });
  const contextNote = langHint
    ? `Клиент: @${thread.target_username || thread.target_telegram_id || "unknown"}. Предполагаемый язык клиента: ${langHint === "ru" ? "русский" : "английский"} (по эвристике юзернейма). Веди диалог на этом языке если клиент не указал иное.`
    : `Клиент: @${thread.target_username || thread.target_telegram_id || "unknown"}. Язык клиента не определён эвристикой — следуй правилу #9.`;
  const { text: rawText, model } = await generateSalesReply({
    salesScript: broadcast?.sales_script || "",
    dialogScenarios: broadcast?.dialog_scenarios || "",
    terminology: broadcast?.terminology || "",
    taskType: broadcast?.task_type || "cold",
    groupPrompt: renderedGroupPrompt,
    firstMessageText: broadcast?.message_text || "",
    history,
    contextNote,
  });

  // The AI may emit control markers we strip before sending:
  //   [[ESCALATE: reason]] → hand off to senior manager below
  //   [[OFFER_SENT]]       → CRM flips lead to stage-offer
  const parsed = extractMarkers(rawText);
  const text = parsed.clientText || "Передам коллегам, они подключатся.";
  const flags = [];
  if (parsed.escalation.triggered) flags.push("ESCALATE");
  if (parsed.offerSent) flags.push("OFFER_SENT");
  console.log(`[conversation] ${thread.id} ai-reply via ${model}${flags.length ? ` [${flags.join(",")}]` : ""}: ${text.slice(0, 80)}`);

  const target = thread.target_username || thread.target_telegram_id;
  if (!target) {
    clearThreadAction(thread.id);
    return;
  }
  const timing = resolveReplyTiming(account, broadcast);
  const result = await sendDirectMessage(thread.account_id, target, text, {
    typingMinMs: timing.typingMin,
    typingMaxMs: timing.typingMax,
  });
  appendThreadMessage({
    threadId: thread.id,
    direction: "out",
    text,
    telegramMessageId: result?.messageId,
  });

  if (parsed.offerSent) {
    // Mark offer sent BEFORE escalation logic so the classifier picks
    // stage-offer when both flags exist (offer + senior-pending).
    markThreadOfferSent(thread.id);

    // Dispatch in background — don't block the AI-reply ack path.
    const dispatchOffer = async () => {
      const brand = resolveClientBrand(thread);
      console.log(`[conversation] ${thread.id} offer dispatch: brand="${brand}"`);

      // 1) Per-brand PDFs generated on-the-fly from the LuckyBear-style Excel
      //    templates (Meta + DSP). One PDF per platform.
      if (!existsSync(OFFER_OUTPUT_DIR)) mkdirSync(OFFER_OUTPUT_DIR, { recursive: true });
      const safe = String(brand).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "brand";
      const ts = Date.now();
      const pdfTargets = [
        { template: "dsp_template.xlsx",  out: `${safe}_DSP_offer_${ts}.pdf`,  label: "DSP" },
        { template: "meta_template.xlsx", out: `${safe}_Meta_offer_${ts}.pdf`, label: "Meta" },
      ];
      for (const t of pdfTargets) {
        const outPath = join(OFFER_OUTPUT_DIR, t.out);
        const res = await generateOfferPdf(t.template, brand, outPath);
        if (!res.ok) {
          console.error(`[conversation] ${thread.id} pdf ${t.label} render failed: ${res.error}`);
          continue;
        }
        try {
          await sendDirectFile(thread.account_id, target, outPath, { caption: "" });
          appendThreadMessage({
            threadId: thread.id,
            direction: "out",
            text: `[offer-pdf] ${t.label} for ${brand}: ${t.out}`,
          });
          console.log(`[conversation] ${thread.id} offer PDF sent: ${t.out}`);
        } catch (err) {
          console.error(`[conversation] ${thread.id} offer PDF ${t.label} send failed:`, err?.message || err);
        }
      }

      // 2) Static group attachments (PNG brand card, additional decks) — kept
      //    for backwards compat. Operator can clear via UI if not needed.
      const attachments = group ? listGroupAttachments(group.id) : [];
      for (const att of attachments) {
        try {
          await sendDirectFile(thread.account_id, target, att.storedPath, { caption: "" });
          appendThreadMessage({
            threadId: thread.id,
            direction: "out",
            text: `[attachment] ${att.filename} (${att.mime}, ${att.size} bytes)`,
          });
          console.log(`[conversation] ${thread.id} static attachment sent: ${att.filename}`);
        } catch (err) {
          console.error(`[conversation] ${thread.id} static attachment ${att.filename} failed:`, err?.message || err);
        }
      }
    };
    dispatchOffer().catch((err) => console.error(`[conversation] ${thread.id} offer dispatch crashed:`, err?.message || err));
  }

  if (parsed.escalation.triggered) {
    // Increment escalation counter BEFORE the DM goes out so the CRM
    // classifier flips this thread to stage-3 (Презентация) immediately.
    bumpThreadEscalationCount(thread.id);
    await escalateThread({
      thread,
      account,
      group,
      reason: parsed.escalation.reason,
      history: [...history, { direction: "out", text }],
    });
  }

  syncLead(thread.id);
  // (Action already cleared at the top — claim-on-entry pattern.)
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

  // 7-day floor: if we pinged this client less than 7 days ago, push the
  // repeat out instead of firing. Protects accounts from getting flagged
  // for over-pinging when broadcasts are misconfigured with short repeats.
  const lastOut = thread.last_outbound_at || 0;
  const now = Date.now();
  if (lastOut && now - lastOut < REPEAT_PER_CLIENT_FLOOR_MS) {
    const dueAt = lastOut + REPEAT_PER_CLIENT_FLOOR_MS;
    console.log(`[conversation] ${thread.id} repeat skipped (last ping ${Math.round((now - lastOut) / 60000)}m ago; rescheduling for ${new Date(dueAt).toISOString()})`);
    scheduleThreadAction(thread.id, dueAt, "repeat", null);
    return;
  }

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
  syncLead(thread.id);
  // Schedule the next repeat at max(broadcast.repeat_interval_ms, 7-day floor).
  const nextDelay = Math.max(broadcast.repeat_interval_ms, REPEAT_PER_CLIENT_FLOOR_MS);
  scheduleThreadAction(thread.id, Date.now() + nextDelay, "repeat", null);
}

// Called by telegram-mtproto.js when an inbound DM lands on a connected
// MTProto account. Decides whether to treat it as a sales reply and
// schedule an AI response.
//
// Scheduling rules:
//   1. If the inbound matches a recent broadcast target → schedule AI reply.
//   2. Else, if the account belongs to a group with a non-empty group_prompt
//      (i.e. the account has a configured "sales persona") AND the sender
//      doesn't look like a Telegram service/junk bot → schedule AI reply
//      anyway, using just the group prompt as context. Lets the bot pick up
//      organic DMs from real prospects.
//   3. Otherwise → just record the inbound and let a human handle it.
export function handleInboundMessage({ accountId, fromUsername, fromTelegramId, text }) {
  if (!accountId || !text) return null;

  // --- Senior-manager forward path (runs BEFORE normal AI flow) ---
  //
  // When the inbound is from a Telegram @handle configured as the group's
  // escalation_username, this is NOT a sales prospect — it's our own support
  // operator answering a question we escalated earlier. Forward the text to
  // the oldest still-escalated client thread on this account (FIFO), mark
  // that thread back to 'active' so AI can resume on the next client reply,
  // and exit. We never AI-reply to the senior themselves.
  if (isAccountEscalationOperator(accountId, fromUsername)) {
    const pending = findOldestEscalatedThread(accountId);
    if (!pending) {
      console.log(`[conversation] inbound from senior @${fromUsername} but no escalated threads pending — ignoring`);
      return null;
    }
    const targetHandle = pending.target_username || pending.target_telegram_id;
    if (!targetHandle) {
      console.warn(`[conversation] escalated thread ${pending.id} has no target handle — cannot forward`);
      return null;
    }
    console.log(`[conversation] senior @${fromUsername} → forwarding to ${pending.id} (client @${pending.target_username})`);
    // Record the operator's reply on a parallel "operator thread" so we
    // have history, but don't expose internals to client.
    const opThread = findOrCreateThread({
      accountId,
      broadcastId: null,
      targetUsername: String(fromUsername || "").toLowerCase().replace(/^@/, ""),
      targetTelegramId: fromTelegramId || "",
    });
    appendThreadMessage({ threadId: opThread.id, direction: "in", text });

    // Send the forwarded text from Sunsh5151 to the original client.
    // Short typing window — operator answer should land quickly.
    sendDirectMessage(accountId, targetHandle, text, {
      typingMinMs: 1500,
      typingMaxMs: 3500,
    }).then((result) => {
      appendThreadMessage({
        threadId: pending.id,
        direction: "out",
        text,
        telegramMessageId: result?.messageId,
      });
      // Resume AI on the client thread so follow-ups continue naturally.
      // CRM auto-flips lead to stage-4 (Согласование) since state is now
      // 'active' with escalation_count ≥ 1.
      try { updateThread(pending.id, { state: "active" }); } catch {}
      try { clearThreadAction(pending.id); } catch {}
      syncLead(pending.id);
    }).catch((err) => {
      console.error(`[conversation] forward to ${pending.id} failed:`, err?.message || err);
    });
    return opThread;
  }
  // --- end senior-forward path ---

  const matchedBroadcast = findBroadcastForTarget(accountId, fromUsername);

  const thread = findOrCreateThread({
    accountId,
    broadcastId: matchedBroadcast?.id ?? null,
    targetUsername: fromUsername || "",
    targetTelegramId: fromTelegramId || "",
  });
  appendThreadMessage({ threadId: thread.id, direction: "in", text });
  syncLead(thread.id); // flips lead from stage-1 → stage-2 on first inbound

  // Honour per-account AI kill-switch.
  const account = getAccount(accountId);
  if (account?.aiEnabled === false) return thread;

  let scheduleReply = false;
  let group = null;
  if (matchedBroadcast) {
    scheduleReply = true;
    group = matchedBroadcast.group_id ? getGroup(matchedBroadcast.group_id) : findGroupForAccount(accountId);
  } else {
    group = findGroupForAccount(accountId);
    if (group?.group_prompt?.trim() && !looksLikeJunkBot(fromUsername)) {
      scheduleReply = true;
    }
  }

  // Keyword-driven escalation: client typed something like "позови менеджера"
  // or "не бот". Don't make them wait for the AI cycle — escalate now, send
  // a short acknowledgement, mark the thread so AI stops auto-replying.
  if (scheduleReply && group?.escalation_username && inboundAsksForHuman(text)) {
    console.log(`[conversation] ${thread.id} inbound asked for human → keyword escalation`);
    bumpThreadEscalationCount(thread.id); // CRM → stage-3 immediately
    const ack = "Сейчас подключу коллегу, он напишет.";
    appendThreadMessage({ threadId: thread.id, direction: "out", text: ack });
    sendDirectMessage(accountId, thread.target_username || thread.target_telegram_id, ack, {
      typingMinMs: 1500, typingMaxMs: 3500,
    }).catch((err) => console.error(`[conversation] ack-send failed for ${thread.id}:`, err?.message || err));
    escalateThread({
      thread,
      account,
      group,
      reason: "Клиент попросил живого человека / упомянул, что это бот.",
      history: getThreadHistory(thread.id, 40),
    }).catch((err) => console.error(`[conversation] escalation failed for ${thread.id}:`, err?.message || err));
    syncLead(thread.id);
    // No AI scheduling — handed off to operator.
    return thread;
  }

  if (!scheduleReply) return thread;

  const timing = resolveReplyTiming(account, matchedBroadcast);
  const span = Math.max(1, timing.replyMax - timing.replyMin);
  const delay = timing.replyMin + Math.floor(Math.random() * span);
  scheduleThreadAction(thread.id, Date.now() + delay, "ai_reply", null);
  return thread;
}

/**
 * Send the escalation DM to the support handle configured on the group, mark
 * the thread as escalated, and clear pending AI actions.
 */
async function escalateThread({ thread, account, group, reason, history }) {
  const target = group?.escalation_username;
  if (!target) {
    console.warn(`[conversation] ${thread.id} escalate requested but group has no escalation_username`);
    return;
  }
  // Note: we used to skip re-escalation when state was already 'escalated',
  // but that paired badly with the new "keep AI replying" behaviour — senior
  // would miss fresh context. Now every MUST-trigger spawns its own DM.
  // (Cheap; senior reads top message and ignores the rest if redundant.)

  const body = formatEscalationDm({ account, thread, reason, history });
  try {
    await sendDirectMessage(thread.account_id, target, body, {
      typingMinMs: 800,
      typingMaxMs: 1800,
    });
    console.log(`[conversation] ${thread.id} escalated to @${target}`);
  } catch (err) {
    console.error(`[conversation] ${thread.id} escalation DM to @${target} failed:`, err?.message || err);
    return; // don't mark escalated if DM failed — operator never got it
  }
  // Mark thread so AI stops auto-replying. Operator takes over via Sunsh5151
  // from here. CRM auto-flips to stage-3 (Презентация) because state is now
  // 'escalated' with escalation_count ≥ 1.
  try { updateThread(thread.id, { state: "escalated" }); } catch {}
  try { clearThreadAction(thread.id); } catch {}
  syncLead(thread.id);
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
      // Apply the 7-day floor here too so the sweep doesn't queue something
      // processRepeat would just push back.
      const interval = Math.max(job.repeat_interval_ms, REPEAT_PER_CLIENT_FLOOR_MS);
      const nextAt = lastOut + interval;
      if (nextAt <= now + 60_000) {
        scheduleThreadAction(thread.id, Math.max(now + 5_000, nextAt), "repeat", null);
      }
    }
  }
}
