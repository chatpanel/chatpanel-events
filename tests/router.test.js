import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineModel, defineMiddleware, defineRouteStrategy, createModelRouter, signalsFrom, requirementsFor, requirementsForStep, preferenceFor, sameModelKey, RouterError } from '../router.js';

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

test('a model that already failed this request is not re-picked', () => {
  // Without this, failover re-picks the model that just returned 402 and the retry is a loop.
  const first = mk().route({ prefer: 'cost' });
  const next = mk().route({ prefer: 'cost', exclude: [first.model.id] });
  assert.notEqual(next.model.id, first.model.id);
  assert.ok(next.rejected.some((x) => x.id === first.model.id && /already failed/.test(x.why)));

  // Excluding everything is an explained dead end, not a silent fallback to the failed one.
  const all = mk().route({ exclude: ['local', 'gateway', 'cloud'] });
  assert.equal(all.model, null);
});

test('provider preference breaks ties, alphabet does not', () => {
  // Ties were breaking on id, which is not a preference — it is the absence of one, and it
  // sent every equal choice to whichever provider happened to sort first.
  const viaAggregator = defineModel({ id: 'zzz-direct', reach: 'any', model: 'gpt-5', latencyMs: 700, costPer1k: 3, providerRank: 10 });
  const viaDirect = defineModel({ id: 'aaa-router', reach: 'any', model: 'gpt-5', latencyMs: 700, costPer1k: 3, providerRank: 80 });
  const r = createModelRouter({ models: [viaDirect, viaAggregator] }).route({});
  assert.equal(r.model.id, 'zzz-direct', 'the alphabetically-first provider won over the preferred one');
});

test('preference never outranks a real difference', () => {
  // It is a TIEBREAK. A preferred provider that is slower and dearer should still lose, or
  // the preference quietly becomes a hard pin.
  const preferredButWorse = defineModel({ id: 'pref', reach: 'any', latencyMs: 4000, costPer1k: 9, providerRank: 0 });
  const better = defineModel({ id: 'better', reach: 'any', latencyMs: 500, costPer1k: 1, providerRank: 99 });
  assert.equal(createModelRouter({ models: [preferredButWorse, better] }).route({}).model.id, 'better');
});

// ── requirements eliminate; cost and speed only order what survives ─────────

test('a structured task sets a quality FLOOR, not a preference', () => {
  // The escalation strategy only ever expressed a preference, so a drawing needing exact
  // coordinates was allowed to consider an 8B model — it merely ranked lower, and ranked
  // lower still wins once the better ones decline. That is how a chain of five ended on a
  // model that could not do the job.
  const req = requirementsFor({ complexity: 'high' }, { structured: true, hasTools: true });
  assert.ok(req.required.includes('tools'));
  assert.ok(req.minQuality >= 0.55);
  assert.ok(req.why.length, 'the requirement gave no reason for itself');

  const tiny = defineModel({ id: 'tiny', reach: 'any', capabilities: ['tools'], quality: 0.3, costPer1k: 0, latencyMs: 100 });
  const good = defineModel({ id: 'good', reach: 'any', capabilities: ['tools'], quality: 0.9, costPer1k: 5, latencyMs: 900 });
  const r = createModelRouter({ models: [tiny, good] }).route({ ...req, capabilities: req.required });
  assert.equal(r.model.id, 'good', 'a cheap fast model beat the quality this task needs');
  assert.ok(r.rejected.some((x) => x.id === 'tiny' && /below the quality/.test(x.why)));
});

test('an easy request sets no floor, so cost decides', () => {
  const req = requirementsFor({ complexity: 'low' }, {});
  assert.equal(req.minQuality, 0);
  const tiny = defineModel({ id: 'tiny', reach: 'any', quality: 0.3, costPer1k: 0 });
  const good = defineModel({ id: 'good', reach: 'any', quality: 0.9, costPer1k: 5 });
  assert.equal(createModelRouter({ models: [tiny, good] }).route({ ...req, prefer: 'cost' }).model.id, 'tiny');
});

