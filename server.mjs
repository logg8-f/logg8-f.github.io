#!/usr/bin/env node
/*
 * Memoria - self-hosted backend
 * ---------------------------------
 * Serves the app (index.html) AND a tiny shared database, so anyone who opens
 * this server's address can publish decks and vote. By default no sign-in is
 * needed; set GOOGLE_CLIENT_ID to require a Google account for publishing and
 * voting (see the "Google sign-in" block further down).
 *
 * Run it:        node server.mjs
 * Pick a port:   PORT=8080 node server.mjs
 * Sign-in on:    GOOGLE_CLIENT_ID=...apps.googleusercontent.com node server.mjs
 * Where data is: data/db.json   (delete it to start over)
 *                data/sessions.json (signed-in sessions; delete to sign everyone out)
 *
 * To move this to another computer you just copy the whole folder, including
 * the data/ folder, and run `node server.mjs` there.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1'; // only this machine by default; set HOST=0.0.0.0 to also allow the local network

const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const OWNERS_FILE = path.join(DATA_DIR, 'owners.json'); // path -> the token that owns it
const REPORTS_FILE = path.join(DATA_DIR, 'reports.json'); // gid / gid/card -> {n,last}
const DELETIONS_FILE = path.join(DATA_DIR, 'deletions.json'); // sub -> deleteAt
const REMINDERS_FILE = path.join(DATA_DIR, 'reminders.json'); // sub -> {email,enabled,interval,lastSent,token}
const BUG_FILE = path.join(DATA_DIR, 'bug-reports.txt'); // human-readable, one block per report
const RESEND_KEY = String(process.env.RESEND_API_KEY || '').trim();
const REMINDER_FROM = String(process.env.REMINDER_FROM || 'Memoria <memoria@example.com>').trim();

const MAX_BODY = 2 * 1024 * 1024; // biggest single write we accept (bytes); leaves room for a published deck with shrunk images
const MAX_DECKS = 15;        // public decks a single publisher may have
const MIN_CARDS = 4;         // cards a public deck must have
const RATE_MAX = 40;         // writes allowed per IP in the window below.
                             // NB: behind a reverse proxy (Tailscale serve or Caddy) every
                             // request arrives from 127.0.0.1, so this collapses into one
                             // global limit rather than per-visitor. Intentional here, not a bug.
const RATE_WINDOW = 60 * 1000;

/* ---------- optional AI grading ----------
   Off unless GROQ_API_KEY is set (see HOW-TO-RUN.md). When on, a typed answer
   that the built-in exact/near match rejects is re-checked by an LLM so a correct
   paraphrase still counts. If the key is missing or the API is unreachable we just
   fall back to the built-in matching — studying never depends on it. */
const GROQ_KEY = String(process.env.GROQ_API_KEY || '').trim();
const GROQ_MODEL = String(process.env.GROQ_MODEL || 'openai/gpt-oss-120b').trim();
const AI_RATE_MAX = 20;          // AI gradings allowed per IP in the window below
const AI_RATE_WINDOW = 60 * 1000;

/* ---------- storage: one flat map of "path" -> JSON ---------- */
let store = load();
function load() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) || {}; }
  catch { return {}; }
}
function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, DB_FILE); // atomic: the file is never half-written
}

/* ---------- write tokens: who may change an existing document ----------
   Anyone may CREATE a document and anyone may READ one. But overwriting or
   deleting a document requires the same secret token that first wrote it.
   The token lives in the visitor's own browser (localStorage) and never in the
   shared data, so nobody can learn anyone else's. This keeps the no-login
   design while stopping a stranger from wiping or rewriting other people's
   decks and votes once the server is public. */
let owners = loadOwners();
function loadOwners() {
  try { return JSON.parse(fs.readFileSync(OWNERS_FILE, 'utf8')) || {}; }
  catch { return {}; }
}
function saveOwners() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = OWNERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(owners));
  fs.renameSync(tmp, OWNERS_FILE);
}

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || fallback; }
  catch { return fallback; }
}
function saveJson(file, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}
let reports = loadJson(REPORTS_FILE, { decks: {}, cards: {} });
if (!reports.decks) reports.decks = {};
if (!reports.cards) reports.cards = {};
let deletions = loadJson(DELETIONS_FILE, {});
let reminders = loadJson(REMINDERS_FILE, {});
const tokenOf = req => String(req.headers['x-write-token'] || '').trim();
/* A visitor's personal area is data/users/<them>/... — their own decks and
   images, not meant to be seen by anyone else. This returns the area key for a
   path, or null if the path is not inside one. */
function nsOf(p) {
  const s = String(p).split('/');
  return (s.length >= 3 && s[0] === 'data' && s[1] === 'users') ? s.slice(0, 3).join('/') : null;
}
/* Writing: whoever writes a path first owns it, and the same token is required
   to change it. Inside a personal area, ownership is claimed once for the whole
   area, so nobody can slip documents into someone else's space. */
function ownerCheck(req, path, claim) {
  if (accountAreaOf(path)) return 'not yours to change'; // account areas belong to the signed-in account
  const tok = tokenOf(req);
  const ns = nsOf(path);
  if (ns) {
    const n = owners[ns];
    if (n === undefined) {
      if (claim) { if (!tok) return 'write token required'; owners[ns] = tok; saveOwners(); }
    } else if (tok !== n) return 'not yours to change';
  }
  const owner = owners[path];
  if (owner === undefined) {
    if (!claim) return null;            // deleting something never written: harmless
    if (!tok) return 'write token required';
    owners[path] = tok; saveOwners(); return null;
  }
  if (tok !== owner) return 'not yours to change';
  return null;
}
/* Reading: public collections (pub/*, votes/*) stay open so anyone can browse
   and tally votes. A personal area needs its owner's token. An area nobody has
   claimed yet just reads as empty, so a brand-new visitor's first load works;
   a claimed one is refused to everyone else. 'data' and 'data/users' are never
   listable, so the set of visitors cannot be enumerated. */
