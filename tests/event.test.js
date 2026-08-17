import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppender, validateEvent, isValidEvent, ALL_TYPES, CURRENT_VERSION } from '../event.js';
import { makeRef, resolveRef, RESOLUTION } from '../ref.js';

const fixed = (host) => {
  let i = 0;
  return createAppender({ host, now: () => 1_700_000_000_000, newId: () => `${host}_${i++}` });
};

test('appender owns seq — callers cannot skip or reuse one', () => {
  const a = fixed('h1');
  const e0 = a.append('turn.started', { turnId: 't1' });
  const e1 = a.append('turn.ended', { turnId: 't1' }, [e0.id]);
  assert.equal(e0.seq, 0);
  assert.equal(e1.seq, 1);
  assert.equal(e1.causes[0], e0.id);
  assert.equal(e0.v, CURRENT_VERSION);
});

test('every declared type is validatable and unknown types are rejected', () => {
  assert.ok(ALL_TYPES.includes('automation.suppressed'));
  // 24 = 21 + the assistant family (prompted, message, reasoning). The count is asserted
  // so growing the schema is a deliberate act: every new type is a forever commitment.
  assert.equal(ALL_TYPES.length, 24);
  assert.throws(() => validateEvent({
    v: 1, id: 'x', host: 'h', seq: 0, causes: [], at: 1, type: 'turn.exploded', payload: {},
  }), /unknown type/);
});

test('I3 is structural — a non-pure invocation without a key cannot enter the log', () => {
  const a = fixed('h1');
  assert.throws(() => a.append('capability.invoked', {
    capability: 'page.actions',
    actor: { kind: 'rule', id: 'r1' },
    scope: { kind: 'tab', id: '42' },
    effects: 'non-replayable',
    // no idempotencyKey
  }), /payload invalid/);

  const ok = a.append('capability.invoked', {
    capability: 'page.actions',
    actor: { kind: 'rule', id: 'r1' },
    scope: { kind: 'tab', id: '42' },
    effects: 'non-replayable',
    idempotencyKey: 'k-1',
  });
  assert.ok(isValidEvent(ok));
});

test('a pure invocation needs no key', () => {
  const a = fixed('h1');
  const e = a.append('capability.invoked', {
    capability: 'history.search',
    actor: { kind: 'model', id: 'm1' },
    scope: { kind: 'session', id: 's1' },
    effects: 'pure',
  });
  assert.ok(isValidEvent(e));
});

test('privacy.redacted carries counts, never values', () => {
  const a = fixed('h1');
  assert.ok(isValidEvent(a.append('privacy.redacted', { counts: { PERSON: 2, EMAIL: 1 } })));
  // a payload whose "counts" are strings is a value leak wearing a count's name
  assert.throws(() => a.append('privacy.redacted', { counts: { PERSON: 'Alex Rivera' } }), /payload invalid/);
});

test('context.assembled requires hashed Refs, not content', () => {
  const a = fixed('h1');
  const ref = makeRef({ kind: 'note', id: 'n_88', hash: 'sha256:abc', range: { from: 10, to: 40 } });
  assert.ok(isValidEvent(a.append('context.assembled', {
    turnId: 't1', budget: 8000, used: 2140, parts: { system: 400 }, resident: [ref], reachableCount: 34,
  })));
  assert.throws(() => a.append('context.assembled', {
    turnId: 't1', budget: 8000, used: 10, parts: {}, resident: [{ text: 'the actual note body' }], reachableCount: 0,
  }), /payload invalid/);
});

test('refs resolve exact / unavailable / drifted — never a silent substitution', () => {
  const ref = makeRef({ kind: 'note', id: 'n_1', hash: 'h_at_capture' });
  assert.equal(resolveRef(ref, () => null).resolution, RESOLUTION.UNAVAILABLE);
  assert.equal(resolveRef(ref, () => ({ hash: 'h_now' })).resolution, RESOLUTION.DRIFTED);
  assert.equal(resolveRef(ref, () => ({ hash: 'h_at_capture', value: 'x' })).resolution, RESOLUTION.EXACT);
});

test('events are frozen — an append-only log is not editable in place', () => {
  const e = fixed('h1').append('turn.started', { turnId: 't1' });
  assert.throws(() => { 'use strict'; e.seq = 99; }, TypeError);
});