test('a floor nothing meets is relaxed VISIBLY, and only the floor', () => {
  // Leaving the user with no answer is worse than a mediocre one — but relaxing silently
  // would hide why the result is poor. Reach and capability are never relaxed: those are not
  // preferences about how well something goes.
  const onlyTiny = defineModel({ id: 'tiny', reach: 'any', capabilities: ['tools'], quality: 0.3 });
  const r = createModelRouter({ models: [onlyTiny] }).route({ minQuality: 0.8, capabilities: ['tools'] });
  assert.equal(r.model.id, 'tiny');
  assert.equal(r.relaxed, true);
  assert.ok(r.reasons.some((x) => /no model met the quality/.test(x)));

  // A capability nothing has is still a dead end, not a relaxation.
  assert.equal(createModelRouter({ models: [onlyTiny] }).route({ minQuality: 0.8, capabilities: ['vision'] }).model, null);
});

test('requirements are read from the request, not guessed', () => {
  const vision = requirementsFor(signalsFrom({ images: [{}] }), {});
  assert.ok(vision.required.includes('vision'));

  const big = requirementsFor(signalsFrom({ text: 'x'.repeat(120_000) }), {});
  assert.ok(big.required.includes('long-context'));

  const code = requirementsFor(signalsFrom({ text: '```js\nfunction f() { return 1; }\n```' }), {});
  assert.ok(code.required.includes('coding'));

  // A fence is unambiguous at any length; a keyword in prose is not.
  assert.ok(requirementsFor(signalsFrom({ text: '```js\nf()\n```' }), {}).required.includes('coding'));
  assert.ok(!requirementsFor(signalsFrom({ text: 'can you import my notes' }), {}).required.includes('coding'),
    'prose mentioning a keyword was read as a programming task');

  // A short greeting requires nothing at all — the point of deriving requirements is that
  // most turns have none.
  assert.deepEqual(requirementsFor(signalsFrom({ text: 'hi' }), {}).required, []);
});

test('a missing capability is relaxed in order, and tools never', () => {
  // A text-only model CAN drive a page badly, and badly beats not at all — but a model that
  // cannot call tools would ignore half the request, so that one is not negotiable.
  const textOnly = defineModel({ id: 'text', reach: 'any', capabilities: ['tools'], quality: 0.9 });
  const req = { capabilities: ['tools', 'vision'], negotiable: ['vision'], minQuality: 0 };
  const r = createModelRouter({ models: [textOnly] }).route({ ...req });
  assert.equal(r.model.id, 'text');
  assert.equal(r.relaxed, true);
  assert.ok(r.reasons.some((x) => /no model offers vision/.test(x)), 'the relaxation was silent');

  // With no tool-capable model at all, there is no answer — relaxing that would produce one
  // that ignores the tools the turn is carrying.
  const noTools = defineModel({ id: 'chat', reach: 'any', capabilities: [], quality: 0.9 });
  assert.equal(createModelRouter({ models: [noTools] }).route({ ...req }).model, null);
});

test('a vision-capable model is preferred over a relaxation', () => {
  const seeing = defineModel({ id: 'sees', reach: 'any', capabilities: ['tools', 'vision'], quality: 0.6, costPer1k: 9 });
  const blindButCheap = defineModel({ id: 'blind', reach: 'any', capabilities: ['tools'], quality: 0.9, costPer1k: 0 });
  const r = createModelRouter({ models: [blindButCheap, seeing] })
    .route({ capabilities: ['tools', 'vision'], negotiable: ['vision'] });
  assert.equal(r.model.id, 'sees', 'a cheaper blind model beat one that can actually see the page');
  assert.ok(!r.relaxed);
});

