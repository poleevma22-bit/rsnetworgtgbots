# tgbots — Telegram sales-bot platform (rsnetworgtgbots)

Node.js service powering the AI sales bots managed via `apps/web/app/admin/tg-bots`.
Owns SQLite at `data/tgbots.sqlite3`, mtproto event loop, OpenRouter LLM calls,
and the standalone CRM kanban at `/tg-crm/`.

## Running

```bash
pm2 restart tg-bots --update-env   # picks up .env changes
pm2 logs tg-bots --lines 50        # tail
pm2 logs tg-bots --err             # errors only
```

Listens on port 4173 by default (`PORT`). Reverse-proxied via nginx to
`/tg-crm/` and the API root.

## Environment variables (`.env`)

| Key | Required | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | yes | LLM provider key. 403 here = key hit daily limit or expired. |
| `OPENAI_API_KEY` | optional | Reserved for legacy code paths. |
| `PUBLIC_BASE_URL` | optional | Used for bot-api webhook registration. |
| `PORT` | optional (default 4173) | HTTP listener. |
| `PROMPT_LINTER_ENABLED` | optional (`1` to enable) | Turns on runtime prompt linter (see below). |

## v3 group prompt model

`account_groups` table holds the sales-bot config per group. The system prompt
fed to the LLM is composed by `resolveGroupPrompt(group)` in `src/db.js` from
these columns, in fixed order, with explicit `=== Title ===` section headers:

1. `sales_persona` → `=== Кто ты ===` — identity, tone, base principles
2. `product_pitch` → `=== Что мы продаём ===` — benefits without technical detail
3. `technical_prompt` → `=== Как работает продукт технически ===` — integrations,
   trackers, S2S mechanics, data fields
4. `objections` → `=== Возражения и как их снимать ===`
5. `qualification_questions` → `=== Обязательные вопросы для квалификации ===`
6. `offer_link` → `=== Ссылка на оффер / презентацию ===` (when set)
7. `offer_message` → `=== Текст оффера ===` (when set, with `[[OFFER_SENT]]` guidance)

**Legacy fallback:** if all five structured fields are empty, `group_prompt`
renders under `=== Кто ты ===`. A one-shot boot backfill copies legacy
`group_prompt` into `sales_persona` so older groups Just Work; the founder
edits incrementally.

A pre-migration snapshot lives in `account_groups_premigration_2026_05_25`
(created once on first boot of v3 code).

## v3 prompt linter

Module `src/prompt-linter.js` exports `lintReply({ reply, history, assembledPrompt })`
returning `{ findings: [...] }`. Two detectors:

- **Repetition**: character-trigram Jaccard similarity between candidate
  reply and the last 3 outbound messages in history. Threshold ≥ 0.85
  emits `{ type: "repetition", severity: "block" }`.
- **Contradiction**: extracts client/partner entities from `assembledPrompt`
  via patterns like `мы работаем с X`, `клиенты: X`, `we work with X`, then
  rejects the reply if it contains counter-claims (`X не подойдёт`,
  `мы не работаем с X`, etc.) for any extracted X. Word-boundary aware to
  avoid substring false positives.

Integrated in `conversation.js: processAiReply`. On a `severity:"block"`
finding:
1. log `[lint] <threadId> <type>: <detail>`
2. retry `generateSalesReply` once with a fixup instruction
3. if retry also blocks: escalate via `escalateThread({..., kind: "lint-fail"})`
   with `Lint:` line in the DM body, abort outbound

Gated by `PROMPT_LINTER_ENABLED=1`. Disabled by default during ramp; flip on
after monitoring lint findings via the health dashboard.

Tests: `node --test test/prompt-linter.test.js` (12 cases).

## v3 HTTP endpoints (new)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/groups/:id/preview` | Returns `{ assembled, sections: [{header, length}] }` for the admin preview panel. |
| `GET`  | `/api/health/snapshot` | Operational overview (accounts, counters_24h, tail, alerts). |
| `POST` | `/api/health/check` | Active probe of SQLite, mtproto auth, OpenRouter. |
| `POST` | `/api/playground/run` | `{ groupId, accountId, inboundText }` → runs reply through full pipeline (including linter) on a `is_test=1` thread. Never sends to Telegram. |

PATCH `/api/telegram/groups/:id` accepts these new keys: `salesPersona`,
`productPitch`, `technicalPrompt`, `qualificationQuestions` (in addition to
existing fields).

## Schema changes (v3)

`account_groups`:
- `sales_persona TEXT NOT NULL DEFAULT ''`
- `product_pitch TEXT NOT NULL DEFAULT ''`
- `technical_prompt TEXT NOT NULL DEFAULT ''`
- `qualification_questions TEXT NOT NULL DEFAULT ''`

`conversation_threads`:
- `is_test INTEGER NOT NULL DEFAULT 0` (1 for playground threads; filtered
  out of all production read paths including `listReadyThreads`,
  `findOrCreateThread`, `sweepStaleLeads`, `syncLeadFromThread`, snapshot leads JOIN)

All ALTERs are wrapped in duplicate-column traps, safe to re-run.

## CRM behaviors (preserved from v2)

- Drag-and-drop lead chips between stage cells in `/tg-crm/`
- 🚨 escalation badge on chips whose thread has `escalation_count > 0` or `state='escalated'`
- Auto-Hold (>7d no inbound) and auto-Archive (>30d no inbound) via `sweepStaleLeads`
  hourly tick (skipped for `manual_stage_id` overrides and `stage-5` winners)
- Junk-bot inbound filter at mtproto event handler (`sender.bot === true` → drop)
- Em-dash sanitizer on outbound text (`stripLongDashes`)

## Health page

Live at `https://rsnetwork.pro/admin/tg-bots/health`. Polls
`GET /api/health/snapshot` every 5s while document visible. Pause toggle.
"Run health check" button POSTs to `/api/health/check`.

Alerts derive from observable state:
- `session_age_days > 25` → warn ("сессия @X истекает через ~N дней")
- `health === "limited"|"down"` → critical
- `counters_24h.openrouter_errors > 0` → critical
- Zero escalations during MSK business hours with inbound > 5 → warn

## Operations cheatsheet

```bash
# What can I see right now?
sqlite3 /opt/tgbots/data/tgbots.sqlite3 \
  "SELECT id, name, length(sales_persona), length(technical_prompt) FROM account_groups;"

# Did the v3 backfill run?
sqlite3 /opt/tgbots/data/tgbots.sqlite3 \
  "SELECT COUNT(*) FROM sqlite_master WHERE name='account_groups_premigration_2026_05_25';"

# Tail with stage transitions
pm2 logs tg-bots --nostream --lines 200 | grep -E '\[lint\]|escalated|ai-reply'

# Force a re-test of a group
curl -X POST http://127.0.0.1:4173/api/playground/run \
  -b /tmp/cookies.txt -H 'content-type: application/json' \
  -d '{"groupId":"grp-...","accountId":"mt-...","inboundText":"..."}'
```
