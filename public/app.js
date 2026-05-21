let snapshot = null;
let crmFilter = "all";

const skills = [
  { id: "first_contact", label: "Первичный контакт" },
  { id: "qualification", label: "Квалификация" },
  { id: "objection_handling", label: "Работа с возражениями" },
  { id: "delayed_message", label: "Отложенное сообщение" },
  { id: "regular_followup", label: "Регулярные сообщения" },
  { id: "queue_reaction", label: "Очередь и задержка" },
  { id: "informal_dialog", label: "Неформальный диалог" }
];

const waitTimers = [
  { id: "wait_60s", label: "Игнор 1 минута" },
  { id: "wait_5m", label: "Игнор 5 минут" },
  { id: "wait_10m", label: "Игнор 10 минут" },
  { id: "wait_15m", label: "Игнор 15 минут" },
  { id: "wait_30m", label: "Игнор 30 минут" }
];

const regularTimers = [
  { id: "repeat_2d", label: "Повтор раз в 2 дня" },
  { id: "repeat_7d", label: "Повтор раз в неделю" },
  { id: "repeat_14d", label: "Повтор раз в 2 недели" },
  { id: "repeat_30d", label: "Повтор раз в месяц" }
];

const sections = document.querySelectorAll(".section");
const navButtons = document.querySelectorAll(".nav button");
const sidebar = document.getElementById("sidebar");
const pageTitle = document.getElementById("pageTitle");
const authScreen = document.getElementById("authScreen");
const accountModal = document.getElementById("accountModal");
const assistantDrawer = document.getElementById("assistantDrawer");

document.getElementById("burger").addEventListener("click", () => {
  sidebar.classList.toggle("collapsed");
});

document.querySelectorAll("[data-auth-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-auth-tab]").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".auth-form").forEach((form) => form.classList.remove("active"));
    button.classList.add("active");
    document.getElementById(`${button.dataset.authTab}Form`).classList.add("active");
  });
});

navButtons.forEach((button) => {
  button.addEventListener("click", () => {
    navButtons.forEach((item) => item.classList.remove("active"));
    sections.forEach((section) => section.classList.remove("active"));
    button.classList.add("active");
    const section = document.getElementById(button.dataset.section);
    section.classList.add("active");
    pageTitle.textContent = section.dataset.title;
  });
});

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.errors?.join(" ") || payload.error || "Ошибка API");
  }
  return payload;
}

