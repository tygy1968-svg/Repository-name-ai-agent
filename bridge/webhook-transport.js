import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import ipaddr from 'ipaddr.js';
import { Webhook } from 'standardwebhooks';

const fail = code => Object.assign(new Error(code), { code });
export function callbackUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      (url.port && url.port !== '443') || net.isIP(url.hostname.replace(/^\[|\]$/g, '')) ||
      !url.hostname.includes('.') || url.hostname.endsWith('.local') || url.hostname.endsWith('.localhost')) throw fail('callback_not_allowed');
  return url;
}
export function isPublicAddress(value) {
  try { return ipaddr.process(value).range() === 'unicast'; } catch { return false; }
}
export async function resolveCallback(hostname, resolve = dns.lookup) {
  const rows = await resolve(hostname, { all: true, verbatim: true });
  if (!rows.length || rows.some(row => !isPublicAddress(row.address))) throw fail('callback_not_public');
  return rows[0];
}

// New socket per attempt. Lookup validates ALL answers, then pins the socket to
// one vetted address, preserving hostname/SNI and normal TLS verification.
// Native HTTPS never follows redirects; no credentials or proxy are inherited.
export function createWebhookPost({ lookup = dns.lookup, request = https.request } = {}) {
  return (value, { body, headers }) => new Promise((resolve, reject) => {
    let url;
    try { url = callbackUrl(value); } catch (error) { reject(error); return; }
    if (typeof body !== 'string' || Buffer.byteLength(body) > 262144) { reject(fail('payload_too_large')); return; }
    const req = request({ protocol: 'https:', hostname: url.hostname, port: 443, method: 'POST',
      path: url.pathname + url.search, servername: url.hostname, rejectUnauthorized: true, agent: false,
      headers: { ...headers, 'content-length': Buffer.byteLength(body) },
      lookup: (host, options, done) => { resolveCallback(host, lookup).then(row =>
        options?.all ? done(null, [row]) : done(null, row.address, row.family), done); }
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400) { response.resume(); req.destroy(fail('redirect_not_allowed')); return; }
      const chunks = []; let length = 0;
      response.on('data', chunk => {
        length += chunk.length;
        if (length > 65536) { reject(fail('callback_response_too_large')); req.destroy(fail('callback_response_too_large')); } else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300,
        body: Buffer.concat(chunks).toString('utf8') }));
    });
    const deadline = setTimeout(() => req.destroy(fail('callback_timeout')), 10000);
    deadline.unref();
    req.once('close', () => clearTimeout(deadline));
    req.setTimeout(10000, () => req.destroy(fail('callback_timeout')));
    req.on('error', error => reject(fail(['callback_not_public', 'redirect_not_allowed', 'callback_response_too_large', 'callback_timeout'].includes(error.code) ? error.code : 'callback_unavailable')));
    req.end(body);
  });
}

export function validateSigningSecret(secret) {
  if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw fail('invalid_signing_secret');
  const encoded = secret.slice(6), key = Buffer.from(encoded, 'base64');
  if (key.length < 24 || key.length > 64 || key.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) throw fail('invalid_signing_secret');
  return secret;
}
export function signedWebhook({ id, payload, subscriptionId, secret, previousSecret, now = Date.now() }) {
  validateSigningSecret(secret);
  const body = JSON.stringify(payload), date = new Date(now);
  const signature = new Webhook(secret).sign(id, date, body);
  return { body, headers: { 'content-type': 'application/json', 'webhook-id': id,
    'webhook-timestamp': String(Math.floor(now / 1000)), 'X-MCP-Subscription-Id': subscriptionId,
    'webhook-signature': previousSecret ? signature + ' ' + new Webhook(validateSigningSecret(previousSecret)).sign(id, date, body) : signature } };
}
