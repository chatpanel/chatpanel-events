import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineModel, defineMiddleware, defineRouteStrategy, createModelRouter, signalsFrom, RouterError } from '../router.js';

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

// ── the DECISION is a plugin too ────────────────────────────────────────────

test('a strategy chooses among the eligible, and says it did', async () => {
  // Scoring by latency and cost is one strategy, not the only defensible one — a classifier
  // could route by task, a learned model by what has worked before, a user by pinning one.
  const byTask = defineRouteStrategy({
    id: 'by-task', classUsed: 'M',
    decide: async (eligible, need) => (need.task === 'vision' ? eligible.find((m) => m.capabilities.includes('vision')) : null),
  });
  const router = mk({ strategies: [byTask] });
  const r = await router.routeWith({ task: 'vision' });
  assert.equal(r.model.id, 'cloud');
  assert.equal(r.strategy, 'by-task');
  assert.ok(r.reasons.some((x) => /by-task.*class M/.test(x)), 'the strategy and its cost were not reported');
});

test('a strategy CANNOT widen past the hard constraints', async () => {
  // The invariant that has to survive any strategy, however clever or learned: a router
  // confidently naming a forbidden model must not be able to overrule reach.
  const rogue = defineRouteStrategy({ id: 'rogue', decide: async () => 'cloud' });
  const r = await mk({ strategies: [rogue] }).routeWith({ reach: 'device' });
  assert.equal(r.model.id, 'local', 'a strategy routed past a device-only requirement');
  assert.equal(r.strategy, 'default-score', 'an ineligible pick was treated as an opinion');
});

test('a partly-ineligible suggestion keeps its legal half and reports the rest', async () => {
  const mixed = defineRouteStrategy({ id: 'mixed', decide: async () => ['cloud', 'local'] });
  const r = await mk({ strategies: [mixed] }).routeWith({ reach: 'device' });
  assert.equal(r.model.id, 'local');
  assert.ok(r.reasons.some((x) => /1 suggestion\(s\) ignored/.test(x)));
});

test('a strategy with no opinion abstains and the next one is asked', async () => {
  const quiet = defineRouteStrategy({ id: 'quiet', decide: async () => null });
  const loud = defineRouteStrategy({ id: 'loud', decide: async () => 'gateway' });
  const r = await mk({ strategies: [quiet, loud] }).routeWith({ reach: 'trusted', capabilities: ['tools'] });
  assert.equal(r.strategy, 'loud');
});

test('the first opinion wins — later strategies are not asked', async () => {
  // A chain that kept consulting after an answer would spend a model call per strategy to
  // produce one decision.
  let asked = 0;
  const first = defineRouteStrategy({ id: 'first', decide: async () => 'local' });
  const second = defineRouteStrategy({ id: 'second', decide: async () => { asked++; return 'cloud'; } });
  const r = await mk({ strategies: [first, second] }).routeWith({});
  assert.equal(r.strategy, 'first');
  assert.equal(asked, 0);
});

test('a strategy that throws, hangs or is disabled never breaks routing', async () => {
  // Routing must not fail because the thing that picks a model was slow, offline or wrong.
  // A router that can fail is worse than one that is occasionally suboptimal.
  const boom = defineRouteStrategy({ id: 'boom', decide: async () => { throw new Error('down'); } });
  assert.equal((await mk({ strategies: [boom] }).routeWith({})).strategy, 'default-score');

  const hang = defineRouteStrategy({ id: 'hang', timeoutMs: 10, decide: () => new Promise(() => {}) });
  assert.equal((await mk({ strategies: [hang] }).routeWith({})).strategy, 'default-score');

  const off = defineRouteStrategy({ id: 'off', decide: async () => 'cloud' });
  const router = mk({ strategies: [off], admit: (x) => x.id !== 'off' });
  assert.equal((await router.routeWith({})).strategy, 'default-score');
});

test('run() uses the strategy chain, and the middleware still applies', async () => {
  const pin = defineRouteStrategy({ id: 'pin', decide: async () => 'gateway' });
  const seen = [];
  const router = mk({
    strategies: [pin],
    middleware: [defineMiddleware({ id: 'note', stage: 'request', run: async (r, ctx) => { seen.push(ctx.model.id); return r; } })],
  });
  const { decision } = await router.run({ text: 'x' }, { dispatch: async () => 'ok', need: { capabilities: ['tools'] } });
  assert.equal(decision.model.id, 'gateway');
  assert.deepEqual(seen, ['gateway'], 'middleware did not see the strategy-chosen model');
});

test('strategy declarations are checked, and registration is revertible', () => {
  assert.throws(() => defineRouteStrategy({ id: 'x' }), (e) => e.code === 'BAD_STRATEGY');
  assert.throws(() => defineRouteStrategy({ decide: async () => {} }), (e) => e.code === 'BAD_STRATEGY');
  const router = mk();
  const un = router.addStrategy(defineRouteStrategy({ id: 's', decide: async () => null }));
  assert.equal(router.strategies().length, 1);
  un();
  assert.equal(router.strategies().length, 0);
});

// ── constraints beyond privacy: deadline, budget, live health ───────────────

