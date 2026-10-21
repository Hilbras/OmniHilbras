/**
 * Duck.ai (duck.ai) — the credential logic and the upstream protocol.
 *
 * ## What this module is
 *
 * Everything about speaking to duck.ai that is not the OpenAI response shape: the credential parser, the
 * anti-bot challenge solver, the request body, the answer parser, the upstream calls themselves, and the two
 * dashboard entry points (`checkWebSession` / `connectWebSession`). The executor
 * (`open-sse/executors/duckduckgo-web.js`) owns the OpenAI-format answer and the gateway contract; everything
 * below is the protocol both halves speak, and it lives in one place because the challenge solver is needed by
 * both — a turn cannot be proven without it, and a check that cannot solve one cannot say a turn would work.
 *
 * ## The three traps, all measured rather than read
 *
 * 1. **The answer arrives in `message`, not `content`.** A reader that checks only `content` returns HTTP 200
 *    with an **empty answer**. The service sends `{"action":"success","message":"…"}` and then a run of
 *    `{"message":"…"}` frames; `content` never appears.
 * 2. **Free models are `accessTier` on the model itself.** The live catalog marks 6 models free there, and only
 *    3 by `reasoningEffortAccess[].accessTier` — a parser keyed on the wrong field silently drops half the
 *    free lineup.
 * 3. **The stream opens with `data: [CHAT_TITLE:…]`**, a non-JSON pseudo-event. It is dropped rather than
 *    thrown on: a parser that threw at the first byte would fail every turn.
 *
 * ## The cookie is optional, and the difference is load-bearing
 *
 * The service is anonymous. An empty paste is this provider's **normal case** and must be accepted everywhere a
 * cookie is; a paste that carries text but reads as no cookie is a **mistake** and is reported. Collapsing the
 * two is how "no cookie is needed" becomes indistinguishable from "the cookie you gave me is bad" — which is
 * the distinction the whole provider turns on. A pasted cookie is also never *claimed* to be verified, because
 * this service does not read one.
 *
 * ## The challenge cannot be skipped
 *
 * `GET /duckchat/v1/status` answers with a base64 blob that is JavaScript which, when run, returns
 * `client_hashes`. Sending the blob back **unsolved** is not a no-op: the live service answers `418
 * ERR_CHALLENGE`, and the wasted call still counts against the address's anonymous-chat quota. So there are
 * exactly two options — solve it or do not attempt a turn at all.
 */

import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { PROVIDERS } from "../../config/providers.js";
import registryEntry from "../../providers/registry/duckduckgo-web.js";
import {
  browserFingerprintHeaders,
  cookieHeaderFrom,
  parseCookieHeader,
  readBodyRefusal,
  CHROME_USER_AGENT,
} from "./common.js";

/**
 * The transport, read from the registry entry.
 *
 * The registry index is generated, so the entry itself is the source of truth and the built map is only a
 * convenience — reading the entry keeps this module working before the index is regenerated.
 */
const DDG_TRANSPORT = PROVIDERS["duckduckgo-web"] || registryEntry.transport;

/**
 * Duck.ai's endpoints and knobs.
 *
 * The URLs come from the registry entry; the rest is the measured behaviour of the service — the timeouts the
 * source recorded for each endpoint and the effort level the service insists on.
 */
export const DUCKDUCKGO_WEB = {
  baseUrl: DDG_TRANSPORT.baseUrl,
  homeUrl: DDG_TRANSPORT.homeUrl,
  statusUrl: DDG_TRANSPORT.statusUrl,
  modelsUrl: DDG_TRANSPORT.modelsUrl,
  origin: new URL(DDG_TRANSPORT.baseUrl).origin,
  /**
   * The model a request gets when it names none.
   *
   * `gpt-5.4-mini` because it is free **today** — verified against the live catalog — and because it is the one
   * free id that has been free on every reading.
   */
  defaultModel: "gpt-5.4-mini",
  /** The service's own default effort, and the value the successful requests used. */
  defaultReasoningEffort: "none",
  homeTimeoutMs: 15_000,
  statusTimeoutMs: 15_000,
  modelsTimeoutMs: 15_000,
  chatTimeoutMs: 60_000,
  challengeTimeoutMs: 5_000,
};

/**
 * The browser-fidelity shims DuckDuckGo's `x-vqd-hash-1` challenge is *executed against*.
 *
 * ## Why this is a string and not code
 *
 * The challenge is base64 JavaScript that DuckDuckGo serves, and it probes for a real browser before it will
 * compute anything: `navigator.webdriver`, a live `document.body.children` collection, an `HTMLDivElement` that
 * really is an `Element`, `Object.isSealed(Math)`, a `NodeList` that is not an array, `window` stringifying as
 * `[object Window]`. Run it in a bare `vm` context and it throws, or worse, returns hashes the service rejects.
 * These shims are the difference between the two.
 *
 * It is a **`String.raw` template compiled by `vm.runInContext`**, which has one hard consequence worth stating
 * loudly: **anything in here that is not valid script-mode JavaScript breaks every request.** A stray `export`,
 * `import` or backtick is a `SyntaxError` at run time rather than a compile error, so the type checker will not
 * see it — the unit test asserts the shape instead, and the solver refuses a template that has drifted.
 *
 * ## Two substitutions
 *
 * `__DDG_REAL_UA__` and `__DDG_HTML_LOOKUP__` are replaced per request, because both are per-request values the
 * challenge reads through the stubs it is handed.
 *
 * ## Provenance
 *
 * Taken from the working implementation in the previous project, which measured it against the live service:
 * five live challenges were solved with it unmodified in 3-4 ms each, so there is nothing here to improve by
 * editing and no way to tell a "harmless" edit from a fatal one until a request is spent.
 *
 * **Do not add `export` or `import` inside the template literal.** See above; it fails at run time only.
 */
