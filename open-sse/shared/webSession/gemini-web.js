import {
  BROWSER_LOCALE,
  BROWSER_TIMEZONE,
  CHROME_USER_AGENT,
  MISSING_BROWSER_MESSAGE,
  cookieHeaderFrom,
  isMissingBrowser,
  loadPlaywright,
  parseCookieHeader,
  profileDir,
} from "./common.js";

/**
 * Gemini Web — the credential, the page, and the parsers.
 *
 * Not an API integration: Google publishes no endpoint that accepts a browser
 * session, so the only way to reach a model this way is to load
 * `gemini.google.com` in a real browser, let the page solve its own
 * challenges, type into the composer and read the answer out of the response
 * stream. The same shape as ChatGPT Web, and it carries the same warning — the
 * credential is a **live session for a whole Google account**, not a token
 * scoped to inference.
 *
 * This module holds everything about the provider that can be reasoned about
 * without a browser: what a Gemini cookie is, what the `StreamGenerate` body
 * means, which models the UI can be driven to, and what refusals are honest to
 * make before a browser is even opened. It also holds the browser half, because
 * the dashboard's "check" is a page load and the executor's turn is the same
 * page load with a prompt in it.
 *
 * Ported from the previous project's `providers/gemini-web/index.ts` (the
 * cookie, the parser, the model table, the refusals) and
 * `apps/gateway/src/geminiWeb.ts` (the page driver).
 */

/** The provider id — used for the browser profile directory and in messages. */
export const GEMINI_WEB_PROVIDER_ID = "gemini-web";

/** The primary cookie, and the one a bare value is assumed to be. */
export const GEMINI_WEB_PRIMARY_COOKIE = "__Secure-1PSID";

/**
 * The cookies Google rotates on its own schedule. They are read back out of the
 * live browser jar after a run and merged into the stored credential, because a
 * session whose `1PSIDTS` is not refreshed stops working while still parsing
 * perfectly.
 */
export const GEMINI_WEB_ROTATABLE_COOKIES = ["__Secure-1PSID", "__Secure-1PSIDTS", "__Secure-1PSIDCC"];

/** Everything about the page: where it is, how it is recognised, and how long it gets. */
export const GEMINI_WEB = {
  /** The only origin this will talk to. */
  origin: "https://gemini.google.com",
  startUrl: "https://gemini.google.com/app",
  /**
   * Where the answer arrives. It is **observed**, never called: the page makes
   * this request itself and the driver reads the response. The URL is matched
   * by this substring, because the full path carries a service name that
   * changes.
   */
  streamMarker: "StreamGenerate",
  /** The composer. A contenteditable, so its class is a styling hook and may change. */
  composer: '.ql-editor, [contenteditable="true"]',
  /**
   * A link to Google's sign-in page, which is what a signed-out Gemini shows.
   *
   * Checked before the composer, because the signed-out page carries **hidden**
   * contenteditable nodes: a check that only looked for the composer counted one
   * of those and reported a dead session as connected.
   */
  signedOutLink: 'a[href*="accounts.google.com"]',
  /**
   * The whole interaction is bounded: a navigation, a settling pause, and a hard
   * cap on waiting for the answer. A page that never answers must fail, not hang.
   */
  navigationTimeoutMs: 20_000,
  settleMs: 3_000,
  answerTimeoutMs: 30_000,
};

/**
 * Gemini's web models.
 *
 * The ids are what this gateway serves; they are **not** Google API model ids,
 * and asking for `gemini-2.5-pro` here is refused rather than silently
 * answered by a different model. The list is short for the same reason the
 * reference's is: the UI offers a handful of modes, and a mode that is not in
 * this table cannot be chosen.
 */
