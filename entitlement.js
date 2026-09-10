// PLANS, GATES AND THE SIGNED ENTITLEMENT — one definition, every client.
//
// WHY THIS IS SHARED, and it is the sharpest example in the package. "Is this user Pro" is
// currently answered in four places: the extension (`js/license.js`), the bridge
// (`src/entitlement.js`), the gateway (`src/entitlement.js`) and now a desktop app. Three of
// those already carry their own copy of the SAME public key, which is why `CLAUDE.md` has to
// warn that rotating the signing key means editing every client by hand.
//
// Duplicating a feature matrix is worse than duplicating a helper: it does not fail loudly,
// it fails as "Pro works in the browser but not on the desktop", which reads to the person
// paying for it as the product being broken. Defining it once makes the two clients agree
// BY CONSTRUCTION rather than by diligence.
//
// WHAT IS STILL THE CLIENT'S JOB (P8, as everywhere else): storing the licence, minting and
// keeping an install id, opening a browser for checkout, and counting local usage against
// the free limits. Those need storage and a platform. Everything here is pure.
//
// THE PRIVATE KEY IS NOT HERE AND NEVER WILL BE. The worker holds it; this file holds only
// the public half, which is what lets every client verify OFFLINE — chat traffic never
// touches the licence server, and a client that cannot reach the network keeps working.

export class EntitlementError extends Error {
  constructor(message) { super(message); this.name = 'EntitlementError'; }
}

export const PLANS = Object.freeze(['free', 'pro', 'team']);
const RANK = Object.freeze({ free: 0, pro: 1, team: 2 });

/** Where the licence server lives. One base; the endpoints derive from it. */
export const API_BASE = 'https://api.chatpanel.net';
export const ENDPOINTS = Object.freeze({
  verify: `${API_BASE}/license/verify`,
  entitlement: `${API_BASE}/entitlement`,
  claim: `${API_BASE}/entitlement/claim`,
  release: `${API_BASE}/entitlement/release`,
  restore: `${API_BASE}/restore`,
});

/**
 * The PUBLIC half of the entitlement signing key.
 *
 * Byte-for-byte the key the extension and bridge already embed. If it is ever rotated it is
 * rotated HERE, and every client that takes this package inherits it on its next sync —
 * which is the entire reason this module exists.
 */
export const ENTITLEMENT_PUBLIC_JWK = Object.freeze({
  kty: 'EC',
  crv: 'P-256',
  x: 'CmgKLC4e3xDMvwhbjVqF7jbDe1JhC1KKQi8JN3qVX_4',
  y: 'r40l6fQiyCcJYqW-SvB4VoSyn4F36yhSt82ZAOSo78E',
});

/** Where "Upgrade" sends people. A stable URL, so pricing can change without a release. */
export const UPGRADE_URL = 'https://chatpanel.net/#pricing';

export function checkoutUrl(plan = 'pro', installId = '', client = '') {
  const u = new URL('https://chatpanel.net/');
  if (installId) u.searchParams.set('install_id', installId);
  if (plan) u.searchParams.set('plan', plan);
  // Which client sent them, so a desktop purchase can be attributed and, later, seated
  // differently from a browser one. Additive: the site ignores what it does not read.
  if (client) u.searchParams.set('client', client);
  u.hash = 'pricing';
  return u.toString();
}

// --------------------------------------------------------------------------
// The matrix
// --------------------------------------------------------------------------

/**
 * Every gated feature → the minimum plan that unlocks it. Anything absent is free.
 *
 * Features a given client cannot perform are still listed: the desktop cannot capture a
 * meeting, but it can READ one, and `liveMeetings` gates the dashboard and history search
 * as well as capture. A client omitting a key it "does not need" is how the two drift.
 */
export const FEATURE_TIER = Object.freeze({
  localAgents: 'free',
  byoModels: 'free',
  urlContext: 'free',
  liveMeetings: 'free',

  multiTab: 'pro',
  unlimitedAgents: 'pro',
  customSkills: 'pro',
  customAgents: 'pro',
  advancedAgent: 'pro',
  unlimitedNotes: 'pro',
  unlimitedMeetings: 'pro',
  structuredInsert: 'pro',
  exportChats: 'pro',
  autoBackup: 'pro',
  promptLibrary: 'pro',
  fileAttachments: 'pro',
  watch: 'pro',

  cloudSync: 'team',
  sharedLibrary: 'team',
  hostedBridge: 'team',
  sso: 'team',
});

