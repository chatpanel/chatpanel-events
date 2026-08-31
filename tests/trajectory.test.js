import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAppender } from '../event.js';
import { buildTrajectory, phasesOf, filterEntries, displayName, groupRequests, requestMetrics } from '../trajectory.js';

test('trajectory: ordered by cause, content by reference, waterfall never invented', async () => {

  let n = 0;
  const a = createAppender({ host: 'ext', now: () => 1000 + n * 100, newId: () => `e${n++}` });
  const ref = { kind: 'chat', id: 'sha256:' + 'a'.repeat(64), hash: 'sha256:' + 'a'.repeat(64) };

  const evs = [
    a.append('turn.started', { turnId: 't1', kind: 'chat' }),
    a.append('context.assembled', { turnId: 't1', budget: 0, used: 832, parts: {}, resident: [], reachableCount: 1, tools: ['page'], redaction: true }),
    a.append('assistant.prompted', { turnId: 't1', ref, chars: 4210 }),
    a.append('capability.invoked', {
      capability: 'page', actor: { kind: 'model', id: 'claude' }, scope: { kind: 'session', id: 'c1' },
      effects: 'non-replayable', idempotencyKey: 'k1', turnId: 't1', args: { action: 'read_page' },
    }),
    a.append('capability.resulted', { capability: 'page', ok: true, classUsed: 'X', cost: { ms: 240 }, turnId: 't1', idempotencyKey: 'k1', summary: '{"chars":18400}' }),
    a.append('assistant.message', { turnId: 't1', ref, chars: 980 }),
    a.append('turn.ended', { turnId: 't1', reason: 'ok', ms: 5000 }),
  ];

  const entries = buildTrajectory(evs);
  assert.deepEqual(entries.map((e) => e.kind), ['context', 'system', 'tool', 'result', 'assistant']);

  // The dispatcher must not flatten every page action into "page" — the same blindness that
  // made every activity row identical and stopped the loop guard exempting screenshots.
  assert.equal(entries.find((e) => e.kind === 'tool').title, 'page.read_page');

  // Content is NOT in the entry. It carries a ref the caller resolves only when the user
  // looks, which keeps building sixty trajectories cheap and stays honest about deleted
  // content.
  const answer = entries.find((e) => e.kind === 'assistant');
  assert.ok(answer.ref, 'the answer entry lost its ref');
  assert.equal(answer.text, undefined, 'content was inlined into the entry');

  // Offsets are relative to the turn's start, so a row says WHEN within the turn.
  assert.equal(entries[0].offsetMs, 100);

  // Ordering comes from causal linearization, never wall time: shuffling the input must not
  // change the trajectory, or an export would read differently from the live view.
  const shuffled = [evs[5], evs[0], evs[4], evs[2], evs[6], evs[1], evs[3]];
  assert.deepEqual(buildTrajectory(shuffled).map((e) => e.kind), entries.map((e) => e.kind));

  // ── the waterfall ───────────────────────────────────────────────────────────
  const ph = phasesOf({ ms: 10_000, prepMs: 4000, ttftMs: 1000 });
  assert.deepEqual(ph.parts.map((p) => p.key), ['setup', 'wait', 'work']);
  assert.deepEqual(ph.parts.map((p) => Math.round(p.pct)), [40, 10, 50]);
  assert.equal(Math.round(ph.parts.reduce((s, p) => s + p.pct, 0)), 100);

  // A phase that did not happen is not drawn, rather than drawn as a sliver.
  assert.deepEqual(phasesOf({ ms: 1000 }).parts.map((p) => p.key), ['work']);

  // A turn with no recorded duration gets NO bar. Drawing one from missing numbers would be
  // a confident lie in the view whose whole job is to be trustworthy.
  assert.equal(phasesOf({}), null);
  assert.equal(phasesOf({ ms: 0 }), null);

  // Setup longer than the whole turn cannot produce a negative or overflowing bar.
  const odd = phasesOf({ ms: 1000, prepMs: 9000, ttftMs: 500 });
  assert.ok(odd.parts.every((p) => p.pct >= 0 && p.pct <= 100));
  assert.equal(Math.round(odd.parts.reduce((s, p) => s + p.pct, 0)), 100);

  // ── search ──────────────────────────────────────────────────────────────────
  assert.equal(filterEntries(entries, 'read_page').length, 1);
  assert.equal(filterEntries(entries, '').length, entries.length);
  assert.equal(filterEntries(entries, 'nothing-here').length, 0);



});