test('a step declares what IT needs, not what the turn needs', () => {
  // A turn is a chain of sub-tasks with different demands: read the canvas (structure),
  // decide what to draw (reasoning), look at the result (vision), write it (structure).
  // Choosing one model for all of them means paying frontier prices to run a loop, or doing
  // the hard parts with something that cannot.
  assert.deepEqual(requirementsForStep('page', { action: 'screenshot' }).required, ['vision']);
  assert.deepEqual(requirementsForStep('page', { action: 'read_canvas' }).required, ['vision']);

  // Writing an exact payload needs structure, not sight.
  const write = requirementsForStep('page', { action: 'structured_insert' });
  assert.deepEqual(write.required, ['tools']);
  assert.ok(write.minQuality >= 0.55);
  assert.ok(!write.required.includes('vision'), 'writing a payload was made a vision task');

  // Reading a page as TEXT is not a vision task either — that was the whole point of
  // read_page existing.
  assert.ok(!requirementsForStep('page', { action: 'read_page' }).required.includes('vision'));

  assert.deepEqual(requirementsForStep('').required, []);
});

test('a page turn does not require vision for the whole turn', () => {
  // Requiring it turn-wide would rule out a strong reasoning model that drives the page well
  // and only needs to see a screenshot occasionally.
  const req = requirementsFor({}, { pageTools: true, hasTools: true });
  assert.ok(req.required.includes('tools'));
  assert.ok(!req.required.includes('vision'), 'one step that looks made the whole turn a vision task');
  assert.ok(req.minQuality >= 0.55);
});

// ── the Order a user sets by hand must actually decide ──────────────────────

test('the same model at two providers is settled by order, not by a cost guess', () => {
  // The complaint that surfaced this: order was a tie-break on exact float equality, which
  // two candidates essentially never hit, so the setting did nothing. When the model is
  // IDENTICAL only the path differs — and the path is exactly what order expresses.
  const fast = defineModel({ id: 'via-aggregator', model: 'deepseek/deepseek-v4-flash', reach: 'any', costPer1k: 0.1, latencyMs: 300, providerRank: 30, orderPinned: true });
  const preferred = defineModel({ id: 'via-first-party', model: 'deepseek-ai/DeepSeek-V4-Flash', reach: 'any', costPer1k: 0.5, latencyMs: 900, providerRank: 10, orderPinned: true });
  const r = createModelRouter({ models: [fast, preferred] }).route({});
  assert.equal(r.model.id, 'via-first-party', 'Lower order wins between two routes to one model.');
  // The loser stays directly behind it: same model elsewhere is the closest fallback there is.
  assert.equal(r.runnersUp[0], 'via-aggregator');
});

test('order breaks a near-tie between different models', () => {
  const a = defineModel({ id: 'a', model: 'alpha', costPer1k: 1, latencyMs: 1000, quality: 0.6, providerRank: 40 });
  const b = defineModel({ id: 'b', model: 'beta', costPer1k: 1.03, latencyMs: 1000, quality: 0.6, providerRank: 10 });
  const r = createModelRouter({ models: [a, b] }).route({});
  assert.equal(r.model.id, 'b', 'A 3% cost gap is noise; the stated order decides.');
  // The lever that made it, AND how many actually tied — "a tie among 16 eligible" was read
  // as sixteen models scoring the same when two did.
  assert.match(r.reasons.at(-1), /order 10 broke a 2-way tie by balanced, of 2 eligible/,
    'The decision names the lever that made it, and the real size of the tie.');
});

test('order is a tie-break, not an override — a clearly better model still wins', () => {
  const cheap = defineModel({ id: 'cheap', model: 'alpha', costPer1k: 0.1, latencyMs: 500, quality: 0.6, providerRank: 90 });
  const dear = defineModel({ id: 'dear', model: 'beta', costPer1k: 8, latencyMs: 4000, quality: 0.6, providerRank: 1 });
  const r = createModelRouter({ models: [cheap, dear] }).route({});
  assert.equal(r.model.id, 'cheap', 'Order must not outrank a real, large difference.');
  assert.match(r.reasons.at(-1), /best by/, 'and the reason says so');
});

test('same-model identity survives provider prefixes and tags', () => {
  assert.equal(sameModelKey({ model: 'deepseek-ai/DeepSeek-V4-Flash' }), sameModelKey({ model: 'deepseek/deepseek-v4-flash' }));
  assert.equal(sameModelKey({ model: 'gemma4:latest' }), sameModelKey({ model: 'gemma4' }));
  assert.notEqual(sameModelKey({ model: 'gpt-5.5' }), sameModelKey({ model: 'gpt-5' }));
  // Two unnamed models are NOT the same model — merging them would hide one entirely.
  assert.equal(sameModelKey({}), '');
});

