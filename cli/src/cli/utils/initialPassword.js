const fs = require("fs");
const path = require("path");
const os = require("os");

/**
 * The initial dashboard password, if the gateway has not been given one yet.
 *
 * A fresh install gets a password that nobody else knows: the gateway
 * generates it on the first boot, stores the hash, and writes the plain text
 * next to its other secrets (0600). The CLI shows it, so the operator does not
 * have to go looking for the file.
 */
function readInitialPassword() {
  try {
    const dataDir = process.env.DATA_DIR || path.join(os.homedir(), ".omnihilbras");
    return fs.readFileSync(path.join(dataDir, "initial-password"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

module.exports = { readInitialPassword };