export const GEMINI_WEB_MODELS = [
  {
    id: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    /**
     * The model the page already opens to, so nothing is clicked. Claiming to
     * have selected it when the UI reports it anyway would be a claim about a
     * click that never happened.
     */
    isDefault: true,
  },
  {
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    /**
     * The menu button, the element that reports the active mode, and the
     * pattern that read-back must match.
     *
     * **Unvalidated.** These are Gemini's UI hooks as best they can be known
     * without a live account; when one is wrong the selection fails closed and
     * says so rather than answering with the wrong model.
     */
    toggleSelector: '[data-test-id="bard-mode-menu-button"], button[aria-haspopup="menu"][aria-label*="model" i]',
    indicatorSelector: '[data-test-id="bard-mode-menu-button"] .mode-title, [data-test-id="bard-mode-menu-button"]',
    // `(?!.*lite)` so the plain Flash mode never matches the Flash-Lite label.
    indicatorPattern: /\bflash\b(?!.*\blite\b)/i,
  },
  {
    id: "gemini-3.1-flash-lite",
    name: "Gemini 3.1 Flash-Lite",
    toggleSelector: '[data-test-id="bard-mode-menu-button"], button[aria-haspopup="menu"][aria-label*="model" i]',
    indicatorSelector: '[data-test-id="bard-mode-menu-button"] .mode-title, [data-test-id="bard-mode-menu-button"]',
    indicatorPattern: /flash.*\blite\b/i,
  },
];

/** The model ids, for the dashboard's model list. */
export function geminiWebModelIds() {
  return GEMINI_WEB_MODELS.map((model) => model.id);
}

/** The model resolved for a request, or `undefined` for an id the UI cannot be driven to. */
export function resolveGeminiWebModel(model) {
  if (!model) return undefined;
  return GEMINI_WEB_MODELS.find((entry) => entry.id === model);
}

/** One cookie, as a name and a value. */
export function geminiWebCookie(name, value) {
  return { name, value };
}

/**
 * A Gemini Web failure, carrying the code the executor turns into a status.
 *
 * The codes are the previous project's, because they are the ones the router
 * and the dashboard already know how to read.
 */
