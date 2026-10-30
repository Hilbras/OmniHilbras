import { describe, it, expect, afterEach } from "vitest";
import {
  adjustMaxTokens,
  withOutputCap,
  clampThinkingBudget,
  getOperatorMaxTokens,
  getOperatorThinkingBudget,
} from "../../open-sse/translator/formats/maxTokens.js";
import { DEFAULT_MAX_TOKENS, DEFAULT_MIN_TOKENS } from "../../open-sse/config/runtimeConfig.js";

describe("operator budget caps", () => {
  afterEach(() => {
    // Every test must leave the module-level override clear — a leaked cap
    // would silently bound every later request in the process.
    withOutputCap(0, () => {}, 0);
  });

  it("applies no cap by default", () => {
    expect(getOperatorMaxTokens()).toBe(0);
    expect(adjustMaxTokens({ max_tokens: 100000 })).toBe(DEFAULT_MAX_TOKENS);
  });

  it("clamps max_tokens down to the operator ceiling", () => {
    withOutputCap(512, () => {
      expect(adjustMaxTokens({ max_tokens: 4000 })).toBe(512);
      expect(adjustMaxTokens({ max_tokens: 100 })).toBe(100); // never raised
    });
  });

  it("wins over the model-specific ceiling", () => {
    withOutputCap(512, () => {
      // A 128k model would otherwise be allowed the full 128k.
      expect(adjustMaxTokens({ max_tokens: 128000 }, 128000)).toBe(512);
    });
  });

  it("restores the previous cap even when the body throws", () => {
    expect(() =>
      withOutputCap(512, () => {
        throw new Error("translator blew up");
      }),
    ).toThrow("translator blew up");
    expect(getOperatorMaxTokens()).toBe(0);
  });

  it("nests caps and restores the outer one", () => {
    withOutputCap(1000, () => {
      expect(adjustMaxTokens({ max_tokens: 5000 })).toBe(1000);
      withOutputCap(200, () => {
        expect(adjustMaxTokens({ max_tokens: 5000 })).toBe(200);
      });
      expect(adjustMaxTokens({ max_tokens: 5000 })).toBe(1000);
    });
    expect(getOperatorMaxTokens()).toBe(0);
  });

  it("still respects the tool-calling floor when the cap is above it", () => {
    withOutputCap(40000, () => {
      const out = adjustMaxTokens({ max_tokens: 1000, tools: [{ type: "function" }] });
      expect(out).toBe(DEFAULT_MIN_TOKENS);
    });
  });

  it("ignores a non-numeric or negative cap", () => {
    withOutputCap(-5, () => expect(getOperatorMaxTokens()).toBe(0));
    withOutputCap("nope", () => expect(getOperatorMaxTokens()).toBe(0));
  });

  it("clamps the thinking budget independently of the output cap", () => {
    withOutputCap(0, () => {
      expect(getOperatorThinkingBudget()).toBe(4000);
      expect(clampThinkingBudget(32000)).toBe(4000);
      expect(clampThinkingBudget(1000)).toBe(1000);
      // An unset budget stays unset.
      expect(clampThinkingBudget(undefined)).toBeUndefined();
      expect(clampThinkingBudget(0)).toBe(0);
    }, 4000);
  });

  it("clears both caps after the scope", () => {
    withOutputCap(100, () => {}, 50);
    expect(getOperatorMaxTokens()).toBe(0);
    expect(getOperatorThinkingBudget()).toBe(0);
  });
});
