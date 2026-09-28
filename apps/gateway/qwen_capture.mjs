/**
 * Captures one real Qwen request, with the age gate cleared by the user.
 *
 * Opens a visible window, watches for the request the page makes when a message is sent, and
 * records the URL, the headers that matter, and the body. Nothing is replayed — this only
 * records, so the wire format is observed rather than guessed.
 */
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";

const dir = "/home/gin/.config/omnihilbras/qwen-probe";
mkdirSync(dir, { recursive: true });

const ctx = await chromium.launchPersistentContext(dir, {
  headless: false,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.7922.34 Safari/537.36",
  locale: "en-US", timezoneId: "America/New_York", viewport: { width: 1280, height: 900 },
});
const page = await ctx.newPage();

const captured = [];
page.on("request", (r) => {
  const u = r.url();
  if (!u.includes("chat.qwen.ai/api/")) return;
  if (r.method() !== "POST" && r.method() !== "GET") return;
  const h = r.headers();
  captured.push({
    method: r.method(),
    url: u,
    headerNames: Object.keys(h).filter((k) => /auth|token|xsrf|device|uid|trace|request|sign|cookie/i.test(k)),
    auth: h.authorization ? h.authorization.slice(0, 60) : null,
    xsrf: h["x-xsrf-token"] ? h["x-xsrf-token"].slice(0, 60) : null,
    body: (r.postData() || "").slice(0, 3000),
  });
});
const responses = [];
page.on("response", async (r) => {
  if (!r.url().includes("chat.qwen.ai/api/")) return;
  if (r.request().method() !== "POST") return;
  let body = "";
  try { body = (await r.text()).slice(0, 2500); } catch { body = "<stream, not buffered>"; }
  responses.push({ url: r.url(), status: r.status(), body });
});

await page.goto("https://chat.qwen.ai/", { waitUntil: "domcontentloaded", timeout: 60000 });
console.log("  A window is open on your desktop.");
console.log("  1. Accept the age gate if it asks.");
console.log("  2. Type:  Reply with the single word: working");
console.log("  3. Press Enter.");
console.log("  This closes itself once it sees a chat request.\n");

const deadline = Date.now() + 300_000;
let done = false;
while (Date.now() < deadline && !done) {
  await page.waitForTimeout(2000);
  // Anything with a chat-ish path and a body is the one we want.
  done = captured.some((c) => c.method === "POST" && c.body.length > 0 && /chat|completion|message|conversation|generate/i.test(c.url));
}

console.log(`  captured ${captured.length} API calls, ${responses.length} responses`);
const interesting = captured.filter((c) => c.body.length > 0);
for (const c of interesting.slice(0, 8)) {
  console.log(`  --- ${c.method} ${c.url}`);
  console.log(`      auth: ${c.auth ?? "(none)"}  xsrf: ${c.xsrf ?? "(none)"}`);
  console.log(`      auth-ish headers: ${JSON.stringify(c.headerNames)}`);
  console.log(`      body: ${c.body.slice(0, 900)}`);
}
for (const r of responses.slice(0, 5)) {
  console.log(`  --- response ${r.status} ${r.url}`);
  console.log(`      ${r.body.slice(0, 700)}`);
}
if (!interesting.length) {
  const text = await page.evaluate(() => (document.body?.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 16));
  console.log(`  nothing sent. page text: ${JSON.stringify(text).slice(0, 500)}`);
}
writeFileSync("/tmp/opencode/qwen-capture.json", JSON.stringify({ captured, responses }, null, 2));
await ctx.close();
