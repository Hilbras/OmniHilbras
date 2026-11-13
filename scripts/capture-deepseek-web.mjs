import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const mode = process.argv[2] ?? 'baseline';
const nonce = `PING-${Date.now()}`;
const REDACT = new Set(['authorization', 'cookie', 'set-cookie']);

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const context = browser.contexts()[0];
const page = context.pages().find((p) => p.url().includes('chat.deepseek.com'));
if (!page) { console.log('no page'); process.exit(1); }

const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable', { maxResourceBufferSize: 400 * 1024 * 1024, maxTotalBufferSize: 800 * 1024 * 1024 });

const records = new Map();
const chunks = new Map();
const redact = (headers) => Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k, REDACT.has(k.toLowerCase()) ? '<redacted>' : v]));

cdp.on('Network.requestWillBeSent', (e) => {
  if (!e.request.url.includes('/api/')) return;
  records.set(e.requestId, {
    phase: 'request', url: e.request.url, method: e.request.method,
    headers: redact(e.request.headers), postData: e.request.postData ?? null,
    timestamp: e.wallTime ?? null,
  });
});
cdp.on('Network.requestWillBeSentExtraInfo', (e) => {
  const r = records.get(e.requestId);
  if (r) r.headersExtra = redact(e.headers);
});
cdp.on('Network.responseReceived', (e) => {
  const r = records.get(e.requestId);
  if (r) { r.status = e.response.status; r.mimeType = e.response.mimeType; r.responseHeaders = redact(e.response.headers); r.fromCache = e.response.fromDiskCache === true; }
});
cdp.on('Network.dataReceived', (e) => {
  chunks.set(e.requestId, (chunks.get(e.requestId) ?? 0) + (e.data?.length ?? 0));
});
cdp.on('Network.loadingFinished', async (e) => {
  const r = records.get(e.requestId);
  if (!r) return;
  r.encodedBytes = e.encodedDataLength;
  try {
    const body = await cdp.send('Network.getResponseBody', { requestId: e.requestId });
    r.body = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
  } catch (error) {
    r.bodyError = String(error.message ?? error).slice(0, 120);
  }
});

// State the toggles must be in for this run.
await page.evaluate((wanted) => {
  const toggles = [...document.querySelectorAll('.ds-toggle-button')];
  for (const toggle of toggles) {
    const on = toggle.className.includes('--on') || toggle.getAttribute('aria-checked') === 'true';
    const label = (toggle.textContent ?? '').trim().toLowerCase();
    const shouldBeOn = (wanted === 'think' && label.includes('think')) || (wanted === 'search' && label.includes('search'));
    if (on !== shouldBeOn) toggle.click();
  }
  return null;
}, mode);
await page.waitForTimeout(600);

const composer = page.locator('textarea[placeholder="Message DeepSeek"]');
await composer.click();
await composer.fill(`Reply with exactly: ${nonce}`);
await page.waitForTimeout(300);
await composer.press('Enter');

const deadline = Date.now() + 120_000;
const completion = () => [...records.values()].find((r) => r.phase === 'request' && r.url.includes('/api/v0/chat/completion') && r.body !== undefined);
while (Date.now() < deadline && !completion()) await page.waitForTimeout(500);
await page.waitForTimeout(2500);

const output = { mode, nonce, capturedAt: new Date().toISOString(), pageUrl: page.url(), records: [...records.values()] };
writeFileSync(`/tmp/ds-capture-${mode}.json`, JSON.stringify(output, null, 1));

for (const r of output.records) {
  const size = r.body ? r.body.length : 0;
  console.log(`${r.method} ${r.url.replace('https://chat.deepseek.com', '')} -> ${r.status ?? '?'} | body ${size} chars${r.bodyError ? ` | bodyError ${r.bodyError}` : ''}`);
  if (r.postData) console.log(`   POST: ${r.postData.slice(0, 300)}`);
  if (r.body && r.url.includes('completion')) console.log(`   SSE(head): ${r.body.slice(0, 400).replace(/\n/g, '\\n')}`);
}
await browser.close();
process.exit(0);
