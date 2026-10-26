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

const ASN1_JS = path.join(__dirname, "..", "node_modules", "node-forge", "lib", "asn1.js");
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
  if (!fs.existsSync(ASN1_JS)) {
    console.warn("[node-forge patch] node-forge not installed; skipping.");
    return;
  }
  let src = fs.readFileSync(ASN1_JS, "utf8");
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
  fs.writeFileSync(ASN1_JS, src, "utf8");
  console.log("[node-forge patch] applied GHSA-86w9-cpqp-85rv fix to lib/asn1.js.");
}

main();
