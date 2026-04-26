import { summarizeDialog } from "./safety.js";

export const store = {
  clients: [
    {
      id: "client-rs-network",
      name: "RS Network",
      brand: "RS Network",
      status: "active",
      ownerEmail: "admin@rs.local",
      createdAt: "2026-04-26T00:00:00.000Z"
    }
  ],
  telegramUpdates: [],
  accounts: [
    {
      id: "tg-100241",
      name: "Sales Moscow 01",
      handle: "@sales_msk_01",
      avatarUrl: "",
      status: "connected",
      health: "ok",
      connector: "Telegram API app",
      databaseId: "db-1",
      promptText: "Работать по разрешенной базе контактов. Квалифицировать бюджет, срок, роль собеседника и следующий шаг. Если сценария не хватает, переводить сделку в Hold и запрашивать summary у главного AI.",
      salesSkill: "qualification",
      timerProfile: "wait_60s",
      repeatIntervalMinutes: null,
      replyDelaySeconds: 60,
      typingSeconds: 5,
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
      databaseId: "db-1",
      promptText: "Поддерживать партнерский пресейл: уточнять контекст, фиксировать требования, не давить, SLA-вопросы поднимать в приоритет. При задержке писать короткий статус без обещаний вне регламента.",
      salesSkill: "queue_reaction",
      timerProfile: "wait_5m",
      repeatIntervalMinutes: null,
      replyDelaySeconds: 300,
      typingSeconds: 5,
      workingHoursPerDay: 5,
      messagesSent: 42
    }
  ],
  prompts: [],
  stages: [
    { id: "stage-1", title: "Новый контакт", color: "#64748b" },
    { id: "stage-2", title: "Квалификация", color: "#0f766e" },
    { id: "stage-3", title: "Презентация", color: "#7c3aed" },
    { id: "stage-offer", title: "Оффер отправлен", color: "#2563eb" },
    { id: "stage-4", title: "Согласование", color: "#b45309" },
    { id: "stage-onboarding", title: "Онбординг", color: "#15803d" },
    { id: "stage-5", title: "Выиграно", color: "#15803d" },
    { id: "stage-hold", title: "Hold", color: "#71717a" },
    { id: "stage-archive", title: "Archive", color: "#525252" }
  ],
  databases: [
    {
      id: "db-1",
      filename: "telegram-contacts-demo.txt",
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
      status: "Ожидает первого ответа после формы.",
      comment: "Проверить источник заявки до ответа.",
      lastReplyAt: null,
      messages: []
    },
    {
      id: "lead-3",
      telegram: "@procurement_team",
      accountId: "tg-100241",
      stageId: "stage-offer",
      status: "Оффер отправлен, ждут DPA и SLA.",
      comment: "Юрист запросил DPA и условия поддержки.",
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
    },
    {
      id: "lead-5",
      telegram: "@new_ops_team",
      accountId: "tg-100241",
      stageId: "stage-onboarding",
      status: "Онбординг: согласован старт и список доступов.",
      comment: "Проверить готовность аккаунтов и интеграций.",
      lastReplyAt: "2026-04-25T10:00:00.000Z",
      messages: [
        { direction: "in", text: "Готовы начать, пришлем доступы." },
        { direction: "out", text: "Принял. Зафиксирую старт и список доступов." }
      ]
    }
  ]
};

export function getSnapshot() {
  const accountMap = Object.fromEntries(store.accounts.map((account) => [account.id, account]));
  const stageMap = Object.fromEntries(store.stages.map((stage) => [stage.id, stage]));
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
    databaseId: account.databaseId,
    database: databaseMap[account.databaseId]?.filename ?? "База не загружена",
    salesSkill: account.salesSkill || "first_contact",
    timerProfile: account.timerProfile || "wait_60s",
    promptText: account.promptText || account.scriptNote || "",
    repeatIntervalMinutes: account.repeatIntervalMinutes ?? null,
    replyDelaySeconds: account.replyDelaySeconds,
    typingSeconds: account.typingSeconds ?? 5,
    timer: `${account.replyDelaySeconds} сек / набор ${account.typingSeconds} сек`
  }));

  const hold = store.leads.filter((lead) => lead.stageId === "stage-hold").length;
  const offer = store.leads.filter((lead) => lead.stageId === "stage-offer").length;
  const onboarding = store.leads.filter((lead) => lead.stageId === "stage-onboarding").length;

  return {
    accounts: store.accounts,
    clients: store.clients,
    telegramUpdates: store.telegramUpdates.slice(-20),
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
      hold,
      offer,
      onboarding,
      archived: store.leads.filter((lead) => lead.stageId === "stage-archive").length,
      accountsInWork: store.accounts.length,
      connectedAccounts: store.accounts.filter((account) => account.status === "connected").length,
      messagesSent: store.accounts.reduce((sum, account) => sum + account.messagesSent, 0),
      telegramUpdates: store.telegramUpdates.length,
      nextRefresh: "каждые 3 часа"
    }
  };
}
