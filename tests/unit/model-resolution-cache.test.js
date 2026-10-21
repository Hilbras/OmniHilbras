import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The memoised model resolution.
 *
 * A model string resolves to a provider through three tables — the alias
 * table, the combo table and the provider-node table. The resolution runs on
 * every request, once per combo member and once per allow-list entry, so it is
 * cached. The cache is only allowed to exist if every write to those tables
 * drops it, which is what these tests check.
 */
describe("model resolution cache", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omnihilbras-modelcache-"));
    process.env.DATA_DIR = tempDir;
  });

  afterAll(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  beforeEach(async () => {
    const { clearModelResolutionCache } = await import("@/lib/modelResolutionCache.js");
    clearModelResolutionCache();
  });

  it("resolves the same answer twice", async () => {
    const { getModelInfo } = await import("@/sse/services/model.js");
    const first = await getModelInfo("openai/gpt-4o");
    const second = await getModelInfo("openai/gpt-4o");
    expect(second).toEqual(first);
    expect(first.provider).toBe("openai");
  });

  it("keeps the caller's copy independent of the cache", async () => {
    const { getModelInfo } = await import("@/sse/services/model.js");
    const first = await getModelInfo("openai/gpt-4o");
    first.provider = "tampered";
    const second = await getModelInfo("openai/gpt-4o");
    expect(second.provider).toBe("openai");
  });

  it("follows a repointed alias on the next resolution", async () => {
    const { getModelInfo } = await import("@/sse/services/model.js");
    const { setModelAlias } = await import("@/lib/db/repos/aliasRepo.js");

    await setModelAlias("my-alias", "openai/gpt-4o");
    const first = await getModelInfo("my-alias");
    expect(first.provider).toBe("openai");
    expect(first.model).toBe("gpt-4o");

    await setModelAlias("my-alias", "anthropic/claude-sonnet-4.5");
    const second = await getModelInfo("my-alias");
    expect(second.provider).toBe("anthropic");
    expect(second.model).toBe("claude-sonnet-4.5");
  });

  it("follows a new combo on the next resolution", async () => {
    const { getModelInfo, getComboModels } = await import("@/sse/services/model.js");
    const { createCombo } = await import("@/lib/db/repos/combosRepo.js");

    expect(await getComboModels("my-combo")).toBeNull();

    await createCombo({ name: "my-combo", models: ["openai/gpt-4o", "openai/gpt-4o-mini"] });
    const models = await getComboModels("my-combo");
    expect(models).toEqual(["openai/gpt-4o", "openai/gpt-4o-mini"]);

    // A combo name shadows a model of the same name.
    const info = await getModelInfo("my-combo");
    expect(info.provider).toBeNull();
  });

  it("follows a new provider node prefix", async () => {
    const { getModelInfo } = await import("@/sse/services/model.js");
    const { createProviderNode } = await import("@/lib/db/repos/nodesRepo.js");

    // Before the node exists the prefix is not a provider, so the string falls
    // back to its own prefix.
    const before = await getModelInfo("mynode/some-model");
    expect(before.provider).toBe("mynode");

    await createProviderNode({
      id: "mynode-id",
      type: "openai-compatible",
      name: "My Node",
      prefix: "mynode",
      baseUrl: "https://mynode.test/v1",
    });

    // The node owns the prefix now, so the string routes to the node's id.
    const after = await getModelInfo("mynode/some-model");
    expect(after.provider).toBe("mynode-id");
    expect(after.model).toBe("some-model");
  });
});