test('an order we merely inferred does not overrule a genuinely cheaper route', () => {
  // The distinction that makes rule 1 safe. A person who ranks two routes by hand can see
  // the prices and chose anyway, so their order stands. An order derived from a URL is a
  // guess about reliability — letting it quietly pick the 5x more expensive route to the
  // SAME model would be the router overriding a real number with an opinion.
  const dear = defineModel({ id: 'first-party', model: 'acme/thinker', costPer1k: 5, latencyMs: 900, providerRank: 1010 });
  const cheap = defineModel({ id: 'aggregator', model: 'acme-ai/Thinker', costPer1k: 0.4, latencyMs: 900, providerRank: 1030 });
  assert.equal(createModelRouter({ models: [dear, cheap] }).route({}).model.id, 'aggregator');

  // Pin the same ranking by hand and it is honoured — the user outranks the guess.
  const pinned = defineModel({ ...dear, providerRank: 1, orderPinned: true });
  assert.equal(createModelRouter({ models: [pinned, cheap] }).route({}).model.id, 'first-party');
});

test('an inferred order still settles two routes that cost the same', () => {
  const direct = defineModel({ id: 'direct', model: 'acme/thinker', costPer1k: 1, latencyMs: 900, providerRank: 1010 });
  const hop = defineModel({ id: 'hop', model: 'acme-ai/Thinker', costPer1k: 1, latencyMs: 900, providerRank: 1030 });
  assert.equal(createModelRouter({ models: [hop, direct] }).route({}).model.id, 'direct', 'Fewer hops wins when nothing else separates them.');
});

// ── equipment is not demand ─────────────────────────────────────────────────

test('a greeting does not inherit a quality floor from the armed tools', () => {
  // With page actions switched on, EVERY turn carried pageTools, so "hello" acquired the
  // 0.55 floor meant for driving a page and was routed to a CLI coding agent. A floor should
  // come from what was asked for.
  const chat = requirementsFor(signalsFrom({ text: 'hello' }), { pageTools: true, hasTools: true });
  assert.equal(chat.minQuality, 0, 'Small talk sets no floor…');
  assert.ok(chat.negotiable.includes('tools'), '…and does not insist on a capability nothing will call.');

  // The same turn, asked to do something, keeps every requirement.
  const work = requirementsFor(signalsFrom({ text: 'draw a circle around the logo' }), { pageTools: true, hasTools: true });
  assert.ok(work.minQuality >= 0.55, 'Real page work still sets the floor…');
  assert.ok(!work.negotiable.includes('tools'), '…and still requires tools.');
});

test('short does not mean trivial — a question about your data is work', () => {
  // "whats my longest streak" is shorter than most greetings and needs the page to answer.
  // Detecting small talk by LENGTH alone would have sent it to a model that cannot read one.
  const r = requirementsFor(signalsFrom({ text: 'whats my longest streak' }), { pageTools: true, hasTools: true });
  assert.ok(r.minQuality >= 0.55);
  assert.ok(!r.negotiable.includes('tools'));
});

test('small talk is recognised through a typo', () => {
  // Matched by the ABSENCE of an action verb or a reference to the user's data, not against a
  // list of greetings — a list fails on the first misspelling, and people misspell.
  assert.equal(signalsFrom({ text: 'what can yo uhelp with' }).smalltalk, true);
  assert.equal(signalsFrom({ text: 'hi' }).smalltalk, true);
  assert.equal(signalsFrom({ text: 'summarise this page' }).smalltalk, false);
  assert.equal(signalsFrom({ text: '```js\nf()\n```' }).smalltalk, false, 'Code is never small talk.');
});

