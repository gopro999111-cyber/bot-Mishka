import { chromium } from "playwright";
import fs from "fs";
import fetch from "node-fetch";
import { login } from "./login.js";

// ====== URL ======
const AUTH_URL = "https://grnd.gg/auth";
const COMPLAINTS_URL = "https://grnd.gg/admin/complaints";

// ====== НАСТРОЙКИ ======
const CHECK_INTERVAL = 30_000;
const STORAGE_FILE = "notified_ids.json";
const AUTH_FILE = "auth.json";

// ⚠️ ВАЖНО:
// - На Railway должно быть true (иначе нет XServer)
// - Локально для ручной авторизации можешь временно поставить false
const HEADLESS = true;

// ====== DISCORD (уведомления) ======
const DISCORD_WEBHOOK =
  "https://discord.com/api/webhooks/1470341874563940498/5OjK0mcdyYjDCaimUUjZnGbLlKm--ttnJoGFZtRQWlIOVorC7_rV-5ILe0JP4wxEWfor";
const DISCORD_ROLE_ID = "1470322549224378450";

// ====== SAFETY ======
process.on("unhandledRejection", err => {
  console.error("❌ UNHANDLED REJECTION:", err?.stack || err);
});
process.on("uncaughtException", err => {
  console.error("❌ UNCAUGHT EXCEPTION:", err?.stack || err);
});

// ====== notified_ids ======
const notified = fs.existsSync(STORAGE_FILE)
  ? new Set(JSON.parse(fs.readFileSync(STORAGE_FILE, "utf8")))
  : new Set();

function saveNotified() {
  fs.writeFileSync(STORAGE_FILE, JSON.stringify([...notified], null, 2));
}

// ====== DISCORD SEND ======
async function sendDiscord(c) {
  const payload = {
    content: `<@&${DISCORD_ROLE_ID}>`,
    allowed_mentions: { roles: [DISCORD_ROLE_ID] },
    embeds: [
      {
        title: "🚨 Новая жалоба",
        color: 15158332,
        fields: [
          { name: "ID", value: `#${c.id}`, inline: true },
          { name: "От", value: c.from || "—", inline: true },
          { name: "На", value: c.on || "—", inline: true },
          { name: "Дата", value: c.date || "—" }
        ],
        footer: { text: "grnd.gg • admin panel" },
        timestamp: new Date().toISOString()
      }
    ]
  };

  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (res.ok) return;

    if (res.status === 429) {
      const retryAfterHeader = res.headers.get("retry-after");
      const retryAfterMs = retryAfterHeader
        ? Math.ceil(Number(retryAfterHeader) * 1000)
        : 3000;
      console.warn(`⚠️ Discord 429 (attempt ${attempt}/5), жду ${retryAfterMs}ms`);
      await new Promise(r => setTimeout(r, retryAfterMs));
      continue;
    }

    const text = await res.text().catch(() => "");
    throw new Error(
      `Discord webhook error ${res.status} ${res.statusText}: ${text}`.slice(0, 800)
    );
  }

  throw new Error("Discord webhook failed after retries (429)");
}

// ====== GET COMPLAINTS ======
async function getComplaints(page) {
  await page.waitForSelector(".table-component-index table", { timeout: 15000 });

  return await page.evaluate(() => {
    return [...document.querySelectorAll(".table-component-index table tbody tr")]
      .map(row => {
        const tds = row.querySelectorAll("td");
        if (tds.length < 4) return null;
        return {
          id: tds[0].innerText.trim(),
          from: tds[1].innerText.trim(),
          on: tds[2].innerText.trim(),
          date: tds[3].innerText.trim()
        };
      })
      .filter(Boolean);
  });
}

// ====== ensure auth via /auth (для локального первого входа) ======
async function ensureSiteAuth(context, page) {
  console.log("🌐 Иду на авторизацию сайта:", AUTH_URL);
  await page.goto(AUTH_URL, { waitUntil: "domcontentloaded" });

  const deadline = Date.now() + 120_000;

  while (Date.now() < deadline) {
    const u = page.url();

    if (u.includes("grnd.gg/admin")) {
      console.log("✅ Сайт авторизован, URL:", u);
      await context.storageState({ path: AUTH_FILE });
      console.log("✅ auth.json сохранён");
      return;
    }

    if (u.includes("discord.com/oauth2") || u.includes("discord.com/authorize")) {
      const btn = page.locator(
        'button:has-text("Authorize"), button:has-text("Авторизовать"), button:has-text("Continue"), button:has-text("Продолжить")'
      );

      if (await btn.count()) {
        try {
          console.log("➡️ Нажимаю Authorize/Continue...");
          await btn.first().click({ timeout: 2000 });
        } catch {}
      }
    }

    await page.waitForTimeout(1200);
  }

  await context.storageState({ path: AUTH_FILE }).catch(() => {});
  throw new Error("Не удалось завершить авторизацию на grnd.gg через /auth за 2 минуты.");
}

// ====== MAIN ======
(async () => {
  const browser = await chromium.launch({ headless: HEADLESS });

  let context;
  let page;

  if (fs.existsSync(AUTH_FILE)) {
    console.log("🔐 auth.json найден — использую сохранённую сессию");
    context = await browser.newContext({ storageState: AUTH_FILE });
    page = await context.newPage();
  } else {
    console.log("🆕 auth.json нет — делаю первый вход (локально). На Railway так не делай.");
    context = await browser.newContext();
    page = await context.newPage();

    // Discord login (нужен для OAuth на сайте)
    await login(page);

    // гарантированно идём на /auth
    console.log("➡️ После Discord логина открываю сайт /auth");
    await page.goto(AUTH_URL, { waitUntil: "domcontentloaded" });

    // руками/кнопкой Authorize и т.п. (в headless=true это почти не работает)
    await ensureSiteAuth(context, page);
  }

  console.log("🤖 Бот запущен, мониторинг начат");

  while (true) {
    try {
      await page.goto(COMPLAINTS_URL, { waitUntil: "networkidle" });

      const complaints = await getComplaints(page);
      console.log(`📄 Найдено жалоб на странице: ${complaints.length}`);

      let sent = 0;

      for (const c of complaints) {
        if (!c?.id) continue;
        if (notified.has(c.id)) continue;

        await sendDiscord(c);
        notified.add(c.id);
        sent++;

        await new Promise(r => setTimeout(r, 400));
      }

      if (sent > 0) {
        saveNotified();
        console.log(`✅ Отправлено новых жалоб: ${sent}`);
      } else {
        console.log("⏳ Новых жалоб нет");
      }
    } catch (err) {
      console.error("❌ Ошибка:", err?.message || err);
    }

    await new Promise(r => setTimeout(r, CHECK_INTERVAL));
  }
})();