function privateRead(req, path) {
  if (!(path === 'data' || path === 'data/users' || path.startsWith('data/users/'))) return 'open';
  const ns = nsOf(path);
  if (!ns) return 'hidden';
  // A personal area that belongs to an account is read-only to that account.
  const sub = String(path).split('/')[2];
  if (sub && accounts[sub]) {
    const u = sessionUser(req);
    return (u && u.sub === sub) ? 'open' : 'denied';
  }
  const owner = owners[ns];
  if (owner === undefined) return 'empty';
  return tokenOf(req) === owner ? 'open' : 'denied';
}

/* ---------- optional Google sign-in ----------
   Off unless GOOGLE_CLIENT_ID is set. When it is on, publishing a deck and
   voting require a signed-in Google account, and the account's own personal area
   (data/users/<sub>/...) is owned by the account too, so the same decks follow
   the person from one device to another. Signed out, a personal area stays local
   to the browser and does not need signing in.

   How it works: the page gets a Google ID token (a signed JWT) from the browser
   and POSTs it to /api/auth/google. We check the signature against Google's
   public keys, then start a session and hand back an HttpOnly cookie. The
   account's stable id (Google's "sub") becomes the owner of pub/** and votes/**,
   so nobody can publish or vote as somebody else. Sessions live in their own
   file (never in the shared store), so the session ids can never be read back
   out through the document API. */
const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || '').trim();
const GOOGLE_JWKS_URL = String(process.env.GOOGLE_JWKS_URL || 'https://www.googleapis.com/oauth2/v3/certs').trim();
const SESSION_COOKIE = 'qz_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

let sessions = loadSessions();
function loadSessions() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) || {}; }
  catch { return {}; }
}
function saveSessions() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = SESSIONS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(sessions));
  fs.renameSync(tmp, SESSIONS_FILE);
}
const randId = () => crypto.randomBytes(24).toString('base64url');

/* The account ids that have ever signed in. A personal area that belongs to one
   of these (data/users/<sub>/...) is owned by the signed-in account rather than
   by a browser token, so the same decks and progress follow the person from one
   device to the next. */
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
let accounts = loadAccounts();
function loadAccounts() {
  try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')) || {}; }
  catch { return {}; }
}
function saveAccounts() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = ACCOUNTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(accounts));
  fs.renameSync(tmp, ACCOUNTS_FILE);
}
/* The account a path belongs to (data/users/<sub>/...), or null. */
function accountAreaOf(p) {
  const s = String(p).split('/');
  return (s.length >= 3 && s[0] === 'data' && s[1] === 'users' && accounts[s[2]]) ? s[2] : null;
}
/* Who may write an account's personal area. Signing in isn't configured -> null. */
function accountGate(req, docPath) {
  if (!GOOGLE_CLIENT_ID) return null;
  const sub = accountAreaOf(docPath);
  if (!sub) return null;
  const u = sessionUser(req);
  if (!u) return { code: 401, error: 'sign in required' };
  if (u.sub !== sub) return { code: 403, error: 'not yours' };
  return null;
}

function cookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i < 0) return;
    out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function isHttps(req) {
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || !!req.socket.encrypted;
}
function sessionUser(req) {
  if (!GOOGLE_CLIENT_ID) return null;
  const sid = cookies(req)[SESSION_COOKIE];
  if (!sid) return null;
  const s = sessions[sid];
  if (!s) return null;
  if (s.exp && s.exp < Date.now()) { delete sessions[sid]; saveSessions(); return null; }
  // A session that predates this feature still marks its account as known, so
  // the account's own personal area is recognised without signing in again.
  if (s.sub && !accounts[s.sub]) { accounts[s.sub] = Date.now(); saveAccounts(); }
  return s;
}
function sessionCookie(value, maxAgeSec, secure) {
  return SESSION_COOKIE + '=' + value + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAgeSec + (secure ? '; Secure' : '');
}

/* Verify a Google ID token: RS256 signature against Google's JWKS, plus the
   audience / issuer / expiry checks Google documents. Returns the account or
   null. The JWKS is cached for an hour; an unknown key id forces one refetch. */
let jwksCache = null, jwksAt = 0;
async function getJwks(force) {
  if (!force && jwksCache && Date.now() - jwksAt < 3600000) return jwksCache;
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(GOOGLE_JWKS_URL, { cache: 'no-store', signal: ac.signal });
    if (!r.ok) throw new Error('jwks ' + r.status);
    jwksCache = await r.json(); jwksAt = Date.now();
    return jwksCache;
  } finally { clearTimeout(to); }
}
async function verifyGoogleIdToken(idToken) {
  if (!GOOGLE_CLIENT_ID) return null;
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch { return null; }
  if (!header || header.alg !== 'RS256' || !header.kid || !payload) return null;

  let jwks = await getJwks(false).catch(() => null);
  let jwk = jwks && (jwks.keys || []).find(k => k.kid === header.kid);
  if (!jwk) {
    jwks = await getJwks(true).catch(() => null);
    jwk = jwks && (jwks.keys || []).find(k => k.kid === header.kid);
  }
  if (!jwk) return null;

  let key;
  try { key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']); }
  catch { return null; }
  const sig = Buffer.from(parts[2], 'base64url');
  const signed = Buffer.from(parts[0] + '.' + parts[1]);
  let good = false;
  try { good = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, signed); }
  catch { return null; }
  if (!good) return null;

  const now = Math.floor(Date.now() / 1000);
  if (!payload.sub) return null;
  if (payload.exp != null && payload.exp < now - 60) return null;      // expired
  if (payload.iat != null && payload.iat > now + 300) return null;    // issued in the future
  if (String(payload.aud) !== GOOGLE_CLIENT_ID) return null;          // for a different app
  const iss = String(payload.iss || '');
  if (iss !== 'accounts.google.com' && iss !== 'https://accounts.google.com') return null;
  return { sub: String(payload.sub), email: String(payload.email || ''), name: String(payload.name || ''), picture: String(payload.picture || '') };
}

