let snapshot = null;

const sections = document.querySelectorAll(".section");
const navButtons = document.querySelectorAll(".nav button");
const sidebar = document.getElementById("sidebar");
const pageTitle = document.getElementById("pageTitle");

document.getElementById("burger").addEventListener("click", () => {
  sidebar.classList.toggle("collapsed");
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

function renderAccountScriptTable() {
  const table = document.getElementById("accountScriptTable");
  if (!snapshot.accounts.length) {
    table.innerHTML = `<div class="empty-state">аккаунт не добавлен</div>`;
    return;
  }

  table.innerHTML = `
    <div class="script-row header">
      <span>Аккаунт</span>
      <span>TXT база</span>
      <span>Скрипт</span>
      <span>Общий промпт / алгоритм</span>
      <span></span>
    </div>
    ${snapshot.bindings.map((binding) => `
      <form class="script-row account-settings-form" data-account-id="${binding.accountId}">
        <div>
          <strong>${binding.accountId}</strong>
          <small>${binding.accountName}</small>
        </div>
        <select name="databaseId">${options(snapshot.databases, binding.databaseId, (item) => item.filename)}</select>
        <select name="promptId">${options(snapshot.prompts, binding.promptId, (item) => item.title)}</select>
        <textarea name="scriptNote" rows="3">${binding.scriptNote || ""}</textarea>
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
  renderAccountScriptTable();
  renderCrmMatrix();
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

refresh().catch((error) => {
  document.getElementById("backendStatus").textContent = `backend: ${error.message}`;
});
