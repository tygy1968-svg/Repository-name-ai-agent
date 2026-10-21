// Local-only laboratory persistence. Never points to production Supabase or Render.
// Caller supplies a dedicated absolute file path in a test directory.
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { dirname, basename, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { exportDecisionSnapshot, importDecisionSnapshot } from "./decision-snapshot.js";

function validatePath(path) {
  if (typeof path !== "string" || !isAbsolute(path) || !basename(path).endsWith(".json")) {
    throw new TypeError("Provide an absolute .json snapshot path");
  }
  return resolve(path);
}

export async function loadDecisionLedger(path) {
  const target = validatePath(path);
  let raw;
  try {
    raw = await readFile(target, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return Object.freeze([]);
    throw error;
  }
  return importDecisionSnapshot(raw);
}

export async function saveDecisionLedger(path, history) {
  const target = validatePath(path);
  const raw = exportDecisionSnapshot(history);
  const temp = resolve(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, raw, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true });
  }
  return target;
}

// Single-writer API: concurrent writers require an external lock or transaction.
// This adapter is intended only for isolated local laboratory tests.