test('a question about something is work, not small talk', () => {
  // The action-verb list was a list of things you DO, so asking to UNDERSTAND matched nothing
  // and came back as small talk. That is what makes preferenceFor ask for latency, and the
  // latency axis reads nothing but milliseconds — so a genuine question was routed for speed
  // and went past a free local model to a third party.
  assert.equal(signalsFrom({ text: 'can you explain what this project does?' }).smalltalk, false);
  assert.equal(signalsFrom({ text: 'why is the build failing' }).smalltalk, false);
  assert.equal(signalsFrom({ text: 'how does routing pick a model' }).smalltalk, false);
  assert.equal(signalsFrom({ text: 'compare these two options' }).smalltalk, false);

  // And the pleasantries this test exists to catch are still pleasantries. 'how' is admitted
  // only when it opens a question about something, or "how are you" would have flipped.
  assert.equal(signalsFrom({ text: 'how are you' }).smalltalk, true);
  assert.equal(signalsFrom({ text: 'what can yo uhelp with' }).smalltalk, true);
  assert.equal(signalsFrom({ text: 'hi' }).smalltalk, true);
});

test('asking for code is a coding request, not only pasting some', () => {
  // `code` read the MATERIAL and nothing else, so a request with no fence required no coding
  // capability — which made the per-model Coding switch unreachable: turning it off for one
  // agent changed nothing, because nothing ever asked for it, and that agent kept winning.
  assert.equal(signalsFrom({ text: 'write a function that debounces this' }).code, true);
  assert.equal(signalsFrom({ text: 'fix the bug in the export module' }).code, true);
  assert.ok(requirementsFor(signalsFrom({ text: 'refactor this component to use hooks' })).required.includes('coding'));

  // A verb NEXT TO a code noun, because either alone is ordinary prose — and a signal that
  // fires on prose would put a quality floor on every message.
  assert.equal(signalsFrom({ text: 'write a note about the offsite' }).code, false);
  assert.equal(signalsFrom({ text: 'can you test whether the room is free' }).code, false);
  assert.equal(signalsFrom({ text: 'update my address' }).code, false);
});

test('nearer wins a close call, and loses a real difference', () => {
  // The provider order claims "the user's own machine: no quota, no outage, no third party"
  // and could never act on it — providerRank only arranges a near-tie, and a local model and
  // a hosted one are almost never inside the tie band. So every preference weighed time and
  // money and ignored where the request goes.
  const near = defineModel({ id: 'near', reach: 'device', capabilities: [], costPer1k: 0, latencyMs: 1000, quality: 0.6 });
  const far = defineModel({ id: 'far', reach: 'any', capabilities: [], costPer1k: 0, latencyMs: 900, quality: 0.6 });
  assert.equal(createModelRouter({ models: [near, far] }).route({}).model.id, 'near',
    'a third party won a coin-flip against the user\'s own machine');
  assert.equal(createModelRouter({ models: [near, far] }).route({ prefer: 'latency' }).model.id, 'near');

  // But it is a nudge, not a veto: a model that is genuinely much faster still wins.
  const quick = defineModel({ id: 'quick', reach: 'any', capabilities: [], costPer1k: 0, latencyMs: 300, quality: 0.6 });
  assert.equal(createModelRouter({ models: [near, quick] }).route({ prefer: 'latency' }).model.id, 'quick');

  // And it never touches 'quality' — a nearer model is not a better one, and saying so would
  // invert that axis the way dividing by quality once inverted speed and cost.
  const strong = defineModel({ id: 'strong', reach: 'any', capabilities: [], costPer1k: 3, latencyMs: 900, quality: 0.9 });
  assert.equal(createModelRouter({ models: [near, strong] }).route({ prefer: 'quality' }).model.id, 'strong');
});

test('reach is still a ceiling — the nudge never admits what the ceiling excluded', () => {
  const near = defineModel({ id: 'near', reach: 'device', capabilities: [], costPer1k: 0, latencyMs: 1000, quality: 0.6 });
  const far = defineModel({ id: 'far', reach: 'any', capabilities: [], costPer1k: 0, latencyMs: 100, quality: 0.9 });
  const r = createModelRouter({ models: [near, far] }).route({ reach: 'device', prefer: 'latency' });
  assert.equal(r.model.id, 'near');
  assert.ok(r.rejected.some((x) => x.id === 'far' && /exceeds/.test(x.why)));
});

