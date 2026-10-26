#!/usr/bin/env node
/**
 * Applies the GHSA-86w9-cpqp-85rv (CVE-2026-85393) patch to node-forge's
 * `asn1.validate`. The patch rejects constructed SEQUENCE nodes that carry
 * more children than a fixed-shape schema declares, closing the
 * "extra nested DigestAlgorithm elements" signature-forgery bypass.
 *
 * Idempotent: if the marker string is already present, the patch is skipped.
 *
 * The patch touches `node_modules`, which is gitignored. Re-run this script
 * after every `npm install` (wired to the `postinstall` hook in package.json).
 */

const fs = require("fs");
const path = require("path");

// Target resolution order:
//  1. NODE_FORGE_ASN1_JS env override (set by the CLI's postinstall to point
//     at the package's own node_modules, where node-forge is hoisted).
//  2. ../node_modules relative to this script — works both in the repo
//     (scripts/ → root node_modules) and in the installed CLI package
//     (app/scripts/ → <pkg>/node_modules) layout.
const ASN1_JS = process.env.NODE_FORGE_ASN1_JS ||
  path.join(__dirname, "..", "node_modules", "node-forge", "lib", "asn1.js");
const MARKER = "GHSA-86w9-cpqp-85rv";

const OLD = [
  "      // handle sub values",
  "      if(v.value && forge.util.isArray(v.value)) {",
  "        var j = 0;",
  "        for(var i = 0; rval && i < v.value.length; ++i) {",
].join("\n");

const NEW = [
  "      // handle sub values",
  "      if(v.value && forge.util.isArray(v.value)) {",
  "        // GHSA-86w9-cpqp-85rv (CVE-2026-85393): reject nodes carrying more",
  "        // children than the schema declares, but only when the value items",
  "        // all have their own sub-schemas (fixed-shape validators like the",
  "        // RSA DigestInfo DigestAlgorithm). Loose child-sequences (e.g.",
  "        // RSA private keys, where an optional primes array varies in",
  "        // length) keep their historical behaviour.",
  "        var allFixedItems = v.value.length > 0;",
  "        for(var k = 0; k < v.value.length && allFixedItems; ++k) {",
  "          allFixedItems = !!(v.value[k].value && forge.util.isArray(v.value[k].value));",
  "        }",
  "        if(allFixedItems && obj.value.length > v.value.length) {",
  "          rval = false;",
  "          if(errors) {",
  "            errors.push('[' + v.name + '] Too many elements. Expected at most ' +",
  "              v.value.length + ', got ' + obj.value.length);",
  "          }",
  "        }",
  "        var j = 0;",
  "        for(var i = 0; rval && i < v.value.length; ++i) {",
].join("\n");

function main() {
  // In the installed CLI package, node-forge may live at <pkg>/node_modules
  // (top-level, installed by npm) rather than <pkg>/app/node_modules. The
  // default path above resolves relative to this script's own location,
  // which is <pkg>/app/scripts/ — so also try one level up as a fallback.
  const fallbackPaths = [
    ASN1_JS,
    path.join(__dirname, "..", "..", "node_modules", "node-forge", "lib", "asn1.js"),
    path.join(process.cwd(), "node_modules", "node-forge", "lib", "asn1.js"),
  ];
  const target = fallbackPaths.find((p) => fs.existsSync(p));
  if (!target) {
    console.warn("[node-forge patch] node-forge not found in any known location; skipping.");
    return;
  }
  let src = fs.readFileSync(target, "utf8");
  if (src.includes(MARKER)) {
    console.log("[node-forge patch] already patched.");
    return;
  }
  if (!src.includes(OLD)) {
    throw new Error(
      "[node-forge patch] expected anchor not found — node-forge version may have changed. " +
      "Re-derive the anchor from lib/asn1.js validate() and update this script."
    );
  }
  src = src.replace(OLD, NEW);
  fs.writeFileSync(target, src, "utf8");
  console.log("[node-forge patch] applied GHSA-86w9-cpqp-85rv fix to lib/asn1.js (" + target + ").");
}

main();