test('a deadline eliminates, it does not discount', async () => {
  // "Answer within 800ms" is a requirement in the same sense privacy is. Treating it as a
  // weight is how a live voice reply ends up on the cheapest model that takes four seconds.
  const r = mk().route({ maxLatencyMs: 500 });
  assert.equal(r.model.id, 'cloud');
  assert.ok(r.rejected.some((x) => x.id === 'local' && /exceeds the 500ms deadline/.test(x.why)));
});

test('a budget eliminates too, and zero is a real budget', async () => {
  const r = mk().route({ maxCostPer1k: 0 });
  assert.equal(r.model.id, 'local');
  assert.ok(r.rejected.some((x) => x.id === 'cloud' && /over the 0 budget/.test(x.why)));
});

test('a rate-limited model is unavailable, not merely worse', () => {
  // Ranking it lower would still let it win when it is the only one left — and then fail.
  const throttled = defineModel({ id: 'throttled', reach: 'device', rateLimited: true });
  const r = createModelRouter({ models: [throttled] }).route({ reach: 'device' });
  assert.equal(r.model, null);
  assert.ok(r.rejected.some((x) => /rate limited/.test(x.why)));
});

test('a measured latency replaces the declared one', () => {
  // A number typed into a config is a guess about a service that changes hourly; a number we
  // recorded is what it actually did.
  const m = defineModel({ id: 'm', latencyMs: 300, observedLatencyMs: 2400 });
  assert.equal(m.latencyMs, 2400);
  assert.equal(m.declaredLatencyMs, 300);
  // The declared value still stands for a model never called.
  assert.equal(defineModel({ id: 'n', latencyMs: 300 }).latencyMs, 300);
});

test('an unknown quality is average, not zero', () => {
  // Scoring unknown as zero would bury every model we have not benchmarked, and the router
  // would permanently prefer whatever it happened to measure first.
  const known = defineModel({ id: 'known', reach: 'any', latencyMs: 1000, costPer1k: 1, quality: 0.9 });
  const unknown = defineModel({ id: 'unknown', reach: 'any', latencyMs: 1000, costPer1k: 1 });
  const weak = defineModel({ id: 'weak', reach: 'any', latencyMs: 1000, costPer1k: 1, quality: 0.2 });
  const r = createModelRouter({ models: [unknown, known, weak] }).route({ prefer: 'quality' });
  assert.equal(r.model.id, 'known');
  assert.deepEqual(r.runnersUp, ['unknown', 'weak'], 'an unbenchmarked model was ranked below a known-bad one');
});

// ── the cheap rung of the escalation ladder ─────────────────────────────────

test('signals are read from the request for free', () => {
  // Sending a request to a classifier to discover it contains an image, or is four hundred
  // tokens long, spends a model call to learn something already visible.
  const s = signalsFrom({ text: 'hi' });
  assert.equal(s.complexity, 'low');
  assert.equal(s.modality, 'text');
  assert.ok(s.approxTokens >= 0);

  assert.equal(signalsFrom({ text: 'x'.repeat(5000) }).complexity, 'high');
  // A keyword in a twenty-character message is a sentence, not a project.
  assert.equal(signalsFrom({ text: 'refactor this please' }).complexity, 'low');
  // The same keyword with enough text around it to be describing real work does count.
  assert.equal(signalsFrom({ text: `refactor this module. ${'context '.repeat(40)}` }).complexity, 'high');
  // And plain prose of that length is medium, so length alone is not doing the work.
  assert.equal(signalsFrom({ text: 'a '.repeat(150) }).complexity, 'medium');
  assert.equal(signalsFrom({ text: '```js\nconst a = 1\n```' }).complexity, 'high');
  assert.equal(signalsFrom({ images: [{}] }).modality, 'vision');
  assert.equal(signalsFrom({ attachments: [{ type: 'audio/wav' }] }).modality, 'audio');
  assert.equal(signalsFrom({ text: 'これはテストです' }).nonLatin, true);
  assert.equal(signalsFrom({ text: 'plain english' }).nonLatin, false);
  // Messages are read as well as raw text, since that is the shape a turn actually has.
  assert.ok(signalsFrom({ messages: [{ content: 'x'.repeat(5000) }] }).complexity === 'high');
  // An empty request is answerable, not an error.
  assert.equal(signalsFrom({}).modality, 'text');
});

test('signals feed a strategy without the router deciding what they mean', async () => {
  // The router supplies facts; what counts as "needs the big model" is policy, and policy
  // belongs in a strategy that can be swapped, not in the thing everyone shares.
  const escalate = defineRouteStrategy({
    id: 'complexity', classUsed: 'R',
    decide: async (eligible, need) => (need.signals?.complexity === 'high'
      ? eligible.find((m) => m.capabilities.includes('vision')) : eligible.find((m) => m.costPer1k === 0)),
  });
  const router = mk({ strategies: [escalate] });
  const hard = await router.routeWith({ signals: signalsFrom({ text: 'x'.repeat(5000) }) });
  assert.equal(hard.model.id, 'cloud');
  const easy = await router.routeWith({ signals: signalsFrom({ text: 'hi' }) });
  assert.equal(easy.model.id, 'local');
});
