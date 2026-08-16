import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../registry.js';

test('effects unwind LIFO — each inverse meets the state its application produced', async () => {
  const order = [];
  const reg = createRegistry();
  const c = reg.register({
    name: 'c',
    apply(ctx) {
      ctx.effect(() => { order.push('mount:1'); return () => order.push('dispose:1'); });
      ctx.effect(() => { order.push('mount:2'); return () => order.push('dispose:2'); });
      ctx.effect(() => { order.push('mount:3'); return () => order.push('dispose:3'); });
    },
  });
  await c.dispose();
  assert.deepEqual(order, ['mount:1', 'mount:2', 'mount:3', 'dispose:3', 'dispose:2', 'dispose:1']);
});

test('a component waits until every requirement is provided', () => {
  const reg = createRegistry();
  const c = reg.register({ name: 'page-tools', requires: ['tab', 'bridge'], apply: () => {} });
  assert.equal(c.state, 'inactive');
  assert.deepEqual(reg.pending(), [{ name: 'page-tools', waitingFor: ['tab', 'bridge'] }]);

  reg.provide('tab', { id: 42 });
  assert.equal(c.state, 'inactive');
  reg.provide('bridge', { url: 'http://127.0.0.1:4319' });
  assert.equal(c.state, 'active');
});

// The ChatPanel-shaped case from the ADR probe: a capability that appears and
// disappears the way a bridge or a tab does.
test('withdraw deactivates dependents; re-provide re-arms them', async () => {
  const armed = [];
  const reg = createRegistry();
  reg.register({
    name: 'history', requires: [],
    apply: (ctx) => { ctx.effect(() => { armed.push('history_search'); return () => armed.splice(armed.indexOf('history_search'), 1); }); },
  });
  reg.register({
    name: 'page', requires: ['tab'],
    apply: (ctx) => { ctx.effect(() => { armed.push('act_on_page'); return () => armed.splice(armed.indexOf('act_on_page'), 1); }); },
  });

  assert.deepEqual([...armed].sort(), ['history_search']);
  const withdrawTab = reg.provide('tab', { id: 1 });
  assert.deepEqual([...armed].sort(), ['act_on_page', 'history_search']);
  withdrawTab();
  assert.deepEqual([...armed].sort(), ['history_search']);
  reg.provide('tab', { id: 2 });
  assert.deepEqual([...armed].sort(), ['act_on_page', 'history_search']);
});

test('RULE 2 — a dependent tears down BEFORE the binding disappears, so it can still read it', () => {
  const trace = [];
  const reg = createRegistry();
  reg.register({
    name: 'pool', requires: [],
    apply: (ctx) => ctx.effect(() => { ctx.provide('conn', { close: () => trace.push('conn.close') }); return () => trace.push('pool.down'); }),
  });
  reg.register({
    name: 'consumer', requires: ['conn'],
    apply: (ctx) => ctx.effect(() => () => {
      // The teardown NEEDS the capability it is being torn down over.
      const conn = ctx.get('conn');
      assert.ok(conn, 'consumer teardown could not read the capability being withdrawn');
      conn.close();
      trace.push('consumer.down');
    }),
  });

  assert.deepEqual(reg.active().sort(), ['consumer', 'pool']);
  reg.dispose();
  assert.deepEqual(trace, ['conn.close', 'consumer.down', 'pool.down']);
});

test('a provider going away cascades to its dependents', () => {
  const reg = createRegistry();
  reg.register({ name: 'gateway', requires: [], apply: (ctx) => ctx.provide('llm', {}) });
  const consumer = reg.register({ name: 'chat', requires: ['llm'], apply: () => {} });
  assert.equal(consumer.state, 'active');
  reg.dispose();
  assert.equal(consumer.state, 'inactive');
});

test('nested components dispose with their parent', async () => {
  const alive = new Set();
  const reg = createRegistry();
  const parent = reg.register({
    name: 'meeting', requires: [],
    apply(ctx) {
      ctx.effect(() => { alive.add('captions'); return () => alive.delete('captions'); });
      ctx.register({
        name: 'monitor', requires: [],
        apply: (c2) => c2.effect(() => { alive.add('monitor'); return () => alive.delete('monitor'); }),
      });
    },
  });
  assert.deepEqual([...alive].sort(), ['captions', 'monitor']);
  await parent.dispose();
  assert.equal(alive.size, 0, 'a nested component leaked past its parent');
});

test('a failing component is recorded, unwinds, and leaves its siblings running', () => {
  const alive = new Set();
  const reg = createRegistry();
  const bad = reg.register({
    name: 'bad', requires: [],
    apply(ctx) {
      ctx.effect(() => { alive.add('partial'); return () => alive.delete('partial'); });
      throw new Error('boom');
    },
  });
  const good = reg.register({ name: 'good', requires: [], apply: (ctx) => ctx.effect(() => { alive.add('good'); return () => alive.delete('good'); }) });
  assert.equal(bad.state, 'inactive');
  assert.match(bad.error.message, /boom/);
  assert.ok(!alive.has('partial'), 'a failed component left an effect behind');
  assert.equal(good.state, 'active');
});

test('a dependency cycle leaves both inactive and is visible from the declarations', () => {
  const reg = createRegistry();
  reg.register({ name: 'A', requires: ['k'], apply: (ctx) => ctx.provide('j', {}) });
  reg.register({ name: 'B', requires: ['j'], apply: (ctx) => ctx.provide('k', {}) });
  assert.deepEqual(reg.active(), []);
  assert.deepEqual(reg.pending().map((p) => p.name).sort(), ['A', 'B']);
});

test('activation cascades reach a fixpoint', () => {
  const reg = createRegistry();
  reg.register({ name: 'C', requires: ['b'], apply: (ctx) => ctx.provide('c', {}) });
  reg.register({ name: 'B', requires: ['a'], apply: (ctx) => ctx.provide('b', {}) });
  reg.register({ name: 'A', requires: [], apply: (ctx) => ctx.provide('a', {}) });
  assert.deepEqual(reg.active(), ['A', 'B', 'C']);
  assert.ok(reg.has('c'));
});

test('two providers cannot claim one key — single-source discipline', () => {
  const reg = createRegistry();
  reg.provide('llm', {});
  assert.throws(() => reg.provide('llm', {}), /already provided/);
});

test('async disposers are awaited before dispose() resolves', async () => {
  const done = [];
  const reg = createRegistry();
  reg.register({
    name: 'slow', requires: [],
    apply: (ctx) => ctx.effect(() => () => new Promise((r) => setTimeout(() => { done.push('flushed'); r(); }, 10))),
  });
  await reg.dispose();
  assert.deepEqual(done, ['flushed']);
});

test('lifecycle transitions are observable, so they can become durable facts', () => {
  const events = [];
  const reg = createRegistry({ onEvent: (e) => events.push(`${e.event}:${e.name || e.key}`) });
  reg.register({ name: 'page', requires: ['tab'], apply: (ctx) => ctx.effect(() => () => {}) });
  const off = reg.provide('tab', {});
  off();
  assert.deepEqual(events, ['provided:tab', 'activated:page', 'deactivated:page', 'withdrawn:tab']);
});
