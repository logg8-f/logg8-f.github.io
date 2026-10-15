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

const MAX_BODY = 300 * 1024; // biggest single write we accept (bytes)
const MAX_DECKS = 15;        // public decks a single publisher may have
const MIN_CARDS = 4;         // cards a public deck must have
const RATE_MAX = 40;         // writes allowed per IP in the window below
const RATE_WINDOW = 60 * 1000;

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
  const ip = req.socket.remoteAddress || '?';

  /* ---- API ---- */
  if (parts[0] === 'api') {
    const kind = parts[1];

    if (kind === 'health' && req.method === 'GET') return json(res, 200, { ok: true });

    if (kind === 'stream' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }

    // list the immediate children of a collection: /api/col/<prefix...>
    if (kind === 'col' && req.method === 'GET') {
      const prefix = clean(parts.slice(2).join('/'));
      if (!prefix || prefix.includes('..')) return json(res, 400, { error: 'bad prefix' });
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
        return store[docPath] === undefined
          ? json(res, 404, { error: 'not found' })
          : json(res, 200, store[docPath]);
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        if (tooMany(ip)) return json(res, 429, { error: 'slow down' });
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
        delete store[docPath];
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
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
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
