import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, createModelHealth, COOLDOWN_MS } from '../model-health.js';
import { runWithFailover, failoverExhausted, FAILOVER_MAX_ATTEMPTS } from '../failover.js';

test('classifyFailure: only the categories that change what to do', () => {
  assert.equal(classifyFailure(new Error('HTTP 402 — {"error":"You have depleted your monthly included credits."}')), 'quota');
  assert.equal(classifyFailure({ status: 429 }), 'rate');
  assert.equal(classifyFailure({ status: 503 }), 'server');
  assert.equal(classifyFailure(new Error('fetch failed: ECONNRESET')), 'server');
  assert.equal(classifyFailure(new Error('HTTP 410 — {"detail":"The model has reached its end of life and is no longer available."}')), 'gone');
  assert.equal(classifyFailure({ status: 404, message: 'unknown model xyz' }), 'gone');
  assert.equal(classifyFailure(new Error('HTTP 404 — {"error":{"message":"The model llama-3.1-8b-instant does not exist or you do not have access to it."}}')), 'gone');
  assert.equal(classifyFailure(new Error('invalid model selection (--model "Gemini"): model Gemini is not recognized as a known model')), 'gone');
  assert.equal(classifyFailure({ status: 401 }), 'auth');
  assert.equal(classifyFailure(new Error('OAuth token exchange failed: HTTP 400 — {"error":"invalid_grant"}')), 'auth');
  assert.equal(classifyFailure({ status: 400 }), 'request');
  assert.equal(classifyFailure(new Error('TypeError: Failed to fetch')), 'unreachable');
  assert.equal(classifyFailure({ ok: false, error: "couldn't reach the gateway on http://127.0.0.1:4320 — ECONNREFUSED" }), 'unreachable', 'a host result that was not thrown still classifies');
  assert.equal(classifyFailure(new Error('something odd')), 'unknown');
});

test('the ledger stands a model down for as long as the failure warrants, and learns about the model across providers', () => {
  let t = 1_000_000;
  const snaps = [];
  const h = createModelHealth({ now: () => t, onChange: (s) => snaps.push(s) });
  const m = h.markUnhealthy('groq:llama', { status: 429 }, 'llama-3.1-8b');
  assert.equal(m.reason, 'rate');
  assert.equal(m.until, t + COOLDOWN_MS.rate);
  assert.deepEqual(h.healthOf('groq:llama'), { available: true, rateLimited: true, reason: 'rate', until: t + COOLDOWN_MS.rate });
  t += COOLDOWN_MS.rate + 1;
  assert.equal(h.healthOf('groq:llama').available, true, 'expired');
  assert.equal(h.healthOf('groq:llama').reason, null);
  // Repeats escalate, capped at an hour — never below the base.
  h.markUnhealthy('x', { status: 503 }); h.markUnhealthy('x', { status: 503 }); h.markUnhealthy('x', { status: 503 });
  assert.equal(h.healthOf('x').until - t, COOLDOWN_MS.server * 3);
  h.markUnhealthy('dead', { status: 410, message: 'end of life' }, 'deepseek-v4-flash');
  assert.equal(h.healthOf('dead').until - t, COOLDOWN_MS.gone);
  // Gone is gone everywhere: the SAME model at another provider is stood down on one report.
  assert.equal(h.healthOf('other:deepseek', 'openrouter/deepseek-v4-flash:free').available, false);
  assert.equal(h.healthOf('other:deepseek', 'deepseek-v4-flash').model, true);
  // Anything else needs two providers to agree.
  h.markUnhealthy('p1', { status: 402 }, 'gpt-x');
  assert.equal(h.healthOf('p3', 'gpt-x').available, true);
  h.markUnhealthy('p2', { status: 402 }, 'gpt-x');
  assert.equal(h.healthOf('p3', 'gpt-x').available, false);
  h.markHealthy('x');
  assert.equal(h.healthOf('x').available, true);
  assert.deepEqual(h.unhealthyModels().map((u) => u.id).sort(), ['dead', 'p1', 'p2']);
  // Persistence is the host's: every change hands over a snapshot another context can load.
  assert.ok(snaps.length >= 5);
  const other = createModelHealth({ now: () => t });
  assert.equal(other.hydrate(snaps.at(-1)), true);
  assert.equal(other.healthOf('dead').available, false);
  assert.equal(other.healthOf('p3', 'gpt-x').available, false);
  other.reset();
  assert.equal(other.unhealthyModels().length, 0);
});

