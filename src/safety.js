export const MIN_REPLY_DELAY_SECONDS = 60;
export const MIN_TYPING_SECONDS = 8;
export const MAX_WORKING_HOURS_PER_DAY = 8;

export function validateAutomationPolicy(settings = {}) {
  const errors = [];
  const replyDelaySeconds = Number(settings.replyDelaySeconds);
  const typingSeconds = Number(settings.typingSeconds);
  const workingHoursPerDay = Number(settings.workingHoursPerDay);

  if (!Number.isFinite(replyDelaySeconds) || replyDelaySeconds < MIN_REPLY_DELAY_SECONDS) {
    errors.push(`Минимальная задержка ответа: ${MIN_REPLY_DELAY_SECONDS} секунд.`);
  }

  if (!Number.isFinite(typingSeconds) || typingSeconds < MIN_TYPING_SECONDS) {
    errors.push(`Минимальное время набора: ${MIN_TYPING_SECONDS} секунд.`);
  }

  if (!Number.isFinite(workingHoursPerDay) || workingHoursPerDay > MAX_WORKING_HOURS_PER_DAY) {
    errors.push(`Максимальное рабочее окно аккаунта: ${MAX_WORKING_HOURS_PER_DAY} часов в день.`);
  }

  if (settings.outreachMode === "cold_mass") {
    errors.push("Массовые холодные рассылки отключены. Разрешены только opt-in диалоги и импорт с подтвержденным основанием контакта.");
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

export function summarizeDialog(messages = []) {
  if (!messages.length) return "Нет сообщений для summary.";
  const last = messages[messages.length - 1];
  const incoming = messages.filter((message) => message.direction === "in").length;
  const outgoing = messages.filter((message) => message.direction === "out").length;
  return `Диалог: ${incoming} входящих, ${outgoing} исходящих. Последний сигнал: ${last.text.slice(0, 110)}`;
}
