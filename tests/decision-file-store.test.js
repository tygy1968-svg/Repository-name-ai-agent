import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { appendDecisionEvent } from "../lib/decision-ledger.js";
import { loadDecisionLedger, saveDecisionLedger } from "../lib/decision-file-store.js";

test("restores decision lineage in a separate Node process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kuzya-ledger-"));
  const path = join(dir, "isolated.json");
  try {
    let history = appendDecisionEvent([], { id: "start", type: "decision", summary: "Initial" });
    history = appendDecisionEvent(history, { id: "fix", type: "correction", summary: "Corrected", parentId: "start" });
    await saveDecisionLedger(path, history);
    const code = `import { loadDecisionLedger } from "./lib/decision-file-store.js";
const data = await loadDecisionLedger(process.argv[1]);
process.stdout.write(JSON.stringify(data.map(x => ({id:x.id,parentId:x.parentId,summary:x.summary}))));`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code, path], {
      cwd: process.cwd(), encoding: "utf8", timeout: 10000
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
      { id: "start", parentId: null, summary: "Initial" },
      { id: "fix", parentId: "start", summary: "Corrected" }
    ]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("missing isolated file is empty, corrupted file is rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kuzya-ledger-"));
  const path = join(dir, "isolated.json");
  try {
    assert.deepEqual(await loadDecisionLedger(path), []);
    await saveDecisionLedger(path, appendDecisionEvent([], { id: "a", type: "decision", summary: "Valid" }));
    const { writeFile } = await import("node:fs/promises");
    const original = await readFile(path, "utf8");
    await writeFile(path, original.replace("Valid", "Altered"));
    await assert.rejects(() => loadDecisionLedger(path), /checksum mismatch/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("rejects relative paths and does not touch other files", async () => {
  await assert.rejects(() => loadDecisionLedger("memory.json"), /absolute/);
  await assert.rejects(() => saveDecisionLedger("../memory.json", []), /absolute/);
});
