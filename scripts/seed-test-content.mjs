// One-shot: populate the ConvertAgain group with test content so operator can
// run an end-to-end manual smoke immediately. Sets:
//   - knowledge_base (terminology, FAQ)
//   - offer_message (3-line offer)
//   - one PNG attachment (small brand swatch)
//   - one PDF attachment (single-page sales brief)
// Then calls /api/leads/cleanup to drop the junk anon-bot leads.
//
// Run on the server:
//   cd /opt/tgbots && node scripts/seed-test-content.mjs

import { deflateSync } from "node:zlib";
// Node 22 has global fetch — no import needed.

const HOST = "http://127.0.0.1:4173";
const GROUP_ID = "grp-167e73544bc3";

const KNOWLEDGE_BASE = `Терминология ConvertAgain:

– DSP (Demand-Side Platform): рекламная платформа закупающая показы программатиком по аукциону. У нас 3 DSP: WW (весь мир), РФ (адалт + пиратские сайты), и большой DSP на санкционно-нейтральные ГЕО.
– Ретеншн-ремаркетинг: показ рекламы уже зарегистрированным игрокам бренда (НЕ привлечение новых) для увеличения частоты депозитов.
– Реактивация: возврат «потухших» игроков через таргет на хешированные email-базы во Meta.
– s2s-интеграция (server-to-server): передача обезличенных событий из CRM/трекера клиента в наш пиксель. Минимальный набор: USER_AGENT, IP, USER ID, TRANSACTION ID, валюта, депозит. Email — только хешированный.
– FTD (First-Time Deposit): первый депозит нового игрока. НЕ наш профиль — мы работаем с retention, а не с acquisition.
– GGR / NGR: Gross / Net Gaming Revenue — стандартные iGaming-метрики.
– Inhaus / in-house трафик: трафик который бренд гонит сам, без аффилейтов. Мы работаем с inhaus-объёмами.
– Top GEO: основные географии работы клиента. Мы работаем на ваших ТОП-ГЕО, специально под них настраиваем DSP-кампании.

Что мы НЕ делаем:
– Не привлекаем новых игроков (это acquisition, не наш профиль).
– Не работаем с холодным трафиком вне базы клиента.
– Не покупаем performance-инвентарь на CPA / CPL.
– Не работаем с США и Европой по YouTube-ремаркетингу (юридические ограничения).

Типовые тех. ответы:
– Время на интеграцию: 1-2 недели от подписания NDA до запуска первого ГЕО.
– Передача данных — только хешированные email + обезличенные ID. NDA обязательно.
– Минимальный объём базы для реактивации — обсуждается индивидуально.
– KPI на стороне клиента отслеживаются через s2s-постбэки.`;

const OFFER_MESSAGE = `Готов прислать наш one-pager с описанием инструментов и кейсами по iGaming-брендам — там есть всё, что нужно для оценки fit'а. Плюс презентация с конкретными цифрами по охвату и uplift'у.
Посмотрите материалы, и если интересно — закроем интеграцию за 1-2 недели от подписания NDA.
Удобно созвониться на этой неделе для обсуждения деталей?`;

