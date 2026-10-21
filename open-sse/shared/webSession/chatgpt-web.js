/**
 * ChatGPT Web — the credential layer for a whole-account browser session.
 *
 * This is not an API integration and it is not an OAuth flow. There is no
 * OpenAI endpoint that accepts a browser session, so the only way to reach a
 * model this way is to load chatgpt.com in a real browser, let ChatGPT's own
 * page solve its anti-automation challenges, send the turn through the page's
 * own request path, and read the answer back out of it.
 *
 * The credential is therefore not a token scoped to inference — it is a **live
 * session for the whole OpenAI account**. A Kiro token can answer a chat; a
 * `__Secure-next-auth.session-token` can do everything the person who exported
 * it can. That is a property of what the credential is, and it is why the
 * card carries a warning.
 *
 * This module owns the parts that can be reasoned about and tested without a
 * browser: what a storage state is, what a cookie header looks like, which
 * models the account is offered, and whether an exported session is still
 * signed in. The turn itself is the executor's business.
 */

import { mkdir } from "node:fs/promises";
import {
  BROWSER_LOCALE,
  BROWSER_TIMEZONE,
  CHROME_USER_AGENT,
  MISSING_BROWSER_MESSAGE,
  isMissingBrowser,
  loadPlaywright,
  parseCookieHeader,
  profileDir,
} from "./common.js";

/**
 * The one cookie a session is read from.
 *
 * Named in a single place because the connect dialog tells the user to copy
 * exactly this cookie by name, and a second copy of the string is a second
 * chance for the instruction and the parser to disagree — which shows up as a
 * dialog that says to copy something the parser will not accept.
 */
export const CHATGPT_WEB_SESSION_COOKIE = "__Secure-next-auth.session-token";

export const CHATGPT_WEB = {
  /** The only origin this will talk to. */
  origin: "https://chatgpt.com",
  /**
   * The signed-in landing page.
   *
   * `?temporary-chat=true` would keep a gateway's traffic out of the account's
   * visible history, which is the right idea, but it is also what triggers the
   * first-use onboarding modal — which holds focus and intercepts the request
   * — and it failed to navigate at all on the address this was tested from. A
   * turn sent through the first-party request path creates its own
   * conversation regardless, so the URL is not what keeps history clean.
   */
  startUrl: "https://chatgpt.com/",
  /** Playwright needs a writable profile directory; this is where the browser state goes. */
  defaultTurnTimeoutMs: 180_000,
  navigationTimeoutMs: 30_000,
  /**
   * The composer and the answer.
   *
   * These are ChatGPT's own test hooks rather than styling hooks, which is
   * why they are used in preference to class names. They are still a private
   * contract with a product that ships changes daily: when ChatGPT renames
   * one, this breaks. That is a real limit of driving a web app rather than
   * its API, and it is stated instead of hidden behind a retry loop that
   * would only fail more slowly.
   */
  composer: "#prompt-textarea",
  sendButton: 'button[data-testid="send-button"]',
  assistantMessage: '[data-message-author-role="assistant"]',
  /** The stop button replaces send while a turn is running. */
  stopButton: 'button[data-testid="stop-button"]',
  /** A sign-in wall. Its presence means the exported session is no longer valid. */
  signedOutMarker: 'a[href="/auth/login"]',
  /**
   * The first-use "Temporary Chat" modal. It holds focus and intercepts the
   * click on Send, so it is dismissed rather than clicked through — a real
   * browser remembers it being dismissed, and this one persists its profile so
   * it does too.
   */
  onboardingModal: '[data-testid="modal-temporary-chat-onboarding"]',
};

/**
 * A failure with a kind, because the kinds have different fixes.
 *
 * - `AUTHENTICATION_FAILED` — the session is dead. The user's next action is
 *   to sign in again, so the router stops instead of failing over.
 * - `PROVIDER_UNAVAILABLE` — the network, or a missing browser. Not the
 *   user's fault, and not retryable by signing in.
 * - `PROVIDER_REQUEST_FAILED` — anything else, which the router may retry.
 */
export class ChatGptWebError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ChatGptWebError";
    this.code = code;
  }
}

/* ------------------------------------------------------------------ *
 * The exported session
 * ------------------------------------------------------------------ */

/**
 * The cookies worth keeping out of a pasted `Cookie` header.
 *
 * A header carries every cookie the site set, and only some of them are the
 * session. An allowlist rather than a denylist, because a header the user
 * pasted from their own browser is still user-supplied input, and the job
 * here is to send ChatGPT its own cookies and nothing else.
 *
 * The Cloudflare pair matters: the edge sets its own clearance cookie on the
 * first response, and a session sent without it can be challenged even though
 * the token is valid.
 */
const COOKIE_HEADER_ALLOWLIST = new Set([
  CHATGPT_WEB_SESSION_COOKIE,
  "__Secure-next-auth.csrf-token",
  "oai-did",
  "cf_clearance",
  "__cf_bm",
  "_cfuvid",
]);

