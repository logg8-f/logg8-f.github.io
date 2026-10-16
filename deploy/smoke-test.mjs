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
// Google sign-in: when the server has GOOGLE_CLIENT_ID set, publishing and
// voting require a signed-in account, which this script cannot create (it would
// need a real Google token). In that case it checks the door is actually shut
// (401 without a session) instead of the successful round-trip; the full
// signed-in flow is covered by deploy/auth-test.mjs, which runs against a local
// server with a throwaway signing key.
//
// Usage:
//   node deploy/smoke-test.mjs                       # http://localhost:8787
//   BASE=https://gaderob.tail2714bf.ts.net:8443 node deploy/smoke-test.mjs
//     (the Tailscale door terminates TLS, so it must be https, not http)
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
  headers['x-write-token'] = token === null ? '' : (token || TOKEN);
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
const pubDeck = { decks: { [deck]: { title: 'Smoke Test', desc: '', cards, choize: false, langW: '', langD: '', at: Date.now() } } };

(async () => {
  let r = await req('GET', 'health');
  ok(r.status === 200 && r.data && r.data.ok === true && typeof r.data.ai === 'boolean', 'GET api/health -> ok + ai flag');
  const authOn = !!(r.data && r.data.auth);
  console.log('    (sign-in required for publish/vote: ' + (authOn ? 'yes' : 'no') + ')');

  if (authOn) {
    // --- with Google sign-in on, publishing and voting need an account ---
    r = await req('PUT', 'doc/pub/' + publisher, { data: pubDeck });
    ok(r.status === 401, 'publishing without signing in is refused (401)');
    r = await req('PUT', 'doc/votes/' + voter, { data: { v: { [gid]: 1 } } });
    ok(r.status === 401, 'voting without signing in is refused (401)');
    r = await req('DELETE', 'doc/pub/' + publisher, null, OTHER);
    ok(r.status === 401, 'deleting a public deck without signing in is refused (401)');
  } else {
    // --- the classic no-login flow ---
    r = await req('PUT', 'doc/pub/' + publisher, { data: pubDeck });
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
  }

  // --- the personal area (data/users/<me>/...) is private, with or without sign-in ---
  r = await req('PUT', 'doc/data/users/' + publisher + '/meta', { data: { review: {}, seeded: true } });
  ok(r.status === 200, 'owner can write into their own personal area');

  r = await req('GET', 'col/data/users/' + publisher);
  ok(r.status === 200 && (Array.isArray(r.data) ? r.data : []).some(x => x.id === 'meta'),
    'owner can read their personal area (sees meta)');

  r = await req('GET', 'col/data/users/' + publisher, null, OTHER);
  ok(r.status === 403, 'another visitor CANNOT read the personal area (403)');

  r = await req('GET', 'col/data/users/' + publisher, null, null);
  ok(r.status === 403, 'a read of the personal area with no token is refused (403)');

  r = await req('GET', 'col/data/users');
  ok(r.status === 403, 'the list of visitors (col/data/users) is not listable (403)');

  r = await req('PUT', 'doc/data/users/' + publisher + '/x', { data: 1 }, OTHER);
  ok(r.status === 403, 'another visitor CANNOT write into the personal area (403)');

  r = await req('GET', 'col/pub');
  ok(r.status === 200, 'public browsing stays open (col/pub)');

  // deleting a personal doc must NOT reopen the area (the namespace entry stays)
  await req('DELETE', 'doc/data/users/' + publisher + '/meta');
  r = await req('PUT', 'doc/data/users/' + publisher + '/meta', { data: { seeded: true } });
  ok(r.status === 200, 'owner can re-create a deleted personal doc');
  r = await req('PUT', 'doc/data/users/' + publisher + '/meta', { data: 1 }, OTHER);
  ok(r.status === 403, 'the personal area stays closed after a delete (403)');

  // --- votes ---
  if (authOn) {
    r = await req('GET', 'col/votes');
    ok(r.status === 200, 'vote tallies stay readable (col/votes)');
  } else {
    r = await req('PUT', 'doc/votes/' + voter, { data: { v: { [gid]: 1 } } });
    ok(r.status === 200, 'cast a vote from another user -> {"ok":true}');

    r = await req('GET', 'col/votes');
    ok((tally(Array.isArray(r.data) ? r.data : [])[gid] || {}).up === 1, 'vote tallies to 1 like');

    await req('PUT', 'doc/votes/' + publisher, { data: { v: { [gid]: 1 } } }); // self-vote
    r = await req('GET', 'col/votes');
    ok((tally(Array.isArray(r.data) ? r.data : [])[gid] || {}).up === 1, 'self-vote is ignored (still 1)');
  }

  // cleanup (delete everything we created)
  await req('DELETE', 'doc/pub/' + publisher);
  await req('DELETE', 'doc/data/users/' + publisher + '/meta');
  await req('DELETE', 'doc/votes/' + voter);
  await req('DELETE', 'doc/votes/' + publisher);
  r = await req('GET', 'col/pub');
  ok(!(Array.isArray(r.data) ? r.data : []).some(x => x.id === publisher), 'cleanup: test deck removed');

  console.log(fails === 0 ? '\nALL PASSED (' + BASE + ')' : '\n' + fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