export const PRO_FEATURES = Object.freeze({
  unlimitedNotes: 'Unlimited notes — Free keeps your first 10',
  unlimitedMeetings: 'Unlimited meetings — Free keeps your first 10',
  multiTab: 'Attach several tabs at once',
  unlimitedAgents: 'Unlimited custom agents',
  customSkills: 'Create & edit your own skills',
  advancedAgent: 'Per-agent system prompts & working directories',
  structuredInsert: 'Clean diagrams on Excalidraw, draw.io & tldraw — shapes placed as data, not pixel-drawn',
  exportChats: 'Export conversations as Markdown',
  autoBackup: 'Automatic daily backup of all your data to disk',
  watch: 'Watch a page & act on changes — the agent reacts as the page updates',
});

export const TEAM_FEATURES = Object.freeze({
  cloudSync: 'Sync chats across your devices',
  sharedLibrary: 'Shared team agents & skills',
  hostedBridge: 'Hosted agents — no local bridge to run',
  sso: 'SSO & admin controls',
});

/** Free-tier ceilings. LIFETIME counts where noted — see the anti-cheat note in each client. */
export const FREE_LIMITS = Object.freeze({
  notes: 10,
  meetings: 10,
  apiEndpoints: 1,
  bridgeAgents: 1,
  customAgents: 1,
  attachmentsPerMessage: 1,
  mcpServers: 1,
  gatewayDestinations: 1,
  webSearchEngines: 3,
  webSearchesPerDay: 50,
  fullRedactions: 25,
});

// --------------------------------------------------------------------------
// Resolution
// --------------------------------------------------------------------------

/**
 * The plan actually in force.
 *
 * An expired licence is `free`, checked against an injected `now` so a client cannot be
 * tested only at the moment it happens to be run.
 */
export function planOf(license, now = Date.now()) {
  if (!license || !PLANS.includes(license.plan)) return 'free';
  if (license.expiresAt && now > license.expiresAt) return 'free';
  return license.plan;
}

export function planLabel(license, now = Date.now()) {
  return { free: 'Free', pro: 'Pro', team: 'Team' }[planOf(license, now)];
}

export function isPro(license, now = Date.now()) {
  return RANK[planOf(license, now)] >= RANK.pro;
}

export function isTeam(license, now = Date.now()) {
  return planOf(license, now) === 'team';
}

/** Gate a feature. `count` expresses "this would be my Nth", for the counted allowances. */
export function can(license, feature, count = 0, now = Date.now()) {
  const plan = planOf(license, now);
  if (feature === 'unlimitedAgents' && RANK[plan] < RANK.pro) {
    return count < FREE_LIMITS.customAgents;
  }
  const need = FEATURE_TIER[feature] || 'free';
  return RANK[plan] >= RANK[need];
}

/** The minimum plan a feature needs — for an upgrade prompt that names the right tier. */
export function tierFor(feature) {
  return FEATURE_TIER[feature] || 'free';
}

/**
 * Is this the Nth use of a lifetime-capped free allowance?
 *
 * The count is MONOTONIC — "how many have ever been created", not "how many exist now" —
 * because a cap on the current count is lifted by deleting things, which is not a limit.
 */
export function withinFreeLimit(license, key, everCount, now = Date.now()) {
  if (isPro(license, now)) return true;
  const cap = FREE_LIMITS[key];
  return typeof cap !== 'number' || everCount < cap;
}

// --------------------------------------------------------------------------
// The signed token
// --------------------------------------------------------------------------

function b64urlToBytes(s) {
  const pad = '='.repeat((4 - (String(s).length % 4)) % 4);
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/') + pad;
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodePayload(head) {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(head)));
  } catch {
    return null;
  }
}

let _keyPromise = null;

