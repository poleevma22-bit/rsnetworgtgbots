let snapshot = null;

const sections = document.querySelectorAll(".section");
const navButtons = document.querySelectorAll(".nav button");
const sidebar = document.getElementById("sidebar");
const pageTitle = document.getElementById("pageTitle");
const authScreen = document.getElementById("authScreen");

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

function setAuthed(user) {
  document.body.classList.remove("auth-locked");
  authScreen.hidden = true;
  document.getElementById("backendStatus").textContent = `user: ${user.email}`;
}

function options(rows, selected, labeler) {
  return rows.map((row) => `<option value="${row.id}" ${row.id === selected ? "selected" : ""}>${labeler(row)}</option>`).join("");
}

function setOptions(selectId, rows, emptyText, labeler = (item) => item.name || item.title || item.filename) {
  const select = document.getElementById(selectId);
  if (!select) return;
  if (!rows.length) {
    select.innerHTML = `<option value="">${emptyText}</option>`;
    select.disabled = true;
    return;
  }

  select.disabled = false;
  select.innerHTML = rows.map((row) => `<option value="${row.id}">${labeler(row)}</option>`).join("");
}

function renderOptions() {
  setOptions("summaryAccount", snapshot.accounts, "аккаунт не добавлен", (item) => `${item.id} / ${item.name}`);
}

function renderMetrics() {
  document.getElementById("metricAccounts").textContent = snapshot.analytics.accountsInWork;
  document.getElementById("metricMessages").textContent = snapshot.analytics.messagesSent;
  document.getElementById("metricContacts").textContent = snapshot.analytics.contactsTotal;
  document.getElementById("metricHold").textContent = snapshot.analytics.hold;
}

function renderAnalyticsTable() {
  document.getElementById("analyticsTable").innerHTML = `
    <div class="row header"><span>Account ID</span><span>Статус</span><span>Сообщения</span><span>Контакты</span><span>Hold</span></div>
    ${snapshot.accounts.map((account) => {
      const leads = snapshot.leads.filter((lead) => lead.accountId === account.id);
      const hold = leads.filter((lead) => lead.stageId === "stage-hold").length;
      return `
        <div class="row">
          <span>${account.id}<small>${account.name}</small></span>
          <span>${account.status} / ${account.health}</span>
          <span>${account.messagesSent}</span>
          <span>${leads.length}</span>
          <span>${hold}</span>
        </div>
      `;
    }).join("")}
  `;
}

function renderClients() {
  const table = document.getElementById("clientTable");
  if (!table) return;
  table.innerHTML = `
    <div class="row header"><span>ID</span><span>Клиент</span><span>Бренд</span><span>Владелец</span><span>Статус</span></div>
    ${snapshot.clients.map((client) => `
      <div class="row">
        <span>${client.id}</span>
        <span>${client.name}</span>
        <span>${client.brand}</span>
        <span>${client.ownerEmail || "-"}</span>
        <span>${client.status}</span>
      </div>
    `).join("")}
  `;
}

async function renderTelegramStatus() {
  const box = document.getElementById("telegramStatus");
  if (!box) return;
  try {
    const payload = await api("/api/telegram/status");
    const tg = payload.telegram;
    box.innerHTML = `
      <div><strong>Webhook path</strong><span>${tg.webhookPath}</span></div>
      <div><strong>Bot token</strong><span>${tg.configured ? "configured" : "not configured"}</span></div>
      <div><strong>Public URL</strong><span>${tg.publicWebhookUrl || "not configured"}</span></div>
      <div><strong>Secret</strong><span>${tg.hasSecret ? "configured" : "not configured"}</span></div>
    `;
  } catch (error) {
    box.textContent = error.message;
  }
}