test('requests are numbered per model round-trip, not per turn', async () => {
  // A tool loop asks the model, gets a call, feeds the result back, and asks again. "The
  // second request is where it went wrong" is a sentence you can act on; "the turn went
  // wrong" is not. Our own log showed this before it was named — 36 turns carried two
  // context.assembled events, one per round-trip.
  let n = 0;
  const a = createAppender({ host: 'ext', now: () => 1000 + n * 100, newId: () => `r${n++}` });
  const ref = { kind: 'chat', id: 'sha256:' + 'b'.repeat(64), hash: 'sha256:' + 'b'.repeat(64) };
  const call = (key, action) => ([
    a.append('capability.invoked', {
      capability: 'find', actor: { kind: 'model', id: 'm' }, scope: { kind: 'session', id: 's' },
      effects: 'idempotent', idempotencyKey: key, turnId: 't', args: { action },
    }),
    a.append('capability.resulted', { capability: 'find', ok: true, classUsed: 'X', cost: { ms: 50 }, turnId: 't', idempotencyKey: key, summary: 'ok' }),
  ]);
  const entries = buildTrajectory([
    a.append('turn.started', { turnId: 't', kind: 'chat' }),
    a.append('assistant.prompted', { turnId: 't', ref, chars: 10 }),
    ...call('k1', 'web_search'),
    a.append('assistant.prompted', { turnId: 't', ref, chars: 20 }),
    ...call('k2', 'web_search'),
    a.append('assistant.message', { turnId: 't', ref, chars: 30 }),
    a.append('turn.ended', { turnId: 't', reason: 'ok', ms: 900 }),
  ]);

  const reqs = groupRequests(entries);
  assert.equal(reqs.length, 2, 'a tool loop collapsed into one request');
  assert.deepEqual(reqs.map((r) => r.index), [1, 2]);
  assert.equal(reqs[0].calls.length, 1);
  assert.equal(reqs[1].calls.length, 1);
  // The answer belongs to the request that produced it — that is what makes hierarchy a
  // relationship rather than a label.
  assert.ok(reqs[1].answer);
  assert.equal(reqs[0].answer, null);
  assert.equal(entries.find((e) => e.kind === 'tool').requestIndex, 1);
});

test('metrics are derived, and never invented', async () => {
  const m = requestMetrics({ tokensIn: 4127, tokensOut: 73, tokensReasoning: 29, ms: 1520, ttftMs: 957, model: 'opus' });
  assert.equal(m.tokensTotal, 4200);
  // Generation is the part AFTER the first token. Dividing by the total would blame a slow
  // first token on the model's writing speed.
  assert.equal(m.generationMs, 563);
  assert.equal(m.throughput, +(73 / 0.563).toFixed(1));

  // No generation window → no throughput. A rate computed from a 0ms window is a very
  // large lie, and a plausible-looking one.
  assert.equal(requestMetrics({ tokensOut: 50, ms: 100, ttftMs: 100 }).throughput, null);
  assert.equal(requestMetrics({ tokensOut: 0, ms: 500, ttftMs: 100 }).throughput, null);
  // Missing timings stay null rather than becoming zero — "we did not measure" and "it took
  // no time" are different claims.
  const bare = requestMetrics({ tokensOut: 10 });
  assert.equal(bare.ttftMs, null);
  assert.equal(bare.generationMs, null);
  assert.equal(bare.throughput, null);
});