/**
 * Reads a pasted `Cookie` request header.
 *
 * Two things it has to get right, both from the same source: the session token
 * is often **split into numbered chunks** by the browser, so `name.0` and
 * `name.1` are one value and not two; and the `Cookie:` prefix is usually
 * included even though the guide says to omit it, because people copy the
 * whole header line.
 */
function fromCookieHeader(raw) {
  /**
   * The shared reader refuses the two commonest bad pastes with a message
   * that says what to copy: an empty field, and a request line.
   */
  const pairs = parseCookieHeader(raw);

  const values = new Map();
  // Sparse on purpose: a gap is a gap, and `undefined` is how it shows up.
  const chunked = new Map();
  /**
   * Whether *any* NextAuth cookie was present, including ones the allowlist
   * drops.
   *
   * Tracked from the raw names rather than from `values`, because the cookie
   * that identifies a signed-in browser — `__Secure-next-auth.callback-url` —
   * is deliberately not forwarded, so by the time the check below runs there
   * is no trace of it. Without this, a header copied from the Console of a
   * signed-in browser is indistinguishable from one copied while signed out,
   * and the message tells a signed-in user to sign in.
   */
  let sawNextAuthCookie = false;
  for (const [name, value] of Object.entries(pairs)) {
    if (!value) continue;
    if (name.startsWith("__Secure-next-auth.")) sawNextAuthCookie = true;
    // A chunked session token: `…session-token.0`, `…session-token.1`, and so on.
    const chunk = name.match(/^(.*)\.(\d+)$/);
    const family = chunk?.[1];
    if (family !== undefined && COOKIE_HEADER_ALLOWLIST.has(family)) {
      const parts = chunked.get(family) ?? [];
      parts[Number(chunk[2])] = value;
      chunked.set(family, parts);
      continue;
    }
    if (COOKIE_HEADER_ALLOWLIST.has(name)) values.set(name, value);
  }

  /**
   * Reassembled in index order, and only when the set is whole.
   *
   * A partial token is not a shorter session, it is a broken one, and sending
   * it reads as a refusal. A gap is obviously incomplete; a lone `.0` is the
   * harder case, because it looks complete on its own — but a browser only
   * splits a token that is over its size limit, so a single chunk means the
   * header was cut short, and that is worth naming rather than sending.
   */
  for (const [family, parts] of chunked) {
    // `every` skips holes in a sparse array, so a missing middle chunk would
    // pass the check and the reassembled token would silently lose it.
    // `includes` does not skip holes, which is what makes it the right test
    // for "is this set whole".
    const complete = parts.length > 1 && !parts.includes(undefined) && parts.every((part) => Boolean(part));
    if (!complete) {
      const message =
        parts.length <= 1
          ? `That ${CHATGPT_WEB_SESSION_COOKIE} looks cut short — it has one numbered chunk where a whole token has several. Copy the Cookie header again, from a request that is already authenticated.`
          : `That ${CHATGPT_WEB_SESSION_COOKIE} is missing chunk ${parts.findIndex((part) => !part)}. Copy the Cookie header again.`;
      throw new ChatGptWebError("AUTHENTICATION_FAILED", message);
    }
    values.set(family, parts.join(""));
  }

  if (!values.has(CHATGPT_WEB_SESSION_COOKIE)) {
    /**
     * Two different mistakes produce this same header, and they need opposite
     * fixes.
     *
     * NextAuth sets the session cookie `HttpOnly`, so `document.cookie`
     * **cannot** read it — a console one-liner can never return a credential,
     * however it is written. Meanwhile `__Secure-next-auth.callback-url` is
     * not HttpOnly, so a signed-in browser still leaks *some* of the family
     * through `document.cookie`. That is the discriminator: seeing a sibling
     * cookie means you are signed in and copied from the wrong place, while
     * seeing none of the family means you are not signed in at all.
     *
     * Telling those apart matters because the first is a dead end for the
     * obvious move — you cannot fix it by trying the console again.
     */
    const message = sawNextAuthCookie
      ? `That header has chatgpt cookies but no ${CHATGPT_WEB_SESSION_COOKIE}, because the session cookie is HttpOnly and a console command cannot read it. Copy the Cookie header from the Network tab instead: F12 → Network → reload → click a request to chatgpt.com → Headers → Request Headers → Cookie, and copy that whole line.`
      : `That header has no ${CHATGPT_WEB_SESSION_COOKIE} in it, and no other signed-in cookie either, so this browser is not signed in to chatgpt.com. Sign in first, then copy the Cookie header from the Network tab: F12 → Network → reload → click a request to chatgpt.com → Headers → Request Headers → Cookie.`;
    throw new ChatGptWebError("AUTHENTICATION_FAILED", message);
  }

  const cookies = [...values].map(([name, value]) => ({
    name,
    value,
    domain: ".chatgpt.com",
    path: "/",
    // A header carries no expiry, and inventing one would expire a live session.
    expires: -1,
  }));
  return { cookies, origins: [] };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Turns the CLI auth export into cookies.
 *
 * `sessionToken` *is* the session cookie's value, so it becomes
 * `__Secure-next-auth.session-token` on `.chatgpt.com` — which is the one
 * cookie the page checks. The account block and the `expires` field are
 * carried through, because both are worth more than the cookie alone: one
 * says what the account may use, the other says when this stops working.
 */
function fromAuthExport(source) {
  const sessionToken = typeof source.sessionToken === "string" ? source.sessionToken : "";
  if (!sessionToken) {
    throw new ChatGptWebError("INVALID_REQUEST", "That export has no sessionToken in it.");
  }
  const account = isRecord(source.account) ? source.account : undefined;
  const planType = typeof account?.planType === "string" ? account.planType : undefined;
  const expires =
    typeof source.expires === "string" && !Number.isNaN(Date.parse(source.expires)) ? source.expires : undefined;
  const user = isRecord(source.user) ? source.user : undefined;
  const email = typeof user?.email === "string" ? user.email : undefined;
  return {
    cookies: [
      {
        name: CHATGPT_WEB_SESSION_COOKIE,
        value: sessionToken,
        domain: ".chatgpt.com",
        path: "/",
        // `-1` is a session cookie, so it is never treated as expired by the
        // header builder.
        expires: -1,
      },
    ],
    origins: [],
    ...(planType ? { planType } : {}),
    ...(expires ? { expiresAt: expires } : {}),
    ...(email ? { email } : {}),
  };
}

function isOpenAiDomain(domain) {
  const host = domain.replace(/^\./, "").toLowerCase();
  return host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host === "openai.com" || host.endsWith(".openai.com");
}

/**
 * Reads a pasted export: a Playwright storage state, a bare array of cookie
 * objects, the CLI auth export, or a plain `Cookie` header.
 */
export function parseChatGptStorageState(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) {
    throw new ChatGptWebError("INVALID_REQUEST", "Paste the storage-state JSON exported from your browser.");
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // The cookie header is the other thing people actually paste, and the
    // connect dialog tells them to.
    return fromCookieHeader(trimmed);
  }
  /**
   * The CLI/Codex auth export is checked before anything else, because it is
   * the shape people paste most often and it shares no keys with a storage
   * state.
   *
   * The key's presence, not its value, identifies the format: an export with
   * an empty sessionToken is a broken export, and saying "no cookies array"
   * about it is nonsense.
   */
  if (isRecord(parsed) && "sessionToken" in parsed) {
    return fromAuthExport(parsed);
  }

  /**
   * A bare array of cookie objects is accepted as well as a full storage
   * state, because that is what a cookie-editor extension exports and it is
   * the format people actually have in hand.
   */
  const isBareCookieArray = Array.isArray(parsed);
  if (!isBareCookieArray && !isRecord(parsed)) {
    throw new ChatGptWebError("INVALID_REQUEST", "A storage state is a JSON object, or an array of cookie objects.");
  }
  const rawCookies = isBareCookieArray ? parsed : isRecord(parsed) ? parsed.cookies : undefined;
  if (!Array.isArray(rawCookies)) {
    throw new ChatGptWebError("INVALID_REQUEST", "That JSON has no `cookies` array, so it is not a storage state.");
  }
  const cookies = [];
  for (const entry of rawCookies) {
    if (!isRecord(entry)) continue;
    const name = typeof entry.name === "string" ? entry.name : "";
    const value = typeof entry.value === "string" ? entry.value : "";
    if (!name || !value) continue;
    const domain = typeof entry.domain === "string" ? entry.domain : undefined;
    // Only OpenAI's own cookies are carried across. Anything else in the
    // export is not this connection's to send.
    if (domain && !isOpenAiDomain(domain)) continue;
    cookies.push({
      name,
      value,
      ...(domain ? { domain } : {}),
      ...(typeof entry.path === "string" ? { path: entry.path } : {}),
      ...(typeof entry.expires === "number" ? { expires: entry.expires } : {}),
    });
  }
  if (cookies.length === 0) {
    throw new ChatGptWebError(
      "INVALID_REQUEST",
      "That storage state has no usable chatgpt.com cookies in it. Export it while signed in to chatgpt.com.",
    );
  }
  const origins = !isBareCookieArray && isRecord(parsed) && Array.isArray(parsed.origins) ? parsed.origins : [];
  return { cookies, origins };
}

