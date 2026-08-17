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

test('the default list is a starting point the user can edit, not a floor', () => {
  // A developer testing against localhost may genuinely want that traffic to reach a cloud
  // model. If the built-ins were silently prepended to whatever they typed, removing one
  // would be impossible and the rule would look broken rather than configurable.
  const mine = ['acme-corp.example'];
  assert.equal(classifySource('http://localhost:3000', { patterns: mine }).internal, false);
  assert.equal(classifySource('https://clp.acme-corp.example', { patterns: mine }).internal, true);
  // An empty list protects nothing by host — that is a choice, and it must be possible.
  assert.equal(classifySource('http://10.1.1.1', { patterns: [] }).internal, false);
});

test('an unreadable source stays internal however the host list is edited', () => {
  // Failing closed is a separate rule from the host patterns: it is about a URL we could not
  // read at all, which no list can express.
  assert.equal(classifySource('not a url', { patterns: [] }).internal, true);
});

// ── IPv6, now that the default list names v6 ranges ─────────────────────────

test('IPv6 loopback, link-local and unique-local are internal', () => {
  assert.equal(classifySource('http://[::1]:8080/x').internal, true);
  assert.equal(classifySource('http://[fe80::1]/x').internal, true);
  assert.equal(classifySource('http://[fd12:3456::1]/x').internal, true);
  // The long form of the same address is the same address.
  assert.equal(hostMatches('0:0:0:0:0:0:0:1', '::1'), true);
});

test('a public IPv6 address is not swept in by the intranet rule', () => {
  // It has no dots and is not IPv4 — the first version matched it, which would have pinned
  // every v6 host on the internet as internal.
  assert.equal(classifySource('http://[2606:4700::1111]/x').internal, false);
});

test('a v6 prefix is matched by BITS, not by leading text', () => {
  // fc00::/7 covers fc00–fdff. The boundary falls inside a hex digit, so a "starts with"
  // comparison gets it wrong in both directions.
  assert.equal(hostMatches('fdff:ffff::1', 'fc00::/7'), true);
  assert.equal(hostMatches('fe00::1', 'fc00::/7'), false);
  assert.equal(hostMatches('febf:ffff::1', 'fe80::/10'), true);
  assert.equal(hostMatches('fec0::1', 'fe80::/10'), false);
});

test('v4 and v6 never match across families', () => {
  assert.equal(hostMatches('10.0.0.1', 'fc00::/7'), false);
  assert.equal(hostMatches('fc00::1', '10.0.0.0/8'), false);
});

test('malformed v6 is rejected rather than half-parsed', () => {
  assert.equal(hostMatches('fc00::1::2', 'fc00::/7'), false);
  assert.equal(hostMatches('gggg::1', 'fc00::/7'), false);
});

test('carrier-grade NAT space, which some corporate networks use, is covered', () => {
  assert.equal(classifySource('http://100.70.0.1').internal, true);
  assert.equal(classifySource('http://100.63.0.1').internal, false, '…and stops at the range boundary');
});
