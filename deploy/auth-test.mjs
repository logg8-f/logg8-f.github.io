#!/usr/bin/env node
// End-to-end test for the Google sign-in flow in server.mjs, without touching
// Google: it generates a throwaway RSA key, serves it as a JWKS, points the
// server at that JWKS (via GOOGLE_JWKS_URL), mints ID tokens with the key, and
// checks that sign-in, session enforcement, and the pub/votes ownership rules
// all behave. The JWKS override is a test-only env var; production uses Google's
// certificate URL.
//
// Usage: node deploy/auth-test.mjs
// Exits non-zero if any check fails.

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const APP_PORT = Number(process.env.AUTH_TEST_PORT || 8912);
const JWKS_PORT = APP_PORT + 1;
const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const KID = 'test-key-1';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS' : 'FAIL') + ': ' + msg); if (!cond) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- a throwaway signing key + its JWKS ----
const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', publicKey);
Object.assign(jwk, { kid: KID, alg: 'RS256', use: 'sig' });

const b64u = b => Buffer.from(b).toString('base64url');
async function mint(claims, key = privateKey, kid = KID) {
  const header = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64u(JSON.stringify(Object.assign({ iss: 'accounts.google.com', aud: CLIENT_ID, sub: 'user-123', email: 'u@example.com', name: 'Test User', iat: now, exp: now + 3600 }, claims)));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, Buffer.from(header + '.' + body));
  return header + '.' + body + '.' + b64u(sig);
}

const jwksSrv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ keys: [jwk] }));
});
await new Promise(r => jwksSrv.listen(JWKS_PORT, '127.0.0.1', r));

// ---- the app server under test (its own temp folder, real server.mjs) ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quizlet-auth-'));
fs.copyFileSync(path.join(REPO, 'server.mjs'), path.join(dir, 'server.mjs'));
fs.copyFileSync(path.join(REPO, 'index.html'), path.join(dir, 'index.html'));
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: dir, stdio: 'ignore',
  env: Object.assign({}, process.env, {
    PORT: String(APP_PORT), HOST: '127.0.0.1',
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_JWKS_URL: 'http://127.0.0.1:' + JWKS_PORT + '/certs',
  }),
});

