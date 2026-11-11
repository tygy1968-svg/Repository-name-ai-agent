import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Verify returned DATA only. A matching JSON file cannot attest who wrote it,
// install a connection, prove tool access, or measure phone latency.
export function verifyPilot(request, response) {
  if (!response) return { ok: false, status: 'awaiting_dot_response' };
  if (!response || typeof response !== 'object' || Array.isArray(response)) return { ok: false, status: 'invalid_response' };
  const fields = ['schema_version', 'request_id', 'challenge', 'meeting_date', 'meeting_time', 'source_id', 'completed_at'];
  if (fields.some(k => !(k in response)) || Object.keys(response).some(k => !fields.includes(k)) || response.schema_version !== 1) return { ok: false, status: 'invalid_response' };
  if (response.request_id !== request.request_id || response.challenge !== request.challenge) return { ok: false, status: 'wrong_request' };
  const notes = [...request.notes].sort((a, b) => Date.parse(b.recorded_at) - Date.parse(a.recorded_at));
  const latest = notes[0];
  if (!latest || response.meeting_date !== latest.meeting_date || response.meeting_time !== latest.meeting_time || response.source_id !== latest.id) return { ok: false, status: 'source_or_answer_mismatch' };
  if (typeof response.completed_at !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(response.completed_at) ||
      !Number.isFinite(Date.parse(response.completed_at)) || Date.parse(response.completed_at) < Date.parse(request.created_at)) return { ok: false, status: 'invalid_completion_time' };
  return { ok: true, status: 'response_data_validated', requestId: request.request_id,
    actorVerified: false, dotConnected: false,
    meaning: 'Response matches the synthetic task. Confirm the dot activity/commit separately; this is not a live bridge or phone benchmark.' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const request = JSON.parse(await readFile(new URL('./request.json', import.meta.url), 'utf8'));
  let response = null;
  try { response = JSON.parse(await readFile(new URL('./response.json', import.meta.url), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') { console.log(JSON.stringify({ ok: false, status: 'response_unreadable' })); process.exit(2); }
  }
  const result = verifyPilot(request, response);
  console.log(JSON.stringify(result)); process.exitCode = result.ok ? 0 : 2;
}
