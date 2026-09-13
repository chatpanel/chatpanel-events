// The model ledger: an engine's attested record, the card it yields, and how the card
// overrides the name-based guess — and the agent scores it lets the scorecard adjust.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { makeLedgerEntry, summarizeEngine, cardOverride, applyCard, verifyChain, attest, verifyAttested, ledgerKey, WITHDRAW_AFTER } from '../model-ledger.js';
import { inferCandidate, KNOWN_CAPABILITIES } from '../model-candidates.js';
import { makeEntry, summarize, fit, adjustSummary } from '../scorecard.js';

const subtle = webcrypto.subtle;
const key = new TextEncoder().encode('the-store-holds-this');
const ENGINE = { kind: 'model', id: 'openrouter', model: 'gpt-4o-mini' };

async function chain(facts, { t0 = 1_000_000 } = {}) {
  const out = []; let prev = null; let t = t0;
  for (const f of facts) { prev = await makeLedgerEntry({ engine: ENGINE, at: (t += 1000), ...f }, prev, { subtle }); out.push(prev); }
  return out;
}

test('entries chain per engine, verify with the scorecard’s verifier, and the store’s mark attests', async () => {
  const es = await chain([
    { kind: 'call', call: { ttftMs: 300, totalMs: 1200, tokensIn: 100, tokensOut: 50, structured: 'ok' } },
    { kind: 'declined', declined: { reason: 'rate' } },
    { kind: 'rating', rating: { by: 'judge', score: 0.8, jobKind: 'review' }, agentId: 'r' },
  ]);
  assert.equal(es[0].key, 'model:openrouter/gpt-4o-mini'); assert.equal(ledgerKey(ENGINE), es[0].key);
  assert.equal(es[2].prev, es[1].hash);
  assert.equal((await verifyChain(es, { subtle })).ok, true);
  assert.equal((await verifyChain([es[0], { ...es[1], declined: { reason: 'auth' } }, es[2]], { subtle })).ok, false);
  const marked = await attest(es[0], key, { subtle });
  assert.equal((await verifyAttested([marked], key, { subtle })).ok, true);
  await assert.rejects(() => makeLedgerEntry({ engine: { kind: 'model', id: 'other' }, kind: 'call' }, es[2], { subtle }), /chained onto/, 'one chain per engine');
  await assert.rejects(() => makeLedgerEntry({ engine: ENGINE, kind: 'price' }, null, { subtle }).then((e) => makeLedgerEntry({ engine: ENGINE, kind: 'capability', capability: {} }, e, { subtle })), /capability.id/);
  await assert.rejects(() => makeLedgerEntry({ kind: 'call' }, null, { subtle }), /engine required/);
});

