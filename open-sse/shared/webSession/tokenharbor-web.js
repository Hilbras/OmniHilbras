import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import tokenHarborWebEntry from "../../providers/registry/tokenharbor-web.js";
import {
  browserFingerprintHeaders,
  cookieHeaderFrom,
  parseCookieHeader,
  readBodyRefusal,
} from "./common.js";

/**
 * Token Harbor Web — the dashboard half of the provider.
 *
 * The credential is a Supabase session cookie the signed-in browser already
 * holds (`sb-auth-auth-token`, split into `.0`, `.1`, ... above Supabase's
 * size limit). Two things live here:
 *
 * - the **parser**, which turns whatever the user pasted into one `Cookie:`
 *   header value, and
 * - the **check / connect** pair, which asks Token Harbor whether that cookie
 *   means anything and then hands the normalized value back to be stored.
 *
 * ## What a check proves
 *
 * A check reads `/api/me/profile`. That proves the session cookie is accepted
 * and nothing more: whether a model can answer is only known by sending a
 * turn, which is why the card says "credential check" rather than "working".
 *
 * ## What is not stored by a check
 *
 * Nothing. A probe that half-connects is worse than no probe — the user would
 * believe the credential is good and find out on their first request — so the
 * check only reads, and the connect path is the one that verifies before it
 * saves.
 */

/**
 * The endpoints and the model catalog, read from the registry entry so no URL
 * is spelled twice.
 *
 * The entry file is read directly rather than through the `PROVIDERS` barrel:
 * that barrel is built from a generated static-import list, and a provider
 * whose entry has not been added to that list yet would otherwise have no
 * endpoint and no catalog at all.
 */
const TRANSPORT = tokenHarborWebEntry.transport || {};
const MODELS = tokenHarborWebEntry.models || [];

/**
 * The cookie prefix Supabase mints on the `auth` host. Chunks append `.0`,
 * `.1`, ...
 */
const SESSION_COOKIE_PREFIX = "sb-auth-auth-token";

/** `base64-` is Supabase's `base64url` cookie encoding, and the prefix their own decoder strips. */
const SESSION_VALUE_PREFIX = "base64-";

const PASTE_MESSAGE =
  "Paste the Cookie header or the sb-auth-auth-token value from tokenharbor.ai.";

const SIGNED_OUT_MESSAGE =
  `The "${SESSION_COOKIE_PREFIX}" cookie is empty, which is what the browser stores when you are signed out. Sign in at tokenharbor.ai and copy it again.`;

/**
 * Reads the Supabase session cookie out of whatever the user pasted.
 *
 * Two pastes are accepted, because both are things the guide tells people to
 * copy:
 *
 * - the whole `Cookie:` request header (space for the Cloudflare clearance and
 *   the other cookies the SSR layer reads), and
 * - just the `sb-auth-auth-token` value or the `sb-auth-auth-token=...` pair,
 *   from the Application panel.
 *
 * The chunks are **joined in numeric order**, which is not the order they
 * appear in a header: a large token is stored as `.0`, `.1`, ... and a header
 * that happens to list `.1` before `.0` would otherwise reassemble to a
 * garbage session that fails later as an unexplained refusal.
 */