export class GeminiWebError extends Error {
  constructor(code, message, { status = 502 } = {}) {
    super(message);
    this.name = "GeminiWebError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Reads the pasted credential.
 *
 * Three shapes are accepted, because three are what people actually paste: the
 * bare value of `__Secure-1PSID`, a whole `Cookie:` header, and a JSON export
 * from an extension. A bare value has no name in it, so the name is supplied —
 * which is the whole reason this function exists rather than a split on `=`:
 * `abc=def` is a header and `abcdef` is a value, and only one of those parses
 * as a cookie.
 *
 * A paste that is not a cookie at all — a request line, most of all — is
 * refused with a message that says what to copy.
 */
export function normalizeGeminiWebCookie(raw, cookieName = GEMINI_WEB_PRIMARY_COOKIE) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  const pairs = cookiePairsFromJson(trimmed);
  if (pairs.length > 0) return headerFromPairs(pairs);

  // A malformed export is a value, not a crash: anything that is not a JSON
  // object is a value.
  if (trimmed.startsWith("{")) return `${cookieName}=${trimmed}`;

  // A bare value has no name in it, so the name is supplied — which is the
  // whole reason this function exists rather than a split on `=`: `abc=def` is
  // a header and `abcdef` is a value, and only one of those parses as a cookie.
  // A cookie value cannot contain whitespace, which is what tells the two apart
  // when there is no `=` to go by — and it is what tells a pasted request line
  // from a value as well.
  if (!trimmed.includes("=") && !/\s/.test(trimmed)) return `${cookieName}=${trimmed}`;

  // A header. The shared parser refuses a pasted request line with a message
  // that says what to copy — the commonest mistake, and one that otherwise
  // reads as a nonsense credential.
  parseCookieHeader(trimmed);
  return headerFromPairs(parseGeminiWebCookieHeader(trimmed));
}

/** The pairs as a `Cookie:` header value. */
function headerFromPairs(pairs) {
  return cookieHeaderFrom(Object.fromEntries(pairs.map((pair) => [pair.name, pair.value])));
}

/** A JSON object export (`{...}` or `{cookies: {...}}`), or an empty list for anything else. */
function cookiePairsFromJson(raw) {
  if (!raw.startsWith("{")) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
  const record = parsed;
  const source =
    typeof record.cookies === "object" && record.cookies !== null && !Array.isArray(record.cookies)
      ? record.cookies
      : record;
  return Object.entries(source)
    .filter(([, value]) => typeof value === "string" && value.trim() !== "")
    .map(([name, value]) => ({ name, value: value.trim() }));
}

/**
 * Splits a `Cookie:` header into pairs, dropping the attributes that are not
 * cookies.
 *
 * `path`, `domain`, `expires` and the rest appear in a copied header and are
 * not sendable names — treating them as cookies sends `path=/` to Google, which
 * is at best ignored and at worst a malformed request.
 */
export function parseGeminiWebCookieHeader(header) {
  const attributes = new Set([
    "path", "domain", "expires", "max-age", "secure", "httponly", "samesite", "priority", "partitioned",
  ]);
  const pairs = [];
  for (const part of String(header || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name || !value) continue;
    if (attributes.has(name.toLowerCase())) continue;
    pairs.push({ name, value });
  }
  return pairs;
}

/** Whether the credential holds at least one usable cookie. Format only — a browser answers the real question. */
export function geminiWebCookiePresent(raw) {
  try {
    return parseGeminiWebCookieHeader(normalizeGeminiWebCookie(raw)).length > 0;
  } catch {
    // A paste with nothing usable in it is not a credential, and saying so is
    // the answer — not an exception the caller has to interpret.
    return false;
  }
}

/**
 * Merges the cookies the live browser jar reports back into the stored header.
 *
 * Google replaces these three on its own schedule. A jar value that differs is
 * the new one; a rotatable name present in the jar but absent from the original
 * is appended, because a cookie the page minted is part of the session even
 * though the user never pasted it. Everything else in the original is left
 * alone — the driver only sends what Google set, and rewriting the rest would
 * drop something the page needs.
 */
export function mergeRotatedGeminiWebCookies(original, jar) {
  const rotatable = new Set(GEMINI_WEB_ROTATABLE_COOKIES);
  const merged = new Map();
  for (const pair of parseGeminiWebCookieHeader(original)) merged.set(pair.name, pair.value);
  for (const pair of jar || []) {
    if (!rotatable.has(pair.name) || !pair.value) continue;
    merged.set(pair.name, pair.value);
  }
  return [...merged.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

/**
 * Reads the answer out of a `StreamGenerate` body.
 *
 * The body is a `)]}'`-prefixed framing of length-prefixed lines, each holding
 * a `wrb.fr` envelope whose third element is a JSON string. The answer is
 * `inner[4][0][1]`, joined.
 *
 * **The frames are cumulative snapshots of the same answer, not increments** —
 * each one contains everything so far — so concatenating them duplicates the
 * whole reply. Only the last frame that produced text is kept. Grading this
 * wrong is invisible on a one-word answer and unmissable on a paragraph, which
 * is exactly the kind of bug a test has to pin.
 */
export function parseGeminiWebStreamResponse(raw) {
  let text = "";
  for (const line of String(raw || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === ")]}'" || /^\d+$/.test(trimmed)) continue;
    if (!trimmed.includes("wrb.fr")) continue;
    let envelope;
    try {
      envelope = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!Array.isArray(envelope) || !Array.isArray(envelope[0]) || envelope[0][0] !== "wrb.fr") continue;
    const payload = envelope[0][2];
    if (typeof payload !== "string") continue;
    let inner;
    try {
      inner = JSON.parse(payload);
    } catch {
      continue;
    }
    const parts = candidateText(inner);
    if (parts) text = parts;
  }
  return text;
}

/** `inner[4][0][1]` as text, or `undefined` when the shape is not the one that carries an answer. */
function candidateText(inner) {
  if (!Array.isArray(inner)) return undefined;
  const group = inner[4];
  if (!Array.isArray(group) || !Array.isArray(group[0])) return undefined;
  const list = group[0][1];
  if (!Array.isArray(list)) return undefined;
  const text = list.filter((entry) => typeof entry === "string").join("");
  return text.length > 0 ? text : undefined;
}

/**
 * The prompt the page is driven with.
 *
 * Gemini's composer takes one turn, so the conversation is flattened into it: a
 * system message becomes a `System:` block, and earlier turns become a
 * transcript. The **last user message is byte-for-byte** what the person typed,
 * because that is the part the model is answering.
 */
export function buildGeminiWebPrompt(messages) {
  const system = messages.filter((message) => message.role === "system").map((message) => message.text).filter(Boolean);
  const turns = messages.filter((message) => message.role !== "system");
  const current = turns[turns.length - 1];
  const history = turns.slice(0, -1);
  const userText = current?.text ?? "";
  if (system.length === 0 && history.length === 0) return userText;
  const blocks = [];
  if (system.length > 0) blocks.push(`System:\n${system.join("\n\n")}`);
  if (history.length > 0) {
    blocks.push(
      `Previous conversation:\n${history
        .map((message) => `${message.role === "assistant" ? "Assistant" : "User"}: ${message.text}`)
        .join("\n\n")}`,
    );
  }
  blocks.push(`Current user message:\n${userText}`);
  return blocks.join("\n\n");
}

/** The text of one OpenAI message, whatever shape its content arrived in. */
export function geminiWebMessageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof part.text === "string") return part.text;
      return "";
    })
    .join("");
}

