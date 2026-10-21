import path from "node:path";
import fs from "node:fs";
import { DATA_DIR } from "@/lib/dataDir.js";
import { ensureSecureDir } from "@/lib/secureFs.js";

export const DB_DIR = path.join(DATA_DIR, "db");
export const DATA_FILE = path.join(DB_DIR, "data.sqlite");
export const BACKUPS_DIR = path.join(DB_DIR, "backups");
export const LEGACY_FILES = {
  main: path.join(DATA_DIR, "db.json"),
  usage: path.join(DATA_DIR, "usage.json"),
  disabled: path.join(DATA_DIR, "disabledModels.json"),
  details: path.join(DATA_DIR, "request-details.json"),
};
export function ensureDirs() {
  // 0700: the database holds every provider credential in plaintext, so the
  // directory around it must not be world-readable. The helper tolerates a
  // volume this process does not own.
  for (const dir of [DATA_DIR, DB_DIR, BACKUPS_DIR]) {
    ensureSecureDir(dir);
  }
}