function formPayload(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function optionList(rows, selected) {
  return rows.map((row) => `<option value="${row.id}" ${row.id === selected ? "selected" : ""}>${row.label}</option>`).join("");
}

function timerRows(skill, selected) {
  const rows = skill === "regular_followup" ? regularTimers : waitTimers;
  return optionList(rows, selected || rows[0].id);
}

function normalizeTelegramText(text = "") {
  const handles = [
    ...String(text).matchAll(/(?:^|[\s,;])@([a-zA-Z0-9_]{5,32})\b/g),
    ...String(text).matchAll(/(?:https?:\/\/)?t\.me\/([a-zA-Z0-9_]{5,32})\b/g)
  ];
  return [...new Set(handles.map((match) => `@${match[1]}`))].join("\n");
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

async function buildImportPayload(file) {
  if (/\.(xlsx|xls)$/i.test(file.name)) {
    return {
      filename: file.name,
      fileBase64: arrayBufferToBase64(await file.arrayBuffer())
    };
  }
  const text = await file.text();
  return {
    filename: file.name,
    contacts: normalizeTelegramText(text)
  };
}

function setAuthed() {
  document.body.classList.remove("auth-locked");
  authScreen.hidden = true;
}

function setSelect(selectId, html) {
  const select = document.getElementById(selectId);
  if (select) select.innerHTML = html;
}

function renderOptions() {
  const accountOptions = snapshot.accounts.length
    ? snapshot.accounts.map((item) => `<option value="${item.id}">${item.id} / ${item.name}</option>`).join("")
    : `<option value="">аккаунт не добавлен</option>`;
  setSelect(
    "summaryAccount",
    accountOptions
  );
  setSelect("assistantAccount", `<option value="">Все аккаунты</option>${accountOptions}`);
  setSelect(
    "crmAccountFilter",
    `<option value="all">Все аккаунты</option>${snapshot.accounts.map((item) => `<option value="${item.id}" ${crmFilter === item.id ? "selected" : ""}>${item.id} / ${item.name}</option>`).join("")}`
  );
  setSelect("modalSkill", optionList(skills, "first_contact"));
  setSelect("modalTimer", timerRows("first_contact", "wait_60s"));
}

function renderMetrics() {
  document.getElementById("metricAccounts").textContent = snapshot.analytics.accountsInWork;
  document.getElementById("metricMessages").textContent = snapshot.analytics.messagesSent;
  document.getElementById("metricReplies").textContent = snapshot.analytics.answered;
  document.getElementById("metricHold").textContent = snapshot.analytics.hold;
}

function renderAnalyticsTable() {
  document.getElementById("analyticsTable").innerHTML = `
    <div class="row header analytics-row">
      <span>Account ID</span><span>Статус</span><span>Сообщения</span><span>Replies</span><span>Hold</span><span>Оффер</span><span>Онбординг</span><span>Hot leads</span>
    </div>
    ${snapshot.accounts.map((account) => {
      const leads = snapshot.leads.filter((lead) => lead.accountId === account.id);
      const replies = leads.filter((lead) => lead.lastReplyAt).length;
      const hold = leads.filter((lead) => lead.stageId === "stage-hold").length;
      const offer = leads.filter((lead) => lead.stageId === "stage-offer").length;
      const onboarding = leads.filter((lead) => lead.stageId === "stage-onboarding").length;
      const hot = leads.filter((lead) => ["stage-3", "stage-4", "stage-offer"].includes(lead.stageId)).length;
      return `
        <div class="row analytics-row">
          <span>${account.id}<small>${escapeHtml(account.name)}</small></span>
          <span>${escapeHtml(account.status)} / ${escapeHtml(account.health)}</span>
          <span>${account.messagesSent}</span>
          <span>${replies}</span>
          <span>${hold}</span>
          <span>${offer}</span>
          <span>${onboarding}</span>
          <span>${hot}</span>
        </div>
      `;
    }).join("")}
  `;
}

function renderAccountSettingsTable() {
  const table = document.getElementById("accountSettingsTable");
  if (!snapshot.accounts.length) {
    table.innerHTML = `<div class="empty-state">аккаунт не добавлен</div>`;
    return;
  }

  table.innerHTML = `
    <div class="settings-row header">
      <span>Аккаунт</span>
      <span>База контактов</span>
      <span>Скилл</span>
      <span>Таймер</span>
      <span>Промпт</span>
      <span></span>
    </div>
    ${snapshot.bindings.map((binding) => `
      <form class="settings-row account-settings-form" data-account-id="${binding.accountId}">
        <div>
          <strong>${binding.accountId}</strong>
          <small>${escapeHtml(binding.accountName)}</small>
        </div>
        <label class="file-cell">
          <span>${escapeHtml(binding.database)}</span>
          <input name="contactFile" type="file" accept=".txt,.csv,.xlsx,.xls">
        </label>
        <select name="salesSkill" class="skill-select">
          ${optionList(skills, binding.salesSkill)}
        </select>
        <div class="timer-cell">
          <select name="timerProfile" class="timer-select">
            ${timerRows(binding.salesSkill, binding.timerProfile)}
          </select>
          <small>Набор встроен: 3-5 секунд</small>
        </div>
        <textarea name="promptText" rows="4" placeholder="Один общий prompt для аккаунта">${escapeHtml(binding.promptText || "")}</textarea>
        <button type="submit">Сохранить</button>
      </form>
    `).join("")}
  `;

  table.querySelectorAll(".skill-select").forEach((select) => {
    select.addEventListener("change", () => {
      const timer = select.closest("form").querySelector(".timer-select");
      timer.innerHTML = timerRows(select.value, "");
    });
  });

  table.querySelectorAll(".account-settings-form").forEach((form) => {
    form.querySelector('input[type="file"]').addEventListener("change", async (event) => {
      const file = event.currentTarget.files[0];
      if (!file) return;
      const message = document.getElementById("settingsMessage");
      message.textContent = `Загрузка базы ${file.name}...`;
      message.classList.remove("error");
      try {
        const payload = await buildImportPayload(file);
        payload.accountId = form.dataset.accountId;
        const imported = await api("/api/imports", {
          method: "POST",
          body: JSON.stringify(payload)
        });
        message.textContent = `База обновлена: ${imported.import.valid} Telegram username, отклонено: ${imported.import.rejected}.`;
        await refresh();
      } catch (error) {
        message.textContent = error.message;
        message.classList.add("error");
      }
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const message = document.getElementById("settingsMessage");
      message.textContent = "Сохранение настроек...";
      message.classList.remove("error");
      try {
        const payload = formPayload(form);
        delete payload.contactFile;
        payload.accountId = form.dataset.accountId;
        await api("/api/account-settings", {
          method: "POST",
          body: JSON.stringify(payload)
        });
        message.textContent = "Настройки аккаунта сохранены.";
        await refresh();
      } catch (error) {
        message.textContent = error.message;
        message.classList.add("error");
      }
    });
  });
}

function renderCrmMatrix() {
  const matrix = document.getElementById("crmMatrix");
  const accounts = crmFilter === "all" ? snapshot.accounts : snapshot.accounts.filter((account) => account.id === crmFilter);
  const header = ["Account ID", ...snapshot.stages.map((stage) => stage.title)];
  const rows = accounts.map((account) => {
    const cells = snapshot.stages.map((stage) => {
      const leads = snapshot.leads.filter((lead) => lead.accountId === account.id && lead.stageId === stage.id);
      if (!leads.length) return `<div class="crm-cell muted-cell">-</div>`;
      return `
        <div class="crm-cell">
          ${leads.map((lead) => `
            <button class="lead-chip ${stage.id === "stage-hold" ? "hold-chip" : ""}" type="button" data-lead-id="${lead.id}" title="${escapeHtml(lead.status)} Комментарий: ${escapeHtml(lead.comment || "нет")}">
              ${escapeHtml(lead.telegram)}
              ${lead.nextPingAt ? `<small>ping: ${new Date(lead.nextPingAt).toLocaleDateString("ru-RU")}</small>` : ""}
            </button>
          `).join("")}
        </div>
      `;
    }).join("");
    return `
      <div class="matrix-row">
        <div class="account-cell">
          <strong>${account.id}</strong>
          <small>${escapeHtml(account.name)}</small>
        </div>
        ${cells}
      </div>
    `;
  }).join("");

  matrix.style.setProperty("--stage-count", snapshot.stages.length);
  matrix.innerHTML = `
    <div class="matrix-row header">
      ${header.map((title) => `<div>${escapeHtml(title)}</div>`).join("")}
    </div>
    ${rows || `<div class="empty-state">По выбранному аккаунту сделок нет.</div>`}
  `;

  matrix.querySelectorAll(".lead-chip").forEach((chip) => {
    chip.addEventListener("click", async () => {
      const lead = snapshot.leads.find((item) => item.id === chip.dataset.leadId);
      if (!lead) return;
      // If the templates-module exposes the stage modal (Wave 3), use it —
      // it lets the operator move the lead AND edit the comment in one go.
      // Falls back to the old prompt() flow on older deployments.
      if (typeof window.openStageModal === "function") {
        window.openStageModal(lead);
        return;
      }
      const comment = window.prompt(`Комментарий для ${lead.telegram}`, lead.comment || "");
      if (comment === null) return;
      await api("/api/leads/comment", {
        method: "POST",
        body: JSON.stringify({ leadId: lead.id, comment })
      });
      await refresh();
    });
  });
}

function renderAll() {
  renderOptions();
  renderMetrics();
  renderAnalyticsTable();
  renderAccountSettingsTable();
  renderCrmMatrix();
}

function setSystemAnswer(elementId, text) {
  const target = document.getElementById(elementId);
  target.innerHTML = `<div class="system-label">System</div><div>${escapeHtml(text)}</div>`;
}

function addAssistantMessage(text, type = "system") {
  const messages = document.getElementById("assistantMessages");
  const item = document.createElement("div");
  item.className = `assistant-message ${type}`;
  item.textContent = text;
  messages.appendChild(item);
  messages.scrollTop = messages.scrollHeight;
}

async function refresh() {
  snapshot = await api("/api/snapshot");
  renderAll();
}
// Expose for the templates module so the stage-flip modal can soft-refresh.
window.refresh = refresh;

document.getElementById("crmAccountFilter").addEventListener("change", (event) => {
  crmFilter = event.currentTarget.value;
  renderCrmMatrix();
});

document.getElementById("modalSkill").addEventListener("change", (event) => {
  document.getElementById("modalTimer").innerHTML = timerRows(event.currentTarget.value, "");
});

document.getElementById("openAccountModal").addEventListener("click", () => {
  document.getElementById("accountForm").reset();
  document.getElementById("modalSkill").innerHTML = optionList(skills, "first_contact");
  document.getElementById("modalTimer").innerHTML = timerRows("first_contact", "wait_60s");
  accountModal.hidden = false;
});

document.getElementById("closeAccountModal").addEventListener("click", () => {
  accountModal.hidden = true;
});

accountModal.addEventListener("click", (event) => {
  if (event.target === accountModal) accountModal.hidden = true;
});

document.getElementById("modalContactFile").addEventListener("change", async (event) => {
  const file = event.currentTarget.files[0];
  if (!file) return;
  const form = document.getElementById("accountForm");
  form.elements.filename.value = file.name;
  if (/\.(txt|csv)$/i.test(file.name)) {
    form.elements.contacts.value = normalizeTelegramText(await file.text());
  } else {
    form.elements.contacts.value = "";
    document.getElementById("accountMessage").textContent = "Excel-файл выбран. Сервер извлечет Telegram username при сохранении.";
  }
});

document.getElementById("accountForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.getElementById("accountMessage");
  message.textContent = "Сохранение аккаунта...";
  message.classList.remove("error");
  try {
    const payload = formPayload(form);
    const file = document.getElementById("modalContactFile").files[0];
    if (file) {
      Object.assign(payload, await buildImportPayload(file));
    }
    if (payload.contacts || payload.fileBase64 || payload.filename) {
      const imported = await api("/api/imports", {
        method: "POST",
        body: JSON.stringify({ filename: payload.filename, contacts: payload.contacts, fileBase64: payload.fileBase64 })
      });
      payload.databaseId = imported.import.id;
    }
    await api("/api/accounts", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    message.textContent = "Аккаунт добавлен.";
    accountModal.hidden = true;
    await refresh();
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("error");
  }
});

document.getElementById("summaryForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  setSystemAnswer("summaryOutput", "AI анализирует выбранный account ID...");
  try {
    const payload = await api("/api/ai-summary", {
      method: "POST",
      body: JSON.stringify(formPayload(event.currentTarget))
    });
    setSystemAnswer("summaryOutput", payload.summary);
  } catch (error) {
    setSystemAnswer("summaryOutput", error.message);
  }
});

document.getElementById("holdSummaryButton").addEventListener("click", async () => {
  setSystemAnswer("holdSummaryOutput", "Формирую summary по Hold...");
  try {
    const payload = await api("/api/ai/hold-summary", { method: "POST", body: "{}" });
    setSystemAnswer("holdSummaryOutput", payload.summary);
  } catch (error) {
    setSystemAnswer("holdSummaryOutput", error.message);
  }
});

document.getElementById("assistantToggle").addEventListener("click", () => {
  assistantDrawer.hidden = false;
});

document.getElementById("assistantClose").addEventListener("click", () => {
  assistantDrawer.hidden = true;
});

document.getElementById("assistantForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = formPayload(event.currentTarget);
  addAssistantMessage(payload.question || "Запрос без текста", "user");
  try {
    const response = await api("/api/ai/chat", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    addAssistantMessage(response.answer, "system");
  } catch (error) {
    addAssistantMessage(error.message, "system error");
  }
});

async function authSubmit(form, path) {
  const message = document.getElementById("authMessage");
  message.textContent = "Проверка...";
  message.classList.remove("error");
  try {
    await api(path, {
      method: "POST",
      body: JSON.stringify(formPayload(form))
    });
    setAuthed();
    await refresh();
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("error");
  }
}

document.getElementById("loginForm").addEventListener("submit", (event) => {
  event.preventDefault();
  authSubmit(event.currentTarget, "/api/login");
});

document.getElementById("registerForm").addEventListener("submit", (event) => {
  event.preventDefault();
  authSubmit(event.currentTarget, "/api/register");
});

document.getElementById("logoutButton").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST", body: "{}" });
  document.body.classList.add("auth-locked");
  authScreen.hidden = false;
});

