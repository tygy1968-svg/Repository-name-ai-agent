import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createResourceTokenVerifier, inspectOAuthMetadata } from '../bridge/oauth-access.js';

const issuer = 'https://auth.example/kuzya';
const resource = 'https://bridge.example/dot/mcp';
const time = 1794429000000;
async function fixture() {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const key = { ...await exportJWK(publicKey), kid: 'key-1', alg: 'ES256', use: 'sig' };
  const state = { now: time, grantReads: 0, keyReads: 0, grantError: false, keyError: false,
    grant: { active: true, issuer, resource, subject: 'verified-owner-sub', clientId: 'dot-client', tokenId: 'token-1',
      ownerId: 'owner', workerId: 'dot', scopes: ['kuzya.tasks', 'kuzya.memory.read'], expiresAt: time + 600000 } };
  const make = (changes = {}, header = {}) => new SignJWT({ iss: issuer, aud: resource, sub: 'verified-owner-sub',
    iat: time / 1000, exp: time / 1000 + 600, scope: 'kuzya.tasks kuzya.memory.read', client_id: 'dot-client', jti: 'token-1', ...changes })
    .setProtectedHeader({ alg: 'ES256', kid: 'key-1', typ: 'at+jwt', ...header }).sign(privateKey);
  const authenticate = createResourceTokenVerifier({ issuer, resource, now: () => state.now,
    loadJwks: async () => { state.keyReads++; if (state.keyError) throw Error('private infrastructure detail'); return { keys: [key] }; },
    resolveGrant: async binding => { state.grantReads++; state.binding = binding; if (state.grantError) throw Error('private grant detail'); return state.grant; } });
  return { state, make, authenticate, key, privateKey };
}

test('signed resource token resolves owner only from current server grant; revocation and scope changes apply on every use', async () => {
  const h = await fixture();
  const token = await h.make({ user_metadata: { ownerId: 'forged', admin: true }, email: 'untrusted@example.com' });
  assert.deepEqual(await h.authenticate(token), { ownerId: 'owner', workerId: 'dot', scopes: ['kuzya.tasks', 'kuzya.memory.read'] });
  assert.equal(h.state.binding.subject, 'verified-owner-sub');
  h.state.grant.scopes = ['kuzya.tasks'];
  assert.deepEqual((await h.authenticate(token)).scopes, ['kuzya.tasks']);
  h.state.grant.active = false;
  assert.equal(await h.authenticate(token), null);
  h.state.grant.active = true; h.state.grantError = true;
  assert.equal(await h.authenticate(token), null);
  assert.equal(h.state.grantReads, 4);
});

test('wrong issuer/resource, generic Supabase sessions, ID tokens, expiry, future issue time and overlong validity fail before reading private grant', async () => {
  const h = await fixture();
  for (const changes of [{ iss: issuer + '/' }, { aud: 'authenticated' }, { aud: 'dot-client' }, { aud: [resource, 'other'] },
    { exp: time / 1000 }, { nbf: time / 1000 + 1 }, { iat: time / 1000 + 1 }, { exp: time / 1000 + 3601 },
    { scope: 'openid email profile' }, { client_id: '' }, { jti: '' }, { sub: '' }]) {
    assert.equal(await h.authenticate(await h.make(changes)), null, JSON.stringify(changes));
  }
  assert.equal(await h.authenticate(await h.make({}, { typ: 'JWT' })), null);
  assert.equal(h.state.grantReads, 0);
});

test('algorithm confusion, tampering, token-supplied keys and URLs never choose a verification source', async () => {
  const h = await fixture();
  for (const header of [{ jku: 'https://attacker.example/jwks' }, { jwk: h.key }, { x5u: 'http://127.0.0.1/' }, { kid: '' }]) {
    assert.equal(await h.authenticate(await h.make({}, header)), null);
  }
  const token = await h.make();
  const [header, payload] = token.split('.');
  assert.equal(await h.authenticate(header + '.' + Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url')), sub: 'forged' })).toString('base64url') + '.' + token.split('.')[2]), null);
  const symmetric = await new SignJWT({ sub: 'forged' }).setProtectedHeader({ alg: 'HS256', typ: 'at+jwt', kid: 'key-1' }).sign(Buffer.alloc(32, 4));
  assert.equal(await h.authenticate(symmetric), null);
  assert.equal(await h.authenticate('x'.repeat(17000)), null);
  assert.equal(h.state.grantReads, 0);
  assert.equal(h.state.keyReads, 1); // Only the tampered, structurally valid AT reaches the configured key source.
});

test('grant binding cannot be swapped across owner subject/client/resource/token; expired or uncertain grant denies', async () => {
  const h = await fixture(), token = await h.make();
  for (const field of ['issuer', 'resource', 'subject', 'clientId', 'tokenId']) {
    const original = h.state.grant[field]; h.state.grant[field] = 'other';
    assert.equal(await h.authenticate(token), null, field); h.state.grant[field] = original;
  }
  h.state.grant.expiresAt = time;
  assert.equal(await h.authenticate(token), null);
  h.state.grant.expiresAt = time + 600000; h.state.keyError = true;
  assert.equal(await h.authenticate(token), null);
});

test('expiration is rechecked after an asynchronous grant read', async () => {
  const h = await fixture();
  const authenticate = createResourceTokenVerifier({ issuer, resource, now: () => h.state.now,
    loadJwks: async () => ({ keys: [h.key] }), resolveGrant: async () => {
      h.state.now = time + 600000; return { ...h.state.grant, expiresAt: time + 1200000 };
    } });
  assert.equal(await authenticate(await h.make()), null);
});

test('provider metadata reports incompatibility without treating discovery as a connected dot', () => {
  const metadata = { issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', jwks_uri: issuer + '/jwks',
    response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], scopes_supported: ['kuzya.tasks', 'kuzya.memory.read'],
    token_endpoint_auth_methods_supported: ['none'], client_id_metadata_document_supported: true };
  assert.deepEqual(inspectOAuthMetadata({ metadata, issuer }), { metadataReady: true, connected: false, issues: [] });
  const limited = inspectOAuthMetadata({ metadata: { ...metadata, scopes_supported: ['openid', 'email', 'profile', 'phone'] }, issuer });
  assert.equal(limited.metadataReady, false); assert.equal(limited.connected, false);
  assert.deepEqual(limited.issues, ['scope_missing:kuzya.tasks', 'scope_missing:kuzya.memory.read']);
  const invalid = inspectOAuthMetadata({ metadata: { ...metadata, issuer: issuer + '/', token_endpoint: 'http://unsafe/',
    code_challenge_methods_supported: ['plain'], client_id_metadata_document_supported: false }, issuer });
  assert(invalid.issues.includes('issuer_mismatch')); assert(invalid.issues.includes('pkce_s256_missing'));
  assert(invalid.issues.includes('token_endpoint_invalid')); assert(invalid.issues.includes('client_registration_missing'));
  assert.throws(() => createResourceTokenVerifier({ issuer, resource }), /trusted_keys/);
});