const CHALLENGE_STUBS = String.raw`
var __ua = __DDG_REAL_UA__;
var __HTML_LOOKUP = __DDG_HTML_LOOKUP__;
// Browser-fidelity shims for the DDG "am I a real browser" probes.
// In a browser every built-in stringifies as native code; under a plain vm
// context the user-land re-declarations below would otherwise leak their source.
function __nativeFn(fn, name){
  Object.defineProperty(fn, 'name', { value: name, configurable: true });
  fn.toString = function(){ return 'function ' + name + '() { [native code] }'; };
  return fn;
}
__nativeFn(parseInt, 'parseInt');
__nativeFn(parseFloat, 'parseFloat');
__nativeFn(isNaN, 'isNaN');
__nativeFn(encodeURIComponent, 'encodeURIComponent');
__nativeFn(decodeURIComponent, 'decodeURIComponent');
// NOTE: do NOT seal Math. Real Chromium reports Object.isSealed(Math) === false,
// and at least one challenge variant probes exactly that; sealing it here made
// the vector differ from the browser by one and failed the challenge.
function __makeHtmlElement(tag) {
  var state = { _innerHTML: '', _qsaCount: 0, _cssText: '' };
  // Instantiate against the real per-tag constructor so
  // document.createElement('div') instanceof HTMLDivElement holds.
  var el = Object.create(__ctorForTag(tag).prototype);
  Object.assign(el, {
    tagName: String(tag).toUpperCase(), nodeName: String(tag).toUpperCase(), nodeType: 1,
    children: [], childNodes: [], classList: [], dataset: {},
    offsetWidth: 1, offsetHeight: 1, clientWidth: 1, clientHeight: 1, scrollHeight: 1, scrollWidth: 1,
    getBoundingClientRect: function(){ return { x: 0, y: 0, top: 0, left: 0, right: 1, bottom: 1, width: 1, height: 1, toJSON: function(){ return {}; } }; },
    setAttribute: function(){}, removeAttribute: function(){},
    getAttribute: function(a){ if(a==='srcdoc') return state._srcdoc||''; return null; },
    hasAttribute: function(){ return false; }, appendChild: function(c){ return c; }, removeChild: function(c){ return c; },
    addEventListener: function(){}, removeEventListener: function(){}, querySelector: function(){ return null; },
    querySelectorAll: function(s){ if (s === '*') { return __makeNodeList(state._qsaCount); } return __makeNodeList(0); },
    cloneNode: function(){ return __makeHtmlElement(tag); }
  });
  Object.defineProperty(el, 'style', { value: new Proxy({}, { set: function(t, k, v){ t[k] = v; if (k === 'cssText') state._cssText = String(v); return true; }, get: function(t, k){ if (k === 'cssText') return state._cssText; return t[k] || ''; } }), enumerable: true, configurable: true });
  Object.defineProperty(el, 'innerHTML', { get: function(){ return state._innerHTML; }, set: function(v){ var key = String(v); var entry = __HTML_LOOKUP && __HTML_LOOKUP[key]; if (entry) { state._innerHTML = String(entry.html); state._qsaCount = entry.count|0; } else { state._innerHTML = key; state._qsaCount = 0; } }, enumerable: true, configurable: true });
  Object.defineProperty(el, 'outerHTML', { get: function(){ return '<' + tag + '>' + state._innerHTML + '</' + tag + '>'; }, enumerable: true });
  Object.defineProperty(el, 'srcdoc', { get: function(){ return state._srcdoc||''; }, set: function(v){ state._srcdoc = String(v); }, enumerable: true });
  Object.defineProperty(el, 'contentWindow', { get: function(){ var w = {}; w.document = __ifDoc; w.Proxy = Proxy; w.self = w; w.top = w; w.parent = w; w.window = w; return w; }, enumerable: true });
  Object.defineProperty(el, 'contentDocument', { get: function(){ return __ifDoc; }, enumerable: true });
  return el;
}
function __mkObj(name, base) {
  base = base || {};
  return new Proxy(base, {
    get: function(t, k) {
      if (k in t) return t[k];
      if (k === Symbol.toPrimitive) return function(){ return ''; };
      if (k === Symbol.iterator) return undefined;
      if (k === 'then' || k === 'catch' || k === 'finally') return undefined;
      if (k === 'constructor') return Object;
      if (k === 'toString' || k === 'valueOf') return function(){ return '[object ' + name + ']'; };
      if (k === 'length') return 0;
      if (k === 'nodeType') return 1;
      if (k === 'tagName' || k === 'nodeName') return 'DIV';
      if (k === 'innerHTML' || k === 'outerHTML' || k === 'textContent' || k === 'innerText' || k === 'value') return '';
      if (k === 'children' || k === 'childNodes' || k === 'classList') return [];
      // Real numeric layout values for the DDG challenge DOM probes.
      if (k === 'offsetWidth' || k === 'offsetHeight' || k === 'clientWidth' || k === 'clientHeight' || k === 'scrollHeight' || k === 'scrollWidth') return 1;
      if (k === 'getBoundingClientRect') return function(){ return { x: 0, y: 0, top: 0, left: 0, right: 1, bottom: 1, width: 1, height: 1, toJSON: function(){ return {}; } }; };
      if (typeof k === 'string' && (k.indexOf('get') === 0 || k.indexOf('query') === 0 || k.indexOf('find') === 0)) return function(){ return k === 'querySelectorAll' || k === 'getElementsByTagName' || k === 'getElementsByClassName' ? [] : null; };
      return function(){ return __mkObj(name + '.' + String(k)); };
    },
    has: function(t, k){ return k in t; }, set: function(t, k, v){ t[k] = v; return true; }
  });
}
function __parseCssDisplay(cssText){ if(!cssText) return ''; var m = String(cssText).match(/(?:^|;)\s*display\s*:\s*([^;]+)/i); return m ? String(m[1]).trim() : ''; }
function __getComputedStyle(el){ var cssText = el && el.style && el.style.cssText || ''; var display = __parseCssDisplay(cssText); return { getPropertyValue: function(name){ if(String(name).toLowerCase()==='display') return display; return ''; }, cssText: cssText, display: display }; }
var __ifMeta = __mkObj('meta', { getAttribute: function(a){ return a==='content' ? "default-src 'none'; script-src 'unsafe-inline';" : null; }, hasAttribute: function(a){ return a==='content'; }, tagName: 'META', nodeName: 'META' });
var __ifDoc = __mkObj('iframeDoc', { querySelector: function(s){ if (s && s.indexOf('Content-Security-Policy') !== -1) return __ifMeta; if (s === 'meta') return __ifMeta; return null; }, querySelectorAll: function(s){ if (s && s.indexOf('Content-Security-Policy') !== -1) return [__ifMeta]; if (s === 'meta') return [__ifMeta]; return []; }, getElementsByTagName: function(t){ return t && t.toLowerCase()==='meta' ? [__ifMeta] : []; }, body: __mkObj('iframeBody'), head: __mkObj('iframeHead'), documentElement: __mkObj('iframeRoot'), createElement: function(){ return __mkObj('elem', {setAttribute:function(){}, appendChild:function(){}, removeChild:function(){}, getAttribute:function(){return null;}, hasAttribute:function(){return false;}}); }, cookie: '', readyState: 'complete' });
var __iframeEl = __mkObj('iframe', { contentDocument: __ifDoc, contentWindow: __mkObj('iframeWin', { document: __ifDoc, top: undefined, parent: undefined }), document: __ifDoc, getAttribute: function(a){ if (a==='sandbox') return 'allow-scripts allow-same-origin'; if (a==='srcdoc') return ''; if (a==='id') return 'jsa'; return null; }, hasAttribute: function(a){ return a==='sandbox'||a==='id'; }, tagName: 'IFRAME', nodeName: 'IFRAME', id: 'jsa' });
// document.body keeps a LIVE children collection: challenges append a node and
// assert body.children.length grew by exactly 1, then remove it again.
var __bodyKids = [];
Object.defineProperty(__bodyKids, 'constructor', { value: HTMLCollection, enumerable: false, configurable: true });
var __body = __mkObj('body', {
  appendChild: function(c){ __bodyKids.push(c); return c; },
  removeChild: function(c){ var i = __bodyKids.indexOf(c); if (i !== -1) __bodyKids.splice(i, 1); return c; },
  contains: function(c){ return __bodyKids.indexOf(c) !== -1; },
  querySelector: function(s){ return s === '#jsa' ? __iframeEl : null; },
  querySelectorAll: function(s){ return s === '#jsa' ? [__iframeEl] : __makeNodeList(0); },
  children: __bodyKids, childNodes: __bodyKids,
  tagName: 'BODY', nodeName: 'BODY', nodeType: 1
});
var document = __mkObj('document', { querySelector: function(s){ if (s === '#jsa') return __iframeEl; if (s && s.indexOf('Content-Security-Policy') !== -1) return __ifMeta; return null; }, querySelectorAll: function(s){ if (s === '#jsa') return [__iframeEl]; if (s && s.indexOf('Content-Security-Policy') !== -1) return [__ifMeta]; return __makeNodeList(__bodyKids.length + 3); }, getElementById: function(id){ return id==='jsa' ? __iframeEl : null; }, getElementsByTagName: function(t){ if(t&&t.toLowerCase()==='iframe') return [__iframeEl]; return []; }, getElementsByClassName: function(){ return []; }, body: __body, head: __mkObj('head'), documentElement: __mkObj('root'), createElement: function(tag){ return __makeHtmlElement(tag||'div'); }, createTextNode: function(t){ return {nodeType:3, nodeValue:String(t||''), textContent:String(t||'')}; }, cookie: '', readyState: 'complete', title: '', addEventListener: function(){}, removeEventListener: function(){} });
  var window = __mkObj('window', { document: document, __DDG_BE_VERSION__: 1, __DDG_FE_CHAT_HASH__: 1, navigator: __mkObj('navigator', { userAgent: __ua, webdriver: false, language: 'en-US', languages: ['en-US','en'], platform: 'Linux x86_64', vendor: 'Google Inc.', appVersion: '5.0 (X11)', cookieEnabled: true, onLine: true, hardwareConcurrency: 8, deviceMemory: 8 }), innerWidth: 1280, innerHeight: 800, outerWidth: 1280, outerHeight: 800, devicePixelRatio: 1, screen: __mkObj('screen', { width:1920, height:1080, availWidth:1920, availHeight:1080, colorDepth:24, pixelDepth:24 }), location: __mkObj('location', { href:'https://duck.ai/', origin:'https://duck.ai', host:'duck.ai', hostname:'duck.ai', protocol:'https:', pathname:'/' }), performance: __mkObj('perf', { now: function(){ return 0; }, timeOrigin: 0 }), history: __mkObj('history', { length: 1, state: null }), addEventListener: function(){}, removeEventListener: function(){}, dispatchEvent: function(){return true;}, setTimeout: function(fn){ try{fn();}catch(e){} return 0; }, clearTimeout: function(){}, hasOwnProperty: function(k){ if (k==='__DDG_BE_VERSION__'||k==='__DDG_FE_CHAT_HASH__') return true; return Object.prototype.hasOwnProperty.call(this,k); } });
window.top = window; window.self = window; window.window = window; window.parent = window; window.globalThis = window;
// Object.prototype.toString.call(window) must be "[object Window]".
try { window[Symbol.toStringTag] = 'Window'; } catch (e) {}
// In a browser a sloppy-mode function called with no receiver gets the global
// object, and challenges assert (function(){return this;})() === window.
// In a vm context that is the context's own global, so alias it to window.
try {
  var __g = (function(){ return this; })();
  if (__g && __g !== window) {
    Object.defineProperty(__g, Symbol.toStringTag, { value: 'Window', configurable: true });
    // Copy by VALUE, not via accessors. Two reasons:
    //  1) the var top/self/navigator/... declarations further down are hoisted,
    //     so those names already exist on the vm global and an "in" guard would
    //     skip them, leaving window.navigator undefined;
    //  2) accessors closing over the window binding would recurse once it is
    //     rebound to __g below.
    // The stub window is static, so a value copy is equivalent.
    var __winStub = window;
    for (var __k in __winStub) {
      try { __g[__k] = __winStub[__k]; } catch (e) {}
    }
    // hasOwnProperty is probed for the __DDG_* markers; keep the stub's version.
    try { __g.hasOwnProperty = function(k){ return __winStub.hasOwnProperty(k); }; } catch (e) {}
    window = __g;
    window.top = window; window.self = window; window.window = window; window.parent = window; window.globalThis = window;
  }
} catch (e) {}
var top = window, self = window, parent = window, navigator = window.navigator, location = window.location, screen = window.screen, performance = window.performance, history = window.history;
var __R = null, __E = null;
// Real DOM constructor chain. Some DDG challenge variants assert
// HTMLDivElement.prototype instanceof HTMLElement and
// HTMLElement.prototype instanceof Element, so these cannot be flat
// unrelated stubs — the prototype links have to be real.
function __DomClass(name, parent){
  var c = function(){};
  if (parent) c.prototype = Object.create(parent.prototype);
  c.prototype.constructor = c;
  Object.defineProperty(c, 'name', { value: name, configurable: true });
  c.toString = function(){ return 'function ' + name + '() { [native code] }'; };
  return c;
}
var EventTarget = __DomClass('EventTarget', null);
var Node = __DomClass('Node', EventTarget);
var Element = __DomClass('Element', Node);
var HTMLElement = __DomClass('HTMLElement', Element);
var HTMLDivElement = __DomClass('HTMLDivElement', HTMLElement);
var HTMLIFrameElement = __DomClass('HTMLIFrameElement', HTMLElement);
var HTMLLIElement = __DomClass('HTMLLIElement', HTMLElement);
var HTMLUnknownElement = __DomClass('HTMLUnknownElement', HTMLElement);
var Document = __DomClass('Document', Node);
var HTMLDocument = __DomClass('HTMLDocument', Document);
var NodeList = __DomClass('NodeList', null);
var HTMLCollection = __DomClass('HTMLCollection', null);
// Map a tag name to the constructor a browser would use, so
// document.createElement('div') instanceof HTMLDivElement holds.
function __ctorForTag(tag){
  var t = String(tag||'div').toLowerCase();
  if (t === 'div') return HTMLDivElement;
  if (t === 'iframe') return HTMLIFrameElement;
  if (t === 'li') return HTMLLIElement;
  return HTMLElement;
}
// A NodeList-like: array-shaped but NOT a real Array, with .constructor.name
// === 'NodeList' — challenges check both !Array.isArray(x) and the ctor name.
function __makeNodeList(length){
  var nl = Object.create(NodeList.prototype);
  var n = length|0;
  for (var i = 0; i < n; i++) nl[i] = __makeHtmlElement('div');
  Object.defineProperty(nl, 'length', { value: n, enumerable: false, configurable: true });
  nl.item = function(i){ return this[i] || null; };
  nl.forEach = function(fn, thisArg){ for (var i = 0; i < n; i++) fn.call(thisArg, this[i], i, this); };
  nl[Symbol.iterator] = function(){ var i = 0, self = this; return { next: function(){ return i < n ? { value: self[i++], done: false } : { value: undefined, done: true }; } }; };
  return nl;
}
function __HTMLClass(name){ var c = function(){}; c.prototype = __mkObj(name+'.proto'); return c; }
// NOTE: HTMLElement / HTMLDivElement / HTMLIFrameElement / Element / Node /
// Document / HTMLDocument / NodeList are defined above via __DomClass with a
// REAL prototype chain — do not redeclare them here or the instanceof probes break.
var Window = __HTMLClass('Window'), Event = __HTMLClass('Event'), MouseEvent = __HTMLClass('MouseEvent'), KeyboardEvent = __HTMLClass('KeyboardEvent'), TouchEvent = __HTMLClass('TouchEvent'), XMLHttpRequest = __HTMLClass('XMLHttpRequest'), WebSocket = __HTMLClass('WebSocket'), Image = __HTMLClass('Image'), FormData = __HTMLClass('FormData'), Blob = __HTMLClass('Blob'), File = __HTMLClass('File'), FileReader = __HTMLClass('FileReader'), URL = __HTMLClass('URL'), URLSearchParams = __HTMLClass('URLSearchParams'), Headers = __HTMLClass('Headers'), Request = __HTMLClass('Request'), Response = __HTMLClass('Response');
var fetch = function(){ return Promise.resolve(__mkObj('resp', {ok:true, status:200, json:function(){return Promise.resolve({});}, text:function(){return Promise.resolve('');}})); };
var getComputedStyle = __getComputedStyle;
`;