const target = (id, model, quality = 0.5) => ({ id, model, name: id, routedVia: { model, quality, reasons: [`picked ${id}`] } });

test('a declined request moves to the next model, tells the user, and the answer comes from the one that worked', async () => {
  const h = createModelHealth({ now: () => 5 });
  const calls = [];
  const hops = [];
  const roster = [target('a', 'm-a'), target('b', 'm-b'), target('c', 'm-c')];
  const out = await runWithFailover({
    first: roster[0], chose: true, health: h,
    call: async (t) => { calls.push(t.id); if (t.id !== 'c') throw Object.assign(new Error('HTTP 402 — credits depleted'), { status: 402 }); return `answer from ${t.id}`; },
    next: async ({ tried }) => roster.find((r) => !tried.includes(r.id)) || null,
    onHop: (hop) => hops.push(hop),
  });
  assert.equal(out, 'answer from c');
  assert.deepEqual(calls, ['a', 'b', 'c']);
  assert.deepEqual(hops.map((x) => [x.from, x.to, x.reason]), [['m-a', 'm-b', 'quota'], ['m-b', 'm-c', 'quota']]);
  assert.deepEqual(hops[0].reasons, ['m-a declined (quota)', 'picked b']);
  assert.equal(h.healthOf('a').available, false);
  assert.equal(h.healthOf('c').available, true, 'the one that answered is marked healthy');
});

test('only when the router chose: a model the user picked fails plainly', async () => {
  const h = createModelHealth();
  await assert.rejects(
    runWithFailover({ first: target('a', 'm'), chose: false, health: h, call: async () => { throw new Error('HTTP 402'); }, next: async () => target('b', 'm') }),
    /HTTP 402/,
  );
  assert.equal(h.healthOf('a').available, true, 'not even recorded — the user asked for it');
});

test('out of options: the terminal error says how many were tried, not just the last provider\'s complaint', async () => {
  const h = createModelHealth();
  const err = await runWithFailover({
    first: target('a', 'm'), chose: true, health: h,
    call: async () => { throw new Error('HTTP 503 overloaded'); },
    next: async ({ tried }) => (tried.length < 2 ? target(`n${tried.length}`, 'm') : null),
  }).catch((e) => e);
  assert.match(err.message, /^2 models tried, none could answer\. Last error — HTTP 503/);
  assert.deepEqual(err.tried, ['a', 'n1']);
  assert.equal(err.cause.message, 'HTTP 503 overloaded');
});

test('bounded: the chain stops at maxAttempts without announcing a model it will not call', async () => {
  const h = createModelHealth();
  const hops = [];
  let n = 0;
  const err = await runWithFailover({
    first: target('t0', 'm'), chose: true, health: h,
    call: async () => { throw new Error('HTTP 500'); },
    next: async () => target(`t${n += 1}`, 'm'),
    onHop: (x) => hops.push(x.to),
  }).catch((e) => e);
  assert.equal(hops.length, FAILOVER_MAX_ATTEMPTS - 1);
  assert.match(err.message, new RegExp(`^${FAILOVER_MAX_ATTEMPTS} models tried`));
  const one = await runWithFailover({ first: target('a', 'm'), chose: true, health: h, call: async () => { throw new Error('x'); }, next: async () => target('b', 'm'), maxAttempts: 1 }).catch((e) => e);
  assert.match(one.message, /^1 model tried/);
});

test('an abort ends the chain with the current error; a failure the ledger will not record is not retried', async () => {
  const h = createModelHealth();
  const ac = new AbortController();
  const err = await runWithFailover({
    first: target('a', 'm'), chose: true, health: h, signal: ac.signal,
    call: async () => { ac.abort(); throw new Error('aborted'); },
    next: async () => target('b', 'm'),
  }).catch((e) => e);
  assert.equal(err.message, 'aborted');
  const noId = await runWithFailover({ first: { model: 'm' }, chose: true, health: h, call: async () => { throw new Error('HTTP 402'); }, next: async () => target('b', 'm') }).catch((e) => e);
  assert.equal(noId.message, 'HTTP 402', 'nothing to stand down, nothing to fail over from');
  assert.equal(failoverExhausted(3, new Error('e')).message, '3 models tried, none could answer. Last error — e');
});
