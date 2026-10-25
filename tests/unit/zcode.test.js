// ZCode Start Plan provider — unit tests for credential KDF, request building,
// registry integration, and the "zcode" thinking format.
import { describe, expect, it, afterEach } from "vitest";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  ZCodeExecutor,
  backendModelId,
  buildRequestBody,
  credentialSecret,
  decryptCredential,
  mapMessages,
  resolveToken,
} from "../../open-sse/executors/zcode.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import registryEntry from "../../open-sse/providers/registry/zcode.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { getModelsFetcher } from "../../src/shared/constants/providers.js";
import { getModelsByProviderId } from "../../src/shared/constants/models.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { parseModel, resolveProviderAlias } from "../../open-sse/services/model.js";
import { ZCODE_REQUEST_TEMPLATE } from "../../open-sse/config/zcodeRequestTemplate.js";

const ENV_KEYS = ["ZCODE_CREDENTIAL_SECRET", "ZCODE_START_PLAN_TOKEN", "ZCODE_JWT_TOKEN", "ZCODE_CREDENTIALS_FILE"];
const savedEnv = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

// Build an enc:v1 credential exactly like the ZCode desktop store does.
function encryptFixture(plaintext, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const b64url = (buf) => buf.toString("base64url");
  return `enc:v1:${b64url(iv)}.${b64url(tag)}.${b64url(ciphertext)}`;
}

describe("zcode credential decryption", () => {
  it("derives the fallback secret with the bare platform segment (win32/linux — not *-x64)", () => {
    const username = process.env.USER || process.env.USERNAME || "unknown";
    expect(credentialSecret()).toBe(
      `zcode-credential-fallback:${process.platform}:${homedir()}:${username}`,
    );
  });

  it("prefers ZCODE_CREDENTIAL_SECRET when set", () => {
    process.env.ZCODE_CREDENTIAL_SECRET = "test-secret";
    expect(credentialSecret()).toBe("test-secret");
  });

  it("decrypts a store-format credential (round-trip through the documented KDF)", () => {
    process.env.ZCODE_CREDENTIAL_SECRET = "test-secret";
    const fixture = encryptFixture("header.payload.signature", "test-secret");
    expect(fixture.startsWith("enc:v1:")).toBe(true);
    expect(decryptCredential(fixture)).toBe("header.payload.signature");
  });

  it("rejects a credential encrypted with a different secret (GCM auth tag)", () => {
    process.env.ZCODE_CREDENTIAL_SECRET = "test-secret";
    const fixture = encryptFixture("header.payload.signature", "other-secret");
    expect(() => decryptCredential(fixture)).toThrow();
  });

  it("passes plaintext values through untouched", () => {
    expect(decryptCredential("raw-token")).toBe("raw-token");
  });
});

