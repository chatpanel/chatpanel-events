import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppender } from '../event.js';
import { makeRef } from '../ref.js';
import { createBlobStore } from '../store.js';
import { replay, formatReport, parseJsonl, toJsonl } from '../harness.js';

async function recordedRun() {
  const blobs = createBlobStore();
  const hash = await blobs.put('the pricing decision from the Aug 12 call');
  const ref = makeRef({ kind: 'meeting', id: 'm_1', hash, range: { from: 184, to: 233 }, stored: true });

  let i = 0;
  const a = createAppender({ host: 'ext', now: () => 1_700_000_000_000, newId: () => `e${i++}` });
  const started = a.append('turn.started', { turnId: 't1' });
  const asm = a.append('context.assembled', {
    turnId: 't1', budget: 8000, used: 2140,
    parts: { system: 400, toolIndex: 380, history: 120, userText: 340 },
    resident: [ref], reachableCount: 34,
  }, [started.id]);
  const ended = a.append('turn.ended', { turnId: 't1' }, [asm.id]);
  return { events: [started, asm, ended], blobs, ref };
}

test('a sound run replays clean', async () => {
  const { events, blobs } = await recordedRun();
  const r = replay(events, { blobs });
  assert.ok(r.ok, formatReport(r));
  assert.equal(r.refs.exact, 1);
  assert.equal(r.turns[0].reconstructable, true);
  assert.equal(r.turns[0].used, 2140);
});

test('order is reproduced from causes and (host, seq), never from the read order', async () => {
  const { events, blobs } = await recordedRun();
  const forward = replay(events, { blobs }).order;
  const backward = replay([...events].reverse(), { blobs }).order;
  assert.deepEqual(forward, backward);
  assert.ok(replay([...events].reverse(), { blobs }).stable);
});

test('a shredded blob is verified-but-unavailable — a PASS, because shredding is a feature', async () => {
  const { events, blobs, ref } = await recordedRun();
  blobs.shred(ref.hash);
  const r = replay(events, { blobs });
  assert.ok(r.ok, formatReport(r));
  assert.equal(r.refs.unavailable, 1);
  assert.equal(r.refs.exact, 0);
  assert.equal(r.turns[0].reconstructable, true, 'shredding must not make a turn unreconstructable');
});

test('a DRIFTED source fails — replay must never substitute the current version', async () => {
  const { events, blobs } = await recordedRun();
  const tampered = { lookup: () => ({ hash: 'sha256:something-else', value: 'the note as it reads today' }) };
  const r = replay(events, { blobs: tampered });
  assert.equal(r.ok, false);
  assert.equal(r.refs.drifted.length, 1);
  assert.match(formatReport(r), /drifted meeting:m_1 — the source changed since capture/);
  void blobs;
});

test('an invariant violation fails the run and is named in the report', async () => {
  const { blobs } = await recordedRun();
  let i = 0;
  const a = createAppender({ host: 'ext', now: () => 1, newId: () => `x${i++}` });
  const started = a.append('turn.started', { turnId: 't9' });
  const ended = a.append('turn.ended', { turnId: 't9' }, [started.id]);   // no context.assembled
  const r = replay([started, ended], { blobs });
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].invariant, 'I1');
  assert.match(formatReport(r), /I1/);
});

test('JSONL round-trips, and a truncated export still replays', async () => {
  const { events, blobs } = await recordedRun();
  const jsonl = toJsonl(events);
  assert.deepEqual(replay(parseJsonl(jsonl), { blobs }).order, replay(events, { blobs }).order);

  // Drop the first line: the remaining events have a dangling cause and must still load.
  const truncated = parseJsonl(jsonl.split('\n').slice(1).join('\n'));
  const r = replay(truncated, { blobs });
  assert.equal(r.events, 2);
  assert.ok(r.stable);
});

test('the report is legible enough to read in CI output', async () => {
  const { events, blobs } = await recordedRun();
  const text = formatReport(replay(events, { blobs }));
  assert.match(text, /^PASS — 3 events/);
  assert.match(text, /order stable\s+yes/);
  assert.match(text, /I1-I6 hold/);
});