test('the engine card: availability, reliability, latency, cost, proofs, quality by job kind', async () => {
  const now = 2_000_000;
  const es = await chain([
    { kind: 'price', price: { per1kIn: 0.15, per1kOut: 0.6, source: 'provider' } },
    { kind: 'call', call: { ttftMs: 200, totalMs: 1000, tokensIn: 1000, tokensOut: 500, structured: 'ok', toolCalls: { asked: 2, valid: 2 } } },
    { kind: 'call', call: { ttftMs: 400, totalMs: 2000, tokensIn: 1000, tokensOut: 500, structured: 'bad', toolCalls: { asked: 2, valid: 1 } } },
    { kind: 'call', call: { ttftMs: 300, totalMs: 1500, tokensIn: 1000, tokensOut: 500, empty: true, ok: false } },
    { kind: 'call', call: { ttftMs: 250, totalMs: 1200, cost: 0.01 } },
    { kind: 'declined', declined: { reason: 'rate' } },
    { kind: 'rating', rating: { score: 0.9, jobKind: 'review' } },
    { kind: 'rating', rating: { score: 0.5, jobKind: 'summary' } },
    { kind: 'capability', capability: { id: 'vision', proved: false } },
    { kind: 'capability', capability: { id: 'vision', proved: false } },
    { kind: 'capability', capability: { id: 'vision', proved: false } },
    { kind: 'capability', capability: { id: 'json', proved: true } },
    { kind: 'rotated-from', rotated: { to: { kind: 'model', id: 'anthropic', model: 'sonnet' }, reason: 'rate' } },
  ], { t0: now - 20_000 });
  const card = summarizeEngine(es, { minCalls: 3, now });
  assert.equal(card.calls, 4); assert.equal(card.declines, 1); assert.equal(card.observed, true);
  assert.equal(card.availability.rate, 0.8); assert.deepEqual(card.availability.declinesBy, { rate: 1 });
  assert.equal(card.availability.byHour[23].calls, 4, 'all within the last hour band');
  assert.equal(card.availability.decliningNow, false);
  assert.equal(card.reliability.failRate, 0.25); assert.equal(card.reliability.empty, 0.25);
  assert.equal(card.reliability.badJson, 0.5, 'over the calls that asked for JSON'); assert.equal(card.reliability.badToolCall, 0.25);
  assert.equal(card.latency.ttft.p50, 250); assert.equal(card.latency.ttft.p95, 400); assert.equal(card.latency.total.p50, 1200);
  // Cost: three calls priced from tokens (1000·0.15 + 500·0.6)/1000 = 0.45; one that said 0.01.
  assert.equal(card.cost.perTask, Math.round(((0.45 * 3 + 0.01) / 4) * 1000) / 1000);
  assert.equal(card.cost.per1kOut, 0.6); assert.equal(card.cost.tokensPerTask, 1500);
  assert.deepEqual(card.capabilities.withdrawn, ['vision']); assert.deepEqual(card.capabilities.proved, ['json']);
  assert.equal(WITHDRAW_AFTER, 3);
  assert.equal(card.quality.overall.avg, 0.7); assert.equal(card.quality.byJobKind.review.avg, 0.9);
  assert.equal(card.rotatedFrom, 1);
  assert.equal(card.head, es.at(-1).hash);
  // A later successful proof re-admits a withdrawn capability.
  const more = await makeLedgerEntry({ engine: ENGINE, kind: 'capability', capability: { id: 'vision', proved: true }, at: now }, es.at(-1), { subtle });
  assert.deepEqual(summarizeEngine([...es, more], { now }).capabilities.withdrawn, []);
  // Declining right now: three declines in a row within the hour.
  const down = await chain([{ kind: 'declined', declined: { reason: 'unavailable' } }, { kind: 'declined', declined: { reason: 'unavailable' } }, { kind: 'declined', declined: { reason: 'timeout' } }], { t0: now - 5000 });
  assert.equal(summarizeEngine(down, { now }).availability.decliningNow, true);
  assert.equal(summarizeEngine(down, { now: now + 7_200_000 }).availability.decliningNow, false, 'an hour later it is tried again');
});

test('the card overrides the guess only where there is history, and says which fields it touched', async () => {
  const target = { id: 'openrouter', name: 'OpenRouter', model: 'gpt-4o-mini', baseUrl: 'https://openrouter.ai/api/v1' };
  const guess = inferCandidate(target, 'api');
  assert.equal(guess.quality, 0.3, 'the name says mini');
  assert.ok(guess.capabilities.includes('vision'), 'the name says gpt-4');
  const now = 3_000_000;
  const es = await chain([
    ...Array.from({ length: 6 }, () => ({ kind: 'call', call: { ttftMs: 150, totalMs: 900 } })),
    ...Array.from({ length: 6 }, () => ({ kind: 'rating', rating: { score: 0.75, jobKind: 'review' } })),
    ...Array.from({ length: 3 }, () => ({ kind: 'capability', capability: { id: 'vision', proved: false } })),
  ], { t0: now - 60_000 });
  const card = summarizeEngine(es, { now });
  const { override, observed } = cardOverride(card);
  assert.deepEqual(observed, ['quality', 'latencyMs']);
  assert.equal(override.quality, 0.75); assert.equal(override.latencyMs, 150);
  assert.equal(override.costPer1k, undefined, 'nothing priced');
  const m = applyCard(guess, card);
  assert.equal(m.quality, 0.75); assert.equal(m.latencyMs, 150);
  assert.equal(m.capabilities.includes('vision'), false, 'three failed proofs withdraw it');
  assert.deepEqual(m.observed, ['quality', 'latencyMs', 'capabilities']);
  assert.equal(m.reach, guess.reach, 'reach is typed, never learned');
  // Too little history: the guess stands.
  const thin = summarizeEngine(es.slice(0, 3), { now });
  assert.equal(applyCard(guess, thin).quality, 0.3);
  assert.deepEqual(applyCard(guess, thin).observed, []);
  // The person's word is last.
  assert.equal(applyCard(guess, card, { userOverride: { quality: 0.9 } }).quality, 0.9);
  // Per job kind when the card has enough for that kind.
  assert.equal(cardOverride(card, { jobKind: 'review' }).override.quality, 0.75);
  assert.equal(cardOverride(card, { jobKind: 'summary' }).override.quality, 0.75, 'falls back to overall');
  // The media capabilities exist and are never guessed from a name.
  for (const id of ['speech-in', 'speech-out', 'audio', 'image-out']) assert.ok(KNOWN_CAPABILITIES.some((c) => c.id === id), id);
  assert.equal(inferCandidate({ id: 'x', model: 'gpt-4o-audio-preview' }, 'api').capabilities.includes('speech-in'), false);
});