function renderAccountScriptTable() {
  const table = document.getElementById("accountScriptTable");
  if (!snapshot.accounts.length) {
    table.innerHTML = `<div class="empty-state">аккаунт не добавлен</div>`;
    return;
  }

  table.innerHTML = `
    <div class="script-row header">
      <span>Аккаунт</span>
      <span>База / prompt</span>
      <span>Скилл / тип</span>
      <span>Таймеры</span>
      <span>Сценарий</span>
      <span></span>
    </div>
    ${snapshot.bindings.map((binding) => `
      <form class="script-row account-settings-form" data-account-id="${binding.accountId}">
        <div>
          <strong>${binding.accountId}</strong>
          <small>${binding.accountName}</small>
        </div>
        <div class="cell-stack">
          <select name="databaseId">${options(snapshot.databases, binding.databaseId, (item) => item.filename)}</select>
          <select name="promptId">${options(snapshot.prompts, binding.promptId, (item) => item.title)}</select>
        </div>
        <div class="cell-stack">
          <select name="salesSkill">
            <option value="qualification" ${binding.salesSkill === "qualification" ? "selected" : ""}>Квалификация</option>
            <option value="objection_handling" ${binding.salesSkill === "objection_handling" ? "selected" : ""}>Работа с возражениями</option>
            <option value="regular_followup" ${binding.salesSkill === "regular_followup" ? "selected" : ""}>Регулярный follow-up</option>
            <option value="queue_reaction" ${binding.salesSkill === "queue_reaction" ? "selected" : ""}>Очередь и задержка</option>
            <option value="informal_dialog" ${binding.salesSkill === "informal_dialog" ? "selected" : ""}>Неформальный диалог</option>
          </select>
          <select name="messageType">
            <option value="opt_in_intro" ${binding.messageType === "opt_in_intro" ? "selected" : ""}>Первичное opt-in</option>
            <option value="reply" ${binding.messageType === "reply" ? "selected" : ""}>Ответ клиенту</option>
            <option value="scheduled" ${binding.messageType === "scheduled" ? "selected" : ""}>Отложенное</option>
            <option value="queue_update" ${binding.messageType === "queue_update" ? "selected" : ""}>Очередь</option>
            <option value="hold_ping" ${binding.messageType === "hold_ping" ? "selected" : ""}>Hold ping</option>
          </select>
        </div>
        <div class="cell-stack">
          <input name="typingSeconds" type="number" min="8" value="${binding.typingSeconds}" title="Время набора">
          <input name="replyDelaySeconds" type="number" min="60" value="${binding.replyDelaySeconds}" title="Минимальное время ответа">
          <input name="repeatIntervalMinutes" type="number" min="60" value="${binding.repeatIntervalMinutes}" title="Повтор, минут">
        </div>
        <div class="cell-stack">
          <textarea name="scriptNote" rows="2" placeholder="Общий prompt / алгоритм">${binding.scriptNote || ""}</textarea>
          <textarea name="persona" rows="2" placeholder="Роль оператора / тональность">${binding.persona || ""}</textarea>
          <textarea name="delayedMessage" rows="2" placeholder="Отложенное сообщение">${binding.delayedMessage || ""}</textarea>
          <textarea name="queueFallback" rows="2" placeholder="Сообщение при задержке / очереди">${binding.queueFallback || ""}</textarea>
        </div>
        <div class="script-actions">
          <label class="checkline"><input type="checkbox" name="exclusiveScript" value="true" checked> без конфликта</label>
          <button type="submit">Сохранить</button>
        </div>
      </form>
    `).join("")}
  `;

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
  const header = ["Account ID", ...snapshot.stages.map((stage) => stage.title)];
  const rows = snapshot.accounts.map((account) => {
    const cells = snapshot.stages.map((stage) => {
      const leads = snapshot.leads.filter((lead) => lead.accountId === account.id && lead.stageId === stage.id);
      if (!leads.length) return `<div class="crm-cell muted-cell">-</div>`;
      return `
        <div class="crm-cell">
          ${leads.map((lead) => `
            <button class="lead-chip ${stage.id === "stage-hold" ? "hold-chip" : ""}" type="button" data-lead-id="${lead.id}" title="${lead.status} Комментарий: ${lead.comment || "нет"}">
              ${lead.telegram}
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
          <small>${account.name}</small>
        </div>
        ${cells}
      </div>
    `;
  }).join("");

  matrix.style.setProperty("--stage-count", snapshot.stages.length);
  matrix.innerHTML = `
    <div class="matrix-row header">
      ${header.map((title) => `<div>${title}</div>`).join("")}
    </div>
    ${rows}
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

async function submitJson(form, path, messageId) {
  const message = document.getElementById(messageId);
  message.textContent = "Сохранение...";
  message.classList.remove("error");

  try {
    await api(path, {
      method: "POST",
      body: JSON.stringify(formPayload(form))
    });
    message.textContent = "Сохранено и проверено backend.";
    await refresh();
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("error");
  }
}

function renderAll() {
  renderOptions();
  renderMetrics();
  renderAnalyticsTable();
  renderClients();
  renderAccountScriptTable();
  renderCrmMatrix();
  renderTelegramStatus();
}

async function refresh() {
  snapshot = await api("/api/snapshot");
  document.getElementById("backendStatus").textContent = "backend: online";
  renderAll();
}

document.getElementById("promptForm").addEventListener("submit", (event) => {
  event.preventDefault();
  submitJson(event.currentTarget, "/api/prompts", "promptMessage");
});

document.getElementById("importForm").addEventListener("submit", (event) => {
  event.preventDefault();
  submitJson(event.currentTarget, "/api/imports", "importMessage");
});

document.getElementById("contactFile").addEventListener("change", async (event) => {
  const file = event.currentTarget.files[0];
  if (!file) return;
  const form = document.getElementById("importForm");
  form.elements.filename.value = file.name;
  if (/\.(txt|csv)$/i.test(file.name)) {
    form.elements.contacts.value = await file.text();
  } else {
    form.elements.contacts.value = "";
    document.getElementById("importMessage").textContent = "Excel-файл выбран. Для полноценного парсинга на сервере нужен XLSX-парсер; сейчас будет сохранено имя базы.";
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

document.getElementById("clientForm").addEventListener("submit", (event) => {
  event.preventDefault();
  submitJson(event.currentTarget, "/api/clients", "clientMessage");
});

document.getElementById("setWebhookButton").addEventListener("click", async () => {
  const message = document.getElementById("telegramMessage");
  message.textContent = "Подключение webhook...";
  message.classList.remove("error");
  try {
    const payload = await api("/api/telegram/set-webhook", { method: "POST", body: "{}" });
    message.textContent = `Webhook готов: ${payload.webhookUrl}`;
    await renderTelegramStatus();
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("error");
  }
});

async function authSubmit(form, path) {
  const message = document.getElementById("authMessage");
  message.textContent = "Проверка...";
  message.classList.remove("error");
  try {
    const payload = await api(path, {
      method: "POST",
      body: JSON.stringify(formPayload(form))
    });
    setAuthed(payload.user);
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
      setAuthed(payload.user);
      await refresh();
    }
  })
  .catch(() => {});
