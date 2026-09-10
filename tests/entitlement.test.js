import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  PLANS, FEATURE_TIER, FREE_LIMITS, PRO_FEATURES, TEAM_FEATURES, ENDPOINTS,
  ENTITLEMENT_PUBLIC_JWK, checkoutUrl,
  planOf, planLabel, isPro, isTeam, can, tierFor, withinFreeLimit,
  verifyEntitlement, licenseFromPayload, needsRecheck, RECHECK_INTERVAL_MS,
} from '../entitlement.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

const pro = { plan: 'pro', expiresAt: NOW + 30 * DAY };
const team = { plan: 'team', expiresAt: NOW + 30 * DAY };

// --------------------------------------------------------------------------
// The matrix
// --------------------------------------------------------------------------

test('every feature tier names a real plan', () => {
  for (const [feature, plan] of Object.entries(FEATURE_TIER)) {
    assert.ok(PLANS.includes(plan), `${feature} → ${plan}`);
  }
});

test('every advertised Pro and Team feature is actually gated at that tier', () => {
  // The failure this prevents: a marketing list promising something the gate lets through
  // free, or gates at the wrong tier.
  for (const f of Object.keys(PRO_FEATURES)) assert.equal(tierFor(f), 'pro', f);
  for (const f of Object.keys(TEAM_FEATURES)) assert.equal(tierFor(f), 'team', f);
});

test('an unknown feature is free, not accidentally locked', () => {
  assert.equal(tierFor('somethingNobodyGatedYet'), 'free');
  assert.equal(can(null, 'somethingNobodyGatedYet', 0, NOW), true);
});

// --------------------------------------------------------------------------
// Resolution
// --------------------------------------------------------------------------

test('no licence is free', () => {
  assert.equal(planOf(null, NOW), 'free');
  assert.equal(planLabel(null, NOW), 'Free');
  assert.equal(isPro(null, NOW), false);
});

test('an expired licence is free, judged against an injected clock', () => {
  const lapsed = { plan: 'pro', expiresAt: NOW - 1 };
  assert.equal(planOf(lapsed, NOW), 'free');
  assert.equal(isPro(lapsed, NOW), false);
  assert.equal(isPro(lapsed, NOW - DAY), true, 'and was Pro before it lapsed');
});

test('team outranks pro everywhere pro is required', () => {
  assert.equal(isPro(team, NOW), true);
  assert.equal(isTeam(pro, NOW), false);
  assert.equal(can(team, 'exportChats', 0, NOW), true);
});

test('a pro licence does not unlock team features', () => {
  assert.equal(can(pro, 'cloudSync', 0, NOW), false);
  assert.equal(can(team, 'cloudSync', 0, NOW), true);
});

test('free gets a counted allowance of custom agents before Pro is required', () => {
  assert.equal(can(null, 'unlimitedAgents', 0, NOW), true);
  assert.equal(can(null, 'unlimitedAgents', FREE_LIMITS.customAgents, NOW), false);
  assert.equal(can(pro, 'unlimitedAgents', 99, NOW), true);
});

test('a lifetime cap counts what was EVER created, so deleting does not lift it', () => {
  assert.equal(withinFreeLimit(null, 'notes', FREE_LIMITS.notes - 1, NOW), true);
  assert.equal(withinFreeLimit(null, 'notes', FREE_LIMITS.notes, NOW), false);
  assert.equal(withinFreeLimit(pro, 'notes', 10_000, NOW), true);
});

test('an unknown limit key does not silently block the user', () => {
  assert.equal(withinFreeLimit(null, 'noSuchLimit', 1e9, NOW), true);
});

// --------------------------------------------------------------------------
// The signed token
// --------------------------------------------------------------------------

const b64url = (bytes) => Buffer.from(bytes).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function makeSigner() {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  );
  const jwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  // A subtle stand-in whose importKey ignores the baked-in public JWK and returns OUR test
  // key — so the token path can be exercised without the real private key existing anywhere.
  const subtle = {
    importKey: () => webcrypto.subtle.importKey(
      'jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
    ),
    verify: (...args) => webcrypto.subtle.verify(...args),
  };
  const sign = async (payload) => {
    const head = b64url(new TextEncoder().encode(JSON.stringify(payload)));
    const sig = await webcrypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(head),
    );
    return `${head}.${b64url(new Uint8Array(sig))}`;
  };
  return { subtle, sign };
}

test('a validly signed, correctly bound token verifies', async () => {
  const { subtle, sign } = await makeSigner();
  const token = await sign({ plan: 'pro', install: 'dev-1', exp: NOW + DAY });
  const payload = await verifyEntitlement(token, 'dev-1', { subtle, now: NOW });
  assert.equal(payload.plan, 'pro');
});

test('a token issued to ANOTHER install is refused — pasting one from a forum grants nothing', () => {
  return makeSigner().then(async ({ subtle, sign }) => {
    const token = await sign({ plan: 'pro', install: 'someone-else', exp: NOW + DAY });
    assert.equal(await verifyEntitlement(token, 'dev-1', { subtle, now: NOW }), null);
  });
});

