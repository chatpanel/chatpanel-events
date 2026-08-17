import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineAdapter, createAdapterRegistry, AdapterError } from '../adapters.js';

const mk = (id, matches, priority = 0) => defineAdapter({ id, matches, execute: async () => ({ ok: true }), priority });

test('an adapter is selected by what it recognises, not by a hostname table', () => {
  // Recognition takes the capability probe too, so a self-hosted or embedded instance is
  // matched by what it IS — which is why a hostname table was rejected in the first place.
  const reg = createAdapterRegistry();
  reg.add(mk('sheets', (url) => /docs\.google\.com\/spreadsheets/.test(url)));
  reg.add(mk('excalidraw', (url, caps) => caps.excalidrawApi === true));

  assert.equal(reg.for('https://docs.google.com/spreadsheets/d/abc/edit').id, 'sheets');
  assert.equal(reg.for('https://draw.example.internal/board', { excalidrawApi: true }).id, 'excalidraw');
  assert.equal(reg.for('https://example.com'), null);
});

test('a matcher that throws does not take the page down', () => {
  // One badly-written adapter must not stop the others being offered — the same isolation
  // rule the source registry follows.
  const reg = createAdapterRegistry();
  reg.add(mk('broken', () => { throw new Error('boom'); }));
  reg.add(mk('good', () => true));
  assert.equal(reg.for('https://example.com').id, 'good');
});

test('priority decides between two matches, and ties are stable', () => {
  const reg = createAdapterRegistry();
  reg.add(mk('generic', () => true, 0));
  reg.add(mk('specific', () => true, 10));
  assert.equal(reg.for('https://example.com').id, 'specific');

  const tied = createAdapterRegistry();
  tied.add(mk('first', () => true));
  tied.add(mk('second', () => true));
  assert.equal(tied.for('https://example.com').id, 'first', 'a tie resolved by activation timing is not an answer');
});

test('registration is revertible, so a plugin can be unloaded (P15)', () => {
  const reg = createAdapterRegistry();
  const remove = reg.add(mk('temp', () => true));
  assert.equal(reg.list().length, 1);
  remove();
  assert.equal(reg.list().length, 0);
  assert.equal(reg.for('https://example.com'), null);
});

test('a declaration missing what it needs is rejected at declare time', () => {
  // Not at page-match time, when the failure would look like "the app is unsupported".
  assert.throws(() => defineAdapter({ id: 'x' }), (e) => e instanceof AdapterError);
  assert.throws(() => defineAdapter({ matches: () => true, execute: async () => {} }), (e) => e.code === 'BAD_ADAPTER');
});

test('optional parts have safe defaults, so a minimal adapter is legal', () => {
  const a = mk('minimal', () => true);
  assert.deepEqual(a.toolSpecs(), []);
  assert.equal(a.guidance(), '');
  assert.equal(a.label, 'minimal');
});
