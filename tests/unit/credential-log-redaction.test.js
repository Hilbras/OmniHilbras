import { describe, expect, it, vi } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";

import { maskSensitiveHeaders } from "../../open-sse/utils/requestLogger.js";

const require = createRequire(import.meta.url);

// A credential written to disk in plaintext is a credential stolen by anyone
// who can read the log directory — so these values must never reach a file.
const HEADERS = {
  authorization: "Bearer sk-supersecretvalue",
  "x-api-key": "sk-abc123",
  cookie: "a=b",
  "content-type": "application/json",
};

// The secrets themselves — the credential part, not the surrounding scheme.
const SECRETS = ["sk-supersecretvalue", "sk-abc123", "a=b"];

// Every fragment of a secret that is long enough to narrow a brute-force space.
function secretFragments(secret, minLength = 4) {
  const fragments = [];
  for (let i = 0; i < secret.length; i++) {
    for (let j = i + minLength; j <= secret.length; j++) {
      fragments.push(secret.slice(i, j));
    }
  }
  return fragments;
}

function expectNoSecretLeak(serialized) {
  for (const secret of SECRETS) {
    expect(serialized).not.toContain(secret);
    for (const fragment of secretFragments(secret)) {
      expect(serialized).not.toContain(fragment);
    }
  }
}

// The MITM logger resolves its dump dir from DATA_DIR at load time, so it has
// to be re-required against a throwaway data dir.
function loadMitmLogger(dataDir) {
  const loggerPath = require.resolve("../../src/mitm/logger.js");
  const pathsPath = require.resolve("../../src/mitm/paths.js");
  delete require.cache[loggerPath];
  delete require.cache[pathsPath];

  const oldDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  try {
    return require("../../src/mitm/logger.js");
  } finally {
    if (oldDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = oldDataDir;
  }
}

describe("credential redaction in request logs", () => {
  it("masks credential headers and leaves the rest untouched", () => {
    const out = maskSensitiveHeaders(HEADERS);

    expect(out["content-type"]).toBe("application/json");
    expect(out.authorization).toBe("Bearer ***redacted***");
    expect(out["x-api-key"]).toBe("***redacted***");
    expect(out.cookie).toBe("***redacted***");
  });

  it("keeps no fragment of a secret in the masked output", () => {
    const out = maskSensitiveHeaders(HEADERS);
    const serialized = JSON.stringify(out);

    expectNoSecretLeak(serialized);
    expect(serialized).not.toContain("Bearer sk-supersecretvalue");
  });

  it("masks the header name variants that carry credentials", () => {
    const out = maskSensitiveHeaders({
      "Proxy-Authorization": "Bearer sk-proxytoken",
      "X-Api-Key": "sk-xyz789",
      "Set-Cookie": ["sessionid=abc", "csrftoken=def"],
      "X-Auth-Token": "tok-123",
      "X-Secret-Header": "shh",
      "X-Session-Id": "sess-1",
      "X-Password": "hunter2",
      "X-Credential": "cred-1",
      "X-Request-Id": "req-42",
      "content-length": "12",
    });

    for (const value of Object.values(out)) {
      expect(value).not.toContain("sk-proxytoken");
      expect(value).not.toContain("sk-xyz789");
      expect(value).not.toContain("sessionid");
      expect(value).not.toContain("csrftoken");
      expect(value).not.toContain("tok-123");
      expect(value).not.toContain("hunter2");
      expect(value).not.toContain("cred-1");
    }
    expect(out["Proxy-Authorization"]).toBe("Bearer ***redacted***");
    expect(out["X-Request-Id"]).toBe("req-42");
    expect(out["content-length"]).toBe("12");
    expect(Array.isArray(out["Set-Cookie"])).toBe(true);
    expect(out["Set-Cookie"]).toHaveLength(2);
  });
});

describe("MITM dump redaction and permissions", () => {
  it("redacts credentials in the dump and keeps it owner-only", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omnihilbras-mitm-dump-"));
    const { dumpRequest } = loadMitmLogger(dataDir);

    const file = dumpRequest(
      {
        method: "POST",
        url: "https://api2.cursor.sh/v1/chat",
        headers: { host: "api2.cursor.sh", ...HEADERS },
      },
      Buffer.from(JSON.stringify({ hello: "world" }))
    );

    expect(file).toBeTruthy();

    const content = fs.readFileSync(file, "utf8");
    expectNoSecretLeak(content);
    expect(content).not.toContain("Bearer sk-supersecretvalue");
    expect(content).toContain("Bearer ***redacted***");
    expect(content).toContain("application/json");

    // Owner-only: no group/other permission bits on the dump or its directory.
    expect(fs.statSync(file).mode & 0o077).toBe(0);
    expect(fs.statSync(path.dirname(file)).mode & 0o077).toBe(0);
  });

  it("masks headers through the exported helper", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omnihilbras-mitm-mask-"));
    const { maskSensitiveHeaders: mitmMask } = loadMitmLogger(dataDir);

    const out = mitmMask(HEADERS);

    expect(out["content-type"]).toBe("application/json");
    expect(out.authorization).toBe("Bearer ***redacted***");
    expectNoSecretLeak(JSON.stringify(out));
  });
});

// The request logger resolves its log dir from process.cwd() at first use.
const canChdir = typeof process.chdir === "function";

describe.skipIf(!canChdir)("request log directory permissions", () => {
  it("writes client headers redacted into an owner-only log dir", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omnihilbras-reqlog-"));
    const previousCwd = process.cwd();
    const previousEnabled = process.env.ENABLE_REQUEST_LOGS;

    try {
      process.env.ENABLE_REQUEST_LOGS = "true";
      vi.resetModules();
      const mod = await import("../../open-sse/utils/requestLogger.js");

      process.chdir(tmp);
      const logger = await mod.createRequestLogger("openai", "gemini-cli", "gemini-3.8-pro");
      logger.logClientRawRequest("/v1/chat/completions", { hello: "world" }, { ...HEADERS });

      expect(logger.sessionPath).toBeTruthy();

      const logDir = path.join(tmp, "logs");
      const clientDump = path.join(logger.sessionPath, "1_req_client.json");

      expect(fs.statSync(logDir).mode & 0o077).toBe(0);
      expect(fs.statSync(logger.sessionPath).mode & 0o077).toBe(0);
      expect(fs.statSync(clientDump).mode & 0o077).toBe(0);

      const content = fs.readFileSync(clientDump, "utf8");
      expectNoSecretLeak(content);
      expect(content).toContain("Bearer ***redacted***");
      expect(content).toContain("application/json");
    } finally {
      process.chdir(previousCwd);
      if (previousEnabled === undefined) delete process.env.ENABLE_REQUEST_LOGS;
      else process.env.ENABLE_REQUEST_LOGS = previousEnabled;
      vi.resetModules();
    }
  });

  it("tightens the MITM dump directory", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omnihilbras-mitm-mode-"));
    // A directory left over from an older build keeps its old mode.
    fs.mkdirSync(path.join(dataDir, "logs", "mitm"), { recursive: true, mode: 0o755 });
    fs.chmodSync(path.join(dataDir, "logs"), 0o755);
    fs.chmodSync(path.join(dataDir, "logs", "mitm"), 0o755);

    loadMitmLogger(dataDir);

    expect(fs.statSync(path.join(dataDir, "logs")).mode & 0o077).toBe(0);
    expect(fs.statSync(path.join(dataDir, "logs", "mitm")).mode & 0o077).toBe(0);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});