api("/api/session")
  .then(async (payload) => {
    if (payload.authenticated) {
      setAuthed();
      await refresh();
    }
  })
  .catch(() => {});
// === Prompt templates module (added 2026-05-17) ===
//
// Hooks into the existing /opt/tgbots/public admin: a new "Шаблоны промптов"
// section with full CRUD for prompt templates, live variable extraction, and
// per-group binding (template + per-group variable values).
//
// The backend exposes:
//   GET    /api/telegram/templates                     → list (with usedByGroups count)
//   POST   /api/telegram/templates                     → create { name, description, body, defaults }
//   GET    /api/telegram/templates/:id                 → one
//   PATCH  /api/telegram/templates/:id                 → update partial
//   DELETE /api/telegram/templates/:id                 → delete (detaches groups)
//   POST   /api/telegram/templates/preview             → { variables } extracted from {{var}} markers
//   GET    /api/telegram/groups                        → list (each carries template_id + template_vars_json)
//   POST   /api/telegram/groups/:id/template           → bind/unbind { templateId, variables }
//
// All UI labels are Russian to match the rest of the admin.

(function setupPromptTemplates() {
  const VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_\-]*)\s*\}\}/g;
  function detectVars(body) {
    const out = [];
    const seen = new Set();
    for (const m of String(body || "").matchAll(VAR_RE)) {
      if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
    }
    return out;
  }
  function esc(v) {
    return String(v ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  let templates = [];
  let groups = [];

  async function loadAll() {
    const [tplResp, grpResp] = await Promise.all([
      api("/api/telegram/templates"),
      api("/api/telegram/groups"),
    ]);
    templates = tplResp.templates || [];
    groups = grpResp.groups || [];
    renderTemplatesList();
    renderGroupsBindList();
  }

  // ---------- Templates list ----------

  function renderTemplatesList() {
    const list = document.getElementById("templatesList");
    if (!list) return;
    if (!templates.length) {
      list.innerHTML = `<div class="template-card" style="text-align:center;color:var(--muted);">
        Шаблонов пока нет. Создайте первый кнопкой «+ Новый шаблон».
      </div>`;
      return;
    }
    list.innerHTML = templates.map(renderTemplateCard).join("");
    list.querySelectorAll("[data-tpl-edit]").forEach((btn) => {
      btn.addEventListener("click", () => openTemplateModal(btn.dataset.tplEdit));
    });
    list.querySelectorAll("[data-tpl-dup]").forEach((btn) => {
      btn.addEventListener("click", () => duplicateTemplate(btn.dataset.tplDup));
    });
  }

  function renderTemplateCard(tpl) {
    const vars = (tpl.variables || []).map((v) => `<span class="template-chip">{{${esc(v)}}}</span>`).join("");
    return `
      <article class="template-card">
        <div class="template-card-head">
          <strong>${esc(tpl.name)}</strong>
          <span class="template-meta">${tpl.usedByGroups || 0} групп(ы) · ${tpl.body.length}c</span>
        </div>
        ${tpl.description ? `<div class="template-card-desc">${esc(tpl.description)}</div>` : ""}
        <div class="template-card-body">${esc(tpl.body.slice(0, 400))}${tpl.body.length > 400 ? "…" : ""}</div>
        <div class="template-chips">${vars || `<span class="template-chip muted">переменных нет</span>`}</div>
        <div class="template-card-actions">
          <button type="button" data-tpl-edit="${tpl.id}">Редактировать</button>
          <button type="button" data-tpl-dup="${tpl.id}">Дублировать</button>
        </div>
      </article>
    `;
  }

  async function duplicateTemplate(id) {
    const src = templates.find((t) => t.id === id);
    if (!src) return;
    await api("/api/telegram/templates", {
      method: "POST",
      body: JSON.stringify({
        name: `${src.name} (копия)`,
        description: src.description,
        body: src.body,
        defaults: src.defaults || {},
      }),
    });
    await loadAll();
  }

  // ---------- Template create/edit modal ----------

  const templateModal = document.getElementById("templateModal");
  const templateForm = document.getElementById("templateForm");

  function openTemplateModal(id = null) {
    templateForm.reset();
    document.getElementById("templateFormId").value = id || "";
    document.getElementById("templateModalMessage").textContent = "";
    document.getElementById("templateFormDelete").hidden = !id;
    if (id) {
      const t = templates.find((x) => x.id === id);
      document.getElementById("templateModalTitle").textContent = `Шаблон: ${t.name}`;
      document.getElementById("templateFormName").value = t.name;
      document.getElementById("templateFormDescription").value = t.description || "";
      document.getElementById("templateFormBody").value = t.body || "";
    } else {
      document.getElementById("templateModalTitle").textContent = "Новый шаблон промпта";
    }
    refreshTemplateFormVars();
    templateModal.hidden = false;
  }

  function refreshTemplateFormVars() {
    const body = document.getElementById("templateFormBody").value;
    const vars = detectVars(body);
    const chips = document.getElementById("templateFormVars");
    chips.innerHTML = vars.length
      ? vars.map((v) => `<span class="template-chip">{{${esc(v)}}}</span>`).join("")
      : `<span class="template-chip muted">тело пустое или без переменных</span>`;

    // Render the defaults form: one row per variable, prefilled from the
    // currently-edited template (if any) so operator can tweak fallbacks.
    const defaultsHost = document.getElementById("templateFormDefaults");
    const editingId = document.getElementById("templateFormId").value;
    const editing = editingId ? templates.find((t) => t.id === editingId) : null;
    const existing = (editing && editing.defaults) || {};
    defaultsHost.innerHTML = vars.length
      ? vars.map((v) => `
        <label>${esc(v)}
          <input data-default-name="${esc(v)}" value="${esc(existing[v] || "")}" placeholder="(нет значения по умолчанию)">
        </label>`).join("")
      : `<span class="template-chip muted">— нечего настраивать —</span>`;
  }

  document.getElementById("openTemplateModal").addEventListener("click", () => openTemplateModal());
  document.getElementById("closeTemplateModal").addEventListener("click", () => { templateModal.hidden = true; });
  templateModal.addEventListener("click", (e) => { if (e.target === templateModal) templateModal.hidden = true; });
  document.getElementById("templateFormBody").addEventListener("input", refreshTemplateFormVars);

  templateForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const msg = document.getElementById("templateModalMessage");
    msg.textContent = "Сохраняем…";
    msg.classList.remove("error");
    try {
      const id = document.getElementById("templateFormId").value;
      const name = document.getElementById("templateFormName").value.trim();
      const description = document.getElementById("templateFormDescription").value;
      const body = document.getElementById("templateFormBody").value;
      const defaults = {};
      document.querySelectorAll("#templateFormDefaults [data-default-name]").forEach((inp) => {
        const v = inp.value.trim();
        if (v) defaults[inp.dataset.defaultName] = v;
      });
      const payload = { name, description, body, defaults };
      if (id) {
        await api(`/api/telegram/templates/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
      } else {
        await api("/api/telegram/templates", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      }
      templateModal.hidden = true;
      await loadAll();
    } catch (err) {
      msg.classList.add("error");
      msg.textContent = err.message || "Ошибка сохранения";
    }
  });

  document.getElementById("templateFormDelete").addEventListener("click", async () => {
    const id = document.getElementById("templateFormId").value;
    if (!id) return;
    if (!confirm("Удалить шаблон? Привязки групп будут отвязаны (вернутся к legacy group_prompt).")) return;
    try {
      await api(`/api/telegram/templates/${encodeURIComponent(id)}`, { method: "DELETE" });
      templateModal.hidden = true;
      await loadAll();
    } catch (err) {
      const msg = document.getElementById("templateModalMessage");
      msg.classList.add("error");
      msg.textContent = err.message || "Не удалось удалить";
    }
  });

  // ---------- Groups → template binding ----------

  function renderGroupsBindList() {
    const host = document.getElementById("groupsBindList");
    if (!host) return;
    if (!groups.length) {
      host.innerHTML = `<div class="group-bind-row" style="text-align:center;color:var(--muted);">
        Групп аккаунтов пока нет. Создайте их в apps/web /admin/tg-bots → Группы.
      </div>`;
      return;
    }
    host.innerHTML = groups.map(renderGroupBindRow).join("");
    host.querySelectorAll("[data-bind-group]").forEach((btn) => {
      btn.addEventListener("click", () => openBindModal(btn.dataset.bindGroup));
    });
  }

  function renderGroupBindRow(g) {
    const tpl = g.template_id ? templates.find((t) => t.id === g.template_id) : null;
    const values = safeJsonParse(g.template_vars_json, {});
    const missing = tpl ? (tpl.variables || []).filter((v) => !values[v] && !(tpl.defaults || {})[v]) : [];
    const summary = tpl
      ? `Шаблон: <code>${esc(tpl.name)}</code>${missing.length ? ` · <span class="template-chip unbound">не задано: ${missing.map(esc).join(", ")}</span>` : ""}`
      : `<span class="template-chip muted">шаблон не привязан — используется legacy group_prompt</span>`;
    return `
      <div class="group-bind-row">
        <div>
          <strong>${esc(g.name)}</strong>
          <div class="template-meta" style="color:var(--muted);font-size:11px;">${g.members.length} аккаунт(ов)${g.escalation_username ? ` · эскалация @${esc(g.escalation_username)}` : ""}</div>
        </div>
        <div class="group-bind-template">${summary}</div>
        <button type="button" data-bind-group="${g.id}" class="secondary-button" style="padding:6px 14px;">Изменить</button>
      </div>
    `;
  }

  function safeJsonParse(text, fallback) {
    try { return text ? JSON.parse(text) : fallback; } catch { return fallback; }
  }

  // ---------- Bind modal ----------

  const bindModal = document.getElementById("bindModal");
  const bindForm = document.getElementById("bindForm");

  function openBindModal(groupId) {
    const g = groups.find((x) => x.id === groupId);
    if (!g) return;
    document.getElementById("bindFormGroupId").value = groupId;
    document.getElementById("bindModalTitle").textContent = `Привязка шаблона: ${g.name}`;
    document.getElementById("bindModalMessage").textContent = "";
    document.getElementById("bindFormEscalation").value = g.escalation_username || "";
    document.getElementById("bindFormKb").value = g.knowledge_base || "";
    document.getElementById("bindFormOffer").value = g.offer_message || "";
    document.getElementById("bindFormObjections").value = g.objections || "";
    renderBindAttachments(groupId);
    // Populate template select.
    const select = document.getElementById("bindFormTemplate");
    select.innerHTML = `<option value="">— не выбран (legacy group_prompt) —</option>` +
      templates.map((t) => `<option value="${t.id}" ${t.id === g.template_id ? "selected" : ""}>${esc(t.name)}</option>`).join("");
    select.onchange = () => renderBindVars(groupId, select.value);
    renderBindVars(groupId, g.template_id || "");
    bindModal.hidden = false;
  }

  function renderBindVars(groupId, templateId) {
    const host = document.getElementById("bindFormVars");
    if (!templateId) {
      host.innerHTML = `<span class="template-chip muted">шаблон не выбран — группа будет использовать legacy group_prompt</span>`;
      return;
    }
    const t = templates.find((x) => x.id === templateId);
    if (!t) { host.innerHTML = ""; return; }
    const g = groups.find((x) => x.id === groupId);
    const existing = safeJsonParse(g?.template_vars_json, {});
    const vars = t.variables || [];
    if (!vars.length) {
      host.innerHTML = `<span class="template-chip muted">шаблон не содержит переменных — нечего настраивать</span>`;
      return;
    }
    host.innerHTML = vars.map((v) => {
      const value = existing[v] ?? "";
      const placeholder = (t.defaults || {})[v] || "";
      const isLong = (t.body.match(new RegExp(`\\{\\{\\s*${v}\\s*\\}\\}`)) || []).length > 1 || (placeholder && placeholder.length > 80);
      const input = isLong
        ? `<textarea data-var="${esc(v)}" rows="3" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
        : `<input data-var="${esc(v)}" placeholder="${esc(placeholder)}" value="${esc(value)}">`;
      return `<label>{{${esc(v)}}}${placeholder ? `<small style="color:var(--muted);font-weight:400;">по умолч.: ${esc(placeholder.slice(0, 60))}</small>` : ""}${input}</label>`;
    }).join("");
  }

  document.getElementById("closeBindModal").addEventListener("click", () => { bindModal.hidden = true; });
  bindModal.addEventListener("click", (e) => { if (e.target === bindModal) bindModal.hidden = true; });

  bindForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const msg = document.getElementById("bindModalMessage");
    msg.textContent = "Сохраняем…";
    msg.classList.remove("error");
    try {
      const groupId = document.getElementById("bindFormGroupId").value;
      const templateId = document.getElementById("bindFormTemplate").value || null;
      const escalationUsername = document.getElementById("bindFormEscalation").value.trim().replace(/^@/, "");
      const knowledgeBase = document.getElementById("bindFormKb").value;
      const offerMessage = document.getElementById("bindFormOffer").value;
      const objections = document.getElementById("bindFormObjections").value;
      const variables = {};
      document.querySelectorAll("#bindFormVars [data-var]").forEach((inp) => {
        const v = inp.value;
        if (v != null && v !== "") variables[inp.dataset.var] = v;
      });
      // Two writes: template binding (templates endpoint) + escalation handle
      // on the group itself (PATCH /groups/:id). The bind endpoint doesn't
      // touch escalation_username, so we update it separately.
      await Promise.all([
        api(`/api/telegram/groups/${encodeURIComponent(groupId)}/template`, {
          method: "POST",
          body: JSON.stringify({ templateId, variables }),
        }),
        api(`/api/telegram/groups/${encodeURIComponent(groupId)}`, {
          method: "PATCH",
          body: JSON.stringify({ escalationUsername, knowledgeBase, offerMessage, objections }),
        }),
      ]);
      bindModal.hidden = true;
      await loadAll();
    } catch (err) {
      msg.classList.add("error");
      msg.textContent = err.message || "Ошибка сохранения";
    }
  });

  document.getElementById("bindFormUnbind").addEventListener("click", async () => {
    const groupId = document.getElementById("bindFormGroupId").value;
    if (!groupId) return;
    if (!confirm("Отвязать шаблон от группы? Группа вернётся к legacy group_prompt.")) return;
    try {
      await api(`/api/telegram/groups/${encodeURIComponent(groupId)}/template`, {
        method: "POST",
        body: JSON.stringify({ templateId: null, variables: {} }),
      });
      bindModal.hidden = true;
      await loadAll();
    } catch (err) {
      const msg = document.getElementById("bindModalMessage");
      msg.classList.add("error");
      msg.textContent = err.message || "Не удалось отвязать";
    }
  });

  // ---------- Auto-load when section becomes active ----------

  const tmplNavBtn = document.querySelector('[data-section="templates"]');
  if (tmplNavBtn) {
    tmplNavBtn.addEventListener("click", () => {
      loadAll().catch((err) => {
        const msg = document.getElementById("templatesMessage");
        if (msg) { msg.classList.add("error"); msg.textContent = err.message || "Не удалось загрузить"; }
      });
    });
  }

  // ---------- Offer attachments (Wave 2A) ----------

  async function renderBindAttachments(groupId) {
    const host = document.getElementById("bindFormAttachments");
    host.innerHTML = `<span class="template-chip muted">— загружаю —</span>`;
    try {
      const resp = await api(`/api/telegram/groups/${encodeURIComponent(groupId)}/attachments`);
      const files = resp.attachments || [];
      if (!files.length) {
        host.innerHTML = `<span class="template-chip muted">— нет файлов —</span>`;
        return;
      }
      host.innerHTML = files.map((f) => `
        <div class="attachment-row">
          <span class="attachment-name">${esc(f.filename)}</span>
          <span class="attachment-meta">${esc(f.mime)} · ${Math.round(f.size / 1024)} KB</span>
          <button type="button" class="attachment-remove" data-att-id="${esc(f.id)}" title="Удалить">×</button>
        </div>
      `).join("");
      host.querySelectorAll("[data-att-id]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          if (!confirm(`Удалить файл из оффера?`)) return;
          try {
            await api(`/api/telegram/groups/${encodeURIComponent(groupId)}/attachments/${encodeURIComponent(btn.dataset.attId)}`, { method: "DELETE" });
            renderBindAttachments(groupId);
          } catch (err) { alert(err.message || "Не удалось удалить"); }
        });
      });
    } catch (err) {
      host.innerHTML = `<span class="template-chip muted">Ошибка: ${esc(err.message)}</span>`;
    }
  }

  document.getElementById("bindFormAttFile").addEventListener("change", async (event) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    const groupId = document.getElementById("bindFormGroupId").value;
    if (!groupId) return;
    if (file.size > 20 * 1024 * 1024) { alert("Файл больше 20 MB"); event.currentTarget.value = ""; return; }
    const host = document.getElementById("bindFormAttachments");
    host.innerHTML = `<span class="template-chip muted">— загружаю «${esc(file.name)}» —</span>`;
    try {
      const contentBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      await api(`/api/telegram/groups/${encodeURIComponent(groupId)}/attachments`, {
        method: "POST",
        body: JSON.stringify({ filename: file.name, mime: file.type || "application/octet-stream", contentBase64 }),
      });
      event.currentTarget.value = "";
      renderBindAttachments(groupId);
    } catch (err) {
      alert(err.message || "Не удалось загрузить");
      renderBindAttachments(groupId);
    }
  });

  // ---------- Manual CRM stage flip (Wave 3) ----------

  const stageModal = document.getElementById("stageModal");
  const stageForm = document.getElementById("stageForm");

  // Expose a global function so the existing CRM matrix's lead-chip click
  // handler in /opt/tgbots/public/app.js can open this modal. The legacy
  // app.js was patched to call window.openStageModal(lead) instead of
  // prompt()-ing for a comment.
  window.openStageModal = function openStageModal(lead) {
    if (!lead) return;
    document.getElementById("stageFormLeadId").value = lead.id;
    // chat_id on the lead row equals thread.id (see syncLeadFromThread).
    document.getElementById("stageFormThreadId").value = lead.chatId || lead.chat_id || "";
    document.getElementById("stageFormStage").value = ""; // default: auto
    document.getElementById("stageFormClientBrand").value = lead.clientBrand || "";
    document.getElementById("stageFormComment").value = lead.comment || "";
    document.getElementById("stageModalTitle").textContent = `Лид: ${lead.telegram || lead.telegramHandle || lead.id}`;
    document.getElementById("stageModalMessage").textContent = "";
    // Render dialog history from lead.messages (already on snapshot).
    const histHost = document.getElementById("stageFormHistory");
    const msgs = Array.isArray(lead.messages) ? lead.messages.slice(-30) : [];
    if (!msgs.length) {
      histHost.innerHTML = `<span class="template-chip muted">— пусто —</span>`;
    } else {
      histHost.innerHTML = msgs.map((m) => {
        const ts = m.at ? new Date(typeof m.at === "number" ? m.at : Date.parse(m.at)).toLocaleString("ru-RU") : "";
        const cls = m.direction === "in" ? "msg-in" : "msg-out";
        return `<div class="dialog-msg ${cls}"><div class="dialog-msg-meta">${esc(m.direction === "in" ? "клиент" : "бот")} · ${esc(ts)}</div><div class="dialog-msg-text">${esc((m.text || "").slice(0, 800))}</div></div>`;
      }).join("");
    }
    stageModal.hidden = false;
  };

  document.getElementById("closeStageModal").addEventListener("click", () => { stageModal.hidden = true; });
  stageModal.addEventListener("click", (e) => { if (e.target === stageModal) stageModal.hidden = true; });

  stageForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const msg = document.getElementById("stageModalMessage");
    msg.textContent = "Сохраняем…";
    msg.classList.remove("error");
    try {
      const threadId = document.getElementById("stageFormThreadId").value;
      const leadId = document.getElementById("stageFormLeadId").value;
      const stageId = document.getElementById("stageFormStage").value;
      const clientBrand = document.getElementById("stageFormClientBrand").value;
      const comment = document.getElementById("stageFormComment").value;
      const calls = [];
      if (threadId) {
        calls.push(api("/api/leads/stage", {
          method: "POST",
          body: JSON.stringify({ threadId, stageId, clientBrand }),
        }));
      }
      if (leadId) {
        calls.push(api("/api/leads/comment", {
          method: "POST",
          body: JSON.stringify({ leadId, comment }),
        }));
      }
      await Promise.all(calls);
      stageModal.hidden = true;
      // Trigger a soft snapshot refresh via the legacy refresh() exposed on window.
      if (typeof window.refresh === "function") window.refresh();
    } catch (err) {
      msg.classList.add("error");
      msg.textContent = err.message || "Ошибка сохранения";
    }
  });

  // ---------- Broadcast launcher + list (Wave 4C) ----------

  async function loadBroadcasts() {
    // Populate sender dropdown: accounts + groups.
    const senderSel = document.getElementById("broadcastSender");
    if (senderSel) {
      const snap = await api("/api/snapshot").catch(() => ({ accounts: [] }));
      const accounts = (snap.accounts || []).filter((a) => a.kind === "mtproto" && a.status === "connected");
      senderSel.innerHTML =
        accounts.map((a) => `<option value="acc:${esc(a.id)}">${esc(a.handle || a.name)} (account)</option>`).join("") +
        groups.map((g) => `<option value="grp:${esc(g.id)}">${esc(g.name)} (group, ${g.members?.length || 0} accounts)</option>`).join("");
    }
    // Populate broadcasts list.
    try {
      const resp = await api("/api/telegram/broadcast");
      const host = document.getElementById("broadcastsList");
      const jobs = resp.jobs || [];
      if (!jobs.length) { host.innerHTML = `<div style="text-align:center;color:var(--muted);padding:14px;">Рассылок ещё не было.</div>`; return; }
      host.innerHTML = jobs.map((j) => {
        const created = new Date(j.created_at).toLocaleString("ru-RU");
        const total = (() => { try { return JSON.parse(j.targets_json || "[]").length; } catch { return "?"; } })();
        const statusColor = j.status === "running" ? "#fde68a" : (j.status === "done" ? "#86efac" : "#fca5a5");
        return `<div class="broadcast-row">
          <div><strong>${esc(j.id)}</strong><small style="color:var(--muted);"> · ${esc(j.account_id)} · ${esc(created)}</small></div>
          <div>статус: <span style="color:${statusColor};font-weight:700;">${esc(j.status)}</span> · отправлено ${j.sent_count}/${total} · ошибок ${j.failed_count}</div>
          <div class="broadcast-msg">${esc((j.message_text || "").slice(0, 200))}${(j.message_text || "").length > 200 ? "…" : ""}</div>
          ${j.status === "running" ? `<button class="danger-button" type="button" data-bc-cancel="${esc(j.id)}" style="padding:4px 12px;font-size:11px;">Остановить</button>` : ""}
        </div>`;
      }).join("");
      host.querySelectorAll("[data-bc-cancel]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          if (!confirm(`Остановить рассылку ${btn.dataset.bcCancel}?`)) return;
          try { await api(`/api/telegram/broadcast/${encodeURIComponent(btn.dataset.bcCancel)}`, { method: "DELETE" }); loadBroadcasts(); }
          catch (e) { alert(e.message); }
        });
      });
    } catch (err) {
      const host = document.getElementById("broadcastsList");
      if (host) host.innerHTML = `<div style="color:#fca5a5;padding:14px;">Ошибка загрузки: ${esc(err.message)}</div>`;
    }
  }

  const broadcastForm = document.getElementById("broadcastForm");
  if (broadcastForm) {
    broadcastForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const msg = document.getElementById("broadcastMessage_status");
      msg.textContent = "Запускаем…";
      msg.classList.remove("error");
      try {
        const senderRaw = document.getElementById("broadcastSender").value;
        const [senderKind, senderId] = senderRaw.split(":");
        const messageText = document.getElementById("broadcastMessage").value.trim();
        const targetsRaw = document.getElementById("broadcastTargets").value;
        const targets = [];
        for (const line of targetsRaw.split(/\r?\n/)) {
          const m = line.match(/(?:@|t\.me\/)([a-zA-Z0-9_]{5,32})/);
          if (m) targets.push({ target: `@${m[1]}` });
        }
        if (!targets.length) throw new Error("Не нашёл ни одного валидного @username в списке получателей.");
        const payload = {
          messageText,
          targets,
          intervalMs: Math.max(5000, Number(document.getElementById("broadcastInterval").value || 60) * 1000),
          taskType: document.getElementById("broadcastTaskType").value,
          replyIgnoreMinMs: Math.max(5000, Number(document.getElementById("broadcastReplyMin").value || 60) * 1000),
          replyIgnoreMaxMs: Math.max(5000, Number(document.getElementById("broadcastReplyMax").value || 120) * 1000),
          typingMinMs: Math.max(1000, Number(document.getElementById("broadcastTypingMin").value || 5) * 1000),
          typingMaxMs: Math.max(1000, Number(document.getElementById("broadcastTypingMax").value || 10) * 1000),
          repeatEnabled: document.getElementById("broadcastRepeat").checked,
          repeatIntervalMs: Math.max(1, Number(document.getElementById("broadcastRepeatDays").value || 7)) * 86_400_000,
        };
        if (senderKind === "acc") payload.accountId = senderId;
        else if (senderKind === "grp") payload.groupId = senderId;
        await api("/api/telegram/broadcast", { method: "POST", body: JSON.stringify(payload) });
        msg.textContent = `Запущено. ${targets.length} получателей.`;
        broadcastForm.reset();
        loadBroadcasts();
      } catch (err) {
        msg.classList.add("error");
        msg.textContent = err.message || "Не удалось запустить.";
      }
    });
    document.getElementById("broadcastsRefresh").addEventListener("click", loadBroadcasts);
  }

  // ---------- Junk-leads cleanup (Wave 4D) ----------

  const cleanupBtn = document.getElementById("leadsCleanupBtn");
  if (cleanupBtn) {
    cleanupBtn.addEventListener("click", async () => {
      const msg = document.getElementById("leadsCleanupMsg");
      msg.textContent = "";
      if (!confirm("Удалить лиды от анон-ботов + лиды без живого треда?")) return;
      try {
        const r = await api("/api/leads/cleanup", { method: "POST" });
        msg.textContent = `Удалено: junk ${r.removed?.junk || 0}, orphan ${r.removed?.orphan || 0}.`;
        if (typeof window.refresh === "function") window.refresh();
      } catch (err) {
        msg.classList.add("error");
        msg.textContent = err.message || "Ошибка";
      }
    });
  }

  // Load broadcasts when their tab is opened.
  const bcTabBtn = document.querySelector('[data-section="broadcasts"]');
  if (bcTabBtn) bcTabBtn.addEventListener("click", () => setTimeout(loadBroadcasts, 50));

  // Eager-load once the page becomes authenticated. We poll for the
  // `auth-locked` body class going away, since existing app.js doesn't emit
  // a session event we can hook into.
  let eagerLoaded = false;
  function tryEagerLoad() {
    if (eagerLoaded) return;
    if (document.body.classList.contains("auth-locked")) return;
    eagerLoaded = true;
    loadAll().catch(() => { eagerLoaded = false; });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(tryEagerLoad, 200));
  } else {
    setTimeout(tryEagerLoad, 200);
  }
  // Re-try shortly after every nav click in case auth has just landed.
  document.querySelectorAll(".nav button").forEach((btn) => {
    btn.addEventListener("click", () => setTimeout(tryEagerLoad, 50));
  });
})();
