import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let testApi;
try {
  testApi = await import("vitest");
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  testApi = await import("node:test");
}
const { afterEach, describe, it } = testApi;

const require = createRequire(import.meta.url);
const {
  assertRequiredApiArtifacts,
  copyStandaloneBuild,
  mergeServerArtifacts,
  purgeDataDirs,
} = require("../../cli/scripts/build-cli.js");

const tempDirs = [];

function createTempDir() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omnihilbras-cli-build-"));
  tempDirs.push(tempDir);
  return tempDir;
}

function writeFixture(root, relativePath, contents = relativePath) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  return filePath;
}

function createCompleteServer(buildDistDir) {
  const serverDir = path.join(buildDistDir, "server");
  writeFixture(serverDir, "app/api/v1/chat/completions/route.js", "chat route");
  writeFixture(serverDir, "app/api/v1/messages/route.js", "messages route");
  writeFixture(serverDir, "chunks/openai-provider.js", "openai chunk");
  writeFixture(serverDir, "chunks/anthropic-provider.js", "anthropic chunk");
  return serverDir;
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("CLI build server artifacts", () => {
  for (const { name, standalonePath } of [
    {
      name: "legacy nested app",
      standalonePath: (appDir, buildDistDir) => path.join(appDir, ".next", "standalone", "app"),
    },
    {
      name: "Next 16 workspace",
      standalonePath: (appDir, buildDistDir) => path.join(buildDistDir, "standalone", path.basename(appDir)),
    },
  ]) {
    it(`merges complete API routes and provider chunks for the ${name} layout`, () => {
      const root = createTempDir();
      const appDir = path.join(root, "omnihilbras");
      const buildDistDir = path.join(appDir, ".next-cli-build");
      const cliAppDir = path.join(root, "cli-app");
      const standaloneDir = standalonePath(appDir, buildDistDir);

      writeFixture(standaloneDir, "server.js", "standalone server");
      writeFixture(
        standaloneDir,
        ".next-cli-build/server/app/api/v1/chat/completions/route.js",
        "standalone chat route",
      );
      createCompleteServer(buildDistDir);

      copyStandaloneBuild(appDir, buildDistDir, cliAppDir);
      mergeServerArtifacts(buildDistDir, cliAppDir);
      assertRequiredApiArtifacts(cliAppDir);

      const packagedServer = path.join(cliAppDir, ".next-cli-build", "server");
      assert.equal(
        fs.readFileSync(path.join(packagedServer, "app/api/v1/messages/route.js"), "utf8"),
        "messages route",
      );
      assert.equal(
        fs.readFileSync(path.join(packagedServer, "chunks/openai-provider.js"), "utf8"),
        "openai chunk",
      );
      assert.equal(
        fs.readFileSync(path.join(packagedServer, "chunks/anthropic-provider.js"), "utf8"),
        "anthropic chunk",
      );
    });
  }

  it("merges idempotently without removing standalone-generated files", () => {
    const root = createTempDir();
    const buildDistDir = path.join(root, ".next-cli-build");
    const cliAppDir = path.join(root, "cli-app");
    const packagedServer = path.join(cliAppDir, ".next-cli-build", "server");

    createCompleteServer(buildDistDir);
    writeFixture(packagedServer, "standalone-only.js", "keep me");

    mergeServerArtifacts(buildDistDir, cliAppDir);
    mergeServerArtifacts(buildDistDir, cliAppDir);

    assert.equal(
      fs.readFileSync(path.join(packagedServer, "standalone-only.js"), "utf8"),
      "keep me",
    );
    assert.equal(
      fs.readFileSync(path.join(packagedServer, "app/api/v1/messages/route.js"), "utf8"),
      "messages route",
    );
  });

  it("reports the missing required API route artifact path", () => {
    const root = createTempDir();
    const buildDistDir = path.join(root, ".next-cli-build");
    const cliAppDir = path.join(root, "cli-app");

    writeFixture(
      path.join(buildDistDir, "server"),
      "app/api/v1/chat/completions/route.js",
      "chat route",
    );
    mergeServerArtifacts(buildDistDir, cliAppDir);

    assert.throws(
      () => assertRequiredApiArtifacts(cliAppDir),
      (error) => error.message.includes(path.join(
        cliAppDir,
        ".next-cli-build/server/app/api/v1/messages/route.js",
      )),
    );
  });
});

describe("the packaged tree carries no data directory", () => {
  it("skips the data directory while copying the standalone build", () => {
    const root = createTempDir();
    const appDir = path.join(root, "omnihilbras");
    const buildDistDir = path.join(appDir, ".next-cli-build");
    const cliAppDir = path.join(root, "cli-app");
    const standaloneDir = path.join(buildDistDir, "standalone", path.basename(appDir));

    writeFixture(standaloneDir, "server.js", "standalone server");
    // The tracer followed the data directory into the standalone: the
    // database holds every provider credential in plaintext.
    writeFixture(standaloneDir, "cli/.build-home/.omnihilbras/db/data.sqlite", "credentials");
    writeFixture(standaloneDir, "cli/.build-home/.omnihilbras/jwt-secret", "secret");
    writeFixture(standaloneDir, "cli/.build-home/.omnihilbras/machine-id", "machine");

    copyStandaloneBuild(appDir, buildDistDir, cliAppDir);

    const forbidden = [
      path.join(cliAppDir, "cli/.build-home/.omnihilbras/db/data.sqlite"),
      path.join(cliAppDir, "cli/.build-home/.omnihilbras/jwt-secret"),
      path.join(cliAppDir, "cli/.build-home/.omnihilbras/machine-id"),
    ];
    for (const file of forbidden) {
      assert.equal(fs.existsSync(file), false, `${file} must not be packaged`);
    }
    assert.equal(fs.existsSync(path.join(cliAppDir, "server.js")), true);
  });

  it("purges a data directory that another step copied in", () => {
    const root = createTempDir();
    const cliAppDir = path.join(root, "cli-app");

    writeFixture(cliAppDir, "cli/.build-home/.omnihilbras/db/data.sqlite", "credentials");
    writeFixture(cliAppDir, "cli/.build-home/.omnihilbras/jwt-secret", "secret");
    writeFixture(cliAppDir, "app/server.js", "server");

    const removed = purgeDataDirs(cliAppDir);

    assert.equal(removed.length, 1);
    assert.equal(fs.existsSync(path.join(cliAppDir, "cli/.build-home")), false);
    assert.equal(fs.existsSync(path.join(cliAppDir, "app/server.js")), true);
  });

  it("fails the release when the file list carries a secret", async () => {
    const { checkPackageContents, findForbiddenFiles } = await import(
      "../../cli/scripts/check-package-contents.mjs"
    );

    const clean = ["cli.js", "app/server.js", "app/public/logo.svg"];
    assert.deepEqual(findForbiddenFiles(clean), []);
    assert.equal(checkPackageContents(clean, 1000).ok, true);

    const leaky = [
      ...clean,
      "app/cli/.build-home/.omnihilbras/db/data.sqlite",
      "app/cli/.build-home/.omnihilbras/jwt-secret",
    ];
    const result = checkPackageContents(leaky, 1000);
    assert.equal(result.ok, false);
    assert.equal(result.forbidden.length, 2);
  });

  it("fails the release when the package is over the size budget", async () => {
    const { checkPackageContents } = await import("../../cli/scripts/check-package-contents.mjs");
    const files = ["cli.js"];
    assert.equal(checkPackageContents(files, 1000, 2000).ok, true);
    assert.equal(checkPackageContents(files, 3000, 2000).tooBig, true);
    assert.equal(checkPackageContents(files, 3000, 2000).ok, false);
  });
});
