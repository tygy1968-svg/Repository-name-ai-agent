import { mkdir, readFile, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import crypto from 'node:crypto';

// A real restartable SINGLE-PROCESS pilot store. Not a multi-process database.
// The production adapter and migration are a separate activation prerequisite.
export function createJsonStore(path) {
  let tail = Promise.resolve();
  return {
    transaction(fn) {
      const operation = tail.then(async () => {
        let state;
        try { state = JSON.parse(await readFile(path, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; state = { version: 1, tasks: [] }; }
        if (state.version !== 1 || !Array.isArray(state.tasks)) throw new Error('invalid_bridge_state');
        const result = await fn(state);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = `${path}.${crypto.randomUUID()}.tmp`;
        let handle;
        try {
          handle = await open(temporary, 'wx', 0o600);
          await handle.writeFile(JSON.stringify(state), 'utf8'); await handle.sync(); await handle.close(); handle = null;
          await rename(temporary, path);
        } finally { await handle?.close().catch(() => {}); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
        return result;
      });
      tail = operation.catch(() => {});
      return operation;
    }
  };
}