/**
 * A driver failure as a provider failure.
 *
 * Three cases, in the order they should win — the same classification the
 * previous project arrived at for the same reasons, because a page that refuses
 * is not one thing:
 *
 * - **signed out.** The cookie expired or Google revoked it. Not retryable, and
 *   no other provider fixes it: the user's next action is to copy fresher
 *   cookies. `AUTHENTICATION_FAILED` so the router stops rather than failing
 *   over, and the dashboard says "sign in again" rather than "Gemini is
 *   unavailable".
 * - **blocked.** A bot-protection challenge. Also not retryable, and not the
 *   credential's fault, so `PROVIDER_UNAVAILABLE` — the operator waits, they do
 *   not re-copy a working cookie.
 * - **anything else.** `PROVIDER_REQUEST_FAILED`, which the router may retry.
 */
export function geminiWebFailureCode(message) {
  const text = String(message || "");
  if (/sign(ed)?[ -]?in|logged[ -]?out|session (has )?expired|no longer|unauthori[sz]ed|401|log in again/i.test(text)) {
    return "AUTHENTICATION_FAILED";
  }
  if (/challenge|unable to load|bot-protection|anti-bot/i.test(text)) return "PROVIDER_UNAVAILABLE";
  return "PROVIDER_REQUEST_FAILED";
}

/**
 * The browser half of Gemini Web.
 *
 * Launches Chromium, injects the cookies for `.google.com`, opens
 * `gemini.google.com/app`, selects the requested mode, types the prompt into
 * the composer and presses Enter. The answer is not read from the DOM: the page
 * issues its own `StreamGenerate` request and this **observes that response**,
 * which is the only place the answer exists in full.
 *
 * It does not type character by character — `insertText` fires one DOM input
 * event, so a newline in a prompt cannot press Enter early and a long prompt
 * cannot race the timeout. And it does not concatenate the captured frames:
 * they are cumulative snapshots, and joining them duplicates the reply.
 *
 * Each turn launches a browser. A persistent profile is used for the same
 * reason the ChatGPT driver uses one — a cold browser is slower and
 * re-challenges the page every time — and it is closed in `finally` whichever
 * way the turn ends.
 */
