#!/usr/bin/env node

// Postinstall: warm-up SQLite deps into ~/.omnihilbras/runtime so the first
// `omnihilbras` start doesn't need network. Failure here is non-fatal —
// cli.js will retry at runtime if anything is missing.
// `npx @hilbras/omnihilbras …` (npm_command=exec) is typically a one-shot `connect` — skip
// the runtime warm-up; cli.js self-heals it if the server is started later.
if (process.env.npm_command === "exec") process.exit(0);

const { ensureSqliteRuntime } = require("./sqliteRuntime");
const { ensureTrayRuntime } = require("./trayRuntime");

try {
  ensureSqliteRuntime({ silent: false });
  console.log("[omnihilbras] runtime SQLite deps ready");
} catch (e) {
  console.warn(`[omnihilbras] runtime warm-up skipped: ${e.message}`);
}

try {
  ensureTrayRuntime({ silent: false });
} catch (e) {
  console.warn(`[omnihilbras] tray runtime skipped: ${e.message}`);
}

// Apply the node-forge security patch (CVE-2026-85393) to the copy that ships
// with this package. The patch script is bundled at <pkg>/app/scripts/; the
// runtime-resolved node-forge is at <pkg>/app/node_modules/node-forge (the
// standalone server loads it from there). Both are resolved from __dirname
// (which is <pkg>/hooks/ at install time). Failure is non-fatal: the app
// still starts, only the MITM cert-generation path stays unpatched.
const forgePatchSrc = require("path").join(__dirname, "..", "app", "scripts", "apply-node-forge-patch.cjs");
if (require("fs").existsSync(forgePatchSrc)) {
  try {
    // Point the script at <pkg>/app/node_modules/node-forge — the copy the
    // standalone server actually loads. The script's own default
    // (../node_modules from app/scripts/) resolves to the same path, so this
    // env override is belt-and-braces for non-standard layouts.
    process.env.NODE_FORGE_ASN1_JS = require("path").join(
      __dirname, "..", "app", "node_modules", "node-forge", "lib", "asn1.js"
    );
    require(forgePatchSrc);
  } catch (e) {
    console.warn(`[omnihilbras] node-forge patch skipped: ${e.message}`);
  }
}

process.exit(0);
