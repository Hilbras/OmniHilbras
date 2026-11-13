import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

/**
 * Records DeepSeek's own sign-in traffic while a human performs it.
 *
 * ## Why a human performs it
 *
 * The point of this capture is the **auth contract**: which endpoint takes a credential, what it
 * expects, whether a captcha token is part of it, and what comes back. A password is a credential, and
 * the one rule that has no exception is that it must not pass through an agent — so the operator types
 * it, and this script only watches the wire.
 *
 * ## What is redacted on the way out
 *
 * Credential-bearing fields are replaced before anything is written: `password`, `captcha_token`,
 * `mobile`, `email`, `authorization`, `cookie`, `shumei_device_id`, `x-device-id`. Everything else is
 * verbatim, because the shape is the finding.
 *
 * Usage: node scripts/capture-deepseek-auth.mjs [seconds] [endpoint]
 */

const seconds = Number(process.argv[2] ?? 300);
const endpoint = process.argv[3] ?? 'http://127.0.0.1:9222';
const outfile = '/tmp/ds-auth-capture.json';

const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'x-device-id', 'x-ds-pow-response']);
const SENSITIVE_FIELDS = ['password', 'captcha_token', 'mobile', 'email', 'shuo_device_id', 'shumei_device_id', 'device_id', 'refresh_token', 'token'];

const scrub = (text) => {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const field of SENSITIVE_FIELDS) {
    out = out.replace(new RegExp(`"${field}"\\s*:\\s*"[^"]*"`, 'g'), `"${field}":"<redacted>"`);
  }
  return out;
};
const scrubHeaders = (headers) => Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k, SENSITIVE_HEADERS.has(k.toLowerCase()) ? '<redacted>' : v]));

const browser = await chromium.connectOverCDP(endpoint);
const context = browser.contexts()[0];
const page = context.pages().find((p) => p.url().includes('deepseek.com')) ?? context.pages()[0];
if (!page) {
  console.log('no page');
  process.exit(1);
}
console.log('attached to:', page.url());

const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable', { maxResourceBufferSize: 200 * 1024 * 1024, maxTotalBufferSize: 400 * 1024 * 1024 });

const records = new Map();
cdp.on('Network.requestWillBeSent', (e) => {
  records.set(e.requestId, {
    url: e.request.url,
    method: e.request.method,
    headers: scrubHeaders(e.request.headers),
    postData: scrub(e.request.postData),
    startedAt: e.wallTime ?? null,
  });
});
cdp.on('Network.responseReceived', (e) => {
  const r = records.get(e.requestId);
  if (r) {
    r.status = e.response.status;
    r.mimeType = e.response.mimeType;
    r.responseHeaders = scrubHeaders(e.response.headers);
  }
});
cdp.on('Network.loadingFinished', async (e) => {
  const r = records.get(e.requestId);
  if (!r || !r.url.includes('/api/')) return;
  try {
    const body = await cdp.send('Network.getResponseBody', { requestId: e.requestId });
    const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
    r.body = scrub(text.slice(0, 20_000));
  } catch (error) {
    r.bodyError = String(error.message ?? error).slice(0, 100);
  }
});

console.log(`recording for ${seconds}s — sign out and sign back in now; the account stays yours, the password never leaves your keyboard.`);
await page.waitForTimeout(seconds * 1000);

const output = { capturedAt: new Date().toISOString(), seconds, records: [...records.values()].filter((r) => r.url.includes('/api/')) };
writeFileSync(outfile, JSON.stringify(output, null, 1));
console.log(`wrote ${outfile} with ${output.records.length} /api/ calls`);
for (const r of output.records) {
  const path = r.url.replace(/^https?:\/\/[^/]+/, '');
  console.log(`${r.method} ${path} -> ${r.status ?? '?'}${r.body ? ` | ${r.body.slice(0, 160)}` : ''}`);
  if (r.postData) console.log(`   body: ${String(r.postData).slice(0, 200)}`);
}
await browser.close();
process.exit(0);
