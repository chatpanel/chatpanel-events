import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppender } from '../event.js';
import { makeRef, resolveRef, RESOLUTION } from '../ref.js';
import { createLogStore, createBlobStore, createMemoryAdapter } from '../store.js';

const appender = (host = 'ext') => {
  let i = 0;
  return createAppender({ host, now: () => 1_700_000_000_000, newId: () => `${host}_${i++}` });
};

test('append is idempotent on event id — replication retries are safe', () => {
  const log = createLogStore();
  const e = appender().append('turn.started', { turnId: 't1' });
  assert.equal(log.append(e).appended, true);
  assert.equal(log.append(e).appended, false);   // retry
  assert.equal(log.stats().events, 1);
});

test('a seq that moves backwards is rejected — that is a corrupt writer, not a gap', () => {
  const log = createLogStore();
  const a = appender();
  log.append(a.append('turn.started', { turnId: 't1' }));      // seq 0
  log.append(a.append('turn.ended', { turnId: 't1' }));        // seq 1
  const stale = { ...a.append('turn.started', { turnId: 't2' }), seq: 0, id: 'dup_seq' };
  assert.throws(() => log.append(stale), /already seen for host/);
});

test('gaps are allowed — eviction must not corrupt the log', () => {
  const log = createLogStore();
  const a = createAppender({ host: 'ext', seq: 40, now: () => 1, newId: () => 'x1' });
  log.append(a.append('turn.started', { turnId: 't' }));
  const b = createAppender({ host: 'ext', seq: 900, now: () => 1, newId: () => 'x2' });
  assert.equal(log.append(b.append('turn.ended', { turnId: 't' })).appended, true);
});

test('cursor + since() give a replica exactly what it lacks', () => {
  const log = createLogStore();
  const ext = appender('ext');
  const gw = appender('gateway');
  log.append(ext.append('turn.started', { turnId: 't1' }));
  log.append(gw.append('turn.started', { turnId: 't2' }));
  const replica = log.cursor();
  assert.deepEqual(replica, { ext: 0, gateway: 0 });

  log.append(ext.append('turn.ended', { turnId: 't1' }));
  const missing = log.since(replica);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].host, 'ext');
  assert.deepEqual(log.since(log.cursor()), []);
});

test('ordered() is replay order, never insertion order', () => {
  const log = createLogStore();
  const a = appender('zulu');
  const b = appender('alpha');
  const cause = a.append('capability.activated', { capability: 'c', classUsed: 'R' });
  const effect = b.append('capability.revoked', { capability: 'c', cause: 'navigate' }, [cause.id]);
  log.append(effect);   // inserted FIRST
  log.append(cause);
  assert.deepEqual(log.ordered().map((e) => e.id), [cause.id, effect.id]);
});

test('ancestry walks the causality chain backwards', () => {
  const log = createLogStore();
  const a = appender();
  const e1 = a.append('capability.offered', { capability: 'page.actions', reason: 'rule:x' });
  const e2 = a.append('capability.granted', { capability: 'page.actions', actor: { kind: 'user', id: 'u' } }, [e1.id]);
  const e3 = a.append('capability.activated', { capability: 'page.actions', classUsed: 'R' }, [e2.id]);
  [e1, e2, e3].forEach((e) => log.append(e));
  assert.deepEqual(log.ancestry(e3.id).map((e) => e.id), [e3.id, e2.id, e1.id]);
});

test('blobs dedupe — the same excerpt across many turns costs one copy', async () => {
  const blobs = createBlobStore();
  const excerpt = 'the pricing decision from the Aug 12 call';
  const h1 = await blobs.put(excerpt);
  const h2 = await blobs.put(excerpt);
  assert.equal(h1, h2);
  assert.equal(blobs.stats().blobs, 1);
});

test('crypto-shred drops the payload and keeps the audit chain', async () => {
  const log = createLogStore();
  const blobs = createBlobStore();
  const hash = await blobs.put('confidential meeting transcript');
  const ref = makeRef({ kind: 'meeting', id: 'm_1', hash, stored: true });

  const a = appender();
  const attached = a.append('context.attached', { ref });
  log.append(attached);

  assert.equal(resolveRef(ref, (r) => blobs.lookup(r)).resolution, RESOLUTION.EXACT);

  assert.equal(blobs.shred(hash), true);
  assert.equal(blobs.isShredded(hash), true);
  // payload gone...
  assert.equal(resolveRef(ref, (r) => blobs.lookup(r)).resolution, RESOLUTION.UNAVAILABLE);
  // ...but the event, its ref and the chain survive
  assert.equal(log.get(attached.id).payload.ref.hash, hash);
  assert.equal(log.stats().events, 1);
});

test('replay never silently substitutes current content', async () => {
  const blobs = createBlobStore();
  const original = await blobs.put('v1 of the note');
  const ref = makeRef({ kind: 'note', id: 'n_1', hash: original });
  await blobs.put('v2 of the note');           // the note was edited
  // the ref still resolves to what was ACTUALLY sent, not to v2
  const r = resolveRef(ref, (x) => blobs.lookup(x));
  assert.equal(r.resolution, RESOLUTION.EXACT);
  assert.equal(r.value, 'v1 of the note');
});

test('the store is adapter-shaped — persistence is a host concern', () => {
  const calls = [];
  const base = createMemoryAdapter();
  const spy = { ...base, put: (k, v) => { calls.push(k); base.put(k, v); } };
  const log = createLogStore(spy);
  log.append(appender().append('turn.started', { turnId: 't1' }));
  assert.ok(calls.some((k) => k.startsWith('e/')));
  assert.ok(calls.some((k) => k.startsWith('s/')));
});
