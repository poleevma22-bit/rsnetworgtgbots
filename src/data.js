import { summarizeDialog } from "./safety.js";

export const store = {
  accounts: [
    {
      id: "tg-100241",
      name: "Sales Moscow 01",
      handle: "@sales_msk_01",
      avatarUrl: "",
      status: "connected",
      health: "ok",
      connector: "Telegram API app",
      promptId: "prompt-1",
      databaseId: "db-1",
      scriptNote: "Работать только по opt-in контактам. Квалифицировать бюджет, срок и роль, затем передавать менеджеру.",
      replyDelaySeconds: 90,
      typingSeconds: 14,
      workingHoursPerDay: 6,
      messagesSent: 148
    },
    {
      id: "tg-100317",
      name: "Partner Support",
      handle: "@partner_support",
      avatarUrl: "",
      status: "review",
      health: "limited",
      connector: "Bot API",
      promptId: "prompt-2",
      databaseId: "db-1",
      scriptNote: "Сценарий поддержки партнеров: уточнить контекст, зафиксировать требования и поднять приоритет для SLA-вопросов.",
      replyDelaySeconds: 180,
      typingSeconds: 18,
      workingHoursPerDay: 5,
      messagesSent: 42
    }
  ],
  prompts: [
    {
      id: "prompt-1",
      title: "B2B квалификация",
      businessCase: "Квалифицировать входящие заявки по бюджету, срокам и роли собеседника.",
      messageTemplates: [
        "Здравствуйте. Подскажите, какая задача сейчас приоритетна для команды?",
        "Правильно понимаю, что ключевой критерий - скорость внедрения?"
      ],
      priorityRules: "Сначала отвечать на горячие лиды с бюджетом и сроком до 30 дней."
    },
    {
      id: "prompt-2",
      title: "Партнерский пресейл",
      businessCase: "Собрать контекст партнера и передать менеджеру только подтвержденные сделки.",
      messageTemplates: [
        "Спасибо за детали. Я зафиксирую требования и передам менеджеру.",
        "Есть ли ограничения по интеграции или безопасности?"
      ],
      priorityRules: "VIP-партнеры, активные сделки и SLA-вопросы выше обычных обращений."
    }
  ],
  stages: [
    { id: "stage-1", title: "Новый контакт", color: "#64748b" },
    { id: "stage-2", title: "Квалификация", color: "#0f766e" },
    { id: "stage-3", title: "Презентация", color: "#7c3aed" },
    { id: "stage-4", title: "Согласование", color: "#b45309" },
    { id: "stage-5", title: "Выиграно", color: "#15803d" },
    { id: "stage-hold", title: "Hold", color: "#71717a" },
    { id: "stage-archive", title: "Archive", color: "#525252" }
  ],
  databases: [
    {
      id: "db-1",
      filename: "opt-in-demo.txt",
      total: 320,
      valid: 304,
      rejected: 16,
      createdAt: "2026-04-24T07:00:00.000Z",
      sample: ["@client_ops", "https://t.me/procurement_team"]
    }
  ],
  leads: [
    {
      id: "lead-1",
      telegram: "@client_ops",
      accountId: "tg-100241",
      stageId: "stage-2",
      status: "Ответил, просит расчет на 20 пользователей.",
      comment: "Передать менеджеру расчет и интеграционный чеклист.",
      lastReplyAt: "2026-04-24T09:30:00.000Z",
      messages: [
        { direction: "out", text: "Здравствуйте. Подскажите, какая задача сейчас приоритетна для команды?" },
        { direction: "in", text: "Нужен расчет на 20 пользователей и интеграция с CRM." }
      ]
    },
    {
      id: "lead-2",
      telegram: "@founder_north",
      accountId: "tg-100317",
      stageId: "stage-1",
      status: "Ожидает первого ответа после opt-in формы.",
      comment: "Проверить источник заявки до ответа.",
      lastReplyAt: null,
      messages: []
    },
    {
      id: "lead-3",
      telegram: "@procurement_team",
      accountId: "tg-100241",
      stageId: "stage-4",
      status: "Согласуют договор и DPA.",
      comment: "Юрист запросил SLA и DPA.",
      lastReplyAt: "2026-04-24T06:15:00.000Z",
      messages: [
        { direction: "in", text: "Пришлите DPA и условия поддержки." },
        { direction: "out", text: "Отправляю пакет документов и отмечаю вопрос по SLA." }
      ]
    },
    {
      id: "lead-4",
      telegram: "@ops_director",
      accountId: "tg-100317",
      stageId: "stage-hold",
      status: "Сделка на hold: клиент вернется к вопросу в следующем месяце.",
      comment: "Пинг раз в месяц по статусу проекта.",
      nextPingAt: "2026-05-24T09:00:00.000Z",
      lastReplyAt: "2026-04-20T10:00:00.000Z",
      messages: [
        { direction: "in", text: "Вернемся к обсуждению через месяц." },
        { direction: "out", text: "Зафиксировал. Напомню о статусе проекта в следующем месяце." }
      ]
    }
  ]
};

export function getSnapshot() {
  const accountMap = Object.fromEntries(store.accounts.map((account) => [account.id, account]));
  const stageMap = Object.fromEntries(store.stages.map((stage) => [stage.id, stage]));
  const promptMap = Object.fromEntries(store.prompts.map((prompt) => [prompt.id, prompt]));
  const databaseMap = Object.fromEntries(store.databases.map((database) => [database.id, database]));

  const leads = store.leads.map((lead) => ({
    ...lead,
    account: accountMap[lead.accountId]?.name ?? "Не назначен",
    stage: stageMap[lead.stageId]?.title ?? "Без этапа",
    summary: summarizeDialog(lead.messages)
  }));

  const bindings = store.accounts.map((account) => ({
    accountId: account.id,
    accountName: account.name,
    promptId: account.promptId,
    databaseId: account.databaseId,
    scriptNote: account.scriptNote || "",
    prompt: promptMap[account.promptId]?.title ?? "Промпт не выбран",
    database: databaseMap[account.databaseId]?.filename ?? "База не выбрана",
    timer: `${account.replyDelaySeconds} сек / набор ${account.typingSeconds} сек`
  }));

  return {
    accounts: store.accounts,
    prompts: store.prompts,
    stages: store.stages,
    databases: store.databases,
    leads,
    bindings,
    analytics: {
      contactsTotal: store.databases.reduce((sum, item) => sum + item.total, 0),
      contactsUsed: store.leads.length,
      answered: store.leads.filter((lead) => lead.lastReplyAt).length,
      ignored: store.leads.filter((lead) => !lead.lastReplyAt).length,
      hold: store.leads.filter((lead) => lead.stageId === "stage-hold").length,
      archived: store.leads.filter((lead) => lead.stageId === "stage-archive").length,
      accountsInWork: store.accounts.length,
      connectedAccounts: store.accounts.filter((account) => account.status === "connected").length,
      messagesSent: store.accounts.reduce((sum, account) => sum + account.messagesSent, 0),
      nextRefresh: "каждые 3 часа"
    }
  };
}
