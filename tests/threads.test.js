import { test } from 'node:test';
import assert from 'node:assert/strict';
import { threadsOf, threadTitle } from '../trajectory.js';

const run = (o) => ({ calls: [], ...o, turn: { ms: 100, ...(o.turn || {}) } });

test('runs group into threads, and read chronologically within one', () => {
  // Nobody asks "what did run 847 do" — they ask what happened in a conversation.
  const threads = threadsOf([
    run({ turnId: 't3', surface: 'chat', sourceId: 'c1', at: 300 }),
    run({ turnId: 't1', surface: 'chat', sourceId: 'c1', at: 100 }),
    run({ turnId: 't2', surface: 'chat', sourceId: 'c1', at: 200 }),
  ]);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].turns, 3);
  // A conversation read bottom-up is not a conversation.
  assert.deepEqual(threads[0].runs.map((r) => r.turnId), ['t1', 't2', 't3']);
});

test('a meeting holds its monitors and its summaries as turns of one thread', () => {
  // The structure the flat list destroyed: these are not three unrelated runs.
  const threads = threadsOf([
    run({ turnId: 'm1', surface: 'meeting', sourceId: 'mtg-9', at: 10, kind: 'monitor' }),
    run({ turnId: 'm2', surface: 'meeting', sourceId: 'mtg-9', at: 20, kind: 'monitor' }),
    run({ turnId: 'm3', surface: 'meeting', sourceId: 'mtg-9', at: 30, kind: 'summary' }),
    run({ turnId: 'n1', surface: 'note', sourceId: 'note-2', at: 40 }),
  ]);
  assert.equal(threads.length, 2);
  const meeting = threads.find((t) => t.surface === 'meeting');
  assert.equal(meeting.turns, 3);
});

test('surfaces do not collide on a shared id', () => {
  // A note and a chat that happen to share an id are two threads, not one.
  const threads = threadsOf([
    run({ turnId: 'a', surface: 'chat', sourceId: 'x', at: 1 }),
    run({ turnId: 'b', surface: 'note', sourceId: 'x', at: 2 }),
  ]);
  assert.equal(threads.length, 2);
});

test('a run with no source is its own thread, not pooled with other orphans', () => {
  // Without an id there is no evidence two runs are related, and inventing a shared parent
  // would group unrelated work under one heading — the opposite of the problem being fixed.
  const threads = threadsOf([run({ turnId: 'a', at: 1 }), run({ turnId: 'b', at: 2 })]);
  assert.equal(threads.length, 2);
});

test('a thread totals what its turns cost', () => {
  const [t] = threadsOf([
    run({ turnId: 'a', surface: 'chat', sourceId: 'c', at: 1, calls: [{}, {}], turn: { ms: 500, tokensIn: 100, tokensOut: 20 } }),
    run({ turnId: 'b', surface: 'chat', sourceId: 'c', at: 2, calls: [{}], turn: { ms: 300, tokensIn: 50, tokensOut: 10, reason: 'error' } }),
  ]);
  assert.equal(t.ms, 800);
  assert.equal(t.tokensIn, 150);
  assert.equal(t.calls, 3);
  assert.equal(t.errors, 1, 'so a thread that went wrong is visible without opening it');
});

test('threads are ordered by most recent activity', () => {
  const threads = threadsOf([
    run({ turnId: 'old', surface: 'chat', sourceId: 'a', at: 10, turn: { endedAt: 15 } }),
    run({ turnId: 'new', surface: 'chat', sourceId: 'b', at: 90, turn: { endedAt: 99 } }),
  ]);
  assert.deepEqual(threads.map((t) => t.sourceId), ['b', 'a']);
});

test('a heading distinguishes two threads even with no title', () => {
  const [t] = threadsOf([run({ turnId: 'x', surface: 'meeting', sourceId: 'abc123456', at: 1 })]);
  assert.equal(threadTitle(t, () => 'Weekly sync'), 'Weekly sync', 'A real title wins…');
  assert.match(threadTitle(t), /^Meeting · /, '…and the fallback still tells them apart.');
});

import { promptEntries } from '../trajectory.js';

test('a prompt is shown as the parts it was made of, not as one row', () => {
  // "Why did it answer that" is nearly always a question about WHICH input said something.
  const rows = promptEntries({
    system: 'Today is Monday.',
    toolSystem: 'You are connected to the live tab.',
    messages: [{ role: 'user', content: 'summarise this' }],
    context: [{ kind: 'page', title: 'Runbook', url: 'https://example.com/r', chars: 9000, deferred: true }],
  });
  assert.deepEqual(rows.map((r) => r.kind), ['system', 'system', 'user', 'context']);
  // The tool preamble is the largest thing we inject; it was hiding inside a single total.
  assert.equal(rows[1].title, 'Tool instructions');
  assert.equal(rows[2].text, 'summarise this', 'The user row is what the person typed and nothing else.');
  assert.match(rows[3].detail, /read on demand/, 'and an attachment says whether it was handed over or fetched');
});

test('an included attachment reads differently from a deferred one', () => {
  const [row] = promptEntries({ context: [{ title: 'Note', chars: 120, deferred: false }] });
  assert.match(row.detail, /included/);
});

test('empty parts do not become empty rows', () => {
  assert.deepEqual(promptEntries({ system: '', messages: [{ role: 'user', content: '  ' }] }), []);
  assert.deepEqual(promptEntries(null), []);
});

test('runs recorded before `surface` existed still group, by kind', () => {
  // 1,203 of 1,215 turns in a real export had no surface and every one had a kind. A
  // grouping that only works on data recorded after the fix groups nothing anyone has.
  const legacy = [
    { turnId: 'a', at: 1, sourceId: 'conv1', turn: { kind: 'chat', ms: 10 } },
    { turnId: 'b', at: 2, sourceId: 'conv1', turn: { kind: 'chat', ms: 10 } },
    { turnId: 'c', at: 3, sourceId: 'note1', turn: { kind: 'note', ms: 10 } },
  ];
  const threads = threadsOf(legacy);
  assert.equal(threads.length, 2);
  assert.equal(threads.find((t) => t.sourceId === 'conv1').turns, 2);
  assert.equal(threads.find((t) => t.sourceId === 'note1').surface, 'note');
});
