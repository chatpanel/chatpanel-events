import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySource, hostMatches, meetReach, sourcePolicyFor, DEFAULT_INTERNAL_PATTERNS } from '../sources.js';

// ── the guard only ever narrows ─────────────────────────────────────────────

test('reach ceilings compose by meet — nothing downstream can widen them', () => {
  assert.equal(meetReach('any', 'device'), 'device');
  assert.equal(meetReach('device', 'any'), 'device');
  assert.equal(meetReach('trusted', 'any'), 'trusted');
  // An unknown ceiling is not a licence to travel further.
  assert.equal(meetReach('any', 'whatever'), 'any');
  assert.equal(meetReach('nonsense', 'trusted'), 'trusted');
  assert.equal(meetReach('nonsense', 'alsononsense'), 'device');
});

// ── what the address itself proves ──────────────────────────────────────────

test('private address space is internal without any configuration', () => {
  for (const u of [
    'http://10.4.2.9/dashboard', 'https://192.168.1.10', 'http://172.16.5.5:8080/x',
    'http://127.0.0.1:3000', 'http://localhost:8080', 'https://169.254.10.1',
  ]) assert.equal(classifySource(u).internal, true, `${u} should be internal`);
});

test('a public host is left alone', () => {
  for (const u of ['https://example.com/docs', 'https://en.wikipedia.org', 'https://8.8.8.8']) {
    assert.equal(classifySource(u).internal, false, `${u} should be public`);
  }
});

test('a single-label host can only resolve on a private network', () => {
  assert.equal(classifySource('http://wiki/page').internal, true);
  assert.equal(classifySource('http://tickets:8080/browse/X-1').internal, true);
});

test('a CIDR boundary is respected rather than approximated', () => {
  // 172.16/12 covers 172.16–172.31; 172.32 is public space and must not be swept in.
  assert.equal(classifySource('http://172.31.255.254').internal, true);
  assert.equal(classifySource('http://172.32.0.1').internal, false);
  assert.equal(classifySource('http://11.0.0.1').internal, false);
});

// ── failing closed ──────────────────────────────────────────────────────────

test('an unreadable URL counts as internal, not as public', () => {
  // The whole point is to avoid sending internal material out. A string we cannot parse is
  // not evidence that it is safe to send.
  assert.equal(classifySource('not a url').internal, true);
  assert.equal(classifySource('http://').internal, true);
  assert.equal(classifySource('file:///Users/x/notes.md').internal, true);
});

test('an empty source is not a source at all', () => {
  assert.equal(classifySource('').internal, false);
  assert.equal(classifySource(null).internal, false);
});

test('the extension\'s own pages are not "internal sources"', () => {
  // Pinning every turn to a local model because the panel itself is a chrome-extension: URL
  // would make the feature look broken and get switched off.
  assert.equal(classifySource('chrome-extension://abc/sidepanel.html').internal, false);
  assert.equal(classifySource('about:blank').internal, false);
});

// ── the user's own patterns ─────────────────────────────────────────────────

test('a bare domain covers its subdomains, because that is what people mean', () => {
  assert.equal(hostMatches('wiki.acme-internal.example', 'acme-internal.example'), true);
  assert.equal(hostMatches('acme-internal.example', 'acme-internal.example'), true);
  assert.equal(hostMatches('acme-internal.example.attacker.test', 'acme-internal.example'), false);
  // The explicit wildcard means the same thing, so both spellings work.
  assert.equal(hostMatches('wiki.acme-internal.example', '*.acme-internal.example'), true);
});

test('a pattern form we do not support matches nothing, loudly rather than silently', () => {
  // A half-supported glob that quietly matches nothing looks like protection and is not.
  assert.equal(hostMatches('a.corp.acme.example', '*.corp.*'), false);
});

// ── one internal source pins the whole turn ─────────────────────────────────

test('any internal source pins the turn, even mixed with public ones', () => {
  const p = sourcePolicyFor(['https://example.com/a', 'http://10.1.1.1/b'], {});
  assert.equal(p.internal, true);
  assert.equal(p.reach, 'device');
  assert.match(p.why, /10\.1\.1\.1/, 'The person can see which source pinned it.');
});

test('a workspace ceiling admits a trusted gateway but still not the cloud', () => {
  const p = sourcePolicyFor(['http://10.1.1.1/b'], { ceiling: 'trusted' });
  assert.equal(p.reach, 'trusted');
  assert.match(p.why, /workspace/);
});

test('an internal source cannot widen a request that was already device-only', () => {
  const p = sourcePolicyFor(['http://10.1.1.1'], { ceiling: 'trusted', base: 'device' });
  assert.equal(p.reach, 'device', 'The ceiling narrows; it never relaxes what was stricter.');
});

test('public sources leave the request exactly as it was', () => {
  const p = sourcePolicyFor(['https://example.com'], { base: 'any' });
  assert.equal(p.internal, false);
  assert.equal(p.reach, 'any');
  assert.equal(p.why, null);
});

test('sources may be objects with a url, as attachments are', () => {
  assert.equal(sourcePolicyFor([{ url: 'http://192.168.0.5/x' }]).internal, true);
  assert.equal(sourcePolicyFor([{ href: 'http://192.168.0.5/x' }]).internal, true);
  assert.equal(sourcePolicyFor([{ title: 'no url here' }]).internal, false);
});

test('the defaults claim only what an address proves', () => {
  // A corporate wiki on a public SaaS domain is indistinguishable from any other public host
  // from here. Detecting it would need the user's own pattern, and pretending otherwise
  // would give false confidence.
  assert.equal(classifySource('https://acme.atlassian.net/wiki').internal, false);
  assert.equal(
    classifySource('https://acme.atlassian.net/wiki', { patterns: [...DEFAULT_INTERNAL_PATTERNS, 'acme.atlassian.net'] }).internal,
    true,
  );
});
