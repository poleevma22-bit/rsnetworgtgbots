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

function setAuthed() {
  document.body.classList.remove("auth-locked");
  authScreen.hidden = true;
}

function setSelect(selectId, html) {
  const select = document.getElementById(selectId);
  if (select) select.innerHTML = html;
}

function renderOptions() {
  setSelect(
    "summaryAccount",
    snapshot.accounts.length
      ? snapshot.accounts.map((item) => `<option value="${item.id}">${item.id} / ${item.name}</option>`).join("")
      : `<option value="">аккаунт не добавлен</option>`
  );
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
          <input name="databaseName" value="${escapeHtml(binding.database)}">
        </label>
        <select name="salesSkill" class="skill-select">
          ${optionList(skills, binding.salesSkill)}
        </select>
        <div class="timer-cell">
          <select name="timerProfile" class="timer-select">
            ${timerRows(binding.salesSkill, binding.timerProfile)}
          </select>
          <label>Набор, сек<input name="typingSeconds" type="number" min="3" max="30" value="${binding.typingSeconds || 5}"></label>
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
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const message = document.getElementById("settingsMessage");
      message.textContent = "Сохранение настроек...";
      message.classList.remove("error");
      try {
        const payload = formPayload(form);
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

async function refresh() {
  snapshot = await api("/api/snapshot");
  renderAll();
}

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
    form.elements.contacts.value = await file.text();
  } else {
    form.elements.contacts.value = "";
    document.getElementById("accountMessage").textContent = "Excel-файл выбран. Для разбора XLSX нужен серверный парсер; сейчас будет сохранено имя базы.";
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
    if (payload.contacts || payload.filename) {
      const imported = await api("/api/imports", {
        method: "POST",
        body: JSON.stringify({ filename: payload.filename, contacts: payload.contacts })
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
  const output = document.getElementById("summaryOutput");
  output.textContent = "AI анализирует выбранный account ID...";
  try {
    const payload = await api("/api/ai-summary", {
      method: "POST",
      body: JSON.stringify(formPayload(event.currentTarget))
    });
    output.textContent = payload.summary;
  } catch (error) {
    output.textContent = error.message;
  }
});

document.getElementById("holdSummaryButton").addEventListener("click", async () => {
  const output = document.getElementById("holdSummaryOutput");
  output.textContent = "Формирую summary по Hold...";
  try {
    const payload = await api("/api/ai/hold-summary", { method: "POST", body: "{}" });
    output.textContent = payload.summary;
  } catch (error) {
    output.textContent = error.message;
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
