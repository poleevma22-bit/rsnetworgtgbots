// Snapshot composition. Demo accounts/leads/databases removed.
// Stages remain as in-code constants (UI references them by id).
import { summarizeDialog } from "./safety.js";
import { listAccounts, listLeads, listDatabases } from "./db.js";

// Stages are part of the product UX and rarely change; keeping them in code.
export const stages = [
  { id: "stage-1", title: "Новый контакт", color: "#64748b" },
  { id: "stage-2", title: "Квалификация", color: "#0f766e" },
  { id: "stage-3", title: "Презентация", color: "#7c3aed" },
  { id: "stage-offer", title: "Оффер отправлен", color: "#2563eb" },
  { id: "stage-4", title: "Согласование", color: "#b45309" },
  { id: "stage-onboarding", title: "Онбординг", color: "#15803d" },
  { id: "stage-5", title: "Выиграно", color: "#15803d" },
  { id: "stage-hold", title: "Hold", color: "#71717a" },
  { id: "stage-archive", title: "Archive", color: "#525252" }
];

// Single static client header — kept so existing UI doesn't break.
// (Real multi-tenant clients can be added later through /api/clients.)
const defaultClients = [
  {
    id: "client-rs-network",
    name: "RS Network",
    brand: "RS Network",
    status: "active",
    ownerEmail: "admin@rs.local",
    createdAt: new Date().toISOString()
  }
];

export const store = {
  // Mutable bits the existing handlers still touch directly.
  // accounts/leads/databases are now read from SQLite via getSnapshot().
  clients: defaultClients,
  prompts: [],
  stages,
  telegramUpdates: []
};

export function getSnapshot() {
  const accounts = listAccounts();
  const databases = listDatabases();
  const leadsRaw = listLeads();
  const accountMap = Object.fromEntries(accounts.map((a) => [a.id, a]));
  const stageMap = Object.fromEntries(stages.map((s) => [s.id, s]));
  const dbMap = Object.fromEntries(databases.map((d) => [d.id, d]));

  const leads = leadsRaw.map((lead) => ({
    ...lead,
    account: accountMap[lead.accountId]?.name ?? "Не назначен",
    stage: stageMap[lead.stageId]?.title ?? "Без этапа",
    summary: summarizeDialog(lead.messages)
  }));

  const bindings = accounts.map((account) => ({
    accountId: account.id,
    accountName: account.name,
    databaseId: account.databaseId,
    database: dbMap[account.databaseId]?.filename ?? "База не загружена",
    salesSkill: account.salesSkill || "first_contact",
    timerProfile: account.timerProfile || "wait_60s",
    promptText: account.promptText || "",
    repeatIntervalMinutes: account.repeatIntervalMinutes ?? null,
    replyDelaySeconds: account.replyDelaySeconds,
    typingSeconds: account.typingSeconds ?? 5,
    timer: `${account.replyDelaySeconds ?? 60} сек / набор ${account.typingSeconds ?? 5} сек`
  }));

  const hold = leads.filter((l) => l.stageId === "stage-hold").length;
  const offer = leads.filter((l) => l.stageId === "stage-offer").length;
  const onboarding = leads.filter((l) => l.stageId === "stage-onboarding").length;

  return {
    accounts,
    clients: store.clients,
    telegramUpdates: store.telegramUpdates.slice(-20),
    prompts: store.prompts,
    stages,
    databases,
    leads,
    bindings,
    analytics: {
      contactsTotal: databases.reduce((sum, item) => sum + item.total, 0),
      contactsUsed: leads.length,
      answered: leads.filter((l) => l.lastReplyAt).length,
      ignored: leads.filter((l) => !l.lastReplyAt).length,
      hold,
      offer,
      onboarding,
      archived: leads.filter((l) => l.stageId === "stage-archive").length,
      accountsInWork: accounts.length,
      connectedAccounts: accounts.filter((a) => a.status === "connected").length,
      messagesSent: accounts.reduce((sum, a) => sum + (a.messagesSent || 0), 0),
      telegramUpdates: store.telegramUpdates.length,
      nextRefresh: "live"
    }
  };
}