export function parseTokenHarborCookie(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) {
    throw new Error(PASTE_MESSAGE);
  }

  // The Application panel's single-field copy: the value on its own, or the
  // cookie name with nothing after it. Neither is a header, so both are
  // handled before the shared parser sees them.
  const bare = bareSessionValue(trimmed);
  if (bare !== null) {
    if (!bare) throw new Error(SIGNED_OUT_MESSAGE);
    const bareProblem = sessionValueProblem(bare);
    if (bareProblem) throw new Error(bareProblem);
    return `${SESSION_COOKIE_PREFIX}=${bare}`;
  }

  // Supabase stores an empty value when there is no session. Naming that
  // state is the difference between "you are signed out" and "that paste is
  // not a cookie", and the shared parser cannot tell them apart because it
  // drops empty values.
  if (new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_PREFIX}=\\s*(?:;|$)`).test(trimmed)) {
    throw new Error(SIGNED_OUT_MESSAGE);
  }

  // A header. The shared parser refuses the two pastes that are not cookies at
  // all — a pasted request line, and a string with no name=value pair in it —
  // and its message is the one the user gets.
  const pairs = parseCookieHeader(stripCookieHeaderName(cookieLine(trimmed)));

  const names = Object.keys(pairs);
  const chunkNames = names
    .filter((name) => name === SESSION_COOKIE_PREFIX || name.startsWith(`${SESSION_COOKIE_PREFIX}.`))
    .sort((a, b) => chunkIndex(a) - chunkIndex(b));

  if (chunkNames.length === 0) {
    throw new Error(
      `That Cookie header carries no "${SESSION_COOKIE_PREFIX}" cookie. Sign in at tokenharbor.ai and copy it again.`,
    );
  }

  const session = chunkNames.map((name) => pairs[name] ?? "").join("");
  if (!session) {
    throw new Error(SIGNED_OUT_MESSAGE);
  }

  /**
   * **A truncated paste is refused here, by name, rather than forwarded.**
   *
   * Supabase stores `base64-<base64url(JSON session)>`. A session is long, and
   * the two ways people paste one — selecting a single Application-panel row,
   * or copying a wrapped header line — routinely cut it short. A cut-short
   * value is forwarded as a cookie, Token Harbor answers 401, and the user is
   * told to sign in again for a paste that never finished. That is exactly the
   * fault the DeepSeek parser was fixed for (`{"value":null}` treated as a
   * token), one provider over: **the most likely bad paste is answered as the
   * wrong problem.**
   */
  const problem = sessionValueProblem(session);
  if (problem) throw new Error(problem);

  // Keep every non-chunk cookie the paste carried — the SSR layer reads the
  // clearance and the rest — and replace the chunks with the single
  // reassembled value.
  const kept = {};
  for (const name of names) {
    if (name === SESSION_COOKIE_PREFIX || name.startsWith(`${SESSION_COOKIE_PREFIX}.`)) continue;
    kept[name] = pairs[name];
  }
  const keptHeader = cookieHeaderFrom(kept);
  const sessionPair = `${SESSION_COOKIE_PREFIX}=${session}`;
  return keptHeader ? `${keptHeader}; ${sessionPair}` : sessionPair;
}

/**
 * The session value of a paste that is not a header, or `null` when the paste
 * is a header after all.
 *
 * A bare value (no `;`, no `name=`) is the Application panel's single-field
 * copy. Supabase v2 stores the session as `base64-<...>`, which is the shape
 * that identifies it as the session rather than one of the sibling cookies; a
 * bare value that is neither that nor the name=value pair is refused by the
 * shared parser rather than guessed at.
 */
function bareSessionValue(trimmed) {
  if (trimmed.startsWith(SESSION_VALUE_PREFIX)) return trimmed;
  if (trimmed === SESSION_COOKIE_PREFIX) return "";
  return null;
}

/**
 * Drops a leading `Cookie:` from a paste.
 *
 * The guide says to copy the Cookie *header*, and a header copied out of the
 * Network panel sometimes arrives with its name still attached. A paste like
 * `Cookie: sb-auth-auth-token=...` is the same credential with one more word
 * in front of it, and refusing it would send the user off to copy it again.
 */
function stripCookieHeaderName(text) {
  return text.replace(/^\s*cookie\s*:\s*/i, "");
}

/**
 * Reduces a paste to its cookie line.
 *
 * A raw request pasted whole — the Network tab's "Copy as fetch", or a copied
 * block of headers — carries the Cookie line among the others. Only that line
 * is the credential; the rest is the request the browser has already made.
 */
function cookieLine(text) {
  if (!/[\r\n]/.test(text)) return text;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const found = lines.find((line) => /^cookie\s*:/i.test(line));
  return found || lines[0] || text;
}

/** The numeric order of a chunk name: the bare cookie is 0, `.0` is 1, and so on. */
function chunkIndex(name) {
  if (name === SESSION_COOKIE_PREFIX) return 0;
  const suffix = Number(name.slice(SESSION_COOKIE_PREFIX.length + 1));
  return Number.isFinite(suffix) ? suffix + 1 : Number.MAX_SAFE_INTEGER;
}

function base64UrlDecodeToString(value) {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    // `atob` yields latin1; the JSON is UTF-8, so the bytes are re-decoded
    // rather than mangled.
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Decodes the session cookie and reports what is wrong with it, or `undefined`
 * when it is intact.
 *
 * Returns a sentence rather than a boolean because the two failures need
 * different instructions: a value that does not decode is a **truncated
 * paste**, and a value that decodes but carries no access token is a **shape
 * this adapter does not recognise**. "Sign in again" is wrong for the first —
 * the session is fine, the paste was short.
 */
export function sessionValueProblem(session) {
  if (!session.startsWith(SESSION_VALUE_PREFIX)) {
    // Not base64url. It may still be a session this service accepts, so it is
    // not refused — but a value that is neither `base64-` nor obviously a JWT
    // is worth naming, because the paste instructions describe the `base64-`
    // form.
    return session.split(".").length === 3
      ? undefined
      : `That session value is not in the shape tokenharbor.ai stores it in — it should start with "${SESSION_VALUE_PREFIX}". Copy the whole value of the cookie, or the whole Cookie header.`;
  }
  const decoded = base64UrlDecodeToString(session.slice(SESSION_VALUE_PREFIX.length));
  if (decoded === undefined) {
    return "That session cookie is not valid base64, which almost always means the paste was cut short. Select the entire cookie value — it is long, and a partially copied one is refused here rather than sent and reported as a dead session.";
  }
  let parsed;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return "That session cookie was cut short: it decodes to something that is not complete JSON. Copy the whole cookie value (or the whole Cookie header) and paste it again — the session itself is probably fine.";
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.access_token !== "string") {
    return `That cookie decodes, but it carries no access token, so this adapter does not recognise it as a Token Harbor session. Confirm you copied the cookie named "${SESSION_COOKIE_PREFIX}".`;
  }
  return undefined;
}

/**
 * The `expires_at` epoch seconds inside the session, when it is one this
 * adapter can read.
 *
 * Accepts either the bare value or a whole Cookie header, because the two
 * callers have different shapes in hand: the parser has the value, the refusal
 * path has the assembled header.
 */
export function sessionExpiresAt(sessionOrCookie) {
  const session = sessionValueFrom(sessionOrCookie);
  if (session === undefined) return undefined;
  const decoded = base64UrlDecodeToString(session.slice(SESSION_VALUE_PREFIX.length));
  if (decoded === undefined) return undefined;
  try {
    const parsed = JSON.parse(decoded);
    return typeof parsed.expires_at === "number" ? parsed.expires_at : undefined;
  } catch {
    return undefined;
  }
}

/** The `sb-auth-auth-token` value, from a bare value or a whole Cookie header. */
function sessionValueFrom(sessionOrCookie) {
  const trimmed = String(sessionOrCookie || "").trim();
  if (trimmed.startsWith(SESSION_VALUE_PREFIX)) return trimmed;
  const match = trimmed.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_PREFIX}=([^;]+)`));
  return match?.[1]?.trim() ?? undefined;
}

