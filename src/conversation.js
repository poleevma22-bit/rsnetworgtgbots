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
  detectInboundTextLanguage,
  resolveThreadLanguage,
  setThreadLanguage,
  resolveClientBrand,
  setPipelineNotifyHook,
  sweepStaleLeads,
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
import { lintReply } from "./prompt-linter.js";

// Linter is opt-in via env flag during the initial ramp. Setting
// PROMPT_LINTER_ENABLED="1" turns it on; anything else is a no-op so the
// pre-v3 reply path is preserved exactly when disabled.
const LINTER_ENABLED = process.env.PROMPT_LINTER_ENABLED === "1";

function summarizeFindings(findings) {
  return findings.map((f) => `${f.type}: ${f.detail}`).join("; ");
}

// Locale-aware handoff text used when the client (or LLM) breaks the locked
// language. Routed through the standard [[ESCALATE]] marker pipeline.
const LANGUAGE_SWITCH_HANDOFF = {
  ru: "Передаю вопрос старшему менеджеру, он скоро напишет вам с точным ответом.",
  en: "Passing this to our senior manager, they will get back to you shortly.",
};

/** Did `text` contain any character of the opposite script for `lockedLang`? */
function containsOppositeScript(text, lockedLang) {
  if (!text) return false;
  if (lockedLang === "ru") {
    // Locked RU: outbound should be Russian. Trigger if the body has Latin-only
    // chunks and no Cyrillic at all (so brand names "ConvertAgain" don't
    // false-positive inside an otherwise-Russian reply).
    return !/[Ѐ-ӿ]/.test(text) && /[A-Za-z]/.test(text);
  }
  if (lockedLang === "en") {
    // Locked EN: any Cyrillic character is a violation.
    return /[Ѐ-ӿ]/.test(text);
  }
  return false;
}

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
  // ask for human
  /позов(и|ите)\s+менеджер/i,
  /живо(й|го|му)\s+(менеджер|человек|оператор)/i,
  /хочу\s+(с\s+)?человек/i,
  /реальн\w+\s+(менеджер|человек)/i,
  /перевед(и|ите)\s+на\s+(менеджер|человек)/i,
  /не\s+бот/i,
  /talk\s+to\s+a?\s*(real\s+)?(human|person|manager)/i,
  /(real|live|human)\s+(person|manager|agent)/i,
  // call-intent: client wants a call / meeting / demo. Instant-escalate so
  // senior gets the lead before the AI's 60-120s reply window.
  /созвон(имся|итесь|нёмся)?/i,
  /\bпозвони(те|ть)\b/i,
  /\b(на|в)\s+(созвон|звонок|колл)\b/i,
  /\bзвон(ок|ка|ки)\b/i,
  /встреч(а|у|и|айтесь)/i,
  /\bdemo\b/i,
  /\bдемо\b/i,
  /calend(ly|ar)/i,
  /\bschedule\s+a?\s*(call|meeting|demo)/i,
  /\bbook\s+a?\s*(call|meeting|demo)/i,
  /\b(hop|jump|get)\s+on\s+a?\s*call/i,
  /let'?s\s+(have|do|set\s+up)\s+a?\s*(call|meeting|chat)/i,
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
// Runtime sanitizer: strips em-dash (—) and en-dash (–) from anything we
// send to the client, regardless of what the LLM emitted. Founder explicitly
// banned both characters across all bot responses. Replaces with a regular
// hyphen surrounded by spaces, or just removes the dash if it's at a word
// boundary, so the text reads naturally.
function stripLongDashes(text) {
  if (!text) return text;
  return text
    .replace(/\s+[—–]\s+/g, ", ")  // "X — Y" → "X, Y"
    .replace(/[—–]/g, "-");        // anything else → plain hyphen
}