test('a greeting can be answered by a small local model, and work cannot', () => {
  const small = defineModel({ id: 'local-small', reach: 'device', model: 'gemma4', capabilities: ['json'], quality: 0.5, costPer1k: 0, latencyMs: 700 });
  const agent = defineModel({ id: 'cli', reach: 'trusted', model: 'gpt-5.6', capabilities: ['json', 'tools', 'coding'], quality: 0.9, costPer1k: 2, latencyMs: 4000 });
  const router = createModelRouter({ models: [small, agent] });

  const hi = router.route(requirementsFor(signalsFrom({ text: 'hello' }), { pageTools: true, hasTools: true }));
  assert.equal(hi.model.id, 'local-small', 'Free, local and instant is the right answer to "hello".');

  const job = router.route({ ...requirementsFor(signalsFrom({ text: 'draw a circle around the logo' }), { pageTools: true, hasTools: true }), capabilities: ['tools'] });
  assert.equal(job.model.id, 'cli', 'and the capable one still gets the actual work');
});

// ── the score trades; it does not annihilate ────────────────────────────────

test('a free model is ordered by its other qualities, not flattened to zero', () => {
  // The balanced score MULTIPLIED time by money, so one zero wiped out everything else:
  // every free model scored exactly 0. A local 8B and a local 26B were indistinguishable
  // and the winner fell to provider order, then to alphabetical id — which is how "hi" and
  // a refactor got the same answer for no stated reason.
  const small = defineModel({ id: 'small', reach: 'device', capabilities: [], costPer1k: 0, latencyMs: 1350, quality: 0.3 });
  const mid = defineModel({ id: 'mid', reach: 'device', capabilities: [], costPer1k: 0, latencyMs: 1800, quality: 0.6 });
  const r = createModelRouter({ models: [small, mid] }).route({});
  assert.equal(r.model.id, 'mid', 'two free models scored identically — quality was invisible');
  assert.notEqual(r.eligible[0].id, r.eligible[1].id);
});

test('a single-axis preference optimises the axis it names', () => {
  // Both of these DIVIDED by quality, which inverts them: asking for speed ranked a frontier
  // model above an 8B at the same latency, and asking for cheap ranked a $5 model above a
  // $2 one. A preference that does the opposite of its name is worse than not offering it.
  const fastCheap = defineModel({ id: 'tiny', reach: 'any', capabilities: [], costPer1k: 1, latencyMs: 300, quality: 0.3 });
  const slowGood = defineModel({ id: 'frontier', reach: 'any', capabilities: [], costPer1k: 5, latencyMs: 1200, quality: 0.9 });
  const r = createModelRouter({ models: [fastCheap, slowGood] });
  assert.equal(r.route({ prefer: 'latency' }).model.id, 'tiny', 'asking for speed did not pick the fastest');
  assert.equal(r.route({ prefer: 'cost' }).model.id, 'tiny', 'asking for cheap did not pick the cheapest');
  assert.equal(r.route({ prefer: 'quality' }).model.id, 'frontier');
});

test('optimising an axis hard cannot reach a model that could not do the job', () => {
  // What makes 'latency' safe to mean literally the fastest: requirements have already
  // eliminated everything unsuitable, so "fastest" is only ever the fastest of those left.
  const tiny = defineModel({ id: 'tiny', reach: 'any', capabilities: [], costPer1k: 0, latencyMs: 100, quality: 0.2 });
  const able = defineModel({ id: 'able', reach: 'any', capabilities: ['tools'], costPer1k: 3, latencyMs: 900, quality: 0.8 });
  const r = createModelRouter({ models: [tiny, able] }).route({ prefer: 'latency', capabilities: ['tools'], minQuality: 0.55 });
  assert.equal(r.model.id, 'able');
});

// ── which axis a request cares about ────────────────────────────────────────

