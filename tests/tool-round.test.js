import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planToolRound, runToolRound } from '../tool-round.js';

const call = (name, input = {}) => ({ name, input });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('consecutive reads share a batch; a write is a barrier; a read after a write waits', () => {
  const plan = planToolRound([
    call('get_a'), call('search_b'), call('click_at', { x: 1 }), call('read_page'), call('list_c'), call('delete_d'),
  ]);
  assert.deepEqual(plan.batches, [
    { indexes: [0, 1], parallel: true },
    { indexes: [2], parallel: false },
    { indexes: [3, 4], parallel: true },
    { indexes: [5], parallel: false },
  ]);
});

test('a host can keep a read serial (page tools share one tab)', () => {
  const plan = planToolRound([call('read_page'), call('screenshot'), call('history_search')], {
    concurrent: (c, t) => t.readOnly && !/page|screenshot/.test(c.name),
  });
  assert.deepEqual(plan.batches.map((b) => b.indexes), [[0], [1], [2]]);
  assert.ok(plan.batches.every((b) => !b.parallel));
});

test('identical calls in one round coalesce onto one execution', async () => {
  let ran = 0;
  const events = [];
  const r = await runToolRound([call('get_a', { id: 1 }), call('get_a', { id: 1 }), call('get_a', { id: 2 })], {
    execute: async (c) => { ran += 1; return `res:${c.input.id}`; },
    onStart: (c, i) => events.push(`start:${i}`),
    onDone: (c, i, res) => events.push(`done:${i}=${res}`),
  });
  assert.equal(ran, 2, 'two distinct calls, two executions');
  assert.deepEqual(r.results, ['res:1', 'res:1', 'res:2']);
  assert.deepEqual(r.coalesced, [1]);
  assert.ok(events.includes('start:1') && events.includes('done:1=res:1'), 'the coalesced slot still announces itself');
  assert.equal(r.status, 'completed');
  // Key order does not defeat coalescing.
  const p = planToolRound([call('x', { a: 1, b: 2 }), call('x', { b: 2, a: 1 })]);
  assert.deepEqual(p.primary, [0, 0]);
});

test('reads actually overlap; writes actually do not', async () => {
  const active = new Set();
  let peak = 0;
  const run = async (c) => {
    active.add(c.name); peak = Math.max(peak, active.size);
    await sleep(20);
    active.delete(c.name);
    return 'ok';
  };
  const reads = await runToolRound([call('get_a'), call('get_b'), call('get_c')], { execute: run });
  assert.equal(peak, 3, 'three reads ran together');
  assert.equal(reads.status, 'completed');
  peak = 0;
  await runToolRound([call('click_a'), call('click_b')], { execute: run });
  assert.equal(peak, 1, 'two writes ran one at a time');
  peak = 0;
  await runToolRound([call('get_a'), call('get_b'), call('get_c'), call('get_d'), call('get_e')], { execute: run, maxConcurrency: 2 });
  assert.equal(peak, 2, 'the pool bounds concurrency');
});

test('order of results is the model\'s order, whatever finished first', async () => {
  const r = await runToolRound([call('get_slow'), call('get_fast')], {
    execute: async (c) => { await sleep(c.name === 'get_slow' ? 30 : 1); return c.name; },
  });
  assert.deepEqual(r.results, ['get_slow', 'get_fast']);
});

test('a throw becomes an error result and the round reports partial failure', async () => {
  const r = await runToolRound([call('get_a'), call('get_b'), call('get_c')], {
    execute: async (c) => { if (c.name === 'get_b') throw new Error('boom'); return 'ok'; },
  });
  assert.equal(r.status, 'partial');
  assert.deepEqual(r.failedIndexes, [1]);
  assert.equal(r.succeeded, 2);
  assert.match(r.results[1].error, /boom/);
  const all = await runToolRound([call('get_a')], { execute: async () => 'error: nope' });
  assert.equal(all.status, 'failed');
  const none = await runToolRound([], { execute: async () => 'x' });
  assert.equal(none.status, 'completed');
  assert.deepEqual(none.results, []);
});

test('a host-supplied isError decides what counts as failure', async () => {
  const r = await runToolRound([call('get_a')], { execute: async () => JSON.stringify({ ok: false }), isError: (x) => JSON.parse(x).ok === false });
  assert.deepEqual(r.failedIndexes, [0]);
});