/* Who owns pub/** and votes/**. Signing in isn't configured -> null (auth off). */
function publicGate(req, docPath) {
  if (!GOOGLE_CLIENT_ID) return null;
  const p = docPath.split('/');
  if ((p[0] === 'pub' || p[0] === 'votes') && p.length >= 2) {
    const u = sessionUser(req);
    if (!u) return { code: 401, error: 'sign in to publish or vote' };
    if (p[1] !== u.sub) return { code: 403, error: 'not yours' };
  }
  return null;
}

/* ---------- live updates: tell every open page "something changed" ---------- */
const clients = new Set();
function broadcast() {
  for (const res of clients) { try { res.write('data: change\n\n'); } catch {} }
}

/* ---------- a small per-IP speed limit on writes ---------- */
const hits = new Map();
function tooMany(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < RATE_WINDOW);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > RATE_MAX;
}
const aiHits = new Map();
function aiTooMany(ip) {
  const now = Date.now();
  const arr = (aiHits.get(ip) || []).filter(t => now - t < AI_RATE_WINDOW);
  arr.push(now);
  aiHits.set(ip, arr);
  return arr.length > AI_RATE_MAX;
}
/* Who the request really came from. Behind a reverse proxy (Caddy, Tailscale
   serve) every connection arrives from 127.0.0.1, which would make the limit
   above one global bucket. When — and only when — the direct peer is loopback,
   trust the proxy's X-Forwarded-For first hop; otherwise use the peer. A remote
   client cannot spoof this because its own peer is never loopback. */
function clientIp(req) {
  const peer = req.socket.remoteAddress || '?';
  const loop = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  const fwd = req.headers['x-forwarded-for'];
  if (loop && fwd) return String(fwd).split(',')[0].trim() || peer;
  return peer;
}

/* ---------- small helpers ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};
function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length });
  res.end(b);
}
function readBody(req, max) {
  const limit = max || MAX_BODY;
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on('data', c => {
      n += c.length;
      if (n > limit) { reject(new Error('too large')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}
const clean = s => String(s || '').replace(/^\/+|\/+$/g, '');

/* Ask the model whether the learner's wording means the same as the expected
   answer. Returns true/false, or null on any failure (so the caller falls back). */
const AI_SYS = 'You are a lenient but sensible grader for a Swedish vocabulary flashcard app. ' +
  'The learner recalls the meaning of a word. Mark the answer CORRECT if it conveys the same ' +
  'core meaning as the accepted answer: a correct synonym, a paraphrase, a shorter or partial ' +
  'phrasing that captures the essential sense, or a different grammatical form all count. Mark ' +
  'it WRONG only if it means something clearly different, is unrelated, or contradicts the ' +
  'accepted answer. Never require the learner to reproduce every part of a longer definition. ' +
  'Reply only as JSON: {"correct": true, "why": "short reason", "closeness": 0-100} or {"correct": false, "why": "short reason", "closeness": 0-100}. Closeness is an approximate percentage of how close the learner was in meaning.\n' +
  'Examples:\n' +
  '- accepted "tillförlitlig och sakligt trovärdig", learner "trovärdig" -> {"correct": true}\n' +
  '- accepted "göra något mindre betydelsefullt än det är", learner "förminska" -> {"correct": true}\n' +
  '- accepted "småaktigt elak eller skamlig", learner "glad" -> {"correct": false}';
async function gradeWithAI(q, a, u, blank) {
  if (!GROQ_KEY) return null;
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 9000);
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + GROQ_KEY },
      body: JSON.stringify({
        model: GROQ_MODEL, temperature: 0, max_tokens: 300, reasoning_effort: 'low',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: AI_SYS },
          { role: 'user', content: 'Card prompt: ' + q + '\nAccepted answer: ' + a +
              '\nLearner wrote: ' + u +
              (blank ? '\n(The learner filled in a blank; accept synonyms and inflections.)' : '') }
        ]
      }),
      signal: ac.signal
    });
    if (!r.ok) return null;
    const j = await r.json();
    const msg = (j && j.choices && j.choices[0] && j.choices[0].message) || {};
    const txt = String(msg.content || '');
    const m = txt.match(/\{[\s\S]*\}/);
    const obj = JSON.parse(m ? m[0] : txt);
    return {correct: obj && obj.correct === true,
      why: String((obj && obj.why) || '').slice(0, 160),
      closeness: Math.max(0, Math.min(100, Number((obj && obj.closeness) || 0)))};
  } catch { return null; }
  finally { clearTimeout(to); }
}

/* One short nudge towards a card's answer. Must not contain the answer itself;
   returns null on failure or when the model leaks the answer, so the page can
   fall back to its letter mask. */
const HINT_SYS = 'You give one short hint for a vocabulary flashcard. The learner must recall the ' +
  'accepted answer. Describe its meaning, a typical context or a related idea in ONE plain sentence ' +
  'of at most 14 words, in the same language as the accepted answer. Never write the accepted answer, ' +
  'an inflected form of it, or its distinctive words. Do not ask a question and do not use quotation ' +
  'marks. If the answer is a single word, hint at its category, use or opposite rather than its ' +
  'spelling. Reply with the hint only.';