test('routing decisions appear in the trajectory', async () => {
  // They were being recorded and then not shown, which is the least useful place for them:
  // the log knew a turn changed model three times and the view that exists to explain a turn
  // did not mention it.
  let n = 0;
  const a = createAppender({ host: 'ext', now: () => 1000 + n * 10, newId: () => `r${n++}` });
  const entries = buildTrajectory([
    a.append('turn.started', { turnId: 't', kind: 'chat' }),
    a.append('policy.changed', {
      dial: 'route.applied', actor: { kind: 'rule', id: 'model-router' },
      from: 'auto', to: 'OpenAI · gpt-5.5', reasons: ['best by balanced (4 eligible)'], strategy: 'escalate-on-complexity',
    }),
    a.append('automation.fired', { ruleId: 'router:failover', classUsed: 'R', from: 'OpenAI · gpt-5.5', to: 'Claude Code', reason: 'quota' }),
    a.append('turn.ended', { turnId: 't', reason: 'ok', ms: 100 }),
  ]);

  const routes = entries.filter((e) => e.kind === 'route');
  assert.equal(routes.length, 2);
  assert.match(routes[0].title, /Routed to OpenAI/);
  assert.equal(routes[0].data.strategy, 'escalate-on-complexity');
  // The failover names both ends AND why, because "it changed model" without a reason reads
  // as a fault rather than a recovery.
  assert.match(routes[1].title, /Failed over to Claude Code/);
  assert.match(routes[1].detail, /declined \(quota\)/);
});

test('an observed decision is not reported as an applied one', () => {
  // Observation records what WOULD have happened. Showing it as what did happen would make
  // the log describe a substitution that never took place.
  let n = 0;
  const a = createAppender({ host: 'ext', now: () => 1000 + n, newId: () => `o${n++}` });
  const [route] = buildTrajectory([
    a.append('policy.changed', { dial: 'route.observed', actor: { kind: 'rule', id: 'model-router' }, from: 'gemma', to: 'gpt-5.5', agrees: false, reasons: [] }),
  ]).filter((e) => e.kind === 'route');
  assert.match(route.title, /Would route to/);
  assert.equal(route.data.applied, false);
});

test('a policy change that is not about routing is left alone', () => {
  let n = 0;
  const a = createAppender({ host: 'ext', now: () => 1, newId: () => `p${n++}` });
  const out = buildTrajectory([a.append('policy.changed', { dial: 'privacy.redaction', actor: { kind: 'user', id: 'u' }, from: 'off', to: 'on' })]);
  assert.deepEqual(out.filter((e) => e.kind === 'route'), []);
});

test('redaction appears in the trajectory — what the model actually saw', () => {
  // A run that shows the prompt, the tools and the answer but not the redaction cannot
  // answer the question the product exists to answer.
  const ev = (type, payload, seq) => ({
    v: 1, id: `e${seq}`, seq, at: 1000 + seq, ts: 1000 + seq, type, host: 'ext',
    actor: { kind: 'user', id: 'u' }, scope: { kind: 'session', id: 's' }, causes: [], payload,
  });
  const entries = buildTrajectory([
    ev('turn.started', {}, 0),
    ev('privacy.redacted', { counts: { PERSON: 3, EMAIL: 1 } }, 1),
    ev('assistant.prompted', { chars: 500 }, 2),
  ]);
  const step = entries.find((x) => x.kind === 'privacy');
  assert.ok(step, 'a privacy step is present');
  assert.match(step.title, /Redacted 4 values before sending/);
  assert.match(step.detail, /3 person/, 'most frequent type first');
  assert.match(step.detail, /1 email/);
  assert.deepEqual(step.data.counts, { PERSON: 3, EMAIL: 1 });
  // Counts only — the contract keeps values out of the event, so they can't reach the view.
  assert.ok(!JSON.stringify(step).includes('@'), 'no real values anywhere in the step');
});

test('a turn with nothing redacted adds no privacy step', () => {
  const ev = (type, payload, seq) => ({
    v: 1, id: `e${seq}`, seq, at: 1000 + seq, ts: 1000 + seq, type, host: 'ext',
    actor: { kind: 'user', id: 'u' }, scope: { kind: 'session', id: 's' }, causes: [], payload,
  });
  const entries = buildTrajectory([ev('turn.started', {}, 0), ev('privacy.redacted', { counts: {} }, 1)]);
  assert.equal(entries.filter((x) => x.kind === 'privacy').length, 0, 'no empty row');
});
