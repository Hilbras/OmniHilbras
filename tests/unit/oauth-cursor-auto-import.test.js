import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fsPromises from "fs/promises";
import * as childProcess from "child_process";

// Mock next/server
vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    })),
  },
}));

// Mock os
vi.mock("os", () => ({
  default: { homedir: vi.fn(() => "/mock/home") },
  homedir: vi.fn(() => "/mock/home"),
}));

// Mock fs/promises
vi.mock("fs/promises", () => ({
  access: vi.fn(),
  constants: { R_OK: 4 },
}));

// The sqlite3 CLI is the route's fallback strategy. Mock it so the tests
// never shell out to a real binary.
//
// On Node >= 24 the better-sqlite3 strategy is skipped on purpose (the native
// addon SIGSEGVs on load there), so the CLI is the path that actually runs.
const mockCliValues = new Map();
vi.mock("child_process", () => ({
  execFile: vi.fn((cmd, args, opts, cb) => {
    if (typeof opts === "function") {
      cb = opts;
      opts = {};
    }
    const sql = String(args?.[1] || "");
    const match = sql.match(/key='([^']+)'/);
    const value = match ? mockCliValues.get(match[1]) : null;
    cb?.(null, { stdout: value ?? "", stderr: "" });
    return { on: vi.fn() };
  }),
}));

// Shared mock db instance
const mockDbInstance = {
  prepare: vi.fn(),
  close: vi.fn(),
  __throwOnConstruct: false,
};

// Mock better-sqlite3 as a class so `new Database(...)` works
vi.mock("better-sqlite3", () => ({
  default: class MockDatabase {
    constructor() {
      if (mockDbInstance.__throwOnConstruct) {
        throw new Error("SQLITE_CANTOPEN");
      }
      return mockDbInstance;
    }
  },
}));

/**
 * The route reads one key at a time:
 *   db.prepare("SELECT value FROM itemTable WHERE key=? LIMIT 1").get(key)
 * so the mock has to answer per key, not with a row set.
 *
 * The CLI strategy asks the same question in SQL
 *   SELECT value FROM itemTable WHERE key='<key>' LIMIT 1
 * so both strategies are fed from the same rows.
 */
function mockItemTable(rows) {
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  mockDbInstance.prepare.mockImplementation(() => ({
    get: (key) => (byKey.has(key) ? { value: byKey.get(key) } : undefined),
  }));
  mockCliValues.clear();
  for (const [key, value] of byKey) mockCliValues.set(key, value);
}

// We need to dynamically import after mocks are registered
let GET;

describe("GET /api/oauth/cursor/auto-import", () => {
  const originalPlatform = process.platform;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockDbInstance.__throwOnConstruct = false;
    mockDbInstance.prepare.mockReset();
    mockDbInstance.close.mockReset();
    mockCliValues.clear();
    // Force darwin so macOS-specific logic is exercised
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    // Re-import to pick up fresh mocks each run
    const mod = await import("../../src/app/api/oauth/cursor/auto-import/route.js");
    GET = mod.GET;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  // ── macOS path probing ────────────────────────────────────────────────

  it("returns not-found and lists the checked locations", async () => {
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("Cursor database not found");
    // The message names every path it tried — that is the point of it.
    expect(response.body.error).toContain("state.vscdb");
    expect(response.body.error).toContain("Cursor - Insiders");
  });

  it("falls back to a manual paste when the db exists but cannot be opened", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockDbInstance.__throwOnConstruct = true;

    const response = await GET();

    // better-sqlite3 failed (native bindings / locked db) and the sqlite3 CLI
    // has nothing either, so the user is asked to paste the token instead.
    expect(response.body.found).toBe(false);
    expect(response.body.windowsManual).toBe(true);
    expect(response.body.dbPath).toBeTruthy();
  });

  // ── Token extraction ──────────────────────────────────────────────────

  it("extracts tokens using exact keys", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockItemTable([
      { key: "cursorAuth/accessToken", value: "test-token" },
      { key: "storage.serviceMachineId", value: "test-machine-id" },
    ]);

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("test-token");
    expect(response.body.machineId).toBe("test-machine-id");
    // The db is closed by the better-sqlite3 strategy — which is skipped on
    // Node >= 24 (the native addon SIGSEGVs there).
    const [nodeMajor] = process.versions.node.split(".").map(Number);
    if (nodeMajor < 24) {
      expect(mockDbInstance.close).toHaveBeenCalled();
    }
  });

  it("unwraps JSON-encoded string values", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockItemTable([
      { key: "cursorAuth/accessToken", value: '"json-token"' },
      { key: "storage.serviceMachineId", value: '"json-machine-id"' },
    ]);

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("json-token");
    expect(response.body.machineId).toBe("json-machine-id");
  });

  it("falls back to the alternate key names when the primary ones are missing", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockItemTable([
      { key: "cursorAuth/token", value: "fallback-token" },
      { key: "storage.machineId", value: "fallback-machine" },
    ]);

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("fallback-token");
    expect(response.body.machineId).toBe("fallback-machine");
  });

  it("returns the manual-paste path when no tokens are found", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockItemTable([]);

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.windowsManual).toBe(true);
  });

  // ── Platform handling ─────────────────────────────────────────────────

  it("linux probes the linux config paths", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(fsPromises.access).toHaveBeenCalled();
    // The probed path is the Linux one, not a macOS one.
    const probed = vi.mocked(fsPromises.access).mock.calls.map((c) => String(c[0]));
    expect(probed.some((p) => p.includes(".config/Cursor"))).toBe(true);
  });

  it("skips auto-import on linux when Cursor IDE is not installed", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    // The db exists, but neither `which cursor` nor the desktop entry does.
    vi.mocked(fsPromises.access).mockImplementation(async (target) => {
      if (String(target).includes("state.vscdb")) return;
      throw new Error("ENOENT");
    });
    vi.mocked(childProcess.execFile).mockImplementationOnce((cmd, args, opts, cb) => {
      if (typeof opts === "function") {
        cb = opts;
        opts = {};
      }
      cb?.(new Error("not found"));
      return { on: vi.fn() };
    });
    mockItemTable([
      { key: "cursorAuth/accessToken", value: "test-token" },
      { key: "storage.serviceMachineId", value: "test-machine-id" },
    ]);

    const response = await GET();

    // Leftover config without the IDE is not a real installation.
    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("does not appear to be installed");
  });

  it("falls back to the generic config paths on an unsupported platform", async () => {
    Object.defineProperty(process, "platform", { value: "freebsd", writable: true });
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    // Unknown platforms are probed with the generic paths instead of 400 —
    // a wrong guess costs a couple of stat() calls, a 400 costs the feature.
    expect(response.status).toBe(200);
    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("Cursor database not found");
  });
});