async function hintWithAI(q, a) {
  if (!GROQ_KEY) return null;
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 9000);
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + GROQ_KEY },
      body: JSON.stringify({
        model: GROQ_MODEL, temperature: 0.5, max_tokens: 80, reasoning_effort: 'low',
        messages: [
          { role: 'system', content: HINT_SYS },
          { role: 'user', content: 'Card prompt: ' + q + '\nAccepted answer: ' + a }
        ]
      }),
      signal: ac.signal
    });
    if (!r.ok) return null;
    const j = await r.json();
    const msg = (j && j.choices && j.choices[0] && j.choices[0].message) || {};
    let t = String(msg.content || '').trim().replace(/^["“']+|["”']+$/g, '').replace(/\s+/g, ' ');
    if (t.length > 180) t = t.slice(0, 180).replace(/\s+\S*$/, '') + '…';
    if (t.length < 4) return null;
    const norm = s => String(s).toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
    const hint = norm(t), ans = norm(a);
    if (ans && hint.includes(ans)) return null;                    // leaked the answer
    const words = ans.split(' ').filter(w => w.length > 3);
    if (words.length && words.every(w => hint.includes(w))) return null; // leaked every key word
    return t;
  } catch { return null; }
  finally { clearTimeout(to); }
}

/* ---------- memo cache for AI answers ----------
   Identical prompts come back instantly and cost no Groq quota: a learner who
   clicks the hint twice, retypes the same answer, or opens Test again gets the
   cached verdict. The cache is small, in-memory and expires after 30 minutes. */
const AI_CACHE_MS = 30 * 60 * 1000;
const AI_CACHE_MAX = 500;
const aiCache = new Map();
function aiCacheGet(key) {
  const hit = aiCache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.until) { aiCache.delete(key); return undefined; }
  return hit.value;
}
function aiCacheSet(key, value) {
  aiCache.delete(key);
  aiCache.set(key, { value, until: Date.now() + AI_CACHE_MS });
  while (aiCache.size > AI_CACHE_MAX) aiCache.delete(aiCache.keys().next().value);
}

/* ---------- rules for what may be published ---------- */
const MAX_PUB_CHARS = 1800000;
function checkPub(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'bad data';
  const decks = data.decks;
  if (!decks || typeof decks !== 'object' || Array.isArray(decks)) return 'no decks';
  const keys = Object.keys(decks);
  if (keys.length > MAX_DECKS) return 'too many public decks (max ' + MAX_DECKS + ')';
  for (const k of keys) {
    const d = decks[k];
    if (!d || typeof d !== 'object') return 'bad deck';
    if (typeof d.title !== 'string' || !d.title.trim()) return 'a deck needs a title';
    if (!Array.isArray(d.cards) || d.cards.length < MIN_CARDS) {
      return 'a public deck needs at least ' + MIN_CARDS + ' cards';
    }
    if (d.images != null) {
      if (typeof d.images !== 'object' || Array.isArray(d.images)) return 'bad images';
      const ids = Object.keys(d.images);
      if (ids.length > 60) return 'too many images in a deck';
      for (const id of ids) {
        const v = d.images[id];
        if (typeof v !== 'string' || !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v)) return 'bad image';
        if (v.length > 200000) return 'an image is too large';
      }
    }
  }
  if (JSON.stringify(data).length > MAX_PUB_CHARS) return 'that deck is too large';
  return null;
}

/* ---------- account deletion, reports and reminders ---------- */
function sessionSub(req){const u=sessionUser(req);return u?u.sub:null;}
function purgeAccount(sub){
  if(!sub)return;
  const prefixes=['data/users/'+sub, 'data/users/'+sub+'/', 'pub/'+sub, 'pub/'+sub+'/', 'votes/'+sub];
  Object.keys(store).forEach(k=>{
    if(prefixes.some(p=>k===p||k.startsWith(p))) delete store[k];
  });
  Object.keys(owners).forEach(k=>{
    if(prefixes.some(p=>k===p||k.startsWith(p))) delete owners[k];
  });
  delete accounts[sub];
  Object.keys(sessions).forEach(k=>{if(sessions[k]&&sessions[k].sub===sub)delete sessions[k];});
  delete reminders[sub];
  save();saveOwners();saveAccounts();saveSessions();saveJson(REMINDERS_FILE,reminders);
}
function sweepDeletions(){
  let changed=false;
  Object.keys(deletions).forEach(sub=>{
    const at=+deletions[sub]||0;
    if(at&&at<=Date.now()){delete deletions[sub];changed=true;purgeAccount(sub);}
  });
  if(changed)saveJson(DELETIONS_FILE,deletions);
}
function appBase(req){
  if(process.env.PUBLIC_URL)return String(process.env.PUBLIC_URL).replace(/\/+$/,'');
  if(!req)return 'http://localhost:'+PORT;
  const proto=(req.headers['x-forwarded-proto']||'http').split(',')[0].trim();
  const host=req.headers['x-forwarded-host']||req.headers.host||('localhost:'+PORT);
  return proto+'://'+host;
}
async function sendReminderEmail(req,sub,r){
  if(!RESEND_KEY||!r.email)return false;
  const interval=Math.max(1,+r.interval||7);
  const url=appBase(req)+'/?reminder=1';
  const unsub=appBase(req)+'/api/reminders/unsubscribe?token='+encodeURIComponent(r.token||'');
  const body={from:REMINDER_FROM,to:[r.email],subject:'Your Memoria study reminder',
    text:'You asked Memoria to remind you every '+interval+' days.\n\nStudy: '+url+'\n\nStop these emails: '+unsub+'\n'};
  try{
    const res=await fetch('https://api.resend.com/emails',{method:'POST',headers:{authorization:'Bearer '+RESEND_KEY,'content-type':'application/json'},body:JSON.stringify(body)});
    if(!res.ok)return false;
    r.lastSent=Date.now();r.lastError='';saveJson(REMINDERS_FILE,reminders);return true;
  }catch(e){r.lastError=String(e.message||e).slice(0,200);saveJson(REMINDERS_FILE,reminders);return false;}
}
async function sweepReminders(){
  const now=Date.now();
  for(const sub of Object.keys(reminders)){
    const r=reminders[sub];
    if(!r||!r.enabled||!r.email)continue;
    const every=Math.max(1,+r.interval||7)*24*60*60*1000;
    if(now-(+r.lastSent||0)<every)continue;
    await sendReminderEmail(null,sub,r); // request-less; PUBLIC_URL recommended for links
  }
}

