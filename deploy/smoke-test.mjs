#!/usr/bin/env node
// Smoke test for the Quizlet 2.0 backend.
//
// Exercises the SAME requests the browser UI makes (index.html): the API probe,
// publishing a deck, browsing the public collection, voting and the vote tally,
// the server-side limits, the write-token protection, and a write/delete
// round-trip. It is read-mostly but writes a few clearly-namespaced test
// documents and DELETES them again at the end, so it is safe to run against the
// live server.
//
// Usage:
//   node deploy/smoke-test.mjs                       # http://localhost:8787
//   BASE=http://gaderob.tail2714bf.ts.net:8443 node deploy/smoke-test.mjs
//
// Exits non-zero if any check fails.

const BASE = (process.env.BASE || 'http://localhost:8787').replace(/\/+$/, '') + '/api/';
const NS = 'smoke-' + Date.now().toString(36); // unique per run, easy to spot
const TOKEN = 'tok-' + NS;        // the visitor's secret write token
const OTHER = 'tok-other-' + NS;  // a second visitor, with no rights to ours
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS' : 'FAIL') + ': ' + msg); if (!cond) fails++; };

async function req(method, path, body, token) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-write-token'] = token === null ? '' : (token || TOKEN);
  const r = await fetch(BASE + path, {
    method,
    cache: 'no-store',
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
}

// Exact same aggregation as index.html tally().
function tally(voteDocs) {
  const t = {};
  for (const doc of voteDocs) {
    const u = doc.id, mv = (doc.data && doc.data.v) || {};
    for (const g of Object.keys(mv)) {
      if (g.split('~')[0] === u) continue; // self-votes ignored
      const e = t[g] || (t[g] = { up: 0, down: 0 });
      if (mv[g] === 1) e.up++; else if (mv[g] === -1) e.down++;
    }
  }
  return t;
}

const cards = [['q1','a1'],['q2','a2'],['q3','a3'],['q4','a4']];
const publisher = NS + '-pub', voter = NS + '-voter', deck = 'd1', gid = publisher + '~' + deck;

(async () => {
  let r = await req('GET', 'health');
  ok(r.status === 200 && r.data && r.data.ok === true, 'GET api/health -> {ok:true}');

  r = await req('PUT', 'doc/pub/' + publisher, { data: { decks: { [deck]: {
    title: 'Smoke Test', desc: '', cards, choize: false, langW: '', langD: '', at: Date.now() } } } });
  ok(r.status === 200 && r.data && r.data.ok === true, 'publish a valid deck -> {"ok":true}');

  r = await req('GET', 'col/pub');
  const listed = (Array.isArray(r.data) ? r.data : []).find(x => x.id === publisher);
  ok(!!listed && listed.data.decks[deck].cards.length === 4, 'Browse (col/pub) lists it with all 4 cards');

  r = await req('PUT', 'doc/pub/' + NS + '-bad', { data: { decks: { d: { title: 'x', cards: cards.slice(0, 3) } } } });
  ok(r.status === 400, 'rejects a deck with <4 cards');

  const many = {}; for (let i = 0; i < 16; i++) many['k' + i] = { title: 't', cards };
  r = await req('PUT', 'doc/pub/' + NS + '-many', { data: { decks: many } });
  ok(r.status === 400, 'rejects a publisher with >15 decks');

  // --- write-token protection (the thing that makes public publishing safe) ---
  r = await req('PUT', 'doc/pub/' + publisher, { data: { decks: { [deck]: { title: 'Hijacked', cards } } } }, OTHER);
  ok(r.status === 403, 'another visitor CANNOT overwrite our deck (403)');

  r = await req('GET', 'col/pub');
  const still = (Array.isArray(r.data) ? r.data : []).find(x => x.id === publisher);
  ok(!!still && still.data.decks[deck].title === 'Smoke Test', 'our deck is untouched after the hijack attempt');

  r = await req('DELETE', 'doc/pub/' + publisher, null, OTHER);
  ok(r.status === 403, 'another visitor CANNOT delete our deck (403)');

  r = await req('PUT', 'doc/pub/' + NS + '-notoken', { data: { decks: { d: { title: 't', cards } } } }, null);
  ok(r.status === 403, 'a write with no token is refused (403)');

  r = await req('PUT', 'doc/pub/' + publisher, { data: { decks: { [deck]: {
    title: 'Smoke Test 2', cards, at: Date.now() } } } });
  ok(r.status === 200, 'the owner CAN still overwrite their own deck');

  // --- votes ---
  r = await req('PUT', 'doc/votes/' + voter, { data: { v: { [gid]: 1 } } });
  ok(r.status === 200, 'cast a vote from another user -> {"ok":true}');

  r = await req('GET', 'col/votes');
  ok((tally(Array.isArray(r.data) ? r.data : [])[gid] || {}).up === 1, 'vote tallies to 1 like');

  await req('PUT', 'doc/votes/' + publisher, { data: { v: { [gid]: 1 } } }); // self-vote
  r = await req('GET', 'col/votes');
  ok((tally(Array.isArray(r.data) ? r.data : [])[gid] || {}).up === 1, 'self-vote is ignored (still 1)');

  // cleanup (delete everything we created)
  await req('DELETE', 'doc/pub/' + publisher);
  await req('DELETE', 'doc/votes/' + voter);
  await req('DELETE', 'doc/votes/' + publisher);
  r = await req('GET', 'col/pub');
  ok(!(Array.isArray(r.data) ? r.data : []).some(x => x.id === publisher), 'cleanup: test deck removed');

  console.log(fails === 0 ? '\nALL PASSED (' + BASE + ')' : '\n' + fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
