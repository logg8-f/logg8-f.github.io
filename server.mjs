#!/usr/bin/env node
/*
 * Quizlet 2.0 - self-hosted backend
 * ---------------------------------
 * Serves the app (index.html) AND a tiny shared database, so anyone who opens
 * this server's address can publish decks and vote without signing in.
 *
 * Run it:        node server.mjs
 * Pick a port:   PORT=8080 node server.mjs
 * Where data is: data/db.json   (delete it to start over)
 *
 * To move this to another computer you just copy the whole folder, including
 * the data/ folder, and run `node server.mjs` there.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1'; // only this machine by default; set HOST=0.0.0.0 to also allow the local network

const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const OWNERS_FILE = path.join(DATA_DIR, 'owners.json'); // path -> the token that owns it

const MAX_BODY = 300 * 1024; // biggest single write we accept (bytes)
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
  const owner = owners[ns];
  if (owner === undefined) return 'empty';
  return tokenOf(req) === owner ? 'open' : 'denied';
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
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};
function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length });
  res.end(b);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on('data', c => {
      n += c.length;
      if (n > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
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
  'Reply only as JSON: {"correct": true} or {"correct": false}.\n' +
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
    return obj && obj.correct === true;
  } catch { return null; }
  finally { clearTimeout(to); }
}

/* ---------- rules for what may be published ---------- */
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
  }
  return null;
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const parts = u.pathname.split('/').filter(Boolean);
  const ip = clientIp(req);

  /* ---- API ---- */
  if (parts[0] === 'api') {
    const kind = parts[1];

    if (kind === 'health' && req.method === 'GET') return json(res, 200, { ok: true, ai: !!GROQ_KEY });

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
      const verdict = await gradeWithAI(q, a, u, (body && body.t) === 'blank');
      if (verdict === null) return json(res, 200, { ok: false, reason: 'unavailable' });
      return json(res, 200, { ok: true, correct: verdict });
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
        const why = ownerCheck(req, docPath, true);
        if (why) return json(res, 403, { error: why });
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
        const why = ownerCheck(req, docPath, false);
        if (why) return json(res, 403, { error: why });
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

server.listen(PORT, HOST, () => {
  console.log('Quizlet 2.0 server running');
  console.log('  On this computer:   http://localhost:' + PORT + '/');
  if (HOST === '0.0.0.0' || HOST === '::') console.log('  On your network:    http://<this-computer-ip>:' + PORT + '/');
  else console.log('  Other devices:      not directly reachable (set HOST=0.0.0.0 to allow, or use Tailscale)');
  console.log('  Data file:          ' + DB_FILE);
});