/**
 * The `Cookie` header for the session cookies.
 *
 * Expired cookies are dropped: sending one makes the browser's own session
 * look stale, and a stale `__Secure-next-auth.session-token` fails in a way
 * that looks like a bad password rather than an old export.
 */
export function chatGptWebCookieHeader(cookies, now = Date.now()) {
  const live = (cookies || []).filter(
    (cookie) => !cookie.expires || cookie.expires === -1 || cookie.expires * 1000 > now,
  );
  return live.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

/** The credential: the session cookies, held as one opaque blob. */
export function chatGptWebCredential(state) {
  return JSON.stringify({
    cookies: state.cookies,
    ...(state.planType ? { planType: state.planType } : {}),
    ...(state.expiresAt ? { expiresAt: state.expiresAt } : {}),
  });
}

/**
 * Reads a stored credential back.
 *
 * The whole state, not just the cookies: the expiry and the plan are what
 * make a dead session and a plan-gated model distinguishable from a broken
 * connection.
 */
export function chatGptWebSessionFromCredential(credential) {
  const value = typeof credential === "string" ? credential : credential?.value;
  if (!value) {
    throw new ChatGptWebError("AUTHENTICATION_FAILED", "No ChatGPT Web session is stored. Export one and connect.");
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    /**
     * A raw cookie header is accepted too.
     *
     * The stored form is the normalized session, but a connection saved
     * before it was normalized can hold the paste itself, and the paste is
     * unambiguous — so it is read rather than refused, and the refusal that
     * comes back names what is actually wrong with it.
     */
    try {
      return parseChatGptStorageState(value);
    } catch (error) {
      throw new ChatGptWebError(
        "AUTHENTICATION_FAILED",
        error instanceof Error && error.message
          ? error.message
          : "The stored ChatGPT Web session is unreadable. Export one and connect again.",
      );
    }
  }
  if (Array.isArray(parsed)) return { cookies: parsed, origins: [] };
  if (!isRecord(parsed) || !Array.isArray(parsed.cookies)) {
    throw new ChatGptWebError("AUTHENTICATION_FAILED", "The stored ChatGPT Web session is unreadable. Export one and connect again.");
  }
  return {
    cookies: parsed.cookies,
    origins: [],
    ...(typeof parsed.planType === "string" ? { planType: parsed.planType } : {}),
    ...(typeof parsed.expiresAt === "string" ? { expiresAt: parsed.expiresAt } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * The catalog
 * ------------------------------------------------------------------ */

/** The model label the page's own picker shows, which is what a paid turn is driven with. */
const SOL = "GPT-5.6 Sol";
const FIVE_FIVE = "GPT-5.5";

/**
 * The wire model for a family: a plain request, and the Pro request.
 */
const baseModel = (family) => (family === SOL ? "gpt-5-6" : "gpt-5-5");

/**
 * A position on the page's effort ladder.
 *
 * The wire request collapses this ladder to a single boolean: `0` and `4`
 * differ in the model string, and `1`–`3` are one request with thinking on.
 * ChatGPT picks the effort itself once `reason` is set, so the intermediate
 * rungs are distinct *cards* — a client can choose to think — but not distinct
 * requests.
 */
const effortCard = (id, name, family, effort) => ({
  id,
  name,
  family,
  effort,
  // Every rung below Pro is the same request: the base model, with thinking
  // asked for.
  wireModel: baseModel(family),
  think: effort > 0,
});

const proCard = (id, name, family) => ({
  id,
  name,
  family,
  effort: 4,
  wireModel: `${baseModel(family)}-pro`,
  think: false,
});

/**
 * The model catalog, and the single source of truth for it.
 *
 * ChatGPT Web publishes no model list, and which models an account is offered
 * depends on the plan it is signed in with — a free account is not served the
 * same set as a paid one. So the catalog is keyed by plan, using the
 * `planType` the export itself carries.
 *
 * This is still a claim about ChatGPT, not a fact read from ChatGPT. The page
 * is the authority: it renders its own model picker, and a model missing from
 * this table can be typed in as a custom id. That is why the list is a floor
 * and not a gate.
 *
 * **The cards and the resolver are one table on purpose.** A card the resolver
 * refuses is a visible bug — the provider page offers it, a client sends it,
 * and the request comes back `unsupported model`. Deriving both from
 * `CHATGPT_WEB_MODELS` makes that unreachable.
 */
export const CHATGPT_WEB_MODELS = [
  /**
   * The free tier has **no model picker at all**. The page is sent the literal
   * model `auto`, with the page choosing — so the only axis a free account
   * exposes is whether to think.
   */
  { id: "gpt-5.6-luna-free", name: "GPT-5.6 Luna (Free)", family: null, effort: 0, wireModel: "auto", think: false },
  { id: "gpt-5.6-luna-free-thinking", name: "GPT-5.6 Luna (Free, Think)", family: null, effort: 0, wireModel: "auto", think: true },

  effortCard("gpt-5.6-sol-instant", "GPT-5.6 Sol (Instant)", SOL, 0),
  effortCard("gpt-5.6-sol-medium", "GPT-5.6 Sol (Medium)", SOL, 1),
  effortCard("gpt-5.6-sol-high", "GPT-5.6 Sol (High)", SOL, 2),
  effortCard("gpt-5.6-sol-xhigh", "GPT-5.6 Sol (XHigh)", SOL, 3),
  proCard("gpt-5.6-sol-pro", "GPT-5.6 Sol (Pro)", SOL),

  effortCard("gpt-5.5-instant", "GPT-5.5 (Instant)", FIVE_FIVE, 0),
  effortCard("gpt-5.5-medium", "GPT-5.5 (Medium)", FIVE_FIVE, 1),
  effortCard("gpt-5.5-high", "GPT-5.5 (High)", FIVE_FIVE, 2),
  effortCard("gpt-5.5-xhigh", "GPT-5.5 (XHigh)", FIVE_FIVE, 3),
  proCard("gpt-5.5-pro", "GPT-5.5 (Pro)", FIVE_FIVE),
  /**
   * Offered by the reference's own provider page and kept here so a client
   * that sends it is answered rather than refused.
   *
   * It is an **alias of Pro, not a distinct request**: ChatGPT exposes no
   * separate wire model for it, and inventing one would produce a model id
   * the page rejects. It resolves to the same request as `gpt-5.5-pro` and is
   * labelled so here rather than pretending otherwise.
   */
  proCard("gpt-5.5-pro-extended", "GPT-5.5 (Pro Extended)", FIVE_FIVE),
];

/**
 * The spelling normalisation the reference applies before it looks a model up.
 *
 * Every dot becomes a hyphen, which is why `gpt-5.6-luna-free` and
 * `gpt-5-6-luna-free` are the same model and why accepting only one of them
 * refuses the other for no reason. The catalog is dotted, so a client that
 * learned the hyphenated form from a log still resolves.
 */
export function normalizeChatGptWebModel(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^(chatgpt-web|cgpt-web|cgpt)\//, "")
    .replace(/\./g, "-");
}

/**
 * Ids that predate the effort ladder.
 *
 * They are still resolved, so a client that learned one from a log is not
 * broken by the catalog gaining rungs. They are deliberately *not* in the
 * catalog: `gpt-5-6` and `gpt-5.6-sol-instant` are the same request, and
 * listing both would show a duplicate in the picker.
 */
const LEGACY_SELECTIONS = [
  { id: "gpt-5-6", selection: { kind: "picker", modelLabel: SOL, effortIndex: 0, model: "gpt-5-6" } },
  // The reference's own registry ids, which carry no `sol`. They are a
  // different string from `gpt-5.6-sol-pro` after normalisation, so they need
  // their own entries or a client using the published names stops working the
  // moment the catalog gains a family segment.
  { id: "gpt-5-6-pro", selection: { kind: "picker", modelLabel: SOL, effortIndex: 4, model: "gpt-5-6-pro" } },
  { id: "gpt-5-6-instant", selection: { kind: "picker", modelLabel: SOL, effortIndex: 0, model: "gpt-5-6" } },
  { id: "gpt-5-6-thinking", selection: { kind: "picker", modelLabel: SOL, effortIndex: 1, model: "gpt-5-6" } },
  { id: "gpt-5-6-sol", selection: { kind: "picker", modelLabel: SOL, effortIndex: 1, model: "gpt-5-6" } },
  { id: "gpt-5-5", selection: { kind: "picker", modelLabel: FIVE_FIVE, effortIndex: 0, model: "gpt-5-5" } },
  { id: "gpt-5-5-pro", selection: { kind: "picker", modelLabel: FIVE_FIVE, effortIndex: 4, model: "gpt-5-5-pro" } },
  { id: "gpt-5-5-instant", selection: { kind: "picker", modelLabel: FIVE_FIVE, effortIndex: 0, model: "gpt-5-5" } },
  { id: "gpt-5-5-thinking", selection: { kind: "picker", modelLabel: FIVE_FIVE, effortIndex: 1, model: "gpt-5-5" } },
];

/**
 * The rung a `reasoning_effort` in a request body maps onto.
 *
 * The effort in the body only applies to an id that leaves the effort open —
 * `-thinking` and the bare family names. A card that names its rung, like
 * `gpt-5.6-sol-high`, is that rung.
 */
function effortFromRequest(value) {
  if (value === undefined || value === "medium") return 1;
  if (["none", "off", "minimal", "low"].includes(value)) return 0;
  if (value === "high") return 2;
  if (["xhigh", "max"].includes(value)) return 3;
  throw new ChatGptWebError("INVALID_REQUEST", `ChatGPT Web does not support reasoning effort ${value}.`);
}

/**
 * Resolves a client model id onto the selection the page understands.
 *
 * Returns nothing for an id outside the set, rather than guessing: a wrong
 * guess here silently selects a model the user did not ask for, and a
 * plausible-looking model string the page rejects reads as a broken provider.
 */
export function resolveChatGptWebSelection(model, effort) {
  const normalized = normalizeChatGptWebModel(model);

  const card = CHATGPT_WEB_MODELS.find((entry) => normalizeChatGptWebModel(entry.id) === normalized);
  if (card) {
    return card.family === null
      ? { kind: "free", thinkEnabled: card.think, model: "auto" }
      : { kind: "picker", modelLabel: card.family, effortIndex: card.effort, model: card.wireModel };
  }

  const legacy = LEGACY_SELECTIONS.find((entry) => entry.id === normalized);
  if (legacy) {
    // A legacy id that leaves the effort open takes it from the body, as it
    // always did.
    if (effort !== undefined && legacy.selection.kind === "picker") {
      return { ...legacy.selection, effortIndex: effortFromRequest(effort) };
    }
    return legacy.selection;
  }

  return undefined;
}

/**
 * The model string and thinking flag the page is actually given.
 *
 * The rule is not obvious: **Pro must not ask for thinking.** `reason` is a
 * system hint, and a hint of `reason` on a Pro request is one the page does
 * not honour — so deriving it as `effortIndex > 0` sends a flag the reference
 * deliberately withholds. It read as a harmless extra flag; it is a wrong
 * request.
 */
export function chatGptWebDirectModel(selection) {
  if (selection.kind === "free") return { model: "auto", reason: selection.thinkEnabled };
  if (selection.effortIndex === 4) return { model: selection.model, reason: false };
  return { model: selection.model, reason: selection.effortIndex > 0 };
}

/** Every id this provider serves, across plans. */
export function allChatGptWebModels() {
  return [
    ...new Set([...CHATGPT_WEB_MODELS.map((card) => card.id), ...LEGACY_SELECTIONS.map((entry) => entry.id)]),
  ];
}

/**
 * Every model this provider serves, for every plan.
 *
 * **The plan does not narrow this list**, and that is deliberate: a free
 * account is served the two Luna cards and a paid one the whole ladder, but
 * gating the catalog on a `planType` read out of an export is a second,
 * different rule from the one the page applies. A wrong gate is not
 * symmetric — showing a model the account cannot use costs one visible test
 * failure, which names itself, while hiding a model the account *can* use
 * hides something that works.
 */
export function chatGptWebModels(_planType) {
  return CHATGPT_WEB_MODELS.map((card) => ({ id: card.id, name: card.name }));
}

/**
 * Plans that are not the free tier.
 *
 * Anything unrecognised is treated as paid rather than restricted, for the
 * same asymmetry the catalog is.
 */
export function isFreeChatGptPlan(planType) {
  if (!planType) return false;
  const normalized = String(planType).trim().toLowerCase();
  return normalized === "free" || normalized === "free_plan" || normalized === "freeplus" || normalized.startsWith("free");
}

/* ------------------------------------------------------------------ *
 * The browser half
 * ------------------------------------------------------------------ */

/**
 * Chrome's ceiling for a single cookie is 4096 bytes, and a ChatGPT session
 * token is a compact JWE that runs to about 5 KB — so `addCookies` refuses
 * the whole batch with `Invalid cookie fields`, naming no field and giving no
 * hint that the *value* is at fault. Every other field is valid; only the
 * length is not.
 *
 * NextAuth already solves this for the browser: an oversized session cookie
 * is split into numbered chunks (`…session-token.0`, `…session-token.1`)
 * which the page rejoins. Writing them the same way is what makes an exported
 * session loadable into a browser at all.
 */
const CHUNK_SIZE = 3800;

/**
 * Splits one cookie into the numbered chunks a browser will accept.
 *
 * A cookie that already fits is passed through unchanged, so the chunked form
 * is only ever used where it is actually needed.
 */
export function chunkCookie(cookie) {
  if (cookie.value.length <= CHUNK_SIZE) return [cookie];
  const chunks = [];
  for (let index = 0, at = 0; at < cookie.value.length; index += 1, at += CHUNK_SIZE) {
    chunks.push({
      ...cookie,
      name: `${cookie.name}.${index}`,
      value: cookie.value.slice(at, at + CHUNK_SIZE),
      // The chunk carries no expiry of its own: the original's expiry applies
      // to the whole session, and a per-chunk one would expire the tail early.
      ...(cookie.expires === undefined ? {} : { expires: cookie.expires }),
    });
  }
  return chunks;
}

/** Turns a cookie into the shape Playwright's own `addCookies` expects. */
function toPlaywrightCookie(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    // `domain` must be set, and the leading dot is meaningful: it makes the
    // cookie sub-domain-wide, which is how chatgpt.com issued it.
    domain: cookie.domain ?? ".chatgpt.com",
    path: cookie.path ?? "/",
    httpOnly: cookie.httpOnly ?? true,
    secure: cookie.secure ?? true,
    sameSite: "Lax",
    /**
     * `expires` is a Unix timestamp in seconds, and **omitted** for a session
     * cookie. The CLI export carries no expiry for the session token, so the
     * parser records `-1` — which is Chrome's internal marker for "no expiry"
     * and *not* a value Playwright accepts. Passing it through fails the
     * whole `addCookies` call with `Invalid cookie fields`.
     */
    ...(cookie.expires === undefined || cookie.expires === -1 || cookie.expires <= 0 ? {} : { expires: cookie.expires }),
  };
}

/** A bot-protection challenge: the network, not the credential. */
function blockedError() {
  return new ChatGptWebError(
    "PROVIDER_UNAVAILABLE",
    "chatgpt.com served its bot-protection challenge instead of the application, so no turn was attempted. This is a network-level block on the address OmniHilbras is running from — it happens with a valid session, so it is not a problem with your export. A residential connection with no VPN or datacenter is the usual fix.",
  );
}

/** A sign-in wall: the credential, not the network. */
function signedOutError() {
  return new ChatGptWebError(
    "AUTHENTICATION_FAILED",
    "The ChatGPT page is showing a sign-in wall, which means the exported session is no longer valid. Export storage state again while signed in to chatgpt.com.",
  );
}

/**
 * Opens chatgpt.com with a session in it and hands back the signed-in page.
 *
 * Both the turn and the check need exactly this — the cookies set, the
 * profile reused, the navigation retried, and the two failure modes told
 * apart from each other — so it is one function rather than two copies that
 * drift.
 */
export async function openChatGptPage(cookies, profile) {
  const playwright = await loadPlaywright();
  if (!playwright) {
    throw new ChatGptWebError("PROVIDER_UNAVAILABLE", MISSING_BROWSER_MESSAGE);
  }
  // The container this often runs in has no shared memory and no sandbox
  // namespaces. Both are required by a default Chromium and neither is
  // fixable by the user here.
  const launchOptions = {
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
    /**
     * Without these the edge answers 403 before the page exists.
     *
     * Playwright's default for a headless browser is the real Chrome string
     * with `HeadlessChrome/151.0.7922.34` substituted for `Chrome/…`, and
     * that one substring is enough for chatgpt.com's edge to answer **403
     * with a bot-protection interstitial**. Measured on the same machine,
     * same session, same engine, one variable at a time:
     *
     *   default UA            -> 403, title "Just a moment...", empty body
     *   this UA               -> 200, composer present
     *   this UA, headed       -> 200, composer present
     */
    userAgent: CHROME_USER_AGENT,
    locale: BROWSER_LOCALE,
    timezoneId: BROWSER_TIMEZONE,
    viewport: { width: 1400, height: 950 },
  };

  await mkdir(profile, { recursive: true });
  let context;
  try {
    context = await playwright.chromium.launchPersistentContext(profile, launchOptions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isMissingBrowser(message)) {
      throw new ChatGptWebError("PROVIDER_UNAVAILABLE", MISSING_BROWSER_MESSAGE);
    }
    throw new ChatGptWebError("PROVIDER_UNAVAILABLE", `ChatGPT Web could not start a browser: ${message}`);
  }
  const close = async () => {
    await context.close().catch(() => undefined);
  };
  const newPage = async () => context.newPage();
  /** The set the Cloudflare cookies are the reason for. */
  const vaultCookies = () => cookies.flatMap((cookie) => chunkCookie(cookie)).map(toPlaywrightCookie);

  /**
   * The profile is the fast path; the vault is the fallback.
   *
   * Signing in writes the session into the profile, so on every turn after
   * that the browser is already signed in and there is nothing to inject.
   * Injecting anyway would overwrite a *fresher* session with a stored one —
   * including the Cloudflare clearance, which rotates — and replacing a
   * working session with a stale copy is how a working provider starts
   * failing for no visible reason.
   *
   * So the cookies are set only when the profile turns out not to be signed
   * in. The paste-a-cookie flow lands here too, with an empty profile, and is
   * unaffected.
   */
  const signedOut = async (candidate) => (await candidate.locator(CHATGPT_WEB.signedOutMarker).count()) > 0;

  let page;
  try {
    page = await newPage();
    /**
     * Navigation is retried, because a dropped connection reports itself as
     * `ERR_NETWORK_CHANGED` — indistinguishable, to the caller, from
     * chatgpt.com being unreachable. One retry is the difference between a
     * transient blip and a failed turn.
     */
    let navigated = false;
    for (let attempt = 1; attempt <= 2 && !navigated; attempt += 1) {
      try {
        await page.goto(CHATGPT_WEB.startUrl, {
          waitUntil: "domcontentloaded",
          timeout: CHATGPT_WEB.navigationTimeoutMs,
        });
        navigated = true;
      } catch (error) {
        if (attempt === 2) throw error;
        await page.waitForTimeout(2_000).catch(() => undefined);
      }
    }
    await page.waitForTimeout(6_000);

    /**
     * A challenge is identified by its title, because its body is empty.
     * Told apart from a sign-in wall because the two have completely
     * different fixes: one is the network, the other the credential.
     */
    const title = await page.title().catch(() => "");
    if (/just a moment/i.test(title)) throw blockedError();
    if (await signedOut(page)) {
      // The profile was not signed in, so fall back to the stored session.
      // Chunked before they are set, because an oversized cookie fails the
      // whole batch.
      await context.addCookies(vaultCookies());
      await page.goto(CHATGPT_WEB.startUrl, {
        waitUntil: "domcontentloaded",
        timeout: CHATGPT_WEB.navigationTimeoutMs,
      });
      await page.waitForTimeout(6_000);
      if (await signedOut(page)) throw signedOutError();
    }
    return { page, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * Confirms the session is actually signed in, by opening the page.
 *
 * This is the whole point of the connect dialog's "Check cookie" button, and
 * it is why the button costs a page load. Expiry, cookie presence and browser
 * availability are all local checks; none of them can tell a working session
 * from one revoked elsewhere, and reporting "valid" for both is how
 * "connected but every request fails" begins.
 *
 * **The signal is the plan badge, and nothing else.** Measured against a real
 * session and a deliberately invalid one, every DOM marker is identical: both
 * render two textareas, no profile button, no sign-in link, the same form,
 * the same URL. The only thing that differs is the page text, which carries
 * the plan on a signed-in account and not on a signed-out one — so that is
 * what is read, and a page without it is reported as unconfirmed rather than
 * guessed at.
 */
export async function verifyChatGptSession(cookies, profile) {
  const { page, close } = await openChatGptPage(cookies, profile);
  try {
    // Polled, because the badge arrives with the account data and is not in
    // the first paint. A single read races it, and a race that usually wins
    // is still a race.
    const readPlan = () =>
      page
        .evaluate(() => {
          const body = document.body?.innerText ?? "";
          // "Free" is checked first because it is the plan most accounts are
          // on, and the paid names are ordinary English words that can appear
          // in page copy.
          if (/\bFree\b/.test(body)) return "Free";
          return /\b(Plus|Pro|Team|Business|Enterprise|Go)\b/.exec(body)?.[1] ?? null;
        })
        .catch(() => null);

    let plan = await readPlan();
    for (let waited = 0; plan === null && waited < 15_000; waited += 1_500) {
      await page.waitForTimeout(1_500).catch(() => undefined);
      plan = await readPlan();
    }

    if (plan === null) {
      throw new ChatGptWebError(
        "AUTHENTICATION_FAILED",
        "chatgpt.com loaded but showed no account, so this session could not be confirmed. It may have been revoked or signed out. Sign in to chatgpt.com, export the Cookie header again, and check it once more.",
      );
    }
    return { ok: true, plan };
  } finally {
    await close();
  }
}

/* ------------------------------------------------------------------ *
 * The dashboard's two questions
 * ------------------------------------------------------------------ */

/**
 * The profile a session gets before it has a connection of its own.
 *
 * Keyed by the session token, so a second check of the same export reuses
 * the same browser profile — which is what lets the page remember that the
 * first-use modal was dismissed. The token itself never leaves this module:
 * `profileDir` hashes it.
 */
function sessionProfileKey(state) {
  const session = state.cookies.find((cookie) => cookie.name === CHATGPT_WEB_SESSION_COOKIE);
  return session?.value || "default";
}

/**
 * Whether the credential means anything to chatgpt.com.
 *
 * A check, and not a connect: it answers "will this work" and stores nothing.
 * A check that half-connects is worse than no check — the user would believe
 * the credential is good and find out on their first request.
 */
export async function checkWebSession(credential) {
  let state;
  try {
    state = parseChatGptStorageState(credential);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "That export could not be read.";
    return { ok: false, detail, error: detail };
  }

  /**
   * The export says when it expires, so a dead session is reported as one
   * without spending a browser launch to discover it.
   */
  if (state.expiresAt && Number.isFinite(Date.parse(state.expiresAt)) && Date.parse(state.expiresAt) <= Date.now()) {
    const detail = "This ChatGPT session has expired. Export a new one.";
    return { ok: false, detail, error: detail };
  }
  const header = chatGptWebCookieHeader(state.cookies);
  if (!header) {
    const detail = "Every cookie in that export has expired. Export a new one.";
    return { ok: false, detail, error: detail };
  }

  try {
    const verified = await verifyChatGptSession(state.cookies, profileDir("chatgpt-web", sessionProfileKey(state)));
    return {
      ok: true,
      detail: verified.plan
        ? `chatgpt.com accepted the session (plan: ${verified.plan}).`
        : "chatgpt.com accepted the session.",
      models: chatGptWebModels(state.planType).map((model) => model.id),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "The ChatGPT session could not be checked.";
    return { ok: false, detail, error: detail };
  }
}

/**
 * The normalized credential to store.
 *
 * The whole state, not just the cookies: the expiry and the plan are what
 * make a dead session and a plan-gated model distinguishable from a broken
 * connection.
 */
export async function connectWebSession(credential) {
  let state;
  try {
    state = parseChatGptStorageState(credential);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "That export could not be read.";
    return { ok: false, detail, error: detail };
  }
  return {
    ok: true,
    credential: chatGptWebCredential(state),
    models: chatGptWebModels(state.planType).map((model) => model.id),
    name: "ChatGPT Web",
    ...(state.email ? { email: state.email } : {}),
  };
}