test('the preference is read from the request, not fixed at balanced', () => {
  // 'balanced' for everything meant a greeting was worth a frontier model's deliberation and
  // a refactor was worth saving three seconds on. Neither is what anybody means.
  assert.equal(preferenceFor(signalsFrom({ text: 'hi' })).prefer, 'latency');
  const hard = 'refactor this module and migrate every caller step by step, then analyse what breaks across the whole codebase, list the call sites that change behaviour rather than shape, and tell me which of them need a test before the change lands';
  assert.ok(hard.length > 200, 'fixture assumption: long enough for the keyword heuristics to apply');
  assert.equal(preferenceFor(signalsFrom({ text: hard })).prefer, 'quality');
  assert.equal(preferenceFor({}, { structured: true }).prefer, 'quality');
  assert.equal(preferenceFor({ modality: 'vision' }).prefer, 'quality');
  // Real work, but nothing exact or hard about it: no reason to favour either axis.
  assert.equal(preferenceFor(signalsFrom({ text: 'summarize the last three release notes for me' })).prefer, 'balanced');
});

test('a turn carrying tools is never "answer fast at any quality"', () => {
  // `smalltalk` alone is too generous to decide this: it calls "what did we decide in the
  // standup" trivial, and answering THAT on an 8B to save half a second is the same mistake
  // as the greeting on a frontier model, pointing the other way. The turn must also be
  // carrying nothing to look up — which toolNeedFor already decided, from a narrower test.
  const sig = signalsFrom({ text: 'what did we decide in the standup' });
  assert.equal(sig.smalltalk, true, 'fixture assumption: the loose signal calls this small talk');
  assert.equal(preferenceFor(sig, { hasTools: true }).prefer, 'balanced');
  assert.equal(preferenceFor(sig, { hasTools: false }).prefer, 'latency');
});

test('a quality floor outranks any wish to be quick', () => {
  assert.equal(preferenceFor({ smalltalk: true }, { minQuality: 0.55 }).prefer, 'balanced');
});

test('every preference explains itself', () => {
  for (const s of [{ smalltalk: true }, { complexity: 'high' }, {}]) assert.ok(preferenceFor(s).why);
});

test('a prefix in the small-talk exclusion actually fires', () => {
  // `summar` and `analy` were written to catch summarize / summarise / summary and
  // analyse / analyze, but the alternation ends in \b — so each demanded a word boundary
  // immediately after the prefix and matched nothing. "summarize this document" was
  // classified as small talk for as long as that was true, which made tools negotiable for
  // it and kept it away from every escalation. A prefix that can never fire is worse than an
  // absent one: it reads as covered.
  for (const t of ['summarize this document', 'summarise the notes', 'summary of the call', 'analyse the fallout', 'analyze the numbers']) {
    assert.equal(signalsFrom({ text: t }).smalltalk, false, `"${t}" was read as small talk`);
  }
  assert.equal(signalsFrom({ text: 'hi' }).smalltalk, true);
});

// ── the catch-all is a model the user named ─────────────────────────────────

const pinned = (id, over = {}) => defineModel({
  id, reach: 'any', capabilities: ['tools'], costPer1k: 3, latencyMs: 900, quality: 0.9,
  providerRank: 1, orderPinned: true, ...over,
});
const guessed = (id, over = {}) => defineModel({
  id, reach: 'any', capabilities: ['tools'], costPer1k: 0, latencyMs: 400, quality: 0.4,
  providerRank: 1000, orderPinned: false, ...over,
});

test('with no opinion anywhere, the model the user put first answers', () => {
  // The score was deciding this from inferred latency and a cost regex — guesses — and
  // presenting the result as a decision. It is the one case where there IS a right answer
  // and it is not ours to invent.
  const r = createModelRouter({ models: [guessed('cheap'), pinned('mine')] }).route({});
  assert.equal(r.model.id, 'mine');
  assert.equal(r.strategy, 'declared-default');
  assert.match(r.reasons.at(-1), /your default \(Order 1\)/);
});

