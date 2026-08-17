import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKernel, meetDecisions, KernelError, ALLOW_ALL } from '../kernel.js';

const security = { id: 'security', activate: () => {} };

test('will not start without the security plugin', async () => {
  const k = createKernel();
  k.define({ id: 'ui', activate: () => {} });
  await assert.rejects(() => k.start(), (e) => e instanceof KernelError && e.code === 'MISSING_REQUIRED');
  assert.equal(k.started, false, 'a kernel that refused to start must not report itself started');
});

test('will not start when the security plugin is declared but fails to activate', async () => {
  // Declared-but-dead is the same problem as never-installed, and the kernel must not be
  // the component that papers over the difference.
  const k = createKernel();
  k.define({ id: 'security', activate: () => { throw new Error('boom'); } });
  await assert.rejects(() => k.start(), (e) => e.code === 'REQUIRED_INACTIVE');
});

test('will not start when the security plugin waits on a dependency that never arrives', async () => {
  const k = createKernel();
  k.define({ id: 'security', requires: ['crypto'], activate: () => {} });
  await assert.rejects(() => k.start(), (e) => e.code === 'REQUIRED_INACTIVE');
});

test('security cannot be removed at runtime', async () => {
  const k = createKernel();
  k.define(security);
  await k.start();
  assert.throws(() => k.remove('security'), (e) => e.code === 'REQUIRED');
  assert.ok(k.active().includes('security'));
});

test('everything else is removable', async () => {
  const k = createKernel();
  k.define(security);
  k.define({ id: 'loop', activate: () => {} });
  await k.start();
  await k.remove('loop');
  assert.deepEqual(k.list(), ['security']);
});

test('a plugin is activated through its loader, so the module costs nothing until then', async () => {
  let imported = 0;
  const k = createKernel();
  k.define(security);
  k.define({ id: 'heavy', load: async () => { imported++; return { activate: () => {} }; } });
  assert.equal(imported, 0, 'declaring a plugin executed its module');
  await k.start();
  assert.equal(imported, 1);
});

// ---- monotonicity: the guarantee the whole plugin story rests on ----

test('a guard can narrow', async () => {
  const k = createKernel();
  k.define(security);
  k.define({ id: 'p', activate: (ctx) => { ctx.guard('egress', () => false); } });
  await k.start();
  assert.equal(k.decide('egress', {}).allow, false);
});

test('a guard CANNOT widen a denial', async () => {
  const k = createKernel();
  k.define(security);
  k.define({ id: 'deny', activate: (ctx) => { ctx.guard('egress', () => false); } });
  k.define({ id: 'evil', activate: (ctx) => { ctx.guard('egress', () => ({ allow: true })); } });
  await k.start();
  assert.equal(k.decide('egress', {}).allow, false, 'a later guard reopened a denial');
});

test('widening is impossible in either order — meet is commutative', async () => {
  for (const order of [['deny', 'evil'], ['evil', 'deny']]) {
    const k = createKernel();
    k.define(security);
    for (const id of order) {
      k.define(id === 'deny'
        ? { id, activate: (ctx) => ctx.guard('egress', () => false) }
        : { id, activate: (ctx) => ctx.guard('egress', () => ({ allow: true })) });
    }
    await k.start();
    assert.equal(k.decide('egress', {}).allow, false, `order ${order.join(',')} let the denial through`);
  }
});

test('a guard cannot add scopes it was not given', async () => {
  const k = createKernel();
  k.define(security);
  k.define({ id: 'narrow', activate: (ctx) => ctx.guard('read', () => ({ scopes: ['notes'] })) });
  k.define({ id: 'grabby', activate: (ctx) => ctx.guard('read', () => ({ scopes: ['notes', 'meetings', 'chats'] })) });
  await k.start();
  assert.deepEqual(k.decide('read', {}).scopes, ['notes']);
});

test('dropping scoping entirely is treated as widening, not as abstaining', async () => {
  const seen = [];
  const k = createKernel({ onEvent: (e) => { if (e.event === 'guard:widened') seen.push(e.pluginId); } });
  k.define(security);
  k.define({ id: 'narrow', activate: (ctx) => ctx.guard('read', () => ({ scopes: ['notes'] })) });
  k.define({ id: 'unscoped', activate: (ctx) => ctx.guard('read', () => ({ allow: true, scopes: null })) });
  await k.start();
  assert.deepEqual(k.decide('read', {}).scopes, ['notes'], 'scoping was dropped');
  assert.deepEqual(seen, ['unscoped'], 'the attempt was not reported');
});

test('a guard that throws denies — crashing is not a bypass', async () => {
  const k = createKernel();
  k.define(security);
  k.define({ id: 'crash', activate: (ctx) => ctx.guard('egress', () => { throw new Error('nope'); }) });
  await k.start();
  const d = k.decide('egress', {});
  assert.equal(d.allow, false);
  assert.match(d.reasons.join(' '), /guard threw/);
});

test('a guard that abstains leaves the decision alone', async () => {
  const k = createKernel();
  k.define(security);
  k.define({ id: 'quiet', activate: (ctx) => ctx.guard('egress', () => null) });
  await k.start();
  assert.equal(k.decide('egress', {}).allow, true);
});

test('removing a plugin removes its guards', async () => {
  const k = createKernel();
  k.define(security);
  k.define({ id: 'deny', activate: (ctx) => ctx.guard('egress', () => false) });
  await k.start();
  assert.equal(k.decide('egress', {}).allow, false);
  await k.remove('deny');
  assert.equal(k.decide('egress', {}).allow, true, 'a removed plugin still influenced decisions');
});

test('meet is associative, so guard evaluation order can never change the answer', () => {
  const a = { allow: true, scopes: ['a', 'b'], reasons: [] };
  const b = { allow: true, scopes: ['b', 'c'], reasons: [] };
  const c = { allow: true, scopes: ['b'], reasons: [] };
  assert.deepEqual(
    meetDecisions(meetDecisions(a, b), c).scopes,
    meetDecisions(a, meetDecisions(b, c)).scopes,
  );
});

test('ALLOW_ALL is the identity, so an unguarded decision is unchanged', () => {
  const d = { allow: true, scopes: ['notes'], reasons: [] };
  assert.deepEqual(meetDecisions(ALLOW_ALL, d).scopes, ['notes']);
});
