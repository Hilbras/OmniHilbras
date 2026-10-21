import { describe, expect, it } from "vitest";
import { modelIdFromTestModel } from "@/app/(dashboard)/dashboard/providers/[id]/modelTestResults.js";

/**
 * The batch test echoes back the model string it was asked to test, so the
 * result key has to be the model id again — a model id may contain a slash
 * itself ("anthropic/claude-opus-4.7").
 */
describe("model test result keys", () => {
  it("strips the provider prefix the request was sent with", () => {
    expect(modelIdFromTestModel("openai/gpt-4o", "openai")).toBe("gpt-4o");
  });

  it("keeps the slash that belongs to the model id", () => {
    expect(
      modelIdFromTestModel("cline/anthropic/claude-opus-4.7", "cline"),
    ).toBe("anthropic/claude-opus-4.7");
  });

  it("returns the model as sent when the prefix does not match", () => {
    expect(
      modelIdFromTestModel("anthropic/claude-opus-4.7", "openai"),
    ).toBe("anthropic/claude-opus-4.7");
  });

  it("has no key for an empty model", () => {
    expect(modelIdFromTestModel("", "openai")).toBe("");
    expect(modelIdFromTestModel(undefined, "openai")).toBe("");
  });
});
