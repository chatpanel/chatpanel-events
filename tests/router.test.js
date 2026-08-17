import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineModel, defineMiddleware, createModelRouter, RouterError } from '../router.js';

const local = defineModel({ id: 'local', reach: 'device', classUsed: 'L', capabilities: ['json'], costPer1k: 0, latencyMs: 1200 });
const gateway = defineModel({ id: 'gateway', reach: 'trusted', classUsed: 'M', capabilities: ['json', 'tools'], costPer1k: 0.2, latencyMs: 600 });
const cloud = defineModel({ id: 'cloud', reach: 'any', classUsed: 'C', capabilities: ['json', 'tools', 'vision'], costPer1k: 3, latencyMs: 400 });
const mk = (over = {}) => createModelRouter({ models: [local, gateway, cloud], ...over });

// ── privacy is a ceiling, not a preference ──────────────────────────────────

test('a device-only request can never reach a third party', () => {
  // The single worst bug this codebase could have. A privacy requirement that a cheaper or
  // faster model could outweigh is not a requirement.
  const r = mk().route({ reach: 'device' });
  assert.equal(r.model.id, 'local');
  assert.ok(r.rejected.some((x) => x.id === 'cloud' && /exceeds/.test(x.why)));
  assert.ok(r.rejected.some((x) => x.id === 'gateway'));
});

test('cheap and fast cannot buy their way past reach', () => {
  const tempting = defineModel({ id: 'cheap-cloud', reach: 'any', costPer1k: 0, latencyMs: 1 });
  const r = createModelRouter({ models: [local, tempting] }).route({ reach: 'device', prefer: 'cost' });
  assert.equal(r.model.id, 'local');
});

test('trusted reach admits the gateway but still not the cloud', () => {
  const r = mk().route({ reach: 'trusted' });
  assert.deepEqual(r.rejected.map((x) => x.id), ['cloud']);
  // Local still wins here, and should: it is free and allowed under 'trusted', so a paid
  // gateway would have to be justified by something other than being further away.
  assert.equal(r.model.id, 'local');
  // The gateway wins the moment the request needs something local cannot do.
  assert.equal(mk().route({ reach: 'trusted', capabilities: ['tools'] }).model.id, 'gateway');
});

// ── capability eliminates, it does not discount ─────────────────────────────

test('a model missing a required capability is rejected, not merely ranked lower', () => {
  const r = mk().route({ capabilities: ['vision'] });
  assert.equal(r.model.id, 'cloud');
  assert.ok(r.rejected.some((x) => x.id === 'local' && /missing vision/.test(x.why)));
});

test('nothing eligible is an explained failure, not a silent fallback', () => {
  // Falling back to "any model at all" is how a device-only request quietly goes to a
  // third party.
  const r = mk().route({ reach: 'device', capabilities: ['vision'] });
  assert.equal(r.model, null);
  assert.match(r.reasons[0], /no candidate/);
  assert.ok(r.rejected.length >= 3);
});

// ── preference orders survivors ─────────────────────────────────────────────

test('preference changes the winner among equals, and says so', () => {
  assert.equal(mk().route({ prefer: 'latency' }).model.id, 'cloud');
  assert.equal(mk().route({ prefer: 'cost' }).model.id, 'local');
  const r = mk().route({ prefer: 'cost' });
  assert.match(r.reasons.at(-1), /best by cost/);
  assert.ok(r.runnersUp.length, 'the alternatives were not reported');
});

test('load makes a model worse at everything, not slightly pricier', () => {
  const busy = defineModel({ id: 'busy', reach: 'any', latencyMs: 300, costPer1k: 1, load: 1 });
  const idle = defineModel({ id: 'idle', reach: 'any', latencyMs: 500, costPer1k: 1, load: 0 });
  assert.equal(createModelRouter({ models: [busy, idle] }).route({ prefer: 'latency' }).model.id, 'idle');
});

test('an unavailable or disabled model is rejected with the reason', () => {
  const down = defineModel({ id: 'down', reach: 'device', available: false });
  const r = createModelRouter({ models: [down, local], admit: (m) => m.id !== 'local' }).route({ reach: 'device' });
  assert.equal(r.model, null);
  assert.deepEqual(r.rejected.map((x) => x.why).sort(), ['disabled', 'unavailable']);
});

