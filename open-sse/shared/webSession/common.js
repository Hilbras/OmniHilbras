import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Shared plumbing for the web-session providers (the "Web Cookie Sessions" group).
 *
 * These providers reach a service through a credential a signed-in browser
 * holds — a cookie, a localStorage token — rather than through an API key.
 * The credential is pasted by the user; everything here is the machinery that
 * turns that paste into a request the service will answer.
 *
 * Ported from the previous project's web-session layer. The comments carry
 * the measurements that decided the behaviour: several of these services
 * refuse a request that does not look like it came from the web app, and one
 * of them signals refusal with HTTP 200.
 */

/** The browser's own user agent, sent verbatim so the client cannot be told apart from the app. */
export const CHROME_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.7922.34 Safari/537.36";

export const BROWSER_LOCALE = "en-US";
export const BROWSER_TIMEZONE = "America/New_York";

/**
 * Reads a pasted cookie header (or a lone `name=value`) into a plain object.
 *
 * A pasted request line is the commonest mistake and reads as a nonsense
 * credential, so it is refused with a message that says what to copy.
 */
export function parseCookieHeader(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) throw new Error("Paste the Cookie header from your browser.");
  if (/^(GET|POST|PUT|HEAD|OPTIONS|DELETE|PATCH)\s+\//i.test(trimmed)) {
    throw new Error("That is a request line, not a cookie. Copy the value of the Cookie header only.");
  }
  const out = {};
  for (const part of trimmed.split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (name && value) out[name] = value;
  }
  if (Object.keys(out).length === 0) {
    throw new Error("That does not look like a cookie header — it has no name=value pairs in it.");
  }
  return out;
}

/** The same pairs as a `Cookie:` header value. */
export function cookieHeaderFrom(pairs) {
  return Object.entries(pairs || {})
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

/**
 * Headers that make a request look like it came from the web app.
 *
 * Several of these services sit behind a gateway that fingerprints the
 * client, and a bare API call is refused where the app is not.
 */
export function browserFingerprintHeaders({ origin, referer, accept = "application/json", extra = {} } = {}) {
  const headers = {
    accept,
    "accept-language": "en-US,en;q=0.9",
    "user-agent": CHROME_USER_AGENT,
    "sec-ch-ua": '"Chromium";v="151", "Not(A:Brand";v="8"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Linux"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    ...extra,
  };
  if (origin) headers.origin = origin;
  if (referer) headers.referer = referer;
  return headers;
}

/**
 * Whether an error is Chromium not being installed.
 *
 * Classified because the fix is different in kind from every other failure:
 * nothing about the credential or the network is wrong, and the message that
 * comes back has to name the command that fixes it.
 */
export function isMissingBrowser(message) {
  const lower = String(message || "").toLowerCase();
  return (
    lower.includes("executable doesn't exist") ||
    lower.includes("executablenotfound") ||
    lower.includes("playwright install") ||
    (lower.includes("chromium") && lower.includes("download"))
  );
}

let playwrightPromise = null;

/**
 * Loads playwright-core, or undefined when it is not installed.
 *
 * The import is dynamic and the failure is swallowed on purpose: a user
 * without a browser should get a provider that says so, not a crash in the
 * gateway.
 */
export async function loadPlaywright() {
  playwrightPromise ??= (async () => {
    try {
      return await import("playwright-core");
    } catch {
      return undefined;
    }
  })();
  return playwrightPromise;
}

/**
 * A profile directory per connection, so one session's cookies are never
 * another session's.
 */
export function profileDir(providerId, connectionKey) {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const hash = createHash("sha256").update(String(connectionKey || "default")).digest("hex").slice(0, 32);
  return join(base, "omnihilbras", providerId, hash);
}

/**
 * The message a user gets when the browser is missing.
 *
 * The fix is a command, so the message is a command.
 */
export const MISSING_BROWSER_MESSAGE =
  "This provider needs a browser. Install Chromium with `npx playwright install chromium`, " +
  "then try again — everything else about the connection is fine.";

/**
 * Reads a refusal out of a response body.
 *
 * One of these services signals every refusal in the body and never in the
 * status code, so a check that trusted the status would report a guest
 * cookie as a working credential.
 */
export function readBodyRefusal(payload) {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload;
  if (record.success !== false) {
    const ret = Array.isArray(record.ret) ? record.ret : null;
    if (ret && ret.length > 0) return `refused: ${ret.join(", ")}`;
    return undefined;
  }
  const code = record.data?.code ?? record.code;
  const details = record.data?.details ?? record.details;
  return (
    [typeof code === "string" ? code : undefined, typeof details === "string" ? details : undefined]
      .filter(Boolean)
      .join(" — ") || "refused"
  );
}