// --- Generate a minimal valid 200x100 solid-color PNG (ConvertAgain navy) ---
function makePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = (crcTable[(c ^ b) & 0xff] ^ (c >>> 8)) >>> 0;
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = [];
  for (let y = 0; y < height; y++) {
    raw.push(0); // filter byte
    for (let x = 0; x < width; x++) raw.push(...rgba);
  }
  const idat = deflateSync(Buffer.from(raw));
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// --- Generate a minimal one-page PDF with "ConvertAgain — Sales Brief" text ---
function makePdf(text) {
  // Each object/xref offset matters; build incrementally.
  const objs = [];
  const push = (s) => { objs.push(s); };
  push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  push("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n");
  // Wrap long text into multiple lines roughly every 60 chars.
  const lines = String(text).split(/\n/).flatMap((line) => {
    const words = line.split(/\s+/);
    const out = [];
    let cur = "";
    for (const w of words) {
      if ((cur + " " + w).trim().length > 70) { out.push(cur); cur = w; }
      else cur = (cur ? cur + " " : "") + w;
    }
    if (cur) out.push(cur);
    return out.length ? out : [""];
  });
  const escape = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  let body = "BT\n/F1 14 Tf\n50 780 Td\n(ConvertAgain — Sales Brief) Tj\n/F1 11 Tf\n0 -20 Td\n";
  for (const ln of lines) body += `(${escape(ln)}) Tj\n0 -14 Td\n`;
  body += "ET";
  const bodyBuf = Buffer.from(body, "latin1");
  push(`4 0 obj\n<< /Length ${bodyBuf.length} >>\nstream\n${body}\nendstream\nendobj\n`);
  push("5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n");
  // Build the PDF with xref offsets.
  const header = "%PDF-1.4\n%âãÏÓ\n";
  const buf = [Buffer.from(header, "latin1")];
  const offsets = [0];
  let pos = buf[0].length;
  for (const o of objs) {
    offsets.push(pos);
    const b = Buffer.from(o, "latin1");
    buf.push(b);
    pos += b.length;
  }
  const xrefPos = pos;
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  buf.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(buf);
}

// --- API client ---
let cookie = "";
async function api(method, path, body) {
  const r = await fetch(HOST + path, {
    method,
    headers: { "content-type": "application/json", cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = r.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${json.error || text.slice(0, 200)}`);
  return json;
}

console.log("Logging in…");
await api("POST", "/api/login", { email: "admin@rs.local", password: "admin12345" });

console.log("Patching group with KB + offer text…");
const groupPatch = await api("PATCH", `/api/telegram/groups/${GROUP_ID}`, {
  knowledgeBase: KNOWLEDGE_BASE,
  offerMessage: OFFER_MESSAGE,
});
console.log(`  ✓ kb=${groupPatch.group.knowledge_base?.length}c offer=${groupPatch.group.offer_message?.length}c`);

console.log("Generating PNG (200×100 ConvertAgain navy)…");
const pngBuf = makePng(200, 100, [22, 32, 64, 255]); // dark navy
console.log(`  ✓ ${pngBuf.length} bytes`);

console.log("Generating PDF (1-page Sales Brief)…");
const pdfBuf = makePdf(
  "ConvertAgain — retention remarketing for iGaming brands.\n\n" +
  "What we do:\n" +
  "- Product retargeting on in-house brand traffic via YouTube, DSP, Meta.\n" +
  "- Player reactivation from hashed email databases through Meta.\n" +
  "- s2s integration with USER_AGENT, IP, USER ID, TRANSACTION ID, currency, deposit.\n\n" +
  "Numbers:\n" +
  "- 60%+ reach of existing players in your top GEOs.\n" +
  "- +20-30% to deposit volume.\n" +
  "- 70 brands live: Boomerang, Spinbetter, Alpha Affiliates, and more.\n\n" +
  "Onboarding: 1-2 weeks from NDA to first GEO live.\n" +
  "Contact: @ConvertAgainSales | mmmarketng@gmail.com",
);
console.log(`  ✓ ${pdfBuf.length} bytes`);

console.log("Uploading PNG attachment…");
const att1 = await api("POST", `/api/telegram/groups/${GROUP_ID}/attachments`, {
  filename: "convertagain_brand.png",
  mime: "image/png",
  contentBase64: pngBuf.toString("base64"),
});
console.log(`  ✓ ${att1.attachments.length} attachment(s) now on the group`);

console.log("Uploading PDF attachment…");
const att2 = await api("POST", `/api/telegram/groups/${GROUP_ID}/attachments`, {
  filename: "convertagain_sales_brief.pdf",
  mime: "application/pdf",
  contentBase64: pdfBuf.toString("base64"),
});
console.log(`  ✓ ${att2.attachments.length} attachment(s) now on the group`);

console.log("Cleaning up junk leads…");
const cleanup = await api("POST", "/api/leads/cleanup");
console.log(`  ✓ removed junk=${cleanup.removed?.junk} orphan=${cleanup.removed?.orphan}`);

console.log("\nDone. Group is ready for end-to-end manual smoke.");