/** The four conditions the source recorded for the challenge-response shape; asserted so drift is visible. */
export const CHALLENGE_MARKERS = ["client_hashes", "server_hashes", "meta"];

/**
 * `data-version-tag` and `data-version-sha` on the homepage's `<html>`, joined by a hyphen.
 *
 * **The assembled value is the fix, not the regex.** The source looked for `serp_...-<20-40 hex>` as one
 * contiguous string in the homepage HTML and never found it — the tag and the sha are two *attributes* — so it
 * silently fell back to a hardcoded version from an earlier release on every single request. Measured on the
 * live homepage:
 *
 * ```
 * <html ... data-version-tag="serp_20261016_162040_ET" data-version-sha="69b477...">
 * ```
 *
 * A page missing either attribute **refuses the turn**, because a stale version is worse than none — it looks
 * like a measurement.
 */
export function duckDuckGoFeVersion(homeHtml) {
  const tag = /data-version-tag="([^"]+)"/.exec(homeHtml)?.[1];
  const sha = /data-version-sha="([^"]+)"/.exec(homeHtml)?.[1];
  if (!tag || !sha) return undefined;
  return `${tag}-${sha}`;
}

/** `sha256` in base64, which is the encoding the challenge's own hashes use. */
export function sha256Base64(value) {
  return createHash("sha256").update(value, "utf8").digest("base64");
}

