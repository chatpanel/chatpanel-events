import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineModel, defineMiddleware, defineRouteStrategy, createModelRouter, signalsFrom, requirementsFor, requirementsForStep, sameModelKey, RouterError } from '../router.js';

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
  const fast = defineModel({ id: 'via-aggregator', model: 'deepseek/deepseek-v4-flash', reach: 'any', costPer1k: 0.1, latencyMs: 300, providerRank: 30 });
  const preferred = defineModel({ id: 'via-first-party', model: 'deepseek-ai/DeepSeek-V4-Flash', reach: 'any', costPer1k: 0.5, latencyMs: 900, providerRank: 10 });
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
  assert.match(r.reasons.at(-1), /order 10 broke a tie/, 'The decision names the lever that made it.');
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