/**
 * The headers a same-origin browser request carries.
 *
 * Same-origin `fetch` attaches the cookies and sends an `Origin` for free;
 * from Node both have to be stated. They are not a bot-defeating bluff —
 * Cloudflare sits in front of this host, and a request with no `Origin`, no
 * `Referer` and Node's default `User-Agent` is the shape a challenge is meant
 * to stop. What is sent here is what a browser at this origin sends.
 */
function browserHeaders(cookie) {
  const origin = TRANSPORT.origin;
  return {
    ...browserFingerprintHeaders({
      origin,
      referer: origin ? `${origin}/chat` : undefined,
      accept: "application/json",
    }),
    Cookie: cookie,
  };
}

/**
 * Turns a non-ok status into the refusal it actually is, rather than one
 * blanket code.
 */
export function refusalFor(status, what, session) {
  if (status === 401 || status === 403) {
    // Read the expiry out of the pasted session so the sentence distinguishes
    // the two cases a 401 covers. Telling somebody to sign in again when
    // nothing is wrong with the session sends them round a loop; telling them
    // the session is fine when it expired wastes the same trip.
    const expiresAt = session ? sessionExpiresAt(session) : undefined;
    const expired = expiresAt !== undefined && expiresAt * 1000 <= Date.now();
    const who = expired
      ? `The pasted session expired at ${new Date(expiresAt * 1000).toISOString()}. Sign in at tokenharbor.ai and copy a fresh cookie.`
      : "Sign in at tokenharbor.ai again and paste a fresh cookie. A 403 can also be Cloudflare refusing the request rather than the session being dead.";
    return `Token Harbor refused this session while ${what} (${status}). ${who}`;
  }
  if (status === 429) {
    return `Token Harbor is rate limiting this session (${status}) while ${what}.`;
  }
  if (status === 402) {
    return `Token Harbor refused ${what}: the account has no balance for this model (402). The ":free" models do not bill.`;
  }
  return `Token Harbor answered ${status} while ${what}.`;
}