/**
 * The telemetry the real client sends as `x-fe-signals`.
 *
 * A base64 JSON timeline of made-up interaction timings. The source sent one on every request that succeeded
 * and never sent a request without one, so it is carried — recorded as *"the set that returned 200"* rather
 * than as a proven minimum, because proving it would cost a chat POST against a rate-limited endpoint.
 */
export function duckDuckGoFeSignals(now = Date.now()) {
  const start = now - 3000;
  let elapsed = 80 + Math.floor(Math.random() * 101);
  const events = [];
  for (const type of ["mousemove", "scroll", "keydown", "mousemove", "scroll"]) {
    events.push({ type, ts: start + elapsed });
    elapsed += 40 + Math.floor(Math.random() * 221);
  }
  const signals = {
    start,
    duration: elapsed,
    events,
    meta: { origin: DUCKDUCKGO_WEB.origin, stack: ["entry.duckai.js"], duration: String(elapsed) },
  };
  return Buffer.from(JSON.stringify(signals), "utf8").toString("base64");
}

/** A 32-hex journey id, which is what the real client sends as `x-ddg-journey-id`. */
export function duckDuckGoJourneyId() {
  return createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, 32);
}

/**
 * Run the served challenge against the shims and return the header value.
 *
 * The two substitutions are the per-request inputs the challenge reads: the user agent it is asked about, and
 * the HTML literals it harvests. `__DDG_HTML_LOOKUP__` is `{}` in practice — four measured variants contained no
 * HTML literal the source's harvest regex matched — which is why the port dropped the source's `parse5`
 * dependency rather than keeping a parser for a corpus that is empty.
 */
