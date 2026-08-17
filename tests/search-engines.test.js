import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineSearchEngine, reconcileEngines, attemptOrder, SearchEngineError } from '../search-engines.js';

const DECLARED = [
  defineSearchEngine({ id: 'jina', name: 'API', url: 'https://s.jina.ai/', kind: 'api', needsKey: true }),
  defineSearchEngine({ id: 'startpage', url: 'https://startpage/%s', enabled: true }),
  defineSearchEngine({ id: 'duckduckgo', url: 'https://ddg/%s', enabled: true }),
  defineSearchEngine({ id: 'google', url: 'https://g/%s' }),
  defineSearchEngine({ id: 'mojeek', retired: true, url: 'https://mojeek/%s' }),
];
const ids = (l) => l.map((e) => e.id);
const on = (l) => l.filter((e) => e.enabled !== false).map((e) => e.id);

test('a retired engine disappears for users who already stored it', () => {
  // The actual bug: the list lived in the runtime AND in the settings page, so removing a
  // broken engine from one left it showing in the other. One list, one reconcile.
  const stored = [{ id: 'startpage', enabled: true }, { id: 'mojeek', enabled: true }];
  assert.ok(!ids(reconcileEngines(stored, DECLARED)).includes('mojeek'));
});

test('a newly declared engine reaches a user who saved settings long ago', () => {
  // A fix that only lands for new installs is not a fix.
  const stored = [{ id: 'startpage', enabled: true }];
  assert.ok(ids(reconcileEngines(stored, DECLARED)).includes('duckduckgo'));
});

test("a user's own choices survive reconciliation", () => {
  const stored = [{ id: 'startpage', enabled: false }, { id: 'google', enabled: true }];
  const out = reconcileEngines(stored, DECLARED);
  assert.ok(on(out).includes('google'), 'an engine the user switched on was turned off');
  assert.ok(!on(out).includes('startpage'), 'an engine the user switched off came back on');
});

test('an engine that needs a key stays off without one, however the settings look', () => {
  // Otherwise an old stored config could silently start sending queries to a third party.
  const sneaky = [{ id: 'jina', enabled: true }, { id: 'startpage', enabled: true }];
  assert.ok(!on(reconcileEngines(sneaky, DECLARED)).includes('jina'));
  assert.ok(on(reconcileEngines(sneaky, DECLARED, { hasKey: true })).includes('jina'));
});

test('a key does not override an explicit refusal', () => {
  const declined = [{ id: 'jina', enabled: false }, { id: 'startpage', enabled: true }];
  assert.ok(!on(reconcileEngines(declined, DECLARED, { hasKey: true })).includes('jina'));
});

test('reconciliation never leaves the user with nothing usable', () => {
  // Retiring an engine can empty a list that contained only that engine, and a search
  // feature that silently has no engines is a worse failure than the one being fixed.
  const out = reconcileEngines([{ id: 'mojeek', enabled: true }], DECLARED);
  assert.ok(on(out).filter((id) => id !== 'jina').length > 0);
});

test('order is enabled-first, then the rest as fallbacks', () => {
  // Engines are tried one at a time: fanning out to all of them is five times the footprint
  // against services that ban scrapers, and being blocked everywhere makes redundancy
  // worthless because every fallback is blocked too.
  const order = attemptOrder(reconcileEngines([], DECLARED));
  assert.deepEqual(ids(order).slice(0, 2).sort(), ['duckduckgo', 'startpage']);
  assert.ok(!ids(order).includes('mojeek'), 'a retired engine was still attempted');
  assert.ok(ids(order).includes('google'), 'a disabled engine is a fallback, not a deletion');
});

test('reconciliation is idempotent and declarations are checked at declare time', () => {
  const once = reconcileEngines([{ id: 'startpage', enabled: true }], DECLARED);
  assert.deepEqual(ids(reconcileEngines(once, DECLARED)), ids(once));
  assert.throws(() => defineSearchEngine({ id: 'x' }), (e) => e instanceof SearchEngineError);
  assert.throws(() => defineSearchEngine({ id: 'x', url: 'u', kind: 'telepathy' }), (e) => e.code === 'BAD_ENGINE');
});
