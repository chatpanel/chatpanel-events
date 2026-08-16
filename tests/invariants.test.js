import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppender } from '../event.js';
import { makeRef } from '../ref.js';
import { checkInvariants } from '../invariants.js';

const appender = (host = 'ext') => {
  let i = 0;
  return createAppender({ host, now: () => 1_700_000_000_000, newId: () => `${host}_${i++}` });
};

// The F1 trace from the design doc: a rule arms a capability, with no turn anywhere.
function f1Trace() {
  const a = appender();
  const offered = a.append('capability.offered', { capability: 'page.actions', reason: 'rule:canvas-adapter', siteKey: 'excalidraw.com' });
  const granted = a.append('capability.granted', { capability: 'page.actions', actor: { kind: 'user', id: 'u1' } }, [offered.id]);
  const activated = a.append('capability.activated', { capability: 'page.actions', classUsed: 'R', tabId: 42 }, [granted.id]);
  const revoked = a.append('capability.revoked', { capability: 'page.actions', cause: 'navigate' }, [activated.id]);
  return [offered, granted, activated, revoked];
}

test('the F1 trace is sound — a rule arms a capability with no turn in sight', () => {
  const events = f1Trace();
  assert.deepEqual(checkInvariants(events), []);
  assert.ok(events.every((e) => e.type.startsWith('capability.')));
});

test('I4 — a revoke that does not name its activation is a violation', () => {
  const [offered, granted, activated] = f1Trace();
  const a = appender('other');
  const orphan = a.append('capability.revoked', { capability: 'page.actions', cause: 'navigate' }, []);
  const violations = checkInvariants([offered, granted, activated, orphan]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].invariant, 'I4');
  assert.match(violations[0].message, /no recorded inverse/);
});

test('I2 — an invocation that egresses without a privacy.egress is a violation', () => {
  const a = appender();
  const inv = a.append('capability.invoked', {
    capability: 'cloud.chat', actor: { kind: 'model', id: 'm' }, scope: { kind: 'session', id: 's' },
    effects: 'pure', egress: 'redacted',
  });
  const v = checkInvariants([inv]);
  assert.equal(v.length, 1);
  assert.equal(v[0].invariant, 'I2');

  const eg = a.append('privacy.egress', { host: 'api.openai.com', redacted: true, controlled: true }, [inv.id]);
  assert.deepEqual(checkInvariants([inv, eg]), []);
});

test('I2 records a class-A agent send as delegated and uncontrolled', () => {
  const a = appender();
  const inv = a.append('capability.invoked', {
    capability: 'agent.codex', actor: { kind: 'user', id: 'u' }, scope: { kind: 'session', id: 's' },
    effects: 'non-replayable', idempotencyKey: 'k1', egress: 'delegated',
  });
  const eg = a.append('privacy.egress', { host: 'agent:codex', redacted: false, controlled: false }, [inv.id]);
  assert.deepEqual(checkInvariants([inv, eg]), []);
  assert.equal(eg.payload.controlled, false);
});

test('I1 — a turn that stepped without assembling context is a violation', () => {
  const a = appender();
  const started = a.append('turn.started', { turnId: 't1' });
  const ended = a.append('turn.ended', { turnId: 't1' }, [started.id]);
  const v = checkInvariants([started, ended]);
  assert.equal(v.length, 1);
  assert.equal(v[0].invariant, 'I1');

  const b = appender('ext2');
  const s2 = b.append('turn.started', { turnId: 't2' });
  const asm = b.append('context.assembled', {
    turnId: 't2', budget: 8000, used: 210, parts: { system: 210 },
    resident: [makeRef({ kind: 'note', id: 'n1', hash: 'h1' })], reachableCount: 12,
  }, [s2.id]);
  const e2 = b.append('turn.ended', { turnId: 't2' }, [asm.id]);
  assert.deepEqual(checkInvariants([s2, asm, e2]), []);
});

test('I6 — linearization is stable, so replay is deterministic', () => {
  assert.deepEqual(checkInvariants(f1Trace()).filter((v) => v.invariant === 'I6'), []);
});