test('a rule with an opinion outranks the default — otherwise the rules are decoration', () => {
  const models = [guessed('cheap'), pinned('mine')];
  // A derived preference IS a rule speaking: a greeting asking for speed, exact work asking
  // for quality. Landing every turn on Order 1 regardless would make the rules ornamental.
  assert.equal(createModelRouter({ models }).route({ prefer: 'latency' }).model.id, 'cheap');
  assert.equal(createModelRouter({ models }).route({ prefer: 'cost' }).model.id, 'cheap');
});

test('a strategy outranks the default too', async () => {
  const models = [guessed('cheap'), pinned('mine')];
  const pick = defineRouteStrategy({ id: 'pick-cheap', classUsed: 'R', decide: async (e) => e.find((m) => m.id === 'cheap') });
  const r = await createModelRouter({ models, strategies: [pick] }).routeWith({});
  assert.equal(r.model.id, 'cheap');
  assert.equal(r.strategy, 'pick-cheap');
});

test('the default still has to qualify — it is a preference, never a bypass', () => {
  // Requirements eliminate before any of this. A default that cannot do the work is not the
  // answer to "what should do the work".
  const r = createModelRouter({ models: [guessed('able'), pinned('mine', { capabilities: [] })] })
    .route({ capabilities: ['tools'] });
  assert.equal(r.model.id, 'able');
  assert.ok(r.rejected.some((x) => x.id === 'mine'));

  // And privacy is still a ceiling, not something a default can argue with.
  const local = defineModel({ id: 'local', reach: 'device', capabilities: ['tools'], costPer1k: 0, latencyMs: 1200, quality: 0.4 });
  assert.equal(createModelRouter({ models: [local, pinned('mine')] }).route({ reach: 'device' }).model.id, 'local');
});

test('an INFERRED order is not a declaration', () => {
  // `orderPinned` is what separates a number the user chose from a number we made up from a
  // URL. Most setups pin nothing and must be unaffected — the score still decides there.
  const r = createModelRouter({ models: [guessed('a'), guessed('b', { costPer1k: 5, latencyMs: 2000 })] }).route({});
  assert.equal(r.strategy, 'default-score');
  assert.equal(r.model.id, 'a');
});

test('the next pinned model takes over when the first cannot do the work', () => {
  const r = createModelRouter({
    models: [guessed('other'), pinned('first', { capabilities: [] }), pinned('second', { providerRank: 2 })],
  }).route({ capabilities: ['tools'] });
  assert.equal(r.model.id, 'second');
});

// ── length is not difficulty when the length is the material ────────────────

test('background work gets no quality floor from the size of what it was handed', () => {
  // The topic pass inlines an entire transcript, so a conversation carrying one pasted
  // dashboard produced a 6,300-character prompt, read as 'high' complexity, and a 0.55 floor
  // that eliminated every local model. The one call that should always be cheap got more
  // expensive the more material there was to chew through.
  const big = { complexity: 'high', approxTokens: 1600 };
  assert.equal(requirementsFor(big, {}).minQuality, 0.55);
  assert.equal(requirementsFor(big, { background: true }).minQuality, 0, 'a background pass kept the floor');
});

test('needing to FIT survives — only the quality floor is dropped', () => {
  // Whether a model can hold the material is a real capability question and has nothing to
  // do with who is waiting for the answer.
  const huge = { complexity: 'high', approxTokens: 50_000, modality: 'text' };
  assert.ok(requirementsFor(huge, { background: true }).required.includes('long-context'));
  assert.ok(requirementsFor({ modality: 'vision' }, { background: true }).required.includes('vision'));
  // And tools stay required when the turn carries them: nothing about being background makes
  // a model that cannot call a tool able to.
  assert.ok(requirementsFor({}, { background: true, hasTools: true }).required.includes('tools'));
});

test('background work spends as little as possible', () => {
  assert.equal(preferenceFor({ complexity: 'high' }, { background: true }).prefer, 'cost');
  // Even structured background work — a topic index IS a structured artifact, and it has a
  // deterministic fallback when the model declines.
  assert.equal(preferenceFor({ complexity: 'high' }, { background: true, structured: true }).prefer, 'cost');
  // The user's own turn is unaffected.
  assert.equal(preferenceFor({ complexity: 'high' }, {}).prefer, 'quality');
});
