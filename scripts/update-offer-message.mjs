// Update the group's offer_message to mirror the betongame intro the operator
// uses in real conversations. The bot will send this text + 2 generated PDFs
// (DSP + Meta) after AI emits [[OFFER_SENT]].

const HOST = "http://127.0.0.1:4173";
const GROUP_ID = "grp-167e73544bc3";

const OFFER_MESSAGE = `Высылаю оффер на обеих платформах (DSP и Meta).

9200 EUR за 3 источника для ретеншна — DSP + Meta + YouTube (без стран ЕС).

Касательно интеграции: наши девы подтвердили что никаких проблем с подключением через s2s не было — Spinbetter и другие бренды на этой схеме уже работают с нами.

Сейчас пришлю два PDF с детальной разбивкой по DSP и Meta — посмотрите цифры под ваш объём, и если ок — закроем интеграцию за 1-2 недели от подписания NDA.

Удобно созвониться на этой неделе для обсуждения деталей?`;

let cookie = "";
async function api(method, path, body) {
  const r = await fetch(HOST + path, {
    method,
    headers: { "content-type": "application/json", cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = r.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const json = await r.json();
  if (!r.ok) throw new Error(`${method} ${path}: ${json.error || r.status}`);
  return json;
}

await api("POST", "/api/login", { email: "admin@rs.local", password: "admin12345" });
const r = await api("PATCH", `/api/telegram/groups/${GROUP_ID}`, { offerMessage: OFFER_MESSAGE });
console.log(`Updated. offer_message length: ${r.group.offer_message.length}c`);
