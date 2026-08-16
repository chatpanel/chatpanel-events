import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCapability, validateInvocation, canSatisfy, toModelSchema } from '../capability.js';

const pageActions = {
  id: 'page.actions', version: '1.0.0', class: 'R',
  requires: ['tab'], provides: ['page.tools'],
  reads: ['page'], writes: ['page'],
  egress: 'none', effects: 'non-replayable',
  input: { type: 'object', properties: { selector: { type: 'string' } } },
  output: { schema: { type: 'string' }, render: (v) => [{ type: 'text', text: v }] },
  disclose: () => ({ name: 'page.actions', gist: 'Act on the current web page' }),
  cost: () => ({ tokens: 1800 }),
  invoke: async () => ({ ok: true }),
};

test('a valid declaration passes', () => {
  assert.equal(validateCapability(pageActions).id, 'page.actions');
});

test('class R declaring egress is a contradiction, not a warning', () => {
  assert.throws(
    () => validateCapability({ ...pageActions, egress: 'redacted' }),
    /class R must declare egress:none/,
  );
});

test('reads/writes are constrained to known data scopes — the access statement is checkable', () => {
  assert.throws(() => validateCapability({ ...pageActions, reads: ['everything'] }), /reads must be within/);
});

test('canonical value and rendering must be separate', () => {
  assert.throws(() => validateCapability({ ...pageActions, output: { schema: {} } }), /output.render required/);
});

test('a non-pure invocation is refused without an idempotency key', () => {
  const base = { capability: 'page.actions', actor: { kind: 'rule', id: 'r1' }, scope: { kind: 'tab', id: '42' }, causes: [] };
  assert.throws(() => validateInvocation(base, pageActions), /requires an idempotencyKey/);
  assert.ok(validateInvocation({ ...base, idempotencyKey: 'k1' }, pageActions));
});

test('every actor kind uses the identical call shape — turn-independence', () => {
  for (const kind of ['user', 'rule', 'schedule', 'model', 'agent']) {
    assert.ok(validateInvocation(
      { capability: 'page.actions', actor: { kind, id: 'a' }, scope: { kind: 'tab', id: '1' }, causes: [], idempotencyKey: 'k' },
      pageActions,
    ));
  }
});

test('canSatisfy REFUSES rather than silently exceeding a requirement', () => {
  const cloud = { ...pageActions, class: 'C', egress: 'redacted' };
  assert.ok(!canSatisfy(cloud, { deterministic: true }).ok);
  assert.ok(!canSatisfy(cloud, { egress: 'none' }).ok);
  assert.ok(canSatisfy(pageActions, { deterministic: true, egress: 'none' }).ok);
});

test('class is intrinsic, latency is host-bound — the two are never fused', () => {
  const mv3Cold = { realizes: { R: { maxMs: 500 } } };   // service-worker spin-up
  const daemon = { realizes: { R: { maxMs: 1 } } };
  assert.ok(!canSatisfy(pageActions, { maxLatencyMs: 10 }, mv3Cold).ok);
  assert.ok(canSatisfy(pageActions, { maxLatencyMs: 10 }, daemon).ok);
});

test('the model-facing projection is an allowlist — internals cannot leak', () => {
  const schema = toModelSchema(pageActions);
  assert.deepEqual(Object.keys(schema).sort(), ['description', 'name', 'parameters']);
  for (const leak of ['invoke', 'effects', 'cost', 'writes', 'egress', 'output', 'provides']) {
    assert.ok(!(leak in schema), `${leak} leaked into the model request`);
  }
});