/* ---------- Anki .apkg import ----------
   .apkg is a zip with a SQLite collection. We use Node's built-in sqlite
   (experimental in Node 22) and a tiny zip reader, so no npm dependency is
   needed. Only text fields are imported; media is reported as skipped. */
function zipEntries(buf){
  let eocd=-1;
  for(let i=buf.length-22;i>=Math.max(0,buf.length-65557);i--){
    if(buf.readUInt32LE(i)===0x06054b50){eocd=i;break;}
  }
  if(eocd<0)throw new Error('not a zip');
  const count=buf.readUInt16LE(eocd+10),off=buf.readUInt32LE(eocd+16);
  let p=off;const out={};
  for(let n=0;n<count;n++){
    if(buf.readUInt32LE(p)!==0x02014b50)break;
    const method=buf.readUInt16LE(p+10),csize=buf.readUInt32LE(p+20),usize=buf.readUInt32LE(p+24);
    const nlen=buf.readUInt16LE(p+28),elen=buf.readUInt16LE(p+30),clen=buf.readUInt16LE(p+32);
    const name=buf.toString('utf8',p+46,p+46+nlen);
    const local=buf.readUInt32LE(p+42);
    const lnlen=buf.readUInt16LE(local+26),lelen=buf.readUInt16LE(local+28);
    const start=local+30+lnlen+lelen;
    if(usize>25*1024*1024||csize>25*1024*1024)throw new Error('entry too large');
    out[name]=method===0?buf.subarray(start,start+csize):zlib.inflateRawSync(buf.subarray(start,start+csize));
    p+=46+nlen+elen+clen;
  }
  return out;
}
function ankiText(s){
  return String(s||'').replace(/<br\s*\/?>/gi,'\n').replace(/<\/div>/gi,'\n').replace(/<[^>]+>/g,'')
    .replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/\n{3,}/g,'\n\n').trim();
}
function ankiPlain(s){return ankiText(s).replace(/\s+/g,' ').trim();}
/* Field names referenced by a card template, in order. Conditional blocks and
   special names (FrontSide, Tags) are ignored. "cloze:Question" -> "Question". */
