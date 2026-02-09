import fs from "fs";

const AUTH_FILE = "./auth.json";

export async function login(page) {
  if (fs.existsSync(AUTH_FILE)) {
    console.log("🔐 Использую сохранённую сессию");
    const cookies = JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"));
    await page.context().addCookies(cookies.cookies || cookies);
    return;
  }

  console.log("🔑 Логин в Discord");

  await page.goto("https://discord.com/login");

  await page.fill('input[name="email"]', process.env.DISCORD_EMAIL);
  await page.fill('input[name="password"]', process.env.DISCORD_PASSWORD);

  await page.click('button[type="submit"]');
  await page.waitForTimeout(10_000);

  const cookies = await page.context().cookies();
  fs.writeFileSync(AUTH_FILE, JSON.stringify({ cookies }, null, 2));

  console.log("✅ Сессия сохранена");
}