export async function solveDuckDuckGoChallenge(challenge, userAgent, options = {}) {
  let source;
  /**
   * The base64 is checked for **shape** before it is decoded, because `Buffer.from(x, "base64")` is lenient: it
   * drops characters it does not recognise rather than failing, so a malformed challenge sailed into the `vm`
   * and came back as `SyntaxError: Invalid or unexpected token` — an unnamed failure on a path where discovering
   * it costs anonymous-chat quota. Measured before this check existed. Refusing by name is the point: the caller
   * can then say what happened instead of "the challenge failed".
   */
  const trimmed = String(challenge || "").trim();
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(trimmed) || trimmed.length % 4 !== 0) {
    throw new Error("the challenge was not base64");
  }
  try {
    source = Buffer.from(trimmed, "base64").toString("utf8");
  } catch {
    throw new Error("the challenge was not decodable");
  }
  if (!source.trim()) throw new Error("the challenge decoded to nothing");

  const timeoutMs = options.timeoutMs ?? DUCKDUCKGO_WEB.challengeTimeoutMs;
  const stubs = CHALLENGE_STUBS.replace("__DDG_REAL_UA__", JSON.stringify(userAgent)).replace("__DDG_HTML_LOOKUP__", "{}");

  const context = createContext({});
  // The shims first: they define the environment the challenge probes for.
  runInContext(stubs, context, { timeout: timeoutMs });

  const startedAt = Date.now();
  const result = await runInContext(source, context, { timeout: timeoutMs });
  const elapsedMs = Date.now() - startedAt;

  const clientHashes = Array.isArray(result?.client_hashes) ? result.client_hashes : [];
  if (clientHashes.length === 0) throw new Error("the challenge returned no client hashes");
  for (const marker of CHALLENGE_MARKERS) {
    if (!(marker in (result ?? {}))) throw new Error(`the challenge response has no ${marker}`);
  }

  const origin = options.origin ?? DUCKDUCKGO_WEB.origin;
  const bundlePath = options.bundlePath ?? "/dist/duckai-dist/entry.duckai.js";
  const meta = (result.meta ?? {});

  const solved = {
    ...result,
    client_hashes: clientHashes.map((hash) => sha256Base64(String(hash))),
    meta: {
      ...meta,
      // The three fields the source recorded as *required*: without them the service answers 418 "even when
      // every client_hash is correct". Their values are not compared against anything — the probes are presence
      // checks — so they describe this gateway rather than impersonating a browser exactly.
      origin,
      stack: [`${origin}${bundlePath}`],
      duration: String(elapsedMs),
    },
  };

  return { header: Buffer.from(JSON.stringify(solved), "utf8").toString("base64"), elapsedMs };
}

/* ------------------------------------------------------------------ *
 * The cookie, which may legitimately be absent
 * ------------------------------------------------------------------ */

/**
 * The cookies a first visit sets, seeded so a fresh jar is not an empty one.
 *
 * Written as pairs rather than as an object so the order the page sends them in is kept — the order is the
 * page's, and a jar that reorders it is a jar that is not the page's.
 */
const SEEDED_COOKIES = [
  ["5", "1"],
  ["ah", "wt-wt"],
  ["dcs", "1"],
  ["dcm", "3"],
  ["isRecentChatOn", "1"],
];

/**
 * A cookie jar that keeps only what the service sets, so redirects and cookie-rotation survive a turn.
 *
 * The seeded cookies are what the real page carries before it signs anything. Sending them is deliberate rather
 * than incidental: they are the difference between a fresh jar and no jar at all for a request that arrives at a
 * service which sets them itself.
 */
