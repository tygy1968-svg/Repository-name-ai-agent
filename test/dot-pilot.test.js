import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verifyPilot } from '../bridge/pilot/verify.js';

const request = JSON.parse(await readFile(new URL('../bridge/pilot/request.json', import.meta.url), 'utf8'));
const receipt = () => ({ schema_version: 1, request_id: request.request_id, challenge: request.challenge,
  meeting_date: '2026-12-03', meeting_time: '16:40', source_id: 'note-2', completed_at: new Date().toISOString() });

test('missing or stale dot response is not a connection; current answer retains source and does not attest actor', () => {
  assert.equal(verifyPilot(request, null).status, 'awaiting_dot_response');
  assert.equal(verifyPilot(request, { ...receipt(), request_id: 'previous-request' }).status, 'wrong_request');
  assert.equal(verifyPilot(request, { ...receipt(), challenge: 'wrong' }).status, 'wrong_request');
  const verified = verifyPilot(request, receipt());
  assert.equal(verified.ok, true); assert.equal(verified.actorVerified, false); assert.equal(verified.dotConnected, false);
});

test('old or unsourced answer, fabricated old time and extra instructions are rejected', () => {
  for (const fields of [{ meeting_date: '2026-12-02' }, { meeting_time: '15:00' }, { source_id: 'note-1' }, { completed_at: '2020-01-01T00:00:00Z' }, { completed_at: 'tomorrow' }, { execute: 'deploy' }]) assert.equal(verifyPilot(request, { ...receipt(), ...fields }).ok, false);
});
