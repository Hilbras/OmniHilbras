import { describe, expect, it } from "vitest";

import { WEB_SESSION_PROVIDERS } from "@/shared/constants/webSessionProviders";

/**
 * The console snippets.
 *
 * Each web-session provider tells the user how to copy its credential, and
 * where a console one-liner can do it, it says so as a snippet the user can
 * click and paste into the console.
 *
 * Two rules the snippets must keep:
 *
 *  1. **They parse.** A snippet that does not parse is a snippet the user
 *     pastes into their console and gets a red error for.
 *  2. **They do not pretend.** A session cookie that is `HttpOnly` cannot be
 *     read by any console command — a snippet that claims to copy it fails in
 *     a way that looks like being signed out. So the providers whose session
 *     cookie is HttpOnly say so, and their snippet only copies what the page
 *     can actually see.
 */
const HTTP_ONLY_SESSION = {
  "chatgpt-web": "the session cookie is HttpOnly",
  "qwen-web": "HttpOnly",
  "gemini-web": "HttpOnly",
};

describe("web-session console snippets", () => {
  it("gives every provider a snippet", () => {
    for (const [id, descriptor] of Object.entries(WEB_SESSION_PROVIDERS)) {
      const withSnippet = descriptor.extractionSteps.filter((step) => step.snippet);
      expect(withSnippet.length, `${id} has no console snippet`).toBeGreaterThan(0);
    }
  });

  it("every snippet is valid JavaScript", () => {
    for (const [id, descriptor] of Object.entries(WEB_SESSION_PROVIDERS)) {
      for (const step of descriptor.extractionSteps.filter((s) => s.snippet)) {
        expect(() => new Function(step.snippet), `${id} has a snippet that does not parse`).not.toThrow();
      }
    }
  });

  it("a snippet copies to the clipboard", () => {
    // The user's one action is "paste this in the console and the credential
    // is on my clipboard" — so every snippet ends in a copy() call.
    for (const [id, descriptor] of Object.entries(WEB_SESSION_PROVIDERS)) {
      for (const step of descriptor.extractionSteps.filter((s) => s.snippet)) {
        expect(step.snippet, `${id} has a snippet that does not copy`).toMatch(/\bcopy\(/);
      }
    }
  });

  it("says plainly when the session cookie is HttpOnly", () => {
    // A snippet that cannot work is worse than a slightly longer set of
    // clicks: it fails in a way that looks like being signed out.
    for (const [id, phrase] of Object.entries(HTTP_ONLY_SESSION)) {
      const descriptor = WEB_SESSION_PROVIDERS[id];
      const text = descriptor.extractionSteps.map((s) => `${s.label} ${s.body}`).join(" ");
      expect(text, `${id} does not say its session cookie is HttpOnly`).toMatch(new RegExp(phrase, "i"));
    }
  });

  it("a HttpOnly provider's snippet does not extract the session cookie's value", () => {
    for (const id of Object.keys(HTTP_ONLY_SESSION)) {
      const descriptor = WEB_SESSION_PROVIDERS[id];
      for (const step of descriptor.extractionSteps.filter((s) => s.snippet)) {
        // Detecting that the cookie is *there* is fine — that is how the
        // snippet tells the user whether they are signed in. Pulling its value
        // out by name is not: that value is HttpOnly and no console command
        // can read it.
        expect(step.snippet, `${id} extracts a cookie the console cannot read`)
          .not.toMatch(/__Secure-next-auth\.session-token=/);
        expect(step.snippet, `${id} extracts a cookie the console cannot read`)
          .not.toMatch(/__Secure-1PSID=/);
      }
    }
  });
});
