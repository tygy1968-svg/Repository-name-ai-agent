// Resource-server preparation only: no authorization server, login, routes,
// environment reads or network requests are started by importing this module.
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';

export const BRIDGE_SCOPES = Object.freeze(['kuzya.tasks', 'kuzya.memory.read']);
const algorithms = ['RS256', 'ES256'];
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/\s/.test(value);
function httpsIdentifier(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw Error('explicit_https_identifier_required');
  // OAuth identifiers use exact comparison, including trailing slashes.
  return value;
}
const has = (values, value) => Array.isArray(values) && values.includes(value);

// This checks advertised capabilities, NOT successful linking. Even a passing
// document does not prove resource-bound issuance, consent, owner mapping or
// current revocation checks. Those need a real end-to-end acceptance test.
export function inspectOAuthMetadata({ metadata, issuer, predefinedClientId }) {
  httpsIdentifier(issuer);
  const issues = [];
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return { metadataReady: false, connected: false, issues: ['metadata_missing'] };
  if (metadata.issuer !== issuer) issues.push('issuer_mismatch');
  for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    try { httpsIdentifier(metadata[field]); } catch { issues.push(field + '_invalid'); }
  }
  if (!has(metadata.response_types_supported, 'code')) issues.push('authorization_code_missing');
  if (!has(metadata.code_challenge_methods_supported, 'S256')) issues.push('pkce_s256_missing');
  for (const scope of BRIDGE_SCOPES) if (!has(metadata.scopes_supported, scope)) issues.push('scope_missing:' + scope);
  const methods = metadata.token_endpoint_auth_methods_supported;
  if (!Array.isArray(methods) || !methods.some(value => ['none', 'private_key_jwt', 'client_secret_basic', 'client_secret_post'].includes(value))) issues.push('token_auth_method_missing');
  let dcr = false;
  try { httpsIdentifier(metadata.registration_endpoint); dcr = true; } catch { /* Optional when CIMD or a fixed client is configured. */ }
  if (metadata.client_id_metadata_document_supported !== true && !dcr && !identifier(predefinedClientId)) issues.push('client_registration_missing');
  return { metadataReady: issues.length === 0, connected: false, issues };
}

// The provider must mint ATs specifically for this bridge (RFC 9068 typ), with
// explicit scopes, OAuth client identity and jti. A generic Supabase session or
// OIDC ID token is deliberately incompatible, even when it has Julia's email.
// loadJwks is a trusted, bounded fetch/cache adapter for ONE configured issuer;
// NEVER use token-supplied URLs. resolveGrant must read the current server-side
// grant/owner binding on EVERY call, without a positive authorization cache.
// Provider selection, both real adapters and consent remain deployment gates.
export function createResourceTokenVerifier({ issuer, resource, loadJwks, resolveGrant, now = Date.now, maxLifetimeSeconds = 3600 }) {
  httpsIdentifier(issuer); httpsIdentifier(resource);
  if (typeof loadJwks !== 'function' || typeof resolveGrant !== 'function') throw Error('trusted_keys_and_current_grant_required');
  if (!Number.isInteger(maxLifetimeSeconds) || maxLifetimeSeconds < 60 || maxLifetimeSeconds > 3600) throw Error('invalid_token_lifetime');
  return async token => {
    try {
      if (typeof token !== 'string' || token.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
      const header = decodeProtectedHeader(token);
      if (!algorithms.includes(header.alg) || header.typ !== 'at+jwt' || !identifier(header.kid) ||
          ['jku', 'jwk', 'x5u', 'x5c', 'crit'].some(field => field in header)) return null;
      const jwks = await loadJwks();
      if (!Array.isArray(jwks?.keys) || jwks.keys.length < 1 || jwks.keys.length > 10 ||
          jwks.keys.some(key => !key || !['RSA', 'EC'].includes(key.kty) || 'd' in key || 'k' in key)) return null;
      const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), {
        algorithms, issuer, audience: resource, typ: 'at+jwt', clockTolerance: 0,
        currentDate: new Date(now()), requiredClaims: ['exp', 'iat', 'sub', 'scope', 'client_id', 'jti']
      });
      if (payload.aud !== resource || !identifier(payload.sub) || !identifier(payload.client_id) || !identifier(payload.jti) ||
          !Number.isInteger(payload.exp) || !Number.isInteger(payload.iat) || payload.iat > now() / 1000 ||
          payload.exp <= payload.iat || payload.exp - payload.iat > maxLifetimeSeconds ||
          typeof payload.scope !== 'string' || payload.scope.length > 1024) return null;
      const requested = [...new Set(payload.scope.split(' ').filter(Boolean))];
      if (!requested.some(scope => BRIDGE_SCOPES.includes(scope))) return null;
      const binding = { issuer, resource, subject: payload.sub, clientId: payload.client_id, tokenId: payload.jti };
      const grant = await resolveGrant(Object.freeze(binding));
      // Repeat expiry after the asynchronous database call. Revocation errors,
      // missing users and uncertain reads deny access, never grant it.
      if (grant?.active !== true || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= now() || payload.exp * 1000 <= now() ||
          Object.entries(binding).some(([key, value]) => grant[key] !== value) ||
          !identifier(grant.ownerId) || !identifier(grant.workerId) || !Array.isArray(grant.scopes)) return null;
      const scopes = BRIDGE_SCOPES.filter(scope => requested.includes(scope) && grant.scopes.includes(scope));
      if (!scopes.length) return null;
      return Object.freeze({ ownerId: grant.ownerId, workerId: grant.workerId, scopes: Object.freeze(scopes) });
    } catch { return null; }
  };
}