test('agent scores normalised by engine: leverage, the adjusted rating, efficiency — and fit reads them', async () => {
  // One agent, rated 0.8 on a weak engine (60 % of its tasks) and 0.85 on a strong one.
  const facts = [
    { agentId: 'a', kind: 'task.done', runId: 'r1', taskId: 't1', engine: { kind: 'model', id: 'small' }, size: { tokens: 500 } },
    { agentId: 'a', kind: 'rating', runId: 'r1', taskId: 't1', rating: { score: 0.8 } },
    { agentId: 'a', kind: 'task.done', runId: 'r2', taskId: 't2', engine: { kind: 'model', id: 'small' }, size: { tokens: 500 } },
    { agentId: 'a', kind: 'rating', runId: 'r2', taskId: 't2', rating: { score: 0.8 } },
    { agentId: 'a', kind: 'task.done', runId: 'r3', taskId: 't3', engine: { kind: 'model', id: 'small' }, size: { tokens: 500 } },
    { agentId: 'a', kind: 'rating', runId: 'r3', taskId: 't3', rating: { score: 0.8 } },
    { agentId: 'a', kind: 'task.done', runId: 'r4', taskId: 't4', engine: { kind: 'model', id: 'big' }, size: { tokens: 3000 } },
    { agentId: 'a', kind: 'rating', runId: 'r4', taskId: 't4', rating: { score: 0.85 } },
    { agentId: 'a', kind: 'task.done', runId: 'r5', taskId: 't5', engine: { kind: 'model', id: 'big' }, size: { tokens: 3000 } },
    { agentId: 'a', kind: 'rating', runId: 'r5', taskId: 't5', rating: { score: 0.85 } },
  ];
  const entries = []; let prev = null;
  for (const f of facts) { prev = await makeEntry(f, prev, { subtle }); entries.push(prev); }
  const card = summarize(entries);
  assert.equal(Math.round(card.rating.avg * 1000) / 1000, 0.82);
  const qualityOf = (k) => ({ 'model:small': 0.3, 'model:big': 0.9 }[k] ?? null);
  const adj = adjustSummary(card, { qualityOf });
  assert.equal(adj.raw, 0.82);
  // correction = 0.3 · (0.6·(0.6−0.3) + 0.4·(0.6−0.9)) = 0.3 · 0.06 = 0.018
  assert.equal(adj.adjusted, 0.838);
  assert.equal(adj.leverage, Math.round(((3 / 5) * (0.8 - 0.3) + (2 / 5) * (0.85 - 0.9)) * 1000) / 1000);
  assert.match(adj.basis[0], /60 % of its tasks ran on a 0.3-quality engine/);
  assert.equal(adj.efficiency.engine, 'model:small', 'cheapest engine that cleared the bar');
  assert.equal(adj.efficiency.costPerTask, 500, 'the token proxy until the ledger prices it');
  const priced = adjustSummary(card, { qualityOf, costOf: (k) => (k === 'model:big' ? 0.05 : 0.01) });
  assert.equal(priced.efficiency.value, Math.round((0.838 / 0.01) * 1000) / 1000);
  assert.deepEqual(adjustSummary(card, {}).basis, ['engines not rated yet — raw rating used']);
  assert.equal(adjustSummary({ rating: { avg: null }, byEngine: [] }).adjusted, null);
  // fit uses the adjusted rating and says so; a person can turn it off.
  const job = { needs: { skills: ['review'] } }; const type = { skills: ['review'] };
  const withAdj = fit(job, type, card, { qualityOf });
  const without = fit(job, type, card);
  assert.ok(withAdj.score > without.score);
  assert.match(withAdj.reasons.join(' | '), /82% raw, 84% adjusted/);
  assert.equal(withAdj.adjusted.adjusted, 0.838);
  assert.equal(fit(job, type, card, { qualityOf, adjust: false }).score, without.score);
});
