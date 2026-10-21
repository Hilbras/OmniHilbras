import { defineConfig } from "vitest/config";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["**/*.test.js"],
    // Don't scan into git worktrees nested under .claude/ — they carry their
    // own copies of the test files but lack an installed node_modules (open-sse,
    // etc.), which makes provider imports fail during collection.
    // unit/embeddings.cloud.test.js imports `cloud/src/...` from the external
    // Cloudflare Worker companion repo, which is not part of this deployment
    // snapshot — the file stays in-tree but is not runnable here.
    exclude: [
      "**/node_modules/**",
      "**/.claude/**",
      "**/dist/**",
      "unit/embeddings.cloud.test.js",
    ],
    // Allow many it.concurrent cases (real provider smoke runs ~50 providers in parallel)
    maxConcurrency: 60,
    // Several tests open the SQLite layer and build the 5.5k-model catalogue,
    // which takes seconds on a loaded machine. Vitest's 5s default turned
    // those into random failures that looked like regressions. The budget is
    // generous on purpose: a test that hangs still fails, just later.
    testTimeout: 30000,
    hookTimeout: 30000,
    // Suppress noisy console output from handlers under test
    silent: false,
  },
  resolve: {
    // Use array form so subpath aliases (e.g. "@/lib/db/index.js") resolve correctly.
    alias: [
      { find: /^open-sse\//, replacement: resolve(__dirname, "../open-sse") + "/" },
      { find: "open-sse", replacement: resolve(__dirname, "../open-sse") },
      { find: /^@\//, replacement: resolve(__dirname, "../src") + "/" },
    ],
  },
});
