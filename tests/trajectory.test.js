import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAppender } from '../event.js';
import { buildTrajectory, phasesOf, filterEntries, displayName } from '../trajectory.js';

test('trajectory: ordered by cause, content by reference, waterfall never invented', async () => {

  let n = 0;
  const a = createAppender({ host: 'ext', now: () => 1000 + n * 100, newId: () => `e${n++}` });
  const ref = { kind: 'chat', id: 'sha256:' + 'a'.repeat(64), hash: 'sha256:' + 'a'.repeat(64) };

  const evs = [
    a.append('turn.started', { turnId: 't1', kind: 'chat' }),
    a.append('context.assembled', { turnId: 't1', budget: 0, used: 832, parts: {}, resident: [], reachableCount: 1, tools: ['page'], redaction: true }),
    a.append('assistant.prompted', { turnId: 't1', ref, chars: 4210 }),
    a.append('capability.invoked', {
      capability: 'page', actor: { kind: 'model', id: 'claude' }, scope: { kind: 'session', id: 'c1' },
      effects: 'non-replayable', idempotencyKey: 'k1', turnId: 't1', args: { action: 'read_page' },
    }),
    a.append('capability.resulted', { capability: 'page', ok: true, classUsed: 'X', cost: { ms: 240 }, turnId: 't1', idempotencyKey: 'k1', summary: '{"chars":18400}' }),
    a.append('assistant.message', { turnId: 't1', ref, chars: 980 }),
    a.append('turn.ended', { turnId: 't1', reason: 'ok', ms: 5000 }),
  ];

  const entries = buildTrajectory(evs);
  assert.deepEqual(entries.map((e) => e.kind), ['context', 'system', 'tool', 'result', 'assistant']);

  // The dispatcher must not flatten every page action into "page" — the same blindness that
  // made every activity row identical and stopped the loop guard exempting screenshots.
  assert.equal(entries.find((e) => e.kind === 'tool').title, 'page.read_page');

  // Content is NOT in the entry. It carries a ref the caller resolves only when the user
  // looks, which keeps building sixty trajectories cheap and stays honest about deleted
  // content.
  const answer = entries.find((e) => e.kind === 'assistant');
  assert.ok(answer.ref, 'the answer entry lost its ref');
  assert.equal(answer.text, undefined, 'content was inlined into the entry');

  // Offsets are relative to the turn's start, so a row says WHEN within the turn.
  assert.equal(entries[0].offsetMs, 100);

  // Ordering comes from causal linearization, never wall time: shuffling the input must not
  // change the trajectory, or an export would read differently from the live view.
  const shuffled = [evs[5], evs[0], evs[4], evs[2], evs[6], evs[1], evs[3]];
  assert.deepEqual(buildTrajectory(shuffled).map((e) => e.kind), entries.map((e) => e.kind));

  // ── the waterfall ───────────────────────────────────────────────────────────
  const ph = phasesOf({ ms: 10_000, prepMs: 4000, ttftMs: 1000 });
  assert.deepEqual(ph.parts.map((p) => p.key), ['setup', 'wait', 'work']);
  assert.deepEqual(ph.parts.map((p) => Math.round(p.pct)), [40, 10, 50]);
  assert.equal(Math.round(ph.parts.reduce((s, p) => s + p.pct, 0)), 100);

  // A phase that did not happen is not drawn, rather than drawn as a sliver.
  assert.deepEqual(phasesOf({ ms: 1000 }).parts.map((p) => p.key), ['work']);

  // A turn with no recorded duration gets NO bar. Drawing one from missing numbers would be
  // a confident lie in the view whose whole job is to be trustworthy.
  assert.equal(phasesOf({}), null);
  assert.equal(phasesOf({ ms: 0 }), null);

  // Setup longer than the whole turn cannot produce a negative or overflowing bar.
  const odd = phasesOf({ ms: 1000, prepMs: 9000, ttftMs: 500 });
  assert.ok(odd.parts.every((p) => p.pct >= 0 && p.pct <= 100));
  assert.equal(Math.round(odd.parts.reduce((s, p) => s + p.pct, 0)), 100);

  // ── search ──────────────────────────────────────────────────────────────────
  assert.equal(filterEntries(entries, 'read_page').length, 1);
  assert.equal(filterEntries(entries, '').length, entries.length);
  assert.equal(filterEntries(entries, 'nothing-here').length, 0);



});