async function verifyKey(subtle) {
  const s = subtle || globalThis.crypto?.subtle;
  if (!s) throw new EntitlementError('no WebCrypto available on this runtime');
  if (subtle) {
    // An injected implementation must not be memoised into the shared slot, or a test that
    // passes one would poison every later call in the process.
    return s.importKey('jwk', ENTITLEMENT_PUBLIC_JWK, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  }
  if (!_keyPromise) {
    _keyPromise = s.importKey('jwk', ENTITLEMENT_PUBLIC_JWK, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  }
  return _keyPromise;
}

/**
 * The payload field names the WORKER actually signs. Not negotiable, and not guessable:
 * `server/src/worker.js` grant() signs `{ typ:'ent', install_id, plan, sub, iat, exp }`,
 * and the extension checks `p.typ !== 'ent' || p.install_id !== installId`.
 *
 * Written down here because getting them wrong fails in the worst possible way: the
 * signature verifies, the token is genuine, and the binding check reads `undefined` — so
 * every real token is rejected and the user is told their licence is invalid. That is
 * exactly what happened when this module first read `payload.install`.
 */
export const TOKEN_TYPE = 'ent';

/**
 * Verify a server entitlement token and return its payload, or `null`.
 *
 * Four checks, and all four matter: the SIGNATURE (it came from the worker), the TYPE (a
 * `claim` token is also signed by the same key and must not be accepted as an entitlement),
 * the INSTALL BINDING (issued to this device, so a token copied from a forum grants
 * nothing), and EXPIRY. Returning null rather than throwing is deliberate — a caller
 * resolving a licence at startup must degrade to free, not crash the app.
 */
export async function verifyEntitlement(token, installId, { subtle = null, now = Date.now() } = {}) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [head, sig] = token.split('.');
  if (!head || !sig) return null;

  let ok = false;
  try {
    const s = subtle || globalThis.crypto?.subtle;
    ok = await s.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      await verifyKey(subtle),
      b64urlToBytes(sig),
      new TextEncoder().encode(head),
    );
  } catch {
    return null;
  }
  if (!ok) return null;

  const payload = decodePayload(head);
  if (!payload) return null;
  // The same key signs `claim` and `restore` tokens. Accepting one of those as an
  // entitlement would turn a portable, install-independent token into a licence.
  if (payload.typ !== TOKEN_TYPE) return null;
  if (payload.exp && now > Number(payload.exp)) return null;
  // `install_id` binds the token to one device. A token with no binding is refused rather
  // than treated as universal — "unbound" must never be the permissive case.
  if (!payload.install_id || (installId && payload.install_id !== installId)) return null;
  if (!PLANS.includes(payload.plan)) return null;
  return payload;
}

/**
 * A verified payload → the licence record a client stores.
 *
 * TWO EXPIRIES, AND CONFLATING THEM COSTS SOMEONE THEIR PRO.
 *
 *   · `tokenExp` is the signed token's TTL — about a week. It exists so a revoked device
 *     stops working without the server having to reach it.
 *   · `expiresAt` is when the SUBSCRIPTION ends, which the server returns beside the token.
 *
 * `planOf` lapses a licence at `expiresAt`. Setting that from the token's TTL means anyone
 * offline for longer than the TTL silently drops to Free while still paying — which is
 * exactly the bug this signature now prevents by taking the subscription's date separately.
 * With no server date the licence does not expire locally; the next successful check is
 * what corrects it, and that is the safer direction to be wrong in.
 */
export function licenseFromPayload(payload, { at = Date.now(), expiresAt = 0 } = {}) {
  if (!payload) return { plan: 'free' };
  return {
    plan: payload.plan,
    expiresAt: Number(expiresAt) || 0,
    tokenExp: Number(payload.exp) || 0,
    installId: payload.install_id || '',
    sub: payload.sub || null,
    checkedAt: at,
    source: 'entitlement',
  };
}

/**
 * Should this client re-check with the server yet?
 *
 * Offline verification is the point, so the cadence is generous — but a licence that has
 * NEVER been checked, or one whose expiry is close, is worth a call. Pure so the schedule is
 * testable without waiting a day.
 */
export const RECHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

export function needsRecheck(license, { now = Date.now(), interval = RECHECK_INTERVAL_MS } = {}) {
  if (!license || !license.checkedAt) return true;
  if (now - license.checkedAt > interval) return true;
  // Inside the last day of either deadline, check eagerly: a renewal lands near the
  // subscription date, and the token has to be replaced before ITS ttl runs out or the
  // client is left holding something it can no longer prove.
  const soon = 24 * 60 * 60 * 1000;
  if (license.expiresAt && license.expiresAt - now < soon) return true;
  if (license.tokenExp && license.tokenExp - now < soon) return true;
  return false;
}
