import fs from "fs";

const AUTH_FILE = "./auth.json";

export async function login(page) {
  // если уже есть auth.json — просто применяем cookies и выходим
  if (fs.existsSync(AUTH_FILE)) {
    console.log("🔐 Использую сохранённую сессию (auth.json)");
    const cookies = JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"));
    await page.context().addCookies(cookies.cookies || cookies);
    return;
  }

  const email = process.env.DISCORD_EMAIL;
  const password = process.env.DISCORD_PASSWORD;

  if (!email || !password) {
    throw new Error(
      "DISCORD_EMAIL или DISCORD_PASSWORD не заданы. " +
        "В PowerShell: $env:DISCORD_EMAIL='...'; $env:DISCORD_PASSWORD='...'; node monitor.js"
    );
  }

  console.log("🔑 Логин в Discord");

  await page.goto("https://discord.com/login", { waitUntil: "domcontentloaded" });

  await page.fill('input[name="email"]', String(email));
  await page.fill('input[name="password"]', String(password));

  await page.click('button[type="submit"]');

  // ждём, чтобы прошёл логин (если капча — пройдёшь руками)
  await page.waitForTimeout(10_000);

  const cookies = await page.context().cookies();
  fs.writeFileSync(AUTH_FILE, JSON.stringify({ cookies }, null, 2));

  console.log("✅ Сессия сохранена");
}
