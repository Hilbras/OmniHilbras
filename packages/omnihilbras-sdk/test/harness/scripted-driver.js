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