export function createGeminiWebDriver(connectionKey = "default") {
  return {
    /** Whether a browser is actually available, and what to do when it is not. */
    async available() {
      const playwright = await loadPlaywright();
      if (!playwright) {
        return {
          ok: false,
          reason: MISSING_BROWSER_MESSAGE,
        };
      }
      return { ok: true };
    },

    /**
     * Confirms the session is signed in, by opening the page.
     *
     * This is what the dashboard's "Check" button means, and it is why the
     * button costs a page load: cookie presence and expiry are local checks,
     * and neither can tell a working session from one Google has revoked. Only
     * the page knows.
     */
    async verify({ cookie, timeoutMs = GEMINI_WEB.navigationTimeoutMs + GEMINI_WEB.settleMs } = {}) {
      const { context, close } = await open(connectionKey, cookie);
      try {
        const page = await context.newPage();
        await page.goto(GEMINI_WEB.startUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        await page.waitForTimeout(GEMINI_WEB.settleMs);

        /**
         * The sign-in wall is checked **first**, and a composer alone is not
         * enough.
         *
         * Both halves are load-bearing, and both were got wrong once. Gemini's
         * signed-out page carries hidden contenteditable nodes, so
         * `waitForSelector` resolves against one of them while
         * `locator().count()` for a real composer is zero — measured on the
         * previous project's machine with a bogus cookie:
         *
         *   url: https://gemini.google.com/app
         *   ql-editor: 0     [contenteditable=true]: 0     sign-in link: 1
         *   waitForSelector('.ql-editor, [contenteditable="true"]') -> resolved truthy
         *
         * So a check built on `waitForSelector` alone reported a signed-out
         * session as **connected**, which is the worst answer this button can
         * give: the user saves a dead connection and only finds out when a turn
         * fails. The composer must therefore be counted *and* visible, and the
         * wall checked before it.
         */
        const signedOut = await page.locator(GEMINI_WEB.signedOutLink).count();
        if (signedOut > 0) {
          return {
            ok: false,
            note: "The page is showing a Google sign-in wall, so the pasted session is no longer valid. Copy fresh cookies from gemini.google.com while you are signed in.",
          };
        }

        const composer = page.locator(GEMINI_WEB.composer).first();
        if ((await composer.count()) > 0 && (await composer.isVisible().catch(() => false))) return { ok: true };

        return {
          ok: false,
          note: "The Gemini page opened but no usable composer was found, so a turn could not be sent. The page may have changed, or the session may be signed out.",
        };
      } finally {
        await close();
      }
    },

    /**
     * Drives one turn and returns the answer.
     *
     * `onRotatedCookies` is how rotation reaches storage. Google replaces the
     * three `__Secure-1PSID*` cookies on its own schedule, and only the live
     * browser jar knows the new values — so the driver hands them back here
     * rather than through the response, which has no field for them.
     * Persisting is the caller's job, and a failure to persist must never fail
     * the answer: the turn already succeeded.
     */
    async ask({ cookies = [], model, messages = [], timeoutMs, signal, onRotatedCookies } = {}) {
      const header = cookies.map((pair) => `${pair.name}=${pair.value}`).join("; ");
      const prompt = buildGeminiWebPrompt(messages);
      // The budget the caller set bounds waiting for the answer; the navigation
      // has its own smaller timeout. Taking it rather than ignoring it keeps a
      // caller's shorter deadline meaningful.
      const budget = timeoutMs || GEMINI_WEB.answerTimeoutMs + GEMINI_WEB.navigationTimeoutMs + GEMINI_WEB.settleMs;
      const answerTimeoutMs = Math.max(1_000, budget - GEMINI_WEB.navigationTimeoutMs - GEMINI_WEB.settleMs);
      const { context, close } = await open(connectionKey, header);

      let responseText = "";
      let captured = false;
      try {
        if (signal?.aborted) {
          throw new GeminiWebError("CANCELLED", "The request was cancelled before the page opened.", { status: 499 });
        }
        const page = await context.newPage();

        // The answer is not in the DOM; it is in the response the page makes for
        // itself. **Only the first `StreamGenerate` is taken** — later ones
        // belong to whatever the page does next — and the promise resolves even
        // when reading the body fails, so a failure falls through to the
        // empty-answer refusal instead of burning the whole wait.
        let resolveResponse = () => {};
        const responsePromise = new Promise((resolve) => {
          resolveResponse = resolve;
        });
        page.on("response", (response) => {
          const url = response.url();
          if (!url.includes(GEMINI_WEB.streamMarker) || captured) return;
          captured = true;
          void response
            .text()
            .then((text) => {
              responseText = parseGeminiWebStreamResponse(text);
            })
            .catch(() => undefined)
            .finally(() => resolveResponse());
        });

        await page.goto(GEMINI_WEB.startUrl, { waitUntil: "domcontentloaded", timeout: GEMINI_WEB.navigationTimeoutMs });
        await page.waitForTimeout(GEMINI_WEB.settleMs);
        if (signal?.aborted) {
          throw new GeminiWebError("CANCELLED", "The request was cancelled while the page loaded.", { status: 499 });
        }

        await selectModel(page, model);

        // The same check the connect path makes, and for the same reason:
        // `waitForSelector` resolves against a hidden contenteditable on a
        // signed-out page, so the sign-in wall is looked for first and the
        // composer must be counted **and visible** before a prompt is typed
        // into it.
        if ((await page.locator(GEMINI_WEB.signedOutLink).count()) > 0) {
          throw new GeminiWebError("AUTHENTICATION_FAILED", "The Gemini page is showing a sign-in wall.", {
            status: 401,
          });
        }
        const composer = page.locator(GEMINI_WEB.composer).first();
        if ((await composer.count()) === 0 || !(await composer.isVisible().catch(() => false))) {
          throw new GeminiWebError("AUTHENTICATION_FAILED", "No visible Gemini composer was found.", {
            status: 401,
          });
        }
        await composer.click({ timeout: 5_000 });
        // `insertText`, not per-character typing: one DOM input event, so a
        // newline in the prompt cannot press Enter early and a long prompt
        // cannot race the timeout.
        await page.keyboard.insertText(prompt);
        await page.waitForTimeout(300);
        await page.keyboard.press("Enter");

        await Promise.race([responsePromise, page.waitForTimeout(answerTimeoutMs)]);

        // Google rotates the session cookies during a turn, and only the jar
        // knows the new values. Handed back for storage; a failure to store
        // them must not fail the turn, which is why the callback is optional and
        // its rejection is swallowed here.
        if (onRotatedCookies) {
          const jar = await context.cookies().catch(() => []);
          const merged = mergeRotatedGeminiWebCookies(header, jar);
          if (merged !== header) await Promise.resolve(onRotatedCookies(merged)).catch(() => undefined);
        }

        return { text: responseText };
      } catch (error) {
        if (error instanceof GeminiWebError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        if (isMissingBrowser(message)) {
          throw new GeminiWebError("PROVIDER_UNAVAILABLE", MISSING_BROWSER_MESSAGE, { status: 503 });
        }
        const code = geminiWebFailureCode(message);
        throw new GeminiWebError(code, `The Gemini page could not be driven: ${message}`, {
          status: code === "AUTHENTICATION_FAILED" ? 401 : 502,
        });
      } finally {
        await close();
      }
    },
  };

  /** Launches the persistent profile, injects the cookies, and returns a closer that always runs. */
  async function open(key, cookie) {
    const playwright = await loadPlaywright();
    if (!playwright) {
      throw new GeminiWebError("PROVIDER_UNAVAILABLE", MISSING_BROWSER_MESSAGE, { status: 503 });
    }
    const context = await playwright.chromium.launchPersistentContext(profileDir(GEMINI_WEB_PROVIDER_ID, key), {
      headless: true,
      // Playwright's default headless user agent announces itself, and Google's
      // edge treats that as automation. The version is the one this Chromium
      // actually reports.
      userAgent: CHROME_USER_AGENT,
      locale: BROWSER_LOCALE,
      timezoneId: BROWSER_TIMEZONE,
      args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
    });
    try {
      await addGeminiCookies(context, cookie);
    } catch (error) {
      await context.close().catch(() => undefined);
      throw error;
    }
    return { context, close: async () => { await context.close().catch(() => undefined); } };
  }
}

/**
 * Injects the pasted cookies.
 *
 * A bare `__Secure-1PSID` value has no name in it, so it is normalised first —
 * the same rule the parser applies, applied once more here because this is the
 * last place before the browser sees it.
 */
async function addGeminiCookies(context, header) {
  const pairs = parseGeminiWebCookieHeader(normalizeGeminiWebCookie(header));
  if (pairs.length === 0) {
    throw new GeminiWebError("AUTHENTICATION_FAILED", "No Gemini cookie was provided.", { status: 401 });
  }
  await context.addCookies(
    pairs.map((pair) => ({ name: pair.name, value: pair.value, domain: ".google.com", path: "/", secure: true })),
  );
}

/**
 * Drives the mode menu, and **fails closed**.
 *
 * A click that lands is not evidence: the menu may not have opened, the item
 * may not have been there, or the page may already be on a different mode. So
 * the active mode is read back and matched against the pattern, and anything
 * else is a refusal. The alternative — assume the click worked — answers with a
 * model nobody asked for and calls it the one they did.
 */
async function selectModel(page, model) {
  if (!model || model.isDefault) return;
  const failure = (reason) =>
    new GeminiWebError("NOT_SUPPORTED", `Gemini Web could not select ${model.name} (${reason}).`, {
      status: 400,
    });
  if (!model.toggleSelector || !model.indicatorSelector || !model.indicatorPattern) throw failure("no selector");

  const toggle = page.locator(model.toggleSelector).first();
  if ((await toggle.count()) === 0) throw failure("control not found");
  await toggle
    .click({ timeout: 5_000 })
    .catch(() => {
      throw failure("control not clickable");
    });

  const indicator = page.locator(model.indicatorSelector).first();
  if ((await indicator.count()) === 0) throw failure("indicator not found");
  const text = (await indicator.textContent().catch(() => null)) ?? (await indicator.innerText().catch(() => ""));
  if (!model.indicatorPattern.test(text)) throw failure(`the page still reports ${JSON.stringify(text.trim())}`);
}

/**
 * Checks a pasted Gemini cookie and stores nothing.
 *
 * The check is a page load, because cookie presence and expiry are local
 * checks and neither can tell a working session from one Google has revoked.
 */
export async function checkWebSession(credential) {
  const models = geminiWebModelIds();
  let cookie;
  try {
    cookie = normalizeGeminiWebCookie(credential);
  } catch (error) {
    const detail = error.message || "That is not a Gemini cookie.";
    return { ok: false, detail, error: detail, models };
  }
  if (!geminiWebCookiePresent(cookie)) {
    const detail =
      "Paste the value of `__Secure-1PSID` (and `__Secure-1PSIDTS` if you have it), or the whole Cookie header from gemini.google.com.";
    return { ok: false, detail, error: detail, models };
  }

  const driver = createGeminiWebDriver();
  try {
    const available = await driver.available();
    if (!available.ok) {
      return { ok: false, detail: available.reason, error: available.reason, models };
    }
    const result = await driver.verify({ cookie });
    const detail = result.ok
      ? "The Gemini page is signed in, so the session works."
      : result.note || "Gemini did not accept that session. Copy fresh cookies from gemini.google.com while signed in.";
    return { ok: !!result.ok, detail, error: result.ok ? undefined : detail, models };
  } catch (error) {
    const detail = error.message || "The Gemini page could not be opened.";
    return { ok: false, detail, error: detail, models };
  }
}

/**
 * Stores a Gemini Web cookie, after checking the page accepts it.
 *
 * Checked first, so a refused cookie never becomes a connection that looks
 * connected and answers nothing.
 */
export async function connectWebSession(credential) {
  const checked = await checkWebSession(credential);
  if (!checked.ok) {
    return { ok: false, error: checked.detail, models: checked.models };
  }
  return {
    ok: true,
    credential: normalizeGeminiWebCookie(credential),
    models: checked.models,
    name: "Gemini Web",
  };
}
