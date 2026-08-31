import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuseRRF, planQueries, multiSearch } from '../rrf.js';

test('RRF rewards agreement across lists, without comparable scores', () => {
  // `b` is the only id BOTH lists return, so it outranks ids that only one list found —
  // that is the whole point of fusing. (A fully reversed pair is symmetric and proves
  // nothing: there the head of each list wins, correctly.)
  const fused = fuseRRF([['a', 'b'], ['b', 'c']]);
  assert.equal(fused[0].id, 'b', 'the id both lists returned wins');
  assert.equal(fused.length, 3);
  // A single list degenerates to that list's order.
  assert.deepEqual(fuseRRF([['x', 'y']]).map((r) => r.id), ['x', 'y']);
  // Empty / malformed input is inert, not a throw.
  assert.deepEqual(fuseRRF([]), []);
  assert.deepEqual(fuseRRF([null, undefined, ['z']]).map((r) => r.id), ['z']);
  assert.equal(fuseRRF([['a', 'b', 'c']], { limit: 2 }).length, 2);
});

test('planQueries expands a question into complementary shapes', () => {
  const qs = planQueries('What was the outcome of the Ben tooling demo?');
  assert.equal(qs[0], 'What was the outcome of the Ben tooling demo?', 'the question as asked comes first');
  assert.ok(qs.length > 1, 'plus at least one variant');
  const kw = qs.find((q) => !/what|the|of/i.test(q));
  assert.ok(kw, 'a keyword-only variant with the stopwords dropped');
  assert.ok(/ben/i.test(kw) && /demo/i.test(kw), 'it keeps the terms that carry signal');
});

test('planQueries puts an agent’s own formulations in, and never duplicates', () => {
  const qs = planQueries('outcome of the demo', { extra: ['ben demo decisions', 'outcome of the demo'] });
  assert.ok(qs.includes('ben demo decisions'), 'the agent’s query is used');
  assert.equal(new Set(qs.map((q) => q.toLowerCase())).size, qs.length, 'no duplicates');
  assert.ok(planQueries('x', { extra: ['a', 'b', 'c', 'd', 'e'], max: 3 }).length <= 3, 'max is honoured');
});

test('multiSearch fuses several queries and reports which ones found each hit', async () => {
  const index = {
    'ben demo': [{ id: 'm1', snippet: 'Ben demo notes' }, { id: 'm2' }],
    'decisions': [{ id: 'm2' }, { id: 'm1' }],
    'nothing': [],
  };
  const out = await multiSearch(['ben demo', 'decisions', 'nothing'], async (q) => index[q]);
  assert.equal(out.length, 2);
  assert.ok(out.every((r) => r.foundBy.length >= 1), 'every hit says which query found it');
  const m1 = out.find((r) => r.id === 'm1');
  assert.equal(m1.snippet, 'Ben demo notes', 'the richest record for an id survives the fusion');
  assert.deepEqual(m1.foundBy.sort(), ['ben demo', 'decisions']);
});

test('one failing query never sinks the others', async () => {
  const out = await multiSearch(['good', 'bad'], async (q) => {
    if (q === 'bad') throw new Error('boom');
    return [{ id: 'ok' }];
  });
  assert.deepEqual(out.map((r) => r.id), ['ok']);
});