function ankiRefs(t){
  const out=[];
  String(t||'').replace(/\{\{([#/^!]?)([^}]+)\}\}/g,(m,flag,body)=>{
    if(flag)return m;
    const name=body.split(':').pop().split('|')[0].trim();
    if(name&&!['FrontSide','Tags'].includes(name)&&!out.includes(name))out.push(name);
    return m;
  });
  return out;
}
const CLOZE=/{{c\d+::([\s\S]*?)}}/g;
function ankiClozeAnswers(s){
  const out=[];
  String(s||'').replace(CLOZE,(m,body)=>{out.push(String(body).split('::')[0]);return m;});
  return out;
}
async function parseApkg(buf){
  const files=zipEntries(buf);
  const name=['collection.anki21','collection.anki2'].find(n=>files[n]);
  if(!name)throw new Error('no collection in apkg');
  const tmp=path.join(os.tmpdir(),'memoria-anki-'+crypto.randomBytes(8).toString('hex')+'.db');
  fs.writeFileSync(tmp,files[name]);
  try{
    const {DatabaseSync}=await import('node:sqlite');
    const db=new DatabaseSync(tmp);
    const notes=db.prepare('select id,mid,flds from notes').all();
    let models={};
    try{models=JSON.parse(String((db.prepare('select models from col limit 1').get()||{}).models||'{}'));}catch{}
    /* One card per note: the first template is enough for a text import. */
    const first=new Map();
    for(const c of db.prepare('select nid,ord from cards').all()){
      if(!first.has(c.nid)||c.ord<first.get(c.nid))first.set(c.nid,c.ord);
    }
    db.close();

    const cards=[],skipped={empty:0,media:0};
    for(const r of notes){
      const vals=String(r.flds||'').split('\x1f');
      const m=models[String(r.mid)]||{};
      const names=(m.flds||[]).map(f=>f.name);
      const note={};
      names.forEach((n,i)=>{note[n]=vals[i]||'';});
      const tmpl=(m.tmpls||[])[first.get(r.id)||0]||(m.tmpls||[])[0]||{};

      /* Cloze notes are the common case for grammar decks: keep the sentence
         with the blank on the front and the cloze text as the answer. */
      const clozeField=names.find(n=>/\{\{c\d+::/.test(note[n]||''));
      /* Only a field actually called Example is an example. Other third fields
         (Unit, Rubric, Notes) are context: keep them in the prompt instead. */
      const exampleField=names.find(n=>/^examples?$/i.test(n));
      let w='',d='',e='';
      if(clozeField){
        const answers=ankiClozeAnswers(note[clozeField]).map(ankiPlain).filter(Boolean);
        const front=ankiPlain(note[clozeField].replace(CLOZE,'______'));
        const ctx=names.filter(n=>n!==clozeField&&n!==exampleField&&/^(Category|Unit|Rubric|Choices|Notes|Extra|Context)$/i.test(n))
          .map(n=>ankiPlain(note[n])).filter((v,i,a)=>v&&a.indexOf(v)===i).slice(0,3);
        w=ankiPlain([front].concat(ctx).filter(Boolean).join(' · '));
        d=ankiPlain(answers.join(' / '));
        if(!answers.length||!front){skipped.empty++;continue;}
        if(exampleField)e=ankiPlain(note[exampleField]);
      }else{
        const qrefs=ankiRefs(tmpl.qfmt),arefs=ankiRefs(tmpl.afmt);
        const pick=(list,cands)=>cands.find(c=>list.some(n=>n.toLowerCase()===c.toLowerCase()));
        const frontName=pick(names,['Front','Question','Term','Word','Expression','Prompt'])
          ||qrefs.find(n=>names.includes(n))||names[0];
        const backName=pick(names,['Back','Answer','Definition','Meaning','Translation','Explanation'])
          ||arefs.find(n=>n!==frontName&&names.includes(n))
          ||names.find(n=>n!==frontName);
        w=ankiPlain(note[frontName]);
        d=ankiPlain(note[backName]);
        if(!w||!d){skipped.empty++;continue;}
        if(exampleField){
          e=ankiPlain(note[exampleField]);
        }else{
          const rest=names.filter(n=>n!==frontName&&n!==backName);
          const extraName=pick(rest,['Sentence','Notes','Extra','Context','Hint'])
            ||rest.find(n=>ankiPlain(note[n]));
          const extra=extraName?ankiPlain(note[extraName]):'';
          if(extra&&extra!==d)w=ankiPlain(w+' · '+extra);
        }
      }
      cards.push([w,d,e]);
      if(cards.length>=5000)break;
    }
    if(files['media']||files['0'])skipped.media=1;
    return {cards,skipped,total:notes.length};
  }finally{try{fs.unlinkSync(tmp);}catch{}}
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const parts = u.pathname.split('/').filter(Boolean);
  const ip = clientIp(req);

  /* ---- API ---- */
  if (parts[0] === 'api') {
    const kind = parts[1];

    if (kind === 'health' && req.method === 'GET') {
      return json(res, 200, { ok: true, ai: !!GROQ_KEY, auth: !!GOOGLE_CLIENT_ID, clientId: GOOGLE_CLIENT_ID || '' });
    }

    /* ---- sign-in: /api/auth/google, /api/auth/me, /api/auth/logout ---- */
    if (kind === 'auth') {
      const what = parts[2];

      if (what === 'me' && req.method === 'GET') {
        const u = sessionUser(req);
        return json(res, 200, {
          auth: !!GOOGLE_CLIENT_ID, clientId: GOOGLE_CLIENT_ID || '',
          user: u ? { sub: u.sub, email: u.email, name: u.name, picture: u.picture } : null,
          deletionAt: u && deletions[u.sub] ? deletions[u.sub] : null
        });
      }

      // Exchange a Google ID token for a session cookie.
      if (what === 'google' && req.method === 'POST') {
        if (!GOOGLE_CLIENT_ID) return json(res, 200, { ok: false, reason: 'off' });
        if (tooMany(ip)) return json(res, 429, { ok: false, reason: 'slow down' });
        let body;
        try { body = JSON.parse(await readBody(req)); }
        catch { return json(res, 400, { ok: false, reason: 'bad body' }); }
        const info = await verifyGoogleIdToken(body && body.credential);
        if (!info) return json(res, 401, { ok: false, reason: 'invalid token' });
        // Signing in during the 30-day grace period cancels a pending deletion.
        const deletionCanceled=!!deletions[info.sub];
        if(deletionCanceled){delete deletions[info.sub];saveJson(DELETIONS_FILE,deletions);}
        // Remember this account so its personal area (data/users/<sub>/...) is
        // owned by the account and follows the person between devices.
        if (!accounts[info.sub]) { accounts[info.sub] = Date.now(); saveAccounts(); }
        const sid = randId();
        sessions[sid] = { sub: info.sub, email: info.email, name: info.name, picture: info.picture, iat: Date.now(), exp: Date.now() + SESSION_MS };
        saveSessions();
        res.setHeader('set-cookie', sessionCookie(sid, Math.floor(SESSION_MS / 1000), isHttps(req)));
        return json(res, 200, { ok: true, deletionCanceled, user: { sub: info.sub, email: info.email, name: info.name, picture: info.picture } });
      }

      if (what === 'logout' && req.method === 'POST') {
        const sid = cookies(req)[SESSION_COOKIE];
        if (sid && sessions[sid]) { delete sessions[sid]; saveSessions(); }
        res.setHeader('set-cookie', sessionCookie('', 0, isHttps(req)));
        return json(res, 200, { ok: true });
      }

      return json(res, 404, { error: 'no route' });
    }

    /* ---- reports: automated only; no human queue ---- */
    if (kind === 'report' && req.method === 'POST') {
      if (tooMany(ip)) return json(res, 429, { ok: false, reason: 'slow down' });
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return json(res, 400, { ok: false, reason: 'bad body' }); }
      const gid = String((body && body.gid) || '').trim().slice(0, 120);
      const card = body && body.card != null ? Math.max(0, Math.min(500, +body.card || 0)) : null;
      const reason = String((body && body.reason) || 'other').slice(0, 40);
      const gidParts = gid.split('~');
      const pubDoc = gidParts.length === 2 ? store['pub/' + gidParts[0]] : null;
      if (!gid || gidParts.length !== 2 || !pubDoc || !pubDoc.decks || !pubDoc.decks[gidParts[1]]) {
        return json(res, 404, { ok: false, reason: 'unknown deck' });
      }
      const key = card == null ? gid : gid + '/' + card;
      const bucket = card == null ? reports.decks : reports.cards;
      const e = bucket[key] || (bucket[key] = { n: 0, last: 0, by: {}, reasons: {} });
      const who = crypto.createHash('sha256').update(tokenOf(req) || ip).digest('hex').slice(0, 24);
      if (!e.by[who]) {
        e.n = (+e.n || 0) + 1;
        e.by[who] = Date.now();
        e.last = Date.now();
        e.reasons[reason] = (+e.reasons[reason] || 0) + 1;
        saveJson(REPORTS_FILE, reports);
      }
      return json(res, 200, { ok: true, n: e.n, hidden: e.n >= 3 });
    }
    if (kind === 'reports' && req.method === 'GET') {
      const publicBucket = b => Object.fromEntries(Object.entries(b || {}).map(([k, v]) => [k, { n: +v.n || 0, last: +v.last || 0 }]));
      return json(res, 200, { decks: publicBucket(reports.decks), cards: publicBucket(reports.cards) });
    }

    /* ---- bug reports: appended to data/bug-reports.txt; no support desk ---- */
    if (kind === 'bug' && req.method === 'POST') {
      if (tooMany(ip)) return json(res, 429, { ok: false, reason: 'slow down' });
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return json(res, 400, { ok: false, reason: 'bad body' }); }
      const message = String((body && body.message) || '').trim().slice(0, 4000);
      if (!message) return json(res, 400, { ok: false, reason: 'empty report' });
      const page = String((body && body.page) || '').slice(0, 120);
      const version = String((body && body.version) || '').slice(0, 40);
      const ua = String(req.headers['user-agent'] || '').slice(0, 300);
      const sub = sessionSub(req) || '';
      const block = [
        '[' + new Date().toISOString() + '] page=' + (page || '-') + ' version=' + (version || '-') +
          ' user=' + (sub || '-') + ' ip=' + ip,
        message,
        'ua=' + ua,
        '---',
        '',
      ].join('\n');
      try { fs.appendFileSync(BUG_FILE, block, 'utf8'); }
      catch { return json(res, 500, { ok: false, reason: 'could not save' }); }
      return json(res, 200, { ok: true });
    }

    /* ---- account deletion: 30-day grace; no human appeal ---- */
    if (kind === 'account' && parts[2] === 'delete' && req.method === 'POST') {
      const sub = sessionSub(req);
      if (!sub) return json(res, 401, { ok: false, reason: 'sign in first' });
      if (tooMany(ip)) return json(res, 429, { ok: false, reason: 'slow down' });
      const deleteAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
      deletions[sub] = deleteAt;saveJson(DELETIONS_FILE, deletions);
      return json(res, 200, { ok: true, deleteAt });
    }
    if (kind === 'account' && parts[2] === 'deletion' && req.method === 'GET') {
      const sub = sessionSub(req);
      return json(res, 200, { ok: true, deleteAt: sub ? (deletions[sub] || null) : null });
    }

    /* ---- opt-in email reminders (default off) ---- */
    if (kind === 'reminders' && parts[2] === 'unsubscribe' && req.method === 'GET') {
      const token = String(u.searchParams.get('token') || '');
      let hit = null;
      Object.keys(reminders).forEach(sub => { if (reminders[sub] && reminders[sub].token === token) hit = sub; });
      if (hit) { reminders[hit].enabled = false; saveJson(REMINDERS_FILE, reminders); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><meta name="viewport" content="width=device-width"><p style="font:16px system-ui;padding:40px">Reminder emails are off. You can turn them back on in Memoria settings.</p>');
    }
    if (kind === 'reminders') {
      const u2 = sessionUser(req);
      if (!u2) return json(res, 401, { ok: false, reason: 'sign in first' });
      if (req.method === 'GET') {
        const r = reminders[u2.sub] || { enabled: false, interval: 7, lastSent: 0 };
        return json(res, 200, { ok: true, enabled: !!r.enabled, interval: +r.interval || 7, lastSent: +r.lastSent || 0, configured: !!RESEND_KEY });
      }
      if (req.method === 'POST') {
        if (tooMany(ip)) return json(res, 429, { ok: false, reason: 'slow down' });
        let body;
        try { body = JSON.parse(await readBody(req)); }
        catch { return json(res, 400, { ok: false, reason: 'bad body' }); }
        const enabled = !!(body && body.enabled);
        const interval = [1, 3, 7, 14, 30].includes(+((body || {}).interval)) ? +body.interval : 7;
        const r = reminders[u2.sub] || { token: randId(), lastSent: 0 };
        r.email = u2.email || r.email || '';
        r.enabled = enabled;
        r.interval = interval;
        if (!r.token) r.token = randId();
        reminders[u2.sub] = r;saveJson(REMINDERS_FILE, reminders);
        return json(res, 200, { ok: true, enabled, interval, configured: !!RESEND_KEY });
      }
      return json(res, 405, { ok: false, reason: 'method' });
    }

    /* ---- Anki .apkg import (text fields only) ---- */
    if (kind === 'import' && parts[2] === 'anki' && req.method === 'POST') {
      if (tooMany(ip)) return json(res, 429, { ok: false, reason: 'slow down' });
      let body;
      try { body = JSON.parse(await readBody(req, 30 * 1024 * 1024)); }
      catch { return json(res, 400, { ok: false, reason: 'file too large or bad body' }); }
      const b64 = String((body && body.data) || '');
      if (!b64 || b64.length > 28 * 1024 * 1024) return json(res, 400, { ok: false, reason: 'file too large' });
      try {
        const out = await parseApkg(Buffer.from(b64, 'base64'));
        return json(res, 200, { ok: true, cards: out.cards, skipped: out.skipped, total: out.total });
      } catch (e) {
        return json(res, 400, { ok: false, reason: String(e.message || 'could not read apkg').slice(0, 120) });
      }
    }

    if (kind === 'stream' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }

    // AI re-check of one typed answer: POST /api/grade {q,a,u,t}
    if (kind === 'grade' && req.method === 'POST') {
      if (!GROQ_KEY) return json(res, 200, { ok: false, reason: 'off' });
      if (aiTooMany(ip)) return json(res, 429, { ok: false, reason: 'slow down' });
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return json(res, 400, { ok: false, reason: 'bad body' }); }
      const q = String((body && body.q) || '').slice(0, 200).trim();
      const a = String((body && body.a) || '').slice(0, 400).trim();
      const u = String((body && body.u) || '').slice(0, 400).trim();
      if (!a || !u) return json(res, 200, { ok: false, reason: 'empty' });
      const blank = (body && body.t) === 'blank';
      const ck = 'g\n' + q + '\n' + a + '\n' + u + '\n' + (blank ? 'b' : 't');
      let verdict = aiCacheGet(ck);
      if (verdict === undefined) {
        verdict = await gradeWithAI(q, a, u, blank);
        if (verdict !== null) aiCacheSet(ck, verdict);
      }
      if (verdict === null) return json(res, 200, { ok: false, reason: 'unavailable' });
      return json(res, 200, { ok: true, correct: !!verdict.correct, why: verdict.why || '', closeness: verdict.closeness || 0 });
    }

    // one semantic hint for a card: POST /api/hint {q,a}
    if (kind === 'hint' && req.method === 'POST') {
      if (!GROQ_KEY) return json(res, 200, { ok: false, reason: 'off' });
      if (aiTooMany(ip)) return json(res, 429, { ok: false, reason: 'slow down' });
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return json(res, 400, { ok: false, reason: 'bad body' }); }
      const q = String((body && body.q) || '').slice(0, 200).trim();
      const a = String((body && body.a) || '').slice(0, 400).trim();
      if (!a) return json(res, 200, { ok: false, reason: 'empty' });
      const ck = 'h\n' + q + '\n' + a;
      let hint = aiCacheGet(ck);
      if (hint === undefined) {
        hint = await hintWithAI(q, a);
        if (hint) aiCacheSet(ck, hint);
      }
      if (!hint) return json(res, 200, { ok: false, reason: 'unavailable' });
      return json(res, 200, { ok: true, hint });
    }

    // list the immediate children of a collection: /api/col/<prefix...>
    if (kind === 'col' && req.method === 'GET') {
      const prefix = clean(parts.slice(2).join('/'));
      if (!prefix || prefix.includes('..')) return json(res, 400, { error: 'bad prefix' });
      const g = privateRead(req, prefix);
      if (g === 'hidden') return json(res, 403, { error: 'not available' });
      if (g === 'denied') return json(res, 403, { error: 'not yours' });
      if (g === 'empty') return json(res, 200, []);
      const head = prefix + '/', out = [];
      for (const key of Object.keys(store)) {
        if (!key.startsWith(head)) continue;
        const rest = key.slice(head.length);
        if (rest && !rest.includes('/')) out.push({ id: rest, data: store[key] });
      }
      return json(res, 200, out);
    }

    // read / write / delete one document: /api/doc/<path...>
    if (kind === 'doc') {
      const docPath = clean(parts.slice(2).join('/'));
      if (!docPath || docPath.includes('..')) return json(res, 400, { error: 'bad path' });

      if (req.method === 'GET') {
        const g = privateRead(req, docPath);
        if (g === 'hidden') return json(res, 403, { error: 'not available' });
        if (g === 'denied') return json(res, 403, { error: 'not yours' });
        if (g === 'empty' || store[docPath] === undefined) return json(res, 404, { error: 'not found' });
        return json(res, 200, store[docPath]);
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        if (tooMany(ip)) return json(res, 429, { error: 'slow down' });
        const gate = publicGate(req, docPath) || accountGate(req, docPath);
        if (gate) return json(res, gate.code, { error: gate.error });
        // With sign-in on, pub/**, votes/** and an account's own personal area
        // belong to the signed-in account (checked just above), so the
        // per-browser write token is not needed there.
        if (!(GOOGLE_CLIENT_ID && (/^(pub|votes)\//.test(docPath) || accountAreaOf(docPath)))) {
          const why = ownerCheck(req, docPath, true);
          if (why) return json(res, 403, { error: why });
        }
        let body;
        try { body = JSON.parse(await readBody(req)); }
        catch { return json(res, 400, { error: 'bad body' }); }
        const data = (body && body.data !== undefined) ? body.data : body;
        if (docPath.startsWith('pub/')) {
          const why = checkPub(data);
          if (why) return json(res, 400, { error: why });
        }
        store[docPath] = data;
        save(); broadcast();
        return json(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {
        if (tooMany(ip)) return json(res, 429, { error: 'slow down' });
        const gate = publicGate(req, docPath) || accountGate(req, docPath);
        if (gate) return json(res, gate.code, { error: gate.error });
        if (!(GOOGLE_CLIENT_ID && (/^(pub|votes)\//.test(docPath) || accountAreaOf(docPath)))) {
          const why = ownerCheck(req, docPath, false);
          if (why) return json(res, 403, { error: why });
        }
        delete store[docPath];
        if (owners[docPath] !== undefined) {
          // Inside a personal area the namespace entry still guards the space, so the
          // per-document entry can be dropped to stop owners.json growing forever.
          // Everywhere else we keep it: dropping it would let a stranger delete a path
          // and then re-create it as the same person.
          const ns = nsOf(docPath);
          if (ns && docPath !== ns) { delete owners[docPath]; saveOwners(); }
        }
        save(); broadcast();
        return json(res, 200, { ok: true });
      }
      return json(res, 405, { error: 'method' });
    }

    return json(res, 404, { error: 'no route' });
  }

  /* ---- static files (index.html and friends) ---- */
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method' });
  let rel;
  try { rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname).replace(/^\/+/, ''); }
  catch { return json(res, 400, { error: 'bad path' }); }

  const blocked =
    rel.split('/').some(seg => seg.startsWith('.')) ||
    rel === 'server.mjs' ||
    rel.endsWith('.md') ||
    rel.startsWith('data/') ||
    rel.startsWith('deploy/');
  const file = path.join(ROOT, rel);
  if (blocked || !file.startsWith(ROOT + path.sep)) return json(res, 403, { error: 'forbidden' });

  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    /* Always re-check the page instead of letting the browser guess. Without this
       a browser may keep an old copy of index.html after an update and run old
       code (this is what made AI grading look broken after it had gone live). */
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache'
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
});

sweepDeletions();
setInterval(sweepDeletions, 60 * 60 * 1000);
setInterval(sweepReminders, 60 * 60 * 1000);

server.listen(PORT, HOST, () => {
  console.log('Memoria server running');
  console.log('  On this computer:   http://localhost:' + PORT + '/');
  if (HOST === '0.0.0.0' || HOST === '::') console.log('  On your network:    http://<this-computer-ip>:' + PORT + '/');
  else console.log('  Other devices:      not directly reachable (set HOST=0.0.0.0 to allow, or use Tailscale)');
  console.log('  Data file:          ' + DB_FILE);
});
