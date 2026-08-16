import test from 'node:test';
import assert from 'node:assert/strict';
import { linearize, compareEvents, causesAreWellFormed } from '../order.js';
import { EventError } from '../event.js';

const ev = (id, host, seq, causes = [], at = 0) =>
  ({ v: 1, id, host, seq, causes, at, type: 'turn.started', payload: { turnId: id } });

test('order is (host, seq) — never wall clock', () => {
  // b claims an EARLIER timestamp than a, and still sorts after it: clocks do not order.
  const a = ev('a', 'alpha', 0, [], 9_999);
  const b = ev('b', 'beta', 0, [], 1);
  assert.deepEqual(linearize([b, a]).map((e) => e.id), ['a', 'b']);
  assert.ok(compareEvents(a, b) < 0);
});

test('causes dominate the tie-break', () => {
  // zulu/0 causes alpha/0, so it must precede it despite host ordering.
  const z = ev('z', 'zulu', 0);
  const a = ev('a', 'alpha', 0, ['z']);
  assert.deepEqual(linearize([a, z]).map((e) => e.id), ['z', 'a']);
});

test('linearize is a function of the event SET, not the input order', () => {
  const evs = [
    ev('e1', 'h1', 0), ev('e2', 'h2', 0), ev('e3', 'h1', 1, ['e1']),
    ev('e4', 'h2', 1, ['e2']), ev('e5', 'h1', 2, ['e3', 'e4']),
  ];
  const base = linearize(evs).map((e) => e.id).join(',');
  for (let i = 0; i < 50; i++) {
    const shuffled = [...evs].sort(() => Math.random() - 0.5);
    assert.equal(linearize(shuffled).map((e) => e.id).join(','), base);
  }
});

test('dangling causes are ignored so a sanitized export still replays', () => {
  const e = ev('e', 'h1', 5, ['not_in_this_export']);
  assert.deepEqual(linearize([e]).map((x) => x.id), ['e']);
});

test('a cycle is fatal — that means the log is corrupt', () => {
  const a = ev('a', 'h1', 0, ['b']);
  const b = ev('b', 'h1', 1, ['a']);
  assert.throws(() => linearize([a, b]), (err) => err instanceof EventError && err.code === 'CYCLE');
});

test('causesAreWellFormed catches a cause pointing forward in its own host', () => {
  assert.ok(causesAreWellFormed([ev('a', 'h1', 0), ev('b', 'h1', 1, ['a'])]));
  assert.ok(!causesAreWellFormed([ev('a', 'h1', 5), ev('b', 'h1', 1, ['a'])]));
});
