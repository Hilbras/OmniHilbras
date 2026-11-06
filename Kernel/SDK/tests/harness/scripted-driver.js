/**
 * A browser-driver double for adapters that drive a page.
 *
 * `ChatGptWebAdapter` injects `{ driver }` rather than a transport, because answering a question on
 * ChatGPT means opening chatgpt.com and typing into it. There is no HTTP request to intercept, so
 * there is nothing a transport-shaped harness could stand in for — the interface *is* the seam.
 *
 * This is therefore held to the same rule as the transport harness: it must implement the real
 * interface, and it must not quietly succeed where the real thing would fail.
 */

/** The one model the contract drives. ChatGPT Web has no transport to be asked for a model by. */
export const CHATGPT_WEB_CONTRACT_MODEL = 'gpt-5.6-luna-free';

/** A storage state with a real session cookie, which is the only thing a check will accept. */
export function chatGptWebFixtureCredential() {
  return {
    type: 'api-key',
    value: JSON.stringify({
      cookies: [
        { name: '__Secure-next-auth.session-token', value: 'fixture-session-token', domain: '.chatgpt.com', path: '/', secure: true, httpOnly: true },
        { name: 'oai-did', value: 'fixture-device-id', domain: '.chatgpt.com', path: '/', secure: true, httpOnly: false },
      ],
      planType: 'chatgptplus',
      expiresAt: '2099-12-26T17:00:52.429Z',
    }),
  };
}

export function scriptedDriver({ parts = ['Hello', ', ', 'world'], throws } = {}) {
  const asked = [];
  const state = { parts, throws };

  const driver = {
    /**
     * Answers with whatever the fixture was given, joined.
     *
     * Multi-part on purpose. A driver that returns the whole answer in one string is what a real
     * page does too, but the contract's job is to prove the *adapter* neither truncates nor
     * reorders, and that is only provable if the parts are separately addressable on the way in.
     */
    ask: async (input) => {
      asked.push(input);
      if (state.throws) throw state.throws;
      return { text: state.parts.join('') };
    },
    available: async () => (state.throws ? { ok: false, reason: 'no browser' } : { ok: true }),
    verify: async (input) => {
      asked.push({ verify: true, cookies: input.cookies });
      if (state.throws) throw state.throws;
      return { ok: true, plan: 'chatgptplus' };
    },
  };

  driver.set = (next) => { state.parts = next; };
  /** Makes the next ask fail the way a refused page would, for the refusal assertions. */
  driver.setThrow = (error) => { state.throws = error; };
  driver.asked = asked;

  return driver;
}

/** The one model the contract drives for Gemini Web. */
export const GEMINI_WEB_CONTRACT_MODEL = 'gemini-3.1-pro';

/** A cookie header, which is the only thing a Gemini Web check will accept. */
export function geminiWebFixtureCredential() {
  return { type: 'api-key', value: '__Secure-1PSID=fixture-psid; __Secure-1PSIDTS=fixture-psidts' };
}

/**
 * A driver for `GeminiWebAdapter`.
 *
 * Separate from `scriptedDriver` above because the interface differs in one field — Gemini's `verify` takes the
 * cookie **header string**, ChatGPT's takes parsed cookies — and a harness that pretended they were the same
 * would pass while testing the wrong signature. The rest is the same principle: it implements the real
 * interface and does not quietly succeed where the real driver would fail.
 */
export function scriptedGeminiDriver({ parts = ['Hello', ', ', 'world'], throws } = {}) {
  const state = { parts, throws };
  const driver = {
    ask: async () => {
      if (state.throws) throw state.throws;
      return { text: state.parts.join('') };
    },
    /**
     * Always a browser here: the double models a host that has one.
     *
     * This is deliberately **not** tied to `throws`. It was, and that made the refusal assertions test the
     * wrong thing — a refusal set `throws`, `available()` then reported no browser, and the adapter refused
     * before it ever reached `ask`, so a real page refusal was never exercised. The missing-browser path has its
     * own test in `gemini-web.test.js` with a driver that says so.
     */
    available: async () => ({ ok: true }),
    verify: async () => {
      if (state.throws) throw state.throws;
      return { ok: true };
    },
  };
  driver.set = (next) => { state.parts = next; };
  driver.setThrow = (error) => { state.throws = error; };
  return driver;
}

/** The one model the contract drives for Duck.ai. It is free today, which is what the catalog says. */
export const DUCKDUCKGO_WEB_CONTRACT_MODEL = 'gpt-5.4-mini';

/**
 * A driver for `DuckDuckGoWebAdapter`.
 *
 * Its own double for the same reason as Gemini's: the real interface is four methods, and `catalog` and
 * `status` are not `verify` — the adapter filters the catalog by each model's own `accessTier` and calls
 * `status` for the check, so a harness that only stubbed `ask` would leave both paths unexercised and the
 * contract would pass while testing a third of the adapter.
 *
 * The catalog here is deliberately mixed — one free model and one paid — because the free filter is the
 * adapter's whole claim about what it offers. A catalog of free models only would pass with the filter
 * removed.
 */
export function scriptedDuckDuckGoDriver({ parts = ['port', '-', 'ok'], throws } = {}) {
  const state = { parts, throws };
  const driver = {
    available: async () => ({ ok: true }),
    catalog: async () => {
      if (state.throws) throw state.throws;
      return {
        models: [
          { id: DUCKDUCKGO_WEB_CONTRACT_MODEL, modelName: 'GPT-5.4 mini', accessTier: ['free', 'plus'] },
          { id: 'paid-model', modelName: 'Paid', accessTier: ['plus', 'pro'] },
        ],
      };
    },
    status: async () => {
      if (state.throws) throw state.throws;
      return { challengeServed: true, solvedMs: 2 };
    },
    ask: async () => {
      if (state.throws) throw state.throws;
      return { text: state.parts.join(''), model: DUCKDUCKGO_WEB_CONTRACT_MODEL };
    },
  };
  driver.set = (next) => { state.parts = next; };
  driver.setThrow = (error) => { state.throws = error; };
  return driver;
}
