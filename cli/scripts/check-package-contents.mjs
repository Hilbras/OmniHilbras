#!/usr/bin/env node

/**
 * The guard on what the CLI package ships.
 *
 * The package is published to npm, so anything in it is public. The data
 * directory must never be in it: the database holds every provider credential
 * in plaintext, and the build home holds the machine id and the jwt secret of
 * the machine that built the package.
 *
 * This runs `npm pack --dry-run`, so it inspects exactly the file list npm
 * would upload — not the working tree.
 *
 *   node cli/scripts/check-package-contents.mjs [--max-bytes <n>]
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const cliDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The ceiling for the packed tarball. The package carries the whole app
// bundle, so this is a size budget, not a limit — but a budget is what stops
// the next "we just need one more dependency" from quietly adding 5 MB.
export const DEFAULT_MAX_BYTES = 18 * 1024 * 1024;

// A path that carries the data directory, a secret or a database.
export const FORBIDDEN_PATTERNS = [
  /(^|\/)\.omnihilbras(\/|$)/,
  /(^|\/)\.build-home(\/|$)/,
  /(^|\/)jwt-secret$/,
  /(^|\/)machine-id$/,
  /(^|\/)cli-secret$/,
  /\.sqlite(-wal|-shm)?$/,
];

// Files the package must carry.
//
// The sql.js fallback needs the wasm binary next to its loader. Without it
// the module cannot start, and every install has to fetch sql.js at runtime
// — the package is not self-contained.
export const REQUIRED_PATHS = ["app/node_modules/sql.js/dist/sql-wasm.wasm"];

/** The files of a package that must never be published. */
export function findForbiddenFiles(files) {
  return files.filter((file) => FORBIDDEN_PATTERNS.some((re) => re.test(file)));
}

/** The files the package must carry. */
export function findMissingFiles(files) {
  const present = new Set(files);
  return REQUIRED_PATHS.filter((file) => !present.has(file));
}

/**
 * Check a packed file list.
 * @returns {{ok: boolean, forbidden: string[], missing: string[], tooBig: boolean}}
 */
export function checkPackageContents(files, size, maxBytes = DEFAULT_MAX_BYTES) {
  const forbidden = findForbiddenFiles(files);
  const missing = findMissingFiles(files);
  return {
    ok: forbidden.length === 0 && missing.length === 0 && size <= maxBytes,
    forbidden,
    missing,
    tooBig: size > maxBytes,
  };
}

function run() {
  const args = process.argv.slice(2);
  const maxBytes = (() => {
    const i = args.indexOf("--max-bytes");
    if (i === -1 || !args[i + 1]) return DEFAULT_MAX_BYTES;
    const value = Number(args[i + 1]);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_BYTES;
  })();

  let packument;
  try {
    const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: cliDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    packument = JSON.parse(out)[0];
  } catch (error) {
    console.error("[package-check] npm pack --dry-run failed:", error.message);
    process.exit(1);
  }

  const files = (packument.files || []).map((f) => f.path);
  const result = checkPackageContents(files, packument.size, maxBytes);

  if (result.forbidden.length) {
    console.error("[package-check] The package would publish the data directory:");
    for (const file of result.forbidden) console.error(`  - ${file}`);
    console.error("[package-check] Fix cli/scripts/build-cli.js before publishing.");
    process.exit(1);
  }

  if (result.missing.length) {
    console.error("[package-check] The package is missing files it needs at runtime:");
    for (const file of result.missing) console.error(`  - ${file}`);
    console.error("[package-check] Fix cli/scripts/build-cli.js before publishing.");
    process.exit(1);
  }

  if (result.tooBig) {
    console.error(
      `[package-check] The package is ${(packument.size / 1024 / 1024).toFixed(1)} MB, over the ${(
        maxBytes / 1024 / 1024
      ).toFixed(1)} MB budget.`,
    );
    process.exit(1);
  }

  console.log(
    `[package-check] OK — ${files.length} files, ${(packument.size / 1024 / 1024).toFixed(1)} MB, no data directory.`,
  );
}

// Only run when invoked directly — the test imports the checks above.
const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) run();