const BASE = 'http://127.0.0.1:' + APP_PORT + '/api/';
async function req(method, p, body, cookie, token) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (token) headers['x-write-token'] = token;
  const r = await fetch(BASE + p, { method, cache: 'no-store', headers: Object.keys(headers).length ? headers : undefined, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch {}
  const setCookies = (r.headers.getSetCookie && r.headers.getSetCookie()) || (r.headers.get('set-cookie') ? [r.headers.get('set-cookie')] : []);
  return { status: r.status, data, cookie: setCookies.map(c => c.split(';')[0]).join('; '), rawCookies: setCookies };
}

const validDeck = { decks: { d1: { title: 'T', desc: '', cards: [['a','1'],['b','2'],['c','3'],['d','4']], choize: false, langW: '', langD: '', at: Date.now() } } };

async function cleanup() {
  try { child.kill('SIGKILL'); } catch {}
  try { jwksSrv.close(); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

try {
  for (let i = 0; i < 100; i++) { try { const r = await fetch(BASE + 'health'); if (r.ok) break; } catch {} await sleep(100); }

  let r = await req('GET', 'health');
  ok(r.status === 200 && r.data.auth === true && r.data.clientId === CLIENT_ID, 'health reports sign-in is on, with the client id');

  r = await req('GET', 'auth/me');
  ok(r.status === 200 && r.data.user === null, 'before signing in, auth/me says nobody is signed in');

  // ---- signing in ----
  const token = await mint({});
  r = await req('POST', 'auth/google', { credential: token });
  ok(r.status === 200 && r.data.ok === true && r.data.user.sub === 'user-123', 'a valid Google token signs you in');
  const session = r.cookie;
  ok(/^qz_session=/.test(session), 'the response sets a session cookie');
  ok(/HttpOnly/i.test(r.rawCookies.join(';')) && /SameSite=Lax/i.test(r.rawCookies.join(';')), 'the session cookie is HttpOnly and SameSite=Lax');

  r = await req('GET', 'auth/me', null, session);
  ok(r.status === 200 && r.data.user && r.data.user.sub === 'user-123', 'auth/me returns the signed-in account');

  // ---- bad tokens are refused ----
  const otherKey = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])).privateKey;
  r = await req('POST', 'auth/google', { credential: await mint({}, otherKey) });
  ok(r.status === 401, 'a token signed by the wrong key is refused (401)');
  r = await req('POST', 'auth/google', { credential: await mint({ aud: 'someone-else' }) });
  ok(r.status === 401, 'a token for another app (wrong audience) is refused (401)');
  const past = Math.floor(Date.now() / 1000) - 7200;
  r = await req('POST', 'auth/google', { credential: await mint({ iat: past, exp: past + 3600 }) });
  ok(r.status === 401, 'an expired token is refused (401)');
  r = await req('POST', 'auth/google', { credential: 'not.a.jwt' });
  ok(r.status === 401, 'garbage is refused (401)');

  // ---- publish / vote now require the session, and only as yourself ----
  r = await req('PUT', 'doc/pub/user-123', { data: validDeck });
  ok(r.status === 401, 'publishing with no session is refused (401)');

  r = await req('PUT', 'doc/pub/user-123', { data: validDeck }, session);
  ok(r.status === 200 && r.data.ok === true, 'a signed-in user can publish under their own id');

  r = await req('PUT', 'doc/pub/someone-else', { data: validDeck }, session);
  ok(r.status === 403, 'a signed-in user CANNOT publish under another id (403)');

  r = await req('PUT', 'doc/votes/user-123', { data: { v: { 'x~y': 1 } } }, session);
  ok(r.status === 200, 'a signed-in user can vote under their own id');

  r = await req('PUT', 'doc/votes/someone-else', { data: { v: {} } }, session);
  ok(r.status === 403, 'a signed-in user CANNOT vote as another id (403)');

  r = await req('DELETE', 'doc/pub/user-123', null, session);
  ok(r.status === 200, 'a signed-in user can delete their own public deck');

  // ---- personal areas still work with a write token, no sign-in needed ----
  r = await req('PUT', 'doc/data/users/local-1/meta', { data: { seeded: true } }, null, 'tok-local-1');
  ok(r.status === 200, 'personal area still needs only a write token, not sign-in');
  r = await req('PUT', 'doc/data/users/local-1/meta', { data: { seeded: true } }, null, 'tok-someone-else');
  ok(r.status === 403, 'a personal area still refuses a different write token (403)');

  // ---- a signed-in account's own area follows the account, not the browser ----
  // data/users/<sub> belongs to the signed-in account (session), not to a
  // per-browser write token, so the same decks meet on every device.
  r = await req('PUT', 'doc/data/users/user-123/meta', { data: { seeded: true, review: [{ k: 'g~d1', n: 2 }] } }, session);
  ok(r.status === 200, 'a signed-in user can save into their own account area (no write token)');
  r = await req('GET', 'doc/data/users/user-123/meta', null, session);
  ok(r.status === 200 && r.data && r.data.review && r.data.review[0].n === 2, 'the account area reads back to that account');
  r = await req('GET', 'col/data/users/user-123', null, session);
  ok(r.status === 200 && Array.isArray(r.data) && r.data.some(d => d.id === 'meta'), 'the account can list its own area');

  // ...but to nobody else: not to an anonymous browser...
  r = await req('GET', 'doc/data/users/user-123/meta');
  ok(r.status === 403, 'an account area is not readable without signing in (403)');
  r = await req('PUT', 'doc/data/users/user-123/meta', { data: { seeded: true } }, null, 'tok-stranger');
  ok(r.status === 401, 'an account area cannot be claimed with a write token (401)');
  // ...and not to a different account.
  const rb = await req('POST', 'auth/google', { credential: await mint({ sub: 'user-456', email: 'b@example.com', name: 'Other' }) });
  ok(rb.status === 200 && rb.data.user.sub === 'user-456', 'a second account can sign in');
  const sessionB = rb.cookie;
  r = await req('PUT', 'doc/data/users/user-123/meta', { data: { seeded: true } }, sessionB);
  ok(r.status === 403, 'another account CANNOT write your area (403)');
  r = await req('GET', 'doc/data/users/user-123/meta', null, sessionB);
  ok(r.status === 403, 'another account CANNOT read your area (403)');
  r = await req('PUT', 'doc/data/users/user-456/meta', { data: { seeded: true } }, sessionB);
  ok(r.status === 200, 'the second account can write its own area');

  // ---- signing out ends the session ----
  r = await req('POST', 'auth/logout', {}, session);
  ok(r.status === 200, 'signing out succeeds');
  r = await req('GET', 'auth/me', null, session);
  ok(r.status === 200 && r.data.user === null, 'after signing out, auth/me has nobody');
  r = await req('PUT', 'doc/pub/user-123', { data: validDeck }, session);
  ok(r.status === 401, 'the old session no longer publishes (401)');

  console.log(fails === 0 ? '\nAUTH TESTS PASSED' : '\n' + fails + ' FAILED');
} catch (e) {
  console.error('ERROR:', e && e.stack || e);
  fails++;
} finally {
  await cleanup();
}
process.exit(fails === 0 ? 0 : 1);
