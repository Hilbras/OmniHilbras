// ZCode Start Plan provider — unit tests for credential KDF, request building,
// registry integration, and the "zcode" thinking format.
import { describe, expect, it, afterEach, vi } from "vitest";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  ZCodeExecutor,
  backendModelId,
  buildRequestBody,
  classifyZcodeError,
  credentialSecret,
  decryptCredential,
  mapMessages,
  resolveToken,
} from "../../open-sse/executors/zcode.js";
import {
  buildToolContract,
  flattenToolBlocks,
  normalizeToolCalls,
  parseToolBridge,
  rewriteAnthropicMessage,
  rewriteAnthropicStream,
} from "../../open-sse/executors/zcode/toolBridge.js";
import {
  parseZcodeEnvelope,
  zcodeBusinessCode,
} from "../../open-sse/executors/zcode/envelope.js";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import registryEntry from "../../open-sse/providers/registry/zcode.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { getModelsFetcher } from "../../src/shared/constants/providers.js";
import { getModelsByProviderId } from "../../src/shared/constants/models.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { parseModel, resolveProviderAlias } from "../../open-sse/services/model.js";
import { ZCODE_REQUEST_TEMPLATE } from "../../open-sse/config/zcodeRequestTemplate.js";

// The upstream call is mocked so the executor's request/response bridge can be
// exercised without network access.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
  default: vi.fn(),
}));

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

  it("bridges client tools through the transcript and honors the client's stream flag", () => {
    const body = buildRequestBody(
      { ...baseBody, tools: [{ name: "client-tool" }], tool_choice: "auto" },
      "glm-5.3-flash", "s", "u",
    );
    // The stock catalog stays untouched — the client's schema never becomes a
    // real Anthropic tool, because upstream validates the catalog.
    expect(JSON.stringify(body.tools)).not.toContain("client-tool");
    expect(body.tools).toHaveLength(ZCODE_REQUEST_TEMPLATE.tools.length);
    expect(body.tool_choice).toEqual({ type: "auto" });
    // …it rides along as a text contract instead.
    const transcript = JSON.stringify(body.messages);
    expect(transcript).toContain("[AVAILABLE TOOLS]");
    expect(transcript).toContain("client-tool");
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

  it("exposes zcode thinking capabilities: always-on low/high/max, with client tools", () => {
    for (const model of ["glm-5.3", "glm-5.3-flash"]) {
      const caps = getCapabilitiesForModel("zcode", model);
      expect(caps.thinkingFormat).toBe("zcode");
      expect(caps.thinkingCanDisable).toBe(false);
      expect(caps.tools).toBe(true);
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

describe("zcode client-tool bridge", () => {
  const clientTools = [
    {
      name: "read_file",
      description: "Read a file from disk",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" }, limit: { type: "number" } },
        required: ["path"],
      },
    },
  ];

  // A minimal Anthropic SSE turn carrying one text block.
  function upstreamSse(text) {
    return [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_up","model":"GLM-5.3-Flash","content":[],"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`,
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");
  }

  it("serializes the client's schemas into the text contract", () => {
    const contract = buildToolContract(clientTools);
    expect(contract).toContain("[AVAILABLE TOOLS]");
    expect(contract).toContain("[END AVAILABLE TOOLS]");
    expect(contract).toContain('"name": "read_file"');
    expect(contract).toContain('"path"');
    expect(contract).toContain('{"tool_calls":[{"name":"tool_name","input":{}}]}');
    expect(contract).toContain('{"final":"your final answer"}');
    expect(buildToolContract([])).toBe("");
  });

  it("leaves a tool-less request untouched", () => {
    const messages = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    expect(mapMessages({ messages })).toEqual(messages);
  });

  it("keeps the stock template intact while the contract rides in the transcript", () => {
    const body = buildRequestBody(
      { messages: [{ role: "user", content: [{ type: "text", text: "list files" }] }], tools: clientTools },
      "glm-5.3-flash", "s", "u",
    );
    expect(body.system).toHaveLength(3);
    expect(body.tools).toHaveLength(ZCODE_REQUEST_TEMPLATE.tools.length);
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(JSON.stringify(body.tools)).not.toContain("read_file");
    const transcript = JSON.stringify(body.messages);
    expect(transcript).toContain("[AVAILABLE TOOLS]");
    expect(transcript).toContain("read_file");
    expect(transcript).toContain("Return exactly one JSON object now.");
  });

  it("replays earlier tool_use / tool_result turns as marked text", () => {
    const turns = flattenToolBlocks([
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.txt" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "hello" }] },
    ]);
    const flat = JSON.stringify(turns);
    expect(flat).toContain("[PREVIOUS TOOL USE]");
    expect(flat).toContain("read_file");
    expect(flat).toContain("[TOOL RESULT] id=toolu_1");
    expect(flat).toContain("hello");
    // no tool_use / tool_result block survives — the stock catalog cannot resolve them
    expect(flat).not.toContain('"type":"tool_use"');
    expect(flat).not.toContain('"type":"tool_result"');
  });

  it("drops client thinking blocks (their signatures are foreign to zcode)", () => {
    const turns = flattenToolBlocks([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden-reasoning", signature: "sig-abc" },
          { type: "redacted_thinking", data: "redacted-payload" },
          { type: "text", text: "visible" },
        ],
      },
    ]);
    expect(turns).toHaveLength(1);
    const flat = JSON.stringify(turns);
    expect(flat).not.toContain("sig-abc");
    expect(flat).not.toContain("hidden-reasoning");
    expect(flat).not.toContain("redacted-payload");
    expect(flat).toContain("visible");
  });

  it("accepts every answer shape the model may produce", () => {
    expect(parseToolBridge('{"tool_calls":[{"name":"read_file","input":{"path":"a"}}]}').calls)
      .toEqual([{ name: "read_file", input: { path: "a" } }]);
    expect(parseToolBridge('```json\n{"toolCalls":[{"name":"read_file","arguments":{"path":"a"}}]}\n```').calls)
      .toEqual([{ name: "read_file", input: { path: "a" } }]);
    expect(parseToolBridge('Sure! {"tool_calls":[{"name":"read_file","input":{"path":"a"}}]} done').calls)
      .toEqual([{ name: "read_file", input: { path: "a" } }]);
    expect(parseToolBridge('{"final":"all done"}').finalText).toBe("all done");
    expect(parseToolBridge('{"final":"all done"}').calls).toEqual([]);
    expect(parseToolBridge('{"name":"read_file","input":{"path":"a"}}').calls)
      .toEqual([{ name: "read_file", input: { path: "a" } }]);
    // malformed output degrades to text instead of throwing
    const broken = parseToolBridge("not json at all");
    expect(broken.calls).toEqual([]);
    expect(broken.finalText).toBe("not json at all");
  });

  it("keeps only calls that name one of the client's tools", () => {
    const calls = [
      { name: "read_file", input: {} },
      { name: "Bash", input: { command: "ls" } },
      { name: "unknown", input: {} },
    ];
    expect(normalizeToolCalls(calls, clientTools)).toEqual([{ name: "read_file", input: {} }]);
    expect(normalizeToolCalls(calls, [])).toEqual([]);
  });

  it("turns a bridge answer into real tool_use blocks", () => {
    const message = rewriteAnthropicMessage(
      {
        id: "msg_up",
        stop_reason: "end_turn",
        content: [{ type: "text", text: '{"tool_calls":[{"name":"read_file","input":{"path":"a.txt"}}]}' }],
      },
      clientTools,
    );
    expect(message.stop_reason).toBe("tool_use");
    const use = message.content.find((block) => block.type === "tool_use");
    expect(use.name).toBe("read_file");
    expect(use.input).toEqual({ path: "a.txt" });
    expect(use.id.startsWith("toolu_")).toBe(true);
    expect(use.id).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it("turns a final answer into plain text", () => {
    const message = rewriteAnthropicMessage(
      { id: "msg_up", stop_reason: "end_turn", content: [{ type: "text", text: '{"final":"the answer"}' }] },
      clientTools,
    );
    expect(message.stop_reason).toBe("end_turn");
    expect(message.content).toEqual([{ type: "text", text: "the answer" }]);
  });

  it("never leaks the stock catalog's own tool_use blocks", () => {
    const message = rewriteAnthropicMessage(
      {
        id: "msg_up",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "toolu_stock", name: "Bash", input: { command: "rm -rf /" } }],
      },
      clientTools,
    );
    expect(JSON.stringify(message.content)).not.toContain("Bash");
    expect(message.content.filter((block) => block.type === "tool_use")).toHaveLength(0);
  });

  it("forwards a native tool_use that names one of the client's tools untouched", () => {
    const native = { type: "tool_use", id: "toolu_native", name: "read_file", input: { path: "b.txt" } };
    const message = rewriteAnthropicMessage(
      { id: "msg_up", stop_reason: "tool_use", content: [native] },
      clientTools,
    );
    expect(message.stop_reason).toBe("tool_use");
    expect(message.content).toEqual([native]);
  });

  it("re-emits a buffered SSE stream with a real tool_use block", () => {
    const out = rewriteAnthropicStream(
      upstreamSse('{"tool_calls":[{"name":"read_file","input":{"path":"c.txt"}}]}'),
      clientTools,
    );
    expect(out).toContain('"type":"content_block_start"');
    expect(out).toContain('"type":"tool_use"');
    expect(out).toContain('"name":"read_file"');
    expect(out).toContain('"type":"input_json_delta"');
    expect(out).toContain('"partial_json":"{\\"path\\":\\"c.txt\\"}"');
    expect(out).toContain('"stop_reason":"tool_use"');
    expect(out).toContain('"type":"message_stop"');
  });

  it("bridges a full upstream turn through execute()", async () => {
    process.env.ZCODE_START_PLAN_TOKEN = "start-plan-token";
    proxyAwareFetch.mockReset();
    proxyAwareFetch.mockResolvedValue(new Response(
      upstreamSse('{"tool_calls":[{"name":"read_file","input":{"path":"c.txt"}}]}'),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));

    const executor = new ZCodeExecutor();
    const result = await executor.execute({
      model: "glm-5.3-flash",
      body: {
        messages: [{ role: "user", content: [{ type: "text", text: "read c.txt" }] }],
        tools: clientTools,
      },
      stream: true,
      credentials: {},
      log: { debug() {}, warn() {}, error() {} },
    });

    // The request kept the stock catalog and carried the contract in the transcript.
    const sent = JSON.parse(proxyAwareFetch.mock.calls[0][1].body);
    expect(sent.tools).toHaveLength(ZCODE_REQUEST_TEMPLATE.tools.length);
    expect(JSON.stringify(sent.tools)).not.toContain("read_file");
    expect(JSON.stringify(sent.messages)).toContain("[AVAILABLE TOOLS]");

    // The answer came back to the client as a real Anthropic tool_use.
    const text = await result.response.text();
    expect(text).toContain('"type":"tool_use"');
    expect(text).toContain('"name":"read_file"');
    expect(text).toContain('"stop_reason":"tool_use"');
  });
});

describe("zcode business-error envelope", () => {
  // The gateway answers a quota failure with HTTP 200 and a bare JSON
  // envelope — inside an SSE response it arrives unframed, ahead of the
  // `data: [DONE]` marker.
  const quotaEnvelope = JSON.stringify({
    code: 1005,
    msg: "exceed quota limit",
    id: "msg_bc393fa3ff5e405a9f63c7d265aafc4f",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "" }],
    stop_reason: "end_turn",
  });

  const silentLog = { debug() {}, warn() {}, error() {} };

  it("classifies the free-tier quota code as a terminal billing error", () => {
    const classified = classifyZcodeError(200, quotaEnvelope);
    expect(classified.status).toBe(402);
    expect(classified.message).toContain("exceed quota limit");
  });

  it("reads the envelope out of a bare JSON body and out of an unframed SSE body", () => {
    expect(parseZcodeEnvelope(quotaEnvelope).code).toBe(1005);
    expect(parseZcodeEnvelope(`${quotaEnvelope}data: [DONE]`).code).toBe(1005);
    expect(zcodeBusinessCode(parseZcodeEnvelope(quotaEnvelope))).toBe(1005);
    // A normal Anthropic answer carries no business code.
    expect(zcodeBusinessCode(parseZcodeEnvelope('{"id":"msg_1","content":[]}'))).toBeNull();
    expect(zcodeBusinessCode(parseZcodeEnvelope('{"code":0,"msg":"ok"}'))).toBeNull();
  });

  it("fails the turn when a quota envelope rides on HTTP 200 (no client tools)", async () => {
    process.env.ZCODE_START_PLAN_TOKEN = "start-plan-token";
    proxyAwareFetch.mockReset();
    proxyAwareFetch.mockResolvedValue(new Response(quotaEnvelope, {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const executor = new ZCodeExecutor();
    await expect(executor.execute({
      model: "glm-5.3-flash",
      body: { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
      stream: false,
      credentials: {},
      log: silentLog,
    })).rejects.toThrow(/exceed quota limit/);
  });

  it("fails the turn when the quota envelope arrives inside the tool-bridge stream", async () => {
    process.env.ZCODE_START_PLAN_TOKEN = "start-plan-token";
    proxyAwareFetch.mockReset();
    proxyAwareFetch.mockResolvedValue(new Response(`${quotaEnvelope}data: [DONE]`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));

    const executor = new ZCodeExecutor();
    await expect(executor.execute({
      model: "glm-5.3-flash",
      body: {
        messages: [{ role: "user", content: [{ type: "text", text: "read c.txt" }] }],
        tools: [{ name: "read_file", description: "Read a file", input_schema: { type: "object", properties: {} } }],
      },
      stream: true,
      credentials: {},
      log: silentLog,
    })).rejects.toThrow(/exceed quota limit/);
  });

  it("still forwards a healthy stream untouched", async () => {
    process.env.ZCODE_START_PLAN_TOKEN = "start-plan-token";
    proxyAwareFetch.mockReset();
    proxyAwareFetch.mockResolvedValue(new Response(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_ok"}}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));

    const executor = new ZCodeExecutor();
    const result = await executor.execute({
      model: "glm-5.3-flash",
      body: { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
      stream: true,
      credentials: {},
      log: silentLog,
    });

    const text = await result.response.text();
    expect(text).toContain('"type":"message_start"');
    expect(text).toContain("[DONE]");
  });
});