export function createDuckDuckGoCookieJar(seed) {
  const jar = new Map();
  for (const [name, value] of SEEDED_COOKIES) {
    jar.set(name, value);
  }
  if (seed) {
    for (const pair of String(seed).split(";")) {
      const index = pair.indexOf("=");
      if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
  }
  return {
    header() {
      if (jar.size === 0) return undefined;
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    remember(response) {
      for (const value of response?.headers?.getSetCookie?.() ?? []) {
        const pair = value.split(";")[0] ?? "";
        const index = pair.indexOf("=");
        if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
      }
    },
  };
}

/**
 * A pasted cookie in any of the three shapes a browser hands over.
 *
 * Bare value, a full `Cookie:` header line, or a JSON export. Returns `undefined` when the paste carries
 * nothing, so the caller can tell "the user pasted junk" from "there is no cookie", which are different answers:
 * the first is a mistake to report, the second is this provider's normal case.
 *
 * A paste that carries text but reads as no cookie **throws**, with a message that says what to copy — the
 * shared parser's own wording, which is the one the dashboard already shows for the other providers.
 */
export function normalizeDuckDuckGoWebCookie(value) {
  const text = String(value ?? "").trim();
  if (!text) return undefined;

  if (text.startsWith("{") || text.startsWith("[")) {
    const pairs = parseDuckDuckGoCookieExport(text);
    if (pairs.length === 0) {
      throw new Error("That export carried no cookies. Paste the Cookie header from duck.ai, or leave the field empty — no cookie is required.");
    }
    return pairs.join("; ");
  }

  // A header line is `a=1; b=2`; a bare value is whatever was copied out of the devtools cell. Both are
  // accepted, because both are what people paste, and neither can be validated beyond "looks like a token".
  const withoutPrefix = text.replace(/^cookie:\s*/i, "");
  return cookieHeaderFrom(parseCookieHeader(withoutPrefix));
}

/** The devtools JSON export, as a bare array or as the `{ cookies: [...] }` wrapper. */
function parseDuckDuckGoCookieExport(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray(parsed.cookies)
      ? parsed.cookies
      : [];
  return entries
    .map((entry) => {
      const cookie = entry && typeof entry === "object" ? entry : {};
      return typeof cookie.name === "string" && typeof cookie.value === "string"
        ? `${cookie.name}=${cookie.value}`
        : undefined;
    })
    .filter((pair) => pair !== undefined);
}

/**
 * The `Cookie` header for a credential, or `undefined` when there is none to send.
 *
 * An empty credential is the **normal** case for this provider, not a missing value: it is what the connect
 * route stores when the user pastes nothing, and the request goes out without a `Cookie` header. Every other
 * web-cookie adapter refuses that credential, so this is the one place the difference is visible.
 *
 * An unreadable paste is dropped rather than fatal, for the same reason: this service needs no cookie, so a
 * broken one must not cost a turn.
 */
export function duckDuckGoWebCookieHeader(credentials) {
  const raw = credentials?.apiKey || credentials?.accessToken || "";
  if (!String(raw).trim()) return undefined;
  try {
    return normalizeDuckDuckGoWebCookie(raw);
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * The catalog, and the field that decides what is free
 * ------------------------------------------------------------------ */

/**
 * The models the live catalog offers on a **free** tier.
 *
 * **The field is `accessTier` on the model itself**, and that is a measurement rather than a reading. Against
 * the live catalog on 2026-10-17:
 *
 * ```
 * free by model.accessTier                      : 6  (gpt-6-luna, gpt-5.4-mini, claude-haiku-4-5,
 *                                                    mistral-small-2603, tinfoil/gpt-oss-120b, tinfoil/gemma4-31b)
 * free by reasoningEffortAccess[].accessTier    : 3  (gpt-5.4-mini, claude-haiku-4-5, tinfoil/gpt-oss-120b)
 * ```
 *
 * Reading the nested field looks more precise and is simply wrong: it describes which *effort levels* an account
 * tier may select, not whether the model is served. A parser keyed on it silently drops half the free lineup.
 *
 * The list is read per request rather than pinned, because the lineup rotates — `gpt-6-luna` had appeared and
 * three of the source's hardcoded "free" ids no longer were, inside a week.
 */
export function freeDuckDuckGoWebModels(catalog) {
  if (!catalog || typeof catalog !== "object" || !Array.isArray(catalog.models)) return [];
  return catalog.models
    .filter((entry) => entry && typeof entry === "object")
    .filter((entry) => {
      const tiers = Array.isArray(entry.accessTier) ? entry.accessTier : [];
      return tiers.some((tier) => typeof tier === "string" && tier.toLowerCase() === "free");
    })
    .map((entry) => ({
      id: String(entry.id ?? ""),
      displayName: String(entry.modelName ?? entry.name ?? entry.id ?? ""),
    }))
    .filter((model) => model.id.length > 0);
}

export function duckDuckGoWebModelIds(catalog) {
  return freeDuckDuckGoWebModels(catalog).map((model) => model.id);
}

/* ------------------------------------------------------------------ *
 * Reading the answer out of the stream
 * ------------------------------------------------------------------ */

/**
 * One `data:` line, or `undefined` for everything that is not answer text.
 *
 * Non-JSON lines are dropped rather than thrown on: the stream opens with `data: [CHAT_TITLE:…]` before any JSON
 * arrives, and `[DONE]` terminates it. Both are normal, and a parser that threw on them would fail every turn at
 * the first byte.
 */
export function parseDuckDuckGoWebDataLine(line) {
  if (!line.startsWith("data: ")) return undefined;
  const data = line.slice("data: ".length).trim();
  if (!data || data === "[DONE]") return undefined;
  try {
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The text of one event, from `content` **or** `message`.
 *
 * This is trap 1, and it is the difference between an answer and a 200 with nothing in it. The live service
 * sends `{"action":"success","message":"…"}` and then a run of `{"message":"…"}` frames; `content` never
 * appears. A reader that looked only for `content` — which is what every other provider here sends — would
 * return an empty string and report success.
 */
export function duckDuckGoWebContent(event) {
  if (!event) return "";
  if (typeof event.content === "string") return event.content;
  if (typeof event.message === "string") return event.message;
  return "";
}

/**
 * The upstream's `data:` frames, one event at a time.
 *
 * Read as a stream rather than as one blob so the answer can be handed on as it arrives; the frames are plain
 * `data:` lines either way.
 */
export async function* readDuckDuckGoEvents(body, signal) {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const event = parseDuckDuckGoWebDataLine(line.trim());
        if (event) yield event;
        index = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    const tail = parseDuckDuckGoWebDataLine(buffer.trim());
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

/* ------------------------------------------------------------------ *
 * The request body
 * ------------------------------------------------------------------ */

/**
 * The request body.
 *
 * `publicKey` is a **parameter**, not generated here, and that is a hard boundary rather than a preference:
 * generating an RSA key pair needs `node:crypto`, and the body builder is the one piece of this module that
 * has no reason to touch it. The key comes from `publicKeyJwk()` below, which is server-side only.
 *
 * `reasoningEffort` is always sent. The working implementation records it as **required**, with a 400
 * `ERR_BAD_REQUEST` when omitted, verified live on its side. Not re-measured, because proving it costs a chat
 * POST against a rate-limited endpoint, and the requests that succeeded all sent it.
 */
export function buildDuckDuckGoWebPayload(input) {
  return {
    model: input.model,
    metadata: {
      // Every tool off: this gateway is a chat surface, and a search tool that fired on its own would be a
      // request the caller did not ask for.
      toolChoice: { NewsSearch: false, VideosSearch: false, LocalSearch: false, WeatherForecast: false },
    },
    messages: input.messages.map((message) => ({ role: message.role, content: message.content })),
    canUseTools: true,
    reasoningEffort: input.reasoningEffort ?? DUCKDUCKGO_WEB.defaultReasoningEffort,
    canUseApproxLocation: null,
    canDelegateImageGeneration: null,
    durableStream: {
      messageId: input.messageId,
      conversationId: input.conversationId,
      publicKey: input.publicKey,
    },
  };
}

/** The RSA public key the body carries. Generated here because the key pair needs `node:crypto`. */
export function publicKeyJwk() {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 0x10001 });
  const jwk = publicKey.export({ format: "jwk" });
  return { ...jwk, alg: "RSA-OAEP-256", ext: true, key_ops: ["encrypt"], use: "enc" };
}

/* ------------------------------------------------------------------ *
 * Refusals, classified by a field rather than by prose
 * ------------------------------------------------------------------ */

/**
 * A failure with a **kind**, so the caller decides retryability and this module only reports what happened.
 *
 * The alternative — classifying by *message* — is what this file avoids most deliberately: `ERR_CHALLENGE` and
 * `ERR_BN_LIMIT` arrive in the same JSON shape and, per the working implementation's own measurement, the
 * service maps both to the same user-facing message token. A regex over prose cannot tell them apart; a field
 * can.
 */
export class DuckDuckGoWebError extends Error {
  constructor(kind, message, overrideCode, status) {
    super(message);
    this.name = "DuckDuckGoWebError";
    this.kind = kind;
    this.overrideCode = overrideCode;
    this.status = status;
  }
}

/**
 * A response that is not 200, classified by **kind**.
 *
 * The classification reads the JSON body's `type` field, not its prose. The service's own client maps
 * `ERR_CHALLENGE` and `ERR_BN_LIMIT` to the same user-facing message token, so a regex over the message would
 * conflate an expired challenge with an address-level refusal — and only one of those is worth waiting out.
 */
export async function readDuckDuckGoRefusal(response) {
  const body = await response.text().catch(() => "");
  let type = "";
  let overrideCode;
  let detail = "";
  let payload;
  try {
    payload = JSON.parse(body);
    type = typeof payload?.type === "string" ? payload.type : "";
    overrideCode = typeof payload?.overrideCode === "string" ? payload.overrideCode : undefined;
    detail = typeof payload?.message === "string" ? payload.message : "";
  } catch {
    detail = body.slice(0, 200);
  }

  // A refusal can also arrive in the body of a **200** — the shape the shared reader knows — and it is read
  // here so a check that trusted the status alone could not report a broken credential as a working one.
  const bodyRefusal = readBodyRefusal(payload);
  if (bodyRefusal) {
    return new DuckDuckGoWebError("unavailable", `${response.status}: ${bodyRefusal}`, overrideCode, response.status);
  }

  // The override code is in the message as well as on the error, because it is the one identifier a support
  // question needs and the one a log line would otherwise lose.
  const summary = `${response.status}${type ? ` ${type}` : ""}${overrideCode ? ` (overrideCode ${overrideCode})` : ""}${detail ? `: ${detail}` : ""}`;
  if (type === "ERR_BN_LIMIT") return new DuckDuckGoWebError("quota", summary, overrideCode, response.status);
  if (type === "ERR_RATE_LIMIT") return new DuckDuckGoWebError("rate-limit", summary, overrideCode, response.status);
  // Everything else at 418, and a bare 418, is the challenge: measured, and the only retry-free reading that is
  // safe, because the alternative is spending another call to learn the same thing.
  if (response.status === 418 || type === "ERR_CHALLENGE") {
    return new DuckDuckGoWebError("challenge", summary, overrideCode, response.status);
  }
  if (response.status === 400 || response.status === 422) {
    return new DuckDuckGoWebError("bad-request", summary, overrideCode, response.status);
  }
  return new DuckDuckGoWebError("unavailable", summary, overrideCode, response.status);
}

/* ------------------------------------------------------------------ *
 * The upstream calls
 * ------------------------------------------------------------------ */

/**
 * `fetch` with a deadline, because a stalled stream otherwise hangs the turn until the process ends.
 */
async function fetchWithTimeout(url, init, timeoutMs, proxyOptions) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("the request timed out")), timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  try {
    return await proxyAwareFetch(url, { ...init, signal }, proxyOptions);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The headers the real client sends, minus the ones it does not need.
 *
 * The same-origin triplet (`host` + `Origin` + `Referer`, all `duck.ai`) is the part the source records as
 * load-bearing: a *mixed* triplet — a `duck.ai` host with a `duckduckgo.com` origin — is what it measured
 * returning HTTP 400. The `Sec-*` and `Priority` headers are browser fidelity; the browser-only `x-duckai-*`
 * headers the page's own bundle sends were measured as **not** required, so they are absent.
 */
export function duckDuckGoHeaders({ accept = "*/*", cookieHeader, extra } = {}) {
  return browserFingerprintHeaders({
    origin: DUCKDUCKGO_WEB.origin,
    referer: `${DUCKDUCKGO_WEB.origin}/`,
    accept,
    extra: {
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      Priority: "u=1, i",
      ...(extra || {}),
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
  });
}

/**
 * The live catalog, unfiltered — the adapter decides what is free.
 *
 * No VQD, no challenge, no credential: the one endpoint this service leaves open. It is also why the model list
 * can be read before anything is spent.
 */
export async function duckDuckGoCatalog({ signal, proxyOptions } = {}) {
  const response = await fetchWithTimeout(
    DUCKDUCKGO_WEB.modelsUrl,
    { method: "GET", headers: duckDuckGoHeaders({ accept: "application/json" }), ...(signal ? { signal } : {}) },
    DUCKDUCKGO_WEB.modelsTimeoutMs,
    proxyOptions,
  );
  if (!response.ok) throw await readDuckDuckGoRefusal(response);
  const payload = await response.json();
  // A refusal can arrive in the body of a 200, and a catalog that was refused is not a catalog.
  const refusal = readBodyRefusal(payload);
  if (refusal) {
    throw new DuckDuckGoWebError("unavailable", `${response.status}: ${refusal}`, undefined, response.status);
  }
  return payload;
}

/**
 * The handshake, reported as facts: whether a challenge was served and how long solving took.
 *
 * A challenge that is not served is **reported**, not thrown: it means the service decided this request needs no
 * proof, which is a fact about the request rather than a failure.
 */
export async function duckDuckGoStatus({ cookieHeader, signal, proxyOptions } = {}) {
  const response = await fetchWithTimeout(
    DUCKDUCKGO_WEB.statusUrl,
    {
      method: "GET",
      headers: duckDuckGoHeaders({ accept: "*/*", cookieHeader, extra: { "x-vqd-accept": "1" } }),
      ...(signal ? { signal } : {}),
    },
    DUCKDUCKGO_WEB.statusTimeoutMs,
    proxyOptions,
  );
  if (!response.ok) throw await readDuckDuckGoRefusal(response);

  // The body is read for a refusal only: this service can answer 200 and refuse in the body, and a check that
  // trusted the status would report a broken credential as a working one.
  const bodyText = await response.text().catch(() => "");
  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    payload = undefined;
  }
  const refusal = readBodyRefusal(payload);
  if (refusal) {
    throw new DuckDuckGoWebError("unavailable", `${response.status}: ${refusal}`, undefined, response.status);
  }

  const challenge = response.headers.get("x-vqd-hash-1");
  if (!challenge) return { challengeServed: false, solvedMs: 0, challenge: undefined };

  const solved = await solveDuckDuckGoChallenge(challenge, CHROME_USER_AGENT, {
    origin: DUCKDUCKGO_WEB.origin,
    timeoutMs: DUCKDUCKGO_WEB.challengeTimeoutMs,
  });
  return { challengeServed: true, solvedMs: solved.elapsedMs, challenge: solved.header };
}

/**
 * One turn: the homepage for the request version, the challenge, then the chat.
 *
 * The version token is read **per turn** rather than cached: it changes with every front-end deploy, and a stale
 * one is the exact defect the source implementation shipped for its whole life. A fresh challenge is fetched per
 * turn as well, which costs one extra GET and cannot be wrong — whether the rotated `x-vqd-hash-1` is reusable
 * was never established, so it is not assumed.
 */
export async function duckDuckGoTurn({ payload, model, messages, cookieHeader, signal, proxyOptions } = {}) {
  const jar = createDuckDuckGoCookieJar(cookieHeader);

  const home = await fetchWithTimeout(
    DUCKDUCKGO_WEB.homeUrl,
    { method: "GET", headers: duckDuckGoHeaders({ accept: "*/*", cookieHeader: jar.header() }), ...(signal ? { signal } : {}) },
    DUCKDUCKGO_WEB.homeTimeoutMs,
    proxyOptions,
  );
  if (!home.ok) throw await readDuckDuckGoRefusal(home);
  // The response is read for two attributes only, so it is not kept. `remember` still runs, because the session
  // cookies a first visit sets are part of what a browser would carry into the next request.
  jar.remember(home);
  const feVersion = duckDuckGoFeVersion(await home.text());
  if (!feVersion) {
    throw new DuckDuckGoWebError(
      "unavailable",
      "the homepage carried no data-version-tag/data-version-sha pair, so the request version could not be assembled",
    );
  }

  const status = await fetchWithTimeout(
    DUCKDUCKGO_WEB.statusUrl,
    {
      method: "GET",
      headers: duckDuckGoHeaders({ accept: "*/*", cookieHeader: jar.header(), extra: { "x-vqd-accept": "1" } }),
      ...(signal ? { signal } : {}),
    },
    DUCKDUCKGO_WEB.statusTimeoutMs,
    proxyOptions,
  );
  if (!status.ok) throw await readDuckDuckGoRefusal(status);
  jar.remember(status);

  const challenge = status.headers.get("x-vqd-hash-1");
  if (!challenge) {
    throw new DuckDuckGoWebError("challenge", "the service served no anti-bot challenge, so a turn cannot be proven");
  }
  const solved = await solveDuckDuckGoChallenge(challenge, CHROME_USER_AGENT, {
    origin: DUCKDUCKGO_WEB.origin,
    timeoutMs: DUCKDUCKGO_WEB.challengeTimeoutMs,
  });

  const requestPayload = payload ?? buildDuckDuckGoWebPayload({
    model,
    messages,
    publicKey: publicKeyJwk(),
    conversationId: randomUUID(),
    messageId: randomUUID(),
  });

  const chatHeaders = duckDuckGoHeaders({
    accept: "text/event-stream",
    cookieHeader: jar.header(),
    extra: {
      "Content-Type": "application/json",
      "x-ddg-journey-id": duckDuckGoJourneyId(),
      "x-fe-signals": duckDuckGoFeSignals(),
      "x-fe-version": feVersion,
      // Sent solved, always. An unsolved value is answered with 418 and still counts against the quota, so there
      // is no path here that forwards the raw challenge.
      "x-vqd-hash-1": solved.header,
    },
  });

  const response = await fetchWithTimeout(
    DUCKDUCKGO_WEB.baseUrl,
    {
      method: "POST",
      headers: chatHeaders,
      body: JSON.stringify(requestPayload),
      ...(signal ? { signal } : {}),
    },
    DUCKDUCKGO_WEB.chatTimeoutMs,
    proxyOptions,
  );
  if (!response.ok) throw await readDuckDuckGoRefusal(response);

  return { response, feVersion, solvedMs: solved.elapsedMs, headers: chatHeaders };
}

/* ------------------------------------------------------------------ *
 * The dashboard: check and connect
 * ------------------------------------------------------------------ */

/**
 * Checks the endpoint and stores nothing. **The cookie is optional here too.**
 *
 * What a check can honestly establish for this provider is that the service answered and served a challenge this
 * gateway solved. It cannot establish that a cookie works, because the service does not read one — so the note
 * says which of the two happened and never claims the stronger thing.
 */
export async function checkWebSession(credential) {
  let cookieHeader;
  try {
    cookieHeader = normalizeDuckDuckGoWebCookie(credential);
  } catch (error) {
    return { ok: false, detail: error.message, models: [] };
  }

  let models = [];
  try {
    models = duckDuckGoWebModelIds(await duckDuckGoCatalog({}));
  } catch {
    // A catalog that could not be read is not a failure of the endpoint check, and reporting it as one would
    // blame the request for a listing problem.
  }

  let status;
  try {
    status = await duckDuckGoStatus({ cookieHeader });
  } catch (error) {
    return { ok: false, detail: `Duck.ai could not be reached: ${error.message}`, models };
  }

  if (!status.challengeServed) {
    return {
      ok: false,
      detail: "Duck.ai answered without serving an anti-bot challenge, so a turn cannot be proven from here.",
      models,
    };
  }

  return {
    ok: true,
    detail: cookieHeader
      ? "Duck.ai answered and served a challenge this gateway solved. The cookie was sent; this service does not read one, so this does not prove the cookie is valid."
      : "Duck.ai answered and served a challenge this gateway solved. No cookie was needed.",
    models,
  };
}

/**
 * Stores the connection, after checking the endpoint.
 *
 * The credential is empty when nothing was pasted, and that is a decision rather than a gap: this service reads
 * no cookie, so there is nothing to store and nothing to pretend to have stored.
 */
export async function connectWebSession(credential) {
  let cookieHeader;
  try {
    cookieHeader = normalizeDuckDuckGoWebCookie(credential);
  } catch (error) {
    return { ok: false, error: error.message };
  }

  const check = await checkWebSession(credential);
  if (!check.ok) {
    return { ok: false, error: check.detail };
  }

  return {
    ok: true,
    credential: cookieHeader ?? "",
    models: check.models,
    name: "Duck.ai",
  };
}
