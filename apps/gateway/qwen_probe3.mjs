/** One request at a time: a hung body kills the renderer, so nothing is read after headers. */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
const dir = `/home/gin/.config/omnihilbras/qwen-probe-${Date.now()}`;
mkdirSync(dir, { recursive: true });
const ctx = await chromium.launchPersistentContext(dir, {
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.7922.34 Safari/537.36",
  locale: "en-US", timezoneId: "America/New_York", viewport: { width: 1400, height: 950 },
});
const target = process.argv[2] || "/api/v2/chat/completions";
const page = await ctx.newPage();
await page.goto("https://chat.qwen.ai/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(9000);
try {
  const out = await page.evaluate(async (path) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const r = await fetch(path, {
      method: "POST", credentials: "include",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ model: "qwen3.7-plus", messages: [{ role: "user", content: "hi" }], stream: false }),
      signal: controller.signal,
    });
    const headers = Object.fromEntries(r.headers.entries());
    let body = "<never finished>";
    try { body = await r.text(); } catch (e) { body = "<body threw " + e.name + ">"; }
    clearTimeout(timer);
    return { status: r.status, headers, body: body.slice(0, 400) };
  }, target);
  console.log(`  ${target} -> ${out.status}`);
  console.log(`  headers: ${JSON.stringify(out.headers)}`);
  console.log(`  body: ${out.body.replace(/\s+/g, " ").slice(0, 320)}`);
} catch (e) {
  console.log(`  ${target} -> evaluate failed: ${e.name}: ${String(e.message).slice(0, 140)}`);
}
await ctx.close();
