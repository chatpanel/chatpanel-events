// A capability's own UI. The whole security question is one sentence: can a view do anything
// its capability could not? These tests exist to keep the answer "no".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateView, validateViewInvocation, viewResult } from '../view.js';

const cap = (over = {}) => ({
  id: 'calc', version: '1.0.0', class: 'R', requires: ['units'], provides: [],
  reads: [], writes: [], egress: 'none', effects: 'pure',
  invoke: () => {}, disclose: () => ({}), output: { render: () => '' },
  ...over,
});

test('a view declaration is approvable without running it', () => {
  const v = validateView({ id: 'calc.ui', html: '<div>0</div>' });
  assert.equal(v.id, 'calc.ui');
  assert.throws(() => validateView({ id: 'x' }), /html required/);
  assert.throws(() => validateView({ html: '<i>' }), /id required/);
  assert.throws(() => validateView({ id: 'x', html: '<i>', height: 99999 }), /height/);
});

test('a view cannot declare more reach than its capability has', () => {
  const c = cap();
  // Its own id and anything already in `requires` are fine.
  assert.ok(validateView({ id: 'u', html: '<i>', mayInvoke: ['calc', 'units'] }, c));
  // Anything else is refused at APPROVAL time, not at call time.
  assert.throws(
    () => validateView({ id: 'u', html: '<i>', mayInvoke: ['history_search'] }, c),
    /exceeds its capability/,
  );
});

test('a message from a view is untrusted input, checked against the declaration', () => {
  const c = cap({ view: { id: 'u', html: '<i>', mayInvoke: ['units'] } });
  const ok = validateViewInvocation({ callId: 'c1', capability: 'units', args: { to: 'kg' } }, c);
  assert.deepEqual(ok, { capability: 'units', args: { to: 'kg' }, callId: 'c1' });

  // The refusal that matters: a view asking for something it was never granted.
  assert.throws(
    () => validateViewInvocation({ callId: 'c2', capability: 'history_search' }, c),
    /may not invoke/,
  );
  // And the shape rules that keep the channel correlatable and typed.
  assert.throws(() => validateViewInvocation({ capability: 'units' }, c), /callId/);
  assert.throws(() => validateViewInvocation({ callId: 'c', capability: 'units', args: [1] }, c), /args must be an object/);
  assert.throws(() => validateViewInvocation({ callId: 'c', capability: 'units' }, cap()), /declares no view/);
});

test('the canonical value survives a host that cannot render views', () => {
  const c = cap({ view: { id: 'u', html: '<i>' } });
  assert.deepEqual(viewResult(42, cap()), { value: 42 }, 'no view → just the value');
  const r = viewResult(42, c, { total: 42 });
  assert.equal(r.value, 42, 'value is never replaced by its presentation');
  assert.equal(r.view, 'u');
  assert.deepEqual(r.state, { total: 42 });
});