describe("zcode token resolution priority", () => {
  it("prefers the connection key, then env, then the local store", () => {
    process.env.ZCODE_CREDENTIALS_FILE = "/nonexistent-zcode-credentials.json";
    process.env.ZCODE_START_PLAN_TOKEN = "env-token";

    expect(resolveToken({ apiKey: "pasted-jwt" }).token).toBe("pasted-jwt");
    expect(resolveToken({}).token).toBe("env-token");
    expect(resolveToken({}).source).toBe("env");
    expect(() => {
      delete process.env.ZCODE_START_PLAN_TOKEN;
      delete process.env.ZCODE_JWT_TOKEN;
      resolveToken({});
    }).toThrow(/credentials not found/);
  });

  it("reads and decrypts a local credential store file", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-test-"));
    try {
      process.env.ZCODE_CREDENTIAL_SECRET = "test-secret";
      process.env.ZCODE_START_PLAN_TOKEN = "";
      process.env.ZCODE_JWT_TOKEN = "";
      const store = {
        zcodejwttoken: encryptFixture("local-jwt", "test-secret"),
        "oauth:zai:user_info": encryptFixture(JSON.stringify({ user_id: "uuid-1" }), "test-secret"),
      };
      const storePath = join(dir, "credentials.json");
      writeFileSync(storePath, JSON.stringify(store));
      process.env.ZCODE_CREDENTIALS_FILE = storePath;

      const resolved = resolveToken({});
      expect(resolved.token).toBe("local-jwt");
      expect(resolved.source).toBe("local");
      expect(resolved.accountUuid).toBe("uuid-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("zcode request building (stock template discipline)", () => {
  const baseBody = {
    model: "glm-5.3-flash",
    system: "Be terse.",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  };

  it("preserves the stock system blocks and the 34-tool catalog", () => {
    const body = buildRequestBody(baseBody, "glm-5.3-flash", "s", "u");
    expect(body.system).toHaveLength(3);
    expect(body.system[0].text).toBe("You are ZCode, an interactive coding agent");
    expect(body.tools).toHaveLength(ZCODE_REQUEST_TEMPLATE.tools.length);
    expect(body.tool_choice).toEqual({ type: "auto" });
  });

  it("never leaks the workspace placeholder", () => {
    const body = buildRequestBody(baseBody, "glm-5.3-flash", "s", "u");
    expect(JSON.stringify(body)).not.toContain("__ZCODE_PRIMARY_WORKING_DIRECTORY__");
  });

  it("maps model ids to backend names and clamps max_tokens", () => {
    expect(backendModelId("glm-5.3")).toBe("GLM-5.3");
    expect(backendModelId("GLM-5.3-Flash")).toBe("GLM-5.3-Flash");
    expect(backendModelId("whatever")).toBe("GLM-5.3-Flash");

    const small = buildRequestBody({ ...baseBody, max_tokens: 500 }, "glm-5.3", "s", "u");
    expect(small.model).toBe("GLM-5.3");
    expect(small.max_tokens).toBe(500);

    const huge = buildRequestBody({ ...baseBody, max_tokens: 999999 }, "glm-5.3", "s", "u");
    expect(huge.max_tokens).toBe(128000);

    const none = buildRequestBody(baseBody, "glm-5.3", "s", "u");
    expect(none.max_tokens).toBe(128000);
  });

  it("strips client tools and honors the client's stream flag", () => {
    const body = buildRequestBody(
      { ...baseBody, tools: [{ name: "client-tool" }], tool_choice: "auto" },
      "glm-5.3-flash", "s", "u",
    );
    expect(JSON.stringify(body.tools)).not.toContain("client-tool");
    expect(body.stream).toBe(true);
    expect(buildRequestBody(baseBody, "glm-5.3-flash", "s", "u", false).stream).toBe(false);
  });

  it("keeps framework-written thinking/output_config and defaults to enabled/max", () => {
    const withThinking = buildRequestBody(
      { ...baseBody, thinking: { type: "enabled" }, output_config: { effort: "low" } },
      "glm-5.3-flash", "s", "u",
    );
    expect(withThinking.thinking).toEqual({ type: "enabled" });
    expect(withThinking.output_config).toEqual({ effort: "low" });

    const without = buildRequestBody(baseBody, "glm-5.3-flash", "s", "u");
    expect(without.thinking).toEqual({ type: "enabled" });
    expect(without.output_config).toEqual({ effort: "max" });
  });

  it("carries device/account/session metadata", () => {
    const body = buildRequestBody(baseBody, "glm-5.3-flash", "session-1", "account-1");
    const meta = JSON.parse(body.metadata.user_id);
    expect(meta).toMatchObject({ account_uuid: "account-1", session_id: "session-1" });
    expect(typeof meta.device_id).toBe("string");
  });
});

describe("zcode client system injection", () => {
  it("merges the client system into the first user turn as a marked preamble", () => {
    const messages = mapMessages({
      system: "You are Claude Code.",
      messages: [{ role: "user", content: [{ type: "text", text: "do it" }] }],
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content[0].text).toContain("[SESSION INSTRUCTIONS");
    expect(messages[0].content[0].text).toContain("You are Claude Code.");
    expect(messages[0].content[1].text).toBe("do it");
  });

  it("handles string content on the first user turn", () => {
    const messages = mapMessages({
      system: "sys",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(messages[0].content).toHaveLength(1);
    expect(messages[0].content[0].text).toContain("sys");
    expect(messages[0].content[0].text).toContain("hello");
  });

  it("inserts a new user turn when the conversation starts with an assistant turn", () => {
    const messages = mapMessages({
      system: "sys",
      messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }] }],
    });
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });

  it("joins block-shaped system arrays and passes through when no system is present", () => {
    const messages = mapMessages({
      system: [{ type: "text", text: "one" }, { type: "text", text: "two" }],
      messages: [{ role: "user", content: "q" }],
    });
    expect(messages[0].content[0].text).toContain("one\ntwo");

    const untouched = mapMessages({ messages: [{ role: "user", content: "q" }] });
    expect(untouched).toEqual([{ role: "user", content: "q" }]);
  });
});

describe("zcode registry + capabilities integration", () => {
  it("registers the dedicated executor as a no-auth provider", () => {
    const executor = getExecutor("zcode");
    expect(executor).toBeInstanceOf(ZCodeExecutor);
    expect(executor.noAuth).toBe(true);
    expect(executor.buildUrl()).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
  });

  it("registers as a no-auth free-tier provider with the messages endpoint", () => {
    expect(registryEntry.category).toBe("freeTier");
    expect(registryEntry.noAuth).toBe(true);
    expect(registryEntry.transport.baseUrl).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
    expect(registryEntry.transport.format).toBe("claude");
    expect(registryEntry.models.map((m) => m.id)).toEqual(["glm-5.3-flash", "glm-5.3"]);
  });

  it("shows the fixed seed catalog — no phantom models fetcher (gateway has no /models)", () => {
    // The baseUrl ends in /messages, which auto-derives a …/models fetcher that
    // 404s upstream and leaves the provider page model list empty forever.
    expect(getModelsFetcher("zcode")).toBeUndefined();
    expect(getModelsByProviderId("zcode").map((m) => m.id)).toEqual(["glm-5.3-flash", "glm-5.3"]);
  });

  it("routes both the zcode/ and zc/ model prefixes to the zcode provider", () => {
    // "zc" is the UI badge token; it must also resolve in the engine's routing
    // map or requests fall to the DefaultExecutor with no transport.
    expect(resolveProviderAlias("zc")).toBe("zcode");
    expect(parseModel("zc/glm-5.3-flash").provider).toBe("zcode");
    expect(parseModel("zcode/glm-5.3").provider).toBe("zcode");
  });

  it("exposes zcode thinking capabilities: always-on low/high/max, no client tools", () => {
    for (const model of ["glm-5.3", "glm-5.3-flash"]) {
      const caps = getCapabilitiesForModel("zcode", model);
      expect(caps.thinkingFormat).toBe("zcode");
      expect(caps.thinkingCanDisable).toBe(false);
      expect(caps.tools).toBe(false);
      expect(getThinkingLevels("zcode", model)).toEqual(["low", "high", "max"]);
    }
  });

  it("writes the zcode wire shape: thinking enabled + output_config.effort", () => {
    const think = (body) => applyThinking("claude", "glm-5.3", body, "zcode");
    // No client hint → nothing written; the executor's stock template default
    // (enabled/max) applies (covered in the request-building tests above).
    const silent = think({ messages: [] });
    expect(silent.thinking).toBeUndefined();
    expect(silent.output_config).toBeUndefined();
    expect(think({ messages: [], reasoning_effort: "low" })).toMatchObject({ output_config: { effort: "low" } });
    expect(think({ messages: [], reasoning_effort: "high" })).toMatchObject({ output_config: { effort: "high" } });
    // medium/xhigh collapse into the three accepted levels
    expect(think({ messages: [], reasoning_effort: "medium" })).toMatchObject({ output_config: { effort: "high" } });
    expect(think({ messages: [], reasoning_effort: "xhigh" })).toMatchObject({ output_config: { effort: "max" } });
    // cannot disable: "none" clamps to the minimal accepted level
    expect(think({ messages: [], reasoning_effort: "none" })).toMatchObject({ output_config: { effort: "low" } });
  });
});