/**
 * Reads the profile — the cheapest endpoint that proves the cookie is
 * accepted.
 *
 * The status is the answer for this service, but the body is read too: a
 * service that signals a refusal with HTTP 200 and a body would otherwise
 * report a guest cookie as a working credential.
 */
async function readProfile(cookie) {
  const url = TRANSPORT.profileUrl;
  if (!url) {
    return { ok: false, detail: "Token Harbor Web is not configured in this build." };
  }

  let response;
  try {
    response = await proxyAwareFetch(url, {
      method: "GET",
      headers: browserHeaders(cookie),
    });
  } catch (error) {
    return {
      ok: false,
      detail: `Token Harbor could not be reached: ${error?.message || String(error)}`,
    };
  }

  const payload = await response.json().catch(() => undefined);
  const bodyRefusal =
    readBodyRefusal(payload) || (payload?.ok === false ? "the service answered ok:false" : undefined);

  if (!response.ok) {
    return { ok: false, detail: refusalFor(response.status, "checking the session", cookie) };
  }

  if (bodyRefusal) {
    // The status said yes and the body said no. The body wins: a service that
    // signals a refusal with HTTP 200 would otherwise report a guest cookie as
    // a working credential.
    return {
      ok: false,
      detail: `Token Harbor did not accept the session (${bodyRefusal}). Sign in at tokenharbor.ai again and paste a fresh cookie.`,
    };
  }

  return {
    ok: true,
    detail: "Token Harbor accepted the session cookie.",
    // Best-effort: the profile is the only place a signed-in address can
    // come from, and the shape of the answer is not something this adapter
    // can test without a session. A miss costs nothing.
    email: typeof payload?.email === "string" ? payload.email : undefined,
  };
}

/** The model ids this provider serves, from the registry's dated catalog. */
function modelIds() {
  return MODELS.map((model) => model.id).filter(Boolean);
}

/**
 * Asks Token Harbor whether the pasted credential means anything.
 *
 * A read, not a connect: nothing is saved, and the answer is about the
 * credential rather than about a model being able to answer.
 */
export async function checkWebSession(credential) {
  let cookie;
  try {
    cookie = parseTokenHarborCookie(credential);
  } catch (error) {
    return { ok: false, detail: error?.message || PASTE_MESSAGE };
  }

  const profile = await readProfile(cookie);
  if (!profile.ok) {
    return { ok: false, detail: profile.detail };
  }

  return { ok: true, detail: profile.detail, models: modelIds() };
}

/**
 * Normalizes the paste and returns the credential to store.
 *
 * Verified **before** the save, so a refused cookie never becomes a
 * connection — the same order the other web-session providers use, and the
 * opposite of what produces a saved-but-dead connection.
 */
export async function connectWebSession(credential) {
  let cookie;
  try {
    cookie = parseTokenHarborCookie(credential);
  } catch (error) {
    const detail = error?.message || PASTE_MESSAGE;
    return { ok: false, error: detail, detail };
  }

  const profile = await readProfile(cookie);
  if (!profile.ok) {
    return { ok: false, error: profile.detail, detail: profile.detail };
  }

  return {
    ok: true,
    credential: cookie,
    models: modelIds(),
    name: "Token Harbor Web",
    email: profile.email,
  };
}
