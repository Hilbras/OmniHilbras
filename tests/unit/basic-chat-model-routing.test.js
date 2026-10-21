import { describe, expect, it } from "vitest";
import {
  getModelPrefix,
  toRequestModel,
} from "@/app/(dashboard)/dashboard/basic-chat/chatModels.js";

describe("basic chat model routing", () => {
  it("routes a normal provider under its provider id", () => {
    const connection = { provider: "claude" };
    expect(getModelPrefix(connection)).toBe("claude");
    expect(toRequestModel(getModelPrefix(connection), "claude-sonnet-4-5"))
      .toBe("claude/claude-sonnet-4-5");
  });

  it("routes a compatible provider under the prefix of its node", () => {
    const connection = {
      provider: "openai-compatible-chat-1234",
      providerSpecificData: { prefix: "oc-prod" },
    };
    expect(getModelPrefix(connection)).toBe("oc-prod");
    expect(toRequestModel(getModelPrefix(connection), "gpt-4o")).toBe("oc-prod/gpt-4o");
  });

  it("falls back to the provider id when a node has no prefix", () => {
    const connection = { provider: "anthropic-compatible-chat-1234" };
    expect(getModelPrefix(connection)).toBe("anthropic-compatible-chat-1234");
  });

  it("does not prefix a model that already carries its provider", () => {
    expect(toRequestModel("nous", "nous/stepfun/step-5-preview:free"))
      .toBe("nous/stepfun/step-5-preview:free");
  });

  it("does not confuse a provider with a longer one", () => {
    expect(toRequestModel("cl", "cline/grok-4")).toBe("cl/cline/grok-4");
  });

  it("returns nothing for a model without an id", () => {
    expect(toRequestModel("claude", "")).toBe("");
  });
});