function extractMarkers(text) {
  const escMatch = text.match(ESCALATE_MARKER_RE);
  const offerMatch = text.match(OFFER_MARKER_RE);
  let clientText = text;
  if (escMatch) clientText = clientText.replace(ESCALATE_MARKER_RE, "");
  if (offerMatch) clientText = clientText.replace(OFFER_MARKER_RE, "");
  clientText = stripLongDashes(clientText).trim();
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
function formatEscalationDm({ account, thread, reason, history, kind }) {
  const handle = thread.target_username ? `@${thread.target_username}` : (thread.target_telegram_id || "(unknown)");
  const accountLabel = account?.handle || account?.name || account?.id || "(account)";
  const recent = (history || []).slice(-8).map((m) => {
    const who = m.direction === "in" ? handle : accountLabel;
    return `${who}: ${String(m.text || "").slice(0, 400)}`;
  }).join("\n");
  // kind:
  //   "handoff"   — client ready, your turn (default)
  //   "progress"  — passive FYI on a funnel-stage transition, no action needed
  //   "lint-fail" — bot's reply violated the prompt linter twice, take over
  let header;
  if (kind === "progress") header = `📬 Лид прогрессирует по воронке`;
  else if (kind === "lint-fail") header = `⚠️ Бот тормознут линтером, подхвати разговор`;
  else header = `📨 Лид готов к передаче, можно подключаться`;
  // Pull out the lint summary from `reason` if it's a lint-fail call. The
  // reason string is built in conversation.js as:
  //   `lint-fail: <findings summary> | candidate="..."`
  let lintLine = null;
  if (kind === "lint-fail" && typeof reason === "string") {
    const m = reason.match(/^lint-fail:\s*(.+?)(?:\s*\|\s*candidate=|$)/);
    if (m) lintLine = `Lint: ${m[1]}`;
  }
  return [
    header,
    `Клиент: ${handle}`,
    `Аккаунт: ${accountLabel}`,
    lintLine,
    reason ? `Контекст: ${reason}` : null,
    `Тред: ${thread.id}`,
    ``,
    `Последние сообщения:`,
    recent || "(пусто)",
  ].filter(Boolean).join("\n");
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

  // Register funnel-progression notifier so db.js can DM the senior manager
  // whenever a lead moves to stage-offer / stage-5.
  setPipelineNotifyHook(handlePipelineProgress);

  // Stale-lead sweeper: hourly tick auto-flips leads to Hold (>7d no inbound)
  // or Archive (>30d). Operator overrides via manual_stage_id are respected.
  const STALE_SWEEP_MS = 60 * 60 * 1000;
  const staleTimer = setInterval(() => {
    try { sweepStaleLeads(); }
    catch (err) { console.error("[conversation] sweepStaleLeads failed:", err?.message || err); }
  }, STALE_SWEEP_MS);
  if (typeof staleTimer.unref === "function") staleTimer.unref();
  // Run once on boot so a fresh process doesn't have to wait an hour for the
  // first sweep to land on already-stale leads.
  setTimeout(() => {
    try { sweepStaleLeads(); }
    catch (err) { console.error("[conversation] sweepStaleLeads initial failed:", err?.message || err); }
  }, 30_000);

  console.log(`[conversation] worker started (tick=${TICK_MS / 1000}s, repeat-sweep=${REPEAT_TICK_MS / 60_000}min, stale-sweep=60min)`);
}

// Sends a passive "📬 Лид прогрессирует" DM to the group's escalation_username
// when the lead's stage flips to one of the milestone stages. Does NOT change
// thread state (still 'active') — the AI keeps replying. Pure heads-up so the
// senior manager can decide whether to jump in.
const STAGE_TITLES = {
  "stage-offer": "оффер отправлен",
  "stage-onboarding": "онбординг начат",
  "stage-5": "сделка выиграна",
};
function handlePipelineProgress({ threadId, accountId, previousStage, stageId }) {
  const thread = getThread(threadId);
  if (!thread) return;
  const group = findGroupForAccount(accountId);
  if (!group?.escalation_username) return;
  const account = getAccount(accountId);
  const history = getThreadHistory(threadId, 40);
  const stageTitle = STAGE_TITLES[stageId] || stageId;
  const reasonParts = [`воронка: ${previousStage || "новый"} → ${stageId} (${stageTitle})`];
  // Fire-and-forget; never throw from inside the DB write path.
  escalateThread({
    thread,
    account,
    group,
    reason: reasonParts.join(" | "),
    history,
    kind: "progress",
  }).catch((err) => console.error(`[conversation] pipeline-notify ${threadId} failed:`, err?.message || err));
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

  // --- Language resolution (spec: bot-sales-conversation) ---
  // Locked value (if any) is the source of truth; otherwise walk the 5-level
  // priority. Persist non-default signals so the next tick reads the lock.
  let language = thread.language || null;
  let locked = Boolean(language);
  let defaultOnly = false;
  if (!locked) {
    const resolved = resolveThreadLanguage(thread, history);
    language = resolved.language;
    defaultOnly = resolved.source === 5;
    if (!defaultOnly) {
      setThreadLanguage(thread.id, language);
      thread.language = language;
      locked = true;
    }
  }

  // Belt-and-suspenders #1 (inbound side): if the lock is set AND the latest
  // inbound client message is in the opposite language, do NOT call the LLM —
  // emit the locale-correct handoff and escalation marker directly.
  const lastInbound = [...history].reverse().find((m) => m.direction === "in" && m.text);
  if (locked && lastInbound) {
    const inboundLang = detectInboundTextLanguage(lastInbound.text);
    if (inboundLang && inboundLang !== language) {
      const handoff = LANGUAGE_SWITCH_HANDOFF[language] || LANGUAGE_SWITCH_HANDOFF.en;
      const target = thread.target_username || thread.target_telegram_id;
      if (!target) { clearThreadAction(thread.id); return; }
      const timing = resolveReplyTiming(account, broadcast);
      const result = await sendDirectMessage(thread.account_id, target, handoff, {
        typingMinMs: timing.typingMin,
        typingMaxMs: timing.typingMax,
      });
      appendThreadMessage({ threadId: thread.id, direction: "out", text: handoff, telegramMessageId: result?.messageId });
      // Reuse the escalation marker extractor to fire the senior-manager DM.
      const escalateText = `${handoff} [[ESCALATE: client switched language to ${inboundLang} mid-thread]]`;
      const escalated = extractMarkers(escalateText);
      if (escalated.escalation.triggered) bumpThreadEscalationCount(thread.id);
      console.log(`[conversation] ${thread.id} ai-reply skipped — locked=${language}, inbound=${inboundLang} → escalate`);
      syncLead(thread.id);
      return;
    }
  }

  const baseGenArgs = {
    salesScript: broadcast?.sales_script || "",
    dialogScenarios: broadcast?.dialog_scenarios || "",
    terminology: broadcast?.terminology || "",
    taskType: broadcast?.task_type || "cold",
    groupPrompt: renderedGroupPrompt,
    firstMessageText: broadcast?.message_text || "",
    history,
    language,
    locked,
    defaultOnly,
  };
  let { text: rawText, model } = await generateSalesReply(baseGenArgs);

  // Prompt linter — only when explicitly enabled. Catches verbatim repetition
  // vs the last 3 outbounds and contradictions vs claims in the assembled
  // system prompt ("мы работаем с Alpha Affiliates" vs "аффилейтам не подойдёт").
  // On block: retry generation once with an addendum. On double-block: escalate
  // to senior with kind:"lint-fail" and abort the outbound entirely.
  let lintFailEscalation = null;
  if (LINTER_ENABLED) {
    try {
      let candidate = extractMarkers(rawText).clientText || rawText;
      let lintResult = lintReply({
        reply: candidate,
        history,
        assembledPrompt: renderedGroupPrompt,
      });
      let blocking = lintResult.findings.filter((f) => f.severity === "block");
      if (blocking.length > 0) {
        for (const f of blocking) {
          console.log(`[lint] ${thread.id} ${f.type}: ${f.detail}`);
        }
        const fixupNote = `Перегенерируй ответ. Избегай повторов и противоречий: ${summarizeFindings(blocking)}`;
        const retryArgs = {
          ...baseGenArgs,
          // Append the lint hint to the last history entry as a meta-note so
          // generateSalesReply surfaces it to the model without changing its
          // API. If the consumer ignores it, we'll still escalate on retry.
          history: [
            ...history,
            { direction: "out", text: `__LINT_HINT__ ${fixupNote}` },
          ],
        };
        const retry = await generateSalesReply(retryArgs);
        rawText = retry.text;
        model = retry.model;
        candidate = extractMarkers(rawText).clientText || rawText;
        lintResult = lintReply({
          reply: candidate,
          history,
          assembledPrompt: renderedGroupPrompt,
        });
        blocking = lintResult.findings.filter((f) => f.severity === "block");
        if (blocking.length > 0) {
          for (const f of blocking) {
            console.log(`[lint] ${thread.id} ${f.type} (retry-also-failed): ${f.detail}`);
          }
          // Stash for the escalation path below — we still emit the markers
          // pipeline so OFFER_SENT etc. don't get lost, but we won't send.
          lintFailEscalation = {
            findings: blocking,
            originalCandidate: candidate,
          };
        }
      }
    } catch (err) {
      console.error(`[lint] ${thread.id} linter crashed (continuing without):`, err?.message || err);
    }
  }

  // The AI may emit control markers we strip before sending:
  //   [[ESCALATE: reason]] → hand off to senior manager below
  //   [[OFFER_SENT]]       → CRM flips lead to stage-offer
  let parsed = extractMarkers(rawText);
  let text = parsed.clientText || "Передам коллегам, они подключатся.";

  // Lint-fail escalation: don't send candidate to client; DM the senior with
  // the original problematic text and the findings, so they can take over.
  if (lintFailEscalation) {
    bumpThreadEscalationCount(thread.id);
    await escalateThread({
      thread,
      account,
      group,
      reason: `lint-fail: ${summarizeFindings(lintFailEscalation.findings)} | candidate="${lintFailEscalation.originalCandidate.slice(0, 200)}"`,
      history,
      kind: "lint-fail",
    }).catch((err) => console.error(`[conversation] ${thread.id} lint-fail escalation crashed:`, err?.message || err));
    clearThreadAction(thread.id);
    syncLead(thread.id);
    return;
  }

  // Belt-and-suspenders #2 (outbound side): the LLM may have ignored the lock
  // and produced a reply in the opposite script. Force-replace with the
  // locale-correct handoff + escalation marker.
  if (locked && containsOppositeScript(text, language)) {
    const oppLang = language === "ru" ? "en" : "ru";
    const handoff = LANGUAGE_SWITCH_HANDOFF[language] || LANGUAGE_SWITCH_HANDOFF.en;
    const forced = `${handoff} [[ESCALATE: client switched language to ${oppLang} mid-thread]]`;
    parsed = extractMarkers(forced);
    text = parsed.clientText || handoff;
    console.log(`[conversation] ${thread.id} ai-reply force-replaced — LLM emitted ${oppLang} on locked=${language}`);
  }

  const flags = [];
  if (parsed.escalation.triggered) flags.push("ESCALATE");
  if (parsed.offerSent) flags.push("OFFER_SENT");
  console.log(`[conversation] ${thread.id} ai-reply via ${model} [lang=${language}${locked ? ",locked" : defaultOnly ? ",default" : ",pref"}]${flags.length ? ` [${flags.join(",")}]` : ""}: ${text.slice(0, 80)}`);

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
  // Detect ongoing conversation vs brand-new cold inbound (read BEFORE append).
  const isOngoingThread = getThreadHistory(thread.id, 1).length > 0;
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
    // No broadcast match: only auto-reply on an ALREADY-ongoing thread. Cold
    // first-contact strangers are recorded as leads (CRM stage-2) but do NOT
    // trigger an LLM reply — avoids burning OpenRouter on random/spam DMs.
    group = findGroupForAccount(accountId);
    if (group?.group_prompt?.trim() && !looksLikeJunkBot(fromUsername) && isOngoingThread) {
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
async function escalateThread({ thread, account, group, reason, history, kind }) {
  const target = group?.escalation_username;
  if (!target) {
    console.warn(`[conversation] ${thread.id} escalate requested but group has no escalation_username`);
    return;
  }
  // Note: we used to skip re-escalation when state was already 'escalated',
  // but that paired badly with the new "keep AI replying" behaviour — senior
  // would miss fresh context. Now every MUST-trigger spawns its own DM.
  // (Cheap; senior reads top message and ignores the rest if redundant.)

  const effectiveKind = kind || "handoff";
  const body = formatEscalationDm({ account, thread, reason, history, kind: effectiveKind });
  try {
    await sendDirectMessage(thread.account_id, target, body, {
      typingMinMs: 800,
      typingMaxMs: 1800,
    });
    console.log(`[conversation] ${thread.id} ${effectiveKind === "progress" ? "progress-notify" : "escalated"} to @${target}`);
  } catch (err) {
    console.error(`[conversation] ${thread.id} ${effectiveKind} DM to @${target} failed:`, err?.message || err);
    return; // don't mutate state if DM failed — operator never got it
  }
  // For "progress" notifications we deliberately do NOT change thread state
  // or clear the AI action — the bot keeps owning the conversation. The DM
  // is just a passive heads-up to the senior manager.
  if (effectiveKind === "progress") return;
  // For "handoff": mark thread so AI stops auto-replying. Operator takes
  // over via the bot account from here. CRM auto-flips to stage-3
  // (Презентация) because state is now 'escalated' with escalation_count ≥ 1.
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