test('a token with NO install binding is refused — unbound must not mean universal', async () => {
  const { subtle, sign } = await makeSigner();
  const token = await sign({ plan: 'pro', exp: NOW + DAY });
  assert.equal(await verifyEntitlement(token, 'dev-1', { subtle, now: NOW }), null);
});

test('an expired token is refused', async () => {
  const { subtle, sign } = await makeSigner();
  const token = await sign({ plan: 'pro', install: 'dev-1', exp: NOW - 1 });
  assert.equal(await verifyEntitlement(token, 'dev-1', { subtle, now: NOW }), null);
});

test('a tampered payload is refused', async () => {
  const { subtle, sign } = await makeSigner();
  const token = await sign({ plan: 'free', install: 'dev-1', exp: NOW + DAY });
  const forged = `${b64url(new TextEncoder().encode(JSON.stringify({ plan: 'team', install: 'dev-1', exp: NOW + DAY })))}.${token.split('.')[1]}`;
  assert.equal(await verifyEntitlement(forged, 'dev-1', { subtle, now: NOW }), null);
});

test('a token signed by the WRONG key is refused', async () => {
  const a = await makeSigner();
  const b = await makeSigner();
  const token = await a.sign({ plan: 'pro', install: 'dev-1', exp: NOW + DAY });
  assert.equal(await verifyEntitlement(token, 'dev-1', { subtle: b.subtle, now: NOW }), null);
});

test('garbage never throws — a licence check degrades to free, it does not crash the app', async () => {
  for (const bad of [null, '', 'nodot', '..', 'a.b', undefined, 42]) {
    assert.equal(await verifyEntitlement(bad, 'dev-1', { now: NOW }), null, String(bad));
  }
});

test('an unknown plan in a signed token is refused', async () => {
  const { subtle, sign } = await makeSigner();
  const token = await sign({ plan: 'enterprise', install: 'dev-1', exp: NOW + DAY });
  assert.equal(await verifyEntitlement(token, 'dev-1', { subtle, now: NOW }), null);
});

test('a payload becomes the licence record a client stores', () => {
  const lic = licenseFromPayload({ plan: 'pro', install: 'dev-1', exp: NOW + DAY }, { at: NOW });
  assert.equal(lic.plan, 'pro');
  assert.equal(lic.expiresAt, NOW + DAY);
  assert.equal(lic.checkedAt, NOW);
  assert.equal(isPro(lic, NOW), true);
});

test('no payload becomes a free licence rather than undefined', () => {
  assert.equal(licenseFromPayload(null).plan, 'free');
});

// --------------------------------------------------------------------------
// Re-check cadence
// --------------------------------------------------------------------------

test('a licence never checked is due immediately', () => {
  assert.equal(needsRecheck(null, { now: NOW }), true);
  assert.equal(needsRecheck({ plan: 'pro' }, { now: NOW }), true);
});

test('a freshly checked licence is not re-checked — offline verification is the point', () => {
  const lic = { plan: 'pro', checkedAt: NOW, expiresAt: NOW + 30 * DAY };
  assert.equal(needsRecheck(lic, { now: NOW + 60_000 }), false);
});

test('a licence near expiry is checked eagerly, so a renewal is not missed mid-sentence', () => {
  const lic = { plan: 'pro', checkedAt: NOW, expiresAt: NOW + 3 * 60 * 60 * 1000 };
  assert.equal(needsRecheck(lic, { now: NOW + 60_000 }), true);
});

test('a stale check is due again', () => {
  const lic = { plan: 'pro', checkedAt: NOW, expiresAt: NOW + 30 * DAY };
  assert.equal(needsRecheck(lic, { now: NOW + RECHECK_INTERVAL_MS + 1 }), true);
});

// --------------------------------------------------------------------------
// Server surface
// --------------------------------------------------------------------------

test('every endpoint hangs off one https base', () => {
  for (const [name, url] of Object.entries(ENDPOINTS)) {
    assert.match(url, /^https:\/\/api\.chatpanel\.net\//, name);
  }
});

test('checkout carries the install so the purchase seats THIS device', () => {
  const u = new URL(checkoutUrl('pro', 'dev-1', 'desktop'));
  assert.equal(u.searchParams.get('install_id'), 'dev-1');
  assert.equal(u.searchParams.get('client'), 'desktop');
  assert.equal(u.hash, '#pricing');
});

test('the embedded key is a public P-256 JWK and carries no private half', () => {
  assert.equal(ENTITLEMENT_PUBLIC_JWK.kty, 'EC');
  assert.equal(ENTITLEMENT_PUBLIC_JWK.crv, 'P-256');
  assert.equal('d' in ENTITLEMENT_PUBLIC_JWK, false, 'a private scalar must never ship in a client');
});