test('the same inputs always give the same answer', () => {
  // Routing is class R. A tie broken by insertion order or object identity would make the
  // decision unreproducible, which defeats the point of it being a rule.
  const a = defineModel({ id: 'a', reach: 'any', latencyMs: 500, costPer1k: 1 });
  const b = defineModel({ id: 'b', reach: 'any', latencyMs: 500, costPer1k: 1 });
  assert.equal(createModelRouter({ models: [a, b] }).route({}).model.id, 'a');
  assert.equal(createModelRouter({ models: [b, a] }).route({}).model.id, 'a');
});

// ── the pipeline ────────────────────────────────────────────────────────────

test('request steps run in order and response steps unwind symmetrically', async () => {
  // Getting this backwards is how a vault is restored before the text it protects comes back.
  const seen = [];
  const step = (id, stage, priority) => defineMiddleware({
    id, stage, priority, run: async (x) => { seen.push(`${stage}:${id}`); return x; },
  });
  const router = mk({ middleware: [step('redact', 'request', 10), step('tools', 'request', 20), step('restore', 'response', 10), step('cite', 'response', 20)] });
  await router.run({ text: 'hi' }, { dispatch: async () => 'answer' });
  assert.deepEqual(seen, ['request:redact', 'request:tools', 'response:cite', 'response:restore']);
});

test('a step transforms what the model actually receives, and what the caller gets back', async () => {
  const router = mk({
    middleware: [
      defineMiddleware({ id: 'redact', stage: 'request', run: async (r) => ({ ...r, text: r.text.replace('Alex', '[[NAME_1]]') }) }),
      defineMiddleware({ id: 'restore', stage: 'response', run: async (a) => a.replace('[[NAME_1]]', 'Alex') }),
    ],
  });
  let sawByModel = null;
  const { answer } = await router.run({ text: 'call Alex' }, { dispatch: async (p) => { sawByModel = p.text; return `told [[NAME_1]]`; } });
  assert.equal(sawByModel, 'call [[NAME_1]]', 'the model saw the unredacted text');
  assert.equal(answer, 'told Alex');
});

test('a step REQUIRED for a route fails the request when it is not active', async () => {
  // The property this whole structure exists for: "redaction must run before a third party
  // sees this" becomes structural rather than a habit — and a disabled plugin cannot
  // quietly turn it off.
  const redact = defineMiddleware({
    id: 'redact', stage: 'request',
    requiredFor: (model) => model.reach === 'any',
    run: async (r) => r,
  });
  const router = mk({ middleware: [redact], admit: (m) => m.id !== 'redact' });
  await assert.rejects(
    () => router.run({ text: 'x' }, { dispatch: async () => 'ok', need: { reach: 'any', prefer: 'latency' } }),
    (e) => e instanceof RouterError && e.code === 'MISSING_REQUIRED',
  );
});

test('a step required only for the cloud does not block a local route', async () => {
  const redact = defineMiddleware({
    id: 'redact', stage: 'request', requiredFor: (model) => model.reach === 'any', run: async (r) => r,
  });
  const router = mk({ middleware: [redact], admit: (m) => m.id !== 'redact' });
  const { decision } = await router.run({ text: 'x' }, { dispatch: async () => 'ok', need: { reach: 'device' } });
  assert.equal(decision.model.id, 'local');
});

test('routing failure is raised, never routed around', async () => {
  await assert.rejects(
    () => mk().run({}, { dispatch: async () => 'x', need: { reach: 'device', capabilities: ['vision'] } }),
    (e) => e.code === 'NO_ROUTE',
  );
});

test('declarations are checked at declare time', () => {
  assert.throws(() => defineModel({ id: 'x', reach: 'space' }), (e) => e.code === 'BAD_MODEL');
  assert.throws(() => defineModel({}), (e) => e instanceof RouterError);
  assert.throws(() => defineMiddleware({ id: 'x', stage: 'whenever', run: async () => {} }), (e) => e.code === 'BAD_MIDDLEWARE');
  assert.throws(() => defineMiddleware({ id: 'x', stage: 'request' }), (e) => e.code === 'BAD_MIDDLEWARE');
});

test('registration is revertible for both models and steps', () => {
  const router = createModelRouter({});
  const un1 = router.addModel(local);
  const un2 = router.use(defineMiddleware({ id: 'm', stage: 'request', run: async (x) => x }));
  assert.equal(router.models().length, 1);
  assert.equal(router.middleware().length, 1);
  un1(); un2();
  assert.equal(router.models().length, 0);
  assert.equal(router.middleware().length, 0);
});
