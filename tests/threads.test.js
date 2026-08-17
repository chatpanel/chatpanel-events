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

test('the parent id groups a thread even when its turns have different surfaces', () => {
  // Keying on surface+id split a conversation from the autocomplete done inside it. Same
  // thread, different surface — and that split is the exact grouping this exists to produce.
  const threads = threadsOf([
    run({ turnId: 'a', surface: 'chat', sourceId: 'x', at: 1 }),
    run({ turnId: 'b', surface: 'suggestion', sourceId: 'x', at: 2, background: true }),
  ]);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].surface, 'chat', 'and it is named after the work it exists for');
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

import { turnsOf, threadTree } from '../trajectory.js';

let seq = 0;
const ev = (type, at, turnId, payload = {}) => ({ id: `e${++seq}`, causes: [], type, at, turnId, payload: { turnId, ...payload } });

test('a turn holds everything that happened inside it', () => {
  // A run used to be a row with a duration and a token count; what it actually DID was
  // spread across events that only shared an id, so "open the turn" had nothing to open.
  const events = [
    ev('turn.started', 10, 't1', { kind: 'chat', sourceId: 'conv-1', surface: 'chat' }),
    ev('assistant.prompted', 11, 't1', { ref: { id: 'b1' }, chars: 400, contextCount: 1 }),
    ev('capability.invoked', 12, 't1', { name: 'page', idempotencyKey: 'k1' }),
    ev('capability.resulted', 13, 't1', { idempotencyKey: 'k1', ok: true }),
    ev('assistant.message', 14, 't1', { ref: { id: 'b2' }, chars: 90 }),
    ev('turn.ended', 15, 't1', { ms: 5, reason: 'ok', model: 'gemma4' }),
  ];
  const [turn] = turnsOf(events);
  assert.equal(turn.turnId, 't1');
  assert.equal(turn.sourceId, 'conv-1', 'and it knows what it was done for');
  assert.ok(turn.entries.length >= 3, 'with its entries already typed');
  assert.equal(turn.turn.model, 'gemma4');
});

test('the parent is the id, not the kind — two chats are two threads', () => {
  // Every chat shares the kind 'chat'. Grouping on that would merge every conversation ever
  // had into a single thread, which is worse than not grouping at all.
  const tree = threadTree([
    ev('turn.started', 1, 'a', { kind: 'chat', sourceId: 'conv-1' }),
    ev('turn.ended', 2, 'a', { ms: 1 }),
    ev('turn.started', 3, 'b', { kind: 'chat', sourceId: 'conv-2' }),
    ev('turn.ended', 4, 'b', { ms: 1 }),
    ev('turn.started', 5, 'c', { kind: 'chat', sourceId: 'conv-1' }),
    ev('turn.ended', 6, 'c', { ms: 1 }),
  ]);
  assert.equal(tree.length, 2);
  assert.equal(tree.find((t) => t.sourceId === 'conv-1').turns, 2);
});

test('work done FOR a conversation is filed under it', () => {
  // 264 of 1,215 turns in a real export were suggestions: work done for a conversation and
  // recorded under nothing, so they could not be grouped at all.
  const tree = threadTree([
    ev('turn.started', 1, 'msg', { kind: 'chat', sourceId: 'conv-1' }),
    ev('turn.ended', 2, 'msg', { ms: 1 }),
    ev('turn.started', 3, 'sug', { kind: 'suggestion', sourceId: 'conv-1', background: true }),
    ev('turn.ended', 4, 'sug', { ms: 1 }),
  ]);
  assert.equal(tree.length, 1, 'One conversation, two turns — not two unrelated rows.');
  assert.equal(tree[0].turns, 2);
  assert.equal(tree[0].runs.filter((r) => r.background).length, 1, 'and the background one is still marked as such');
});

test('a meeting keeps its monitors and summaries as turns of one meeting', () => {
  const tree = threadTree([
    ev('turn.started', 1, 'm1', { kind: 'monitor', sourceId: 'mtg-1', surface: 'meeting' }),
    ev('turn.ended', 2, 'm1', { ms: 1 }),
    ev('turn.started', 3, 'm2', { kind: 'summary', sourceId: 'mtg-1', surface: 'meeting' }),
    ev('turn.ended', 4, 'm2', { ms: 1 }),
  ]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].surface, 'meeting');
  assert.equal(tree[0].turns, 2);
});

test('an unfinished turn is reported open, not silently dropped', () => {
  const [t] = turnsOf([ev('turn.started', 1, 'x', { kind: 'chat', sourceId: 'c' })]);
  assert.equal(t.turn.reason, 'open');
  assert.equal(t.turn.endedAt, null);
});

test('a turn shows what it was GIVEN and what the answer was based on', () => {
  // The two halves that were missing. Retrieved material was invisible — a tool ran and an
  // answer appeared, with nothing connecting them — and the citations were linkified into
  // the text and then discarded, so the output could not say what stood behind it.
  const [turn] = turnsOf([
    ev('turn.started', 1, 't', { kind: 'chat', sourceId: 'c1' }),
    ev('capability.invoked', 2, 't', { name: 'find', idempotencyKey: 'k' }),
    ev('context.retrieved', 3, 't', { tool: 'find', count: 3, chars: 2200, sources: [{ rank: 1, title: 'Weekly sync', url: '' }] }),
    ev('assistant.message', 4, 't', { ref: { id: 'b' }, chars: 300, citations: [{ rank: 1, title: 'Weekly sync', url: '' }] }),
    ev('turn.ended', 5, 't', { ms: 4 }),
  ]);
  const ctx = turn.entries.find((x) => x.kind === 'context');
  assert.ok(ctx, 'retrieved material is an input, beside the question');
  assert.match(ctx.title, /Retrieved 3 sources/);
  assert.equal(ctx.data.tool, 'find');

  const answer = turn.entries.find((x) => x.kind === 'assistant');
  assert.match(answer.detail, /1 citation/, 'and the answer says what it was based on');
  assert.equal(answer.data.citations.length, 1);
});

test('a retrieval that returned no links is still recorded', () => {
  // Notes and past chats have no urls. Silence here would under-report exactly the private
  // sources this is meant to make visible.
  const [turn] = turnsOf([
    ev('turn.started', 1, 't', { kind: 'chat', sourceId: 'c' }),
    ev('context.retrieved', 2, 't', { tool: 'find', count: 0, chars: 1800, sources: [] }),
    ev('turn.ended', 3, 't', { ms: 2 }),
  ]);
  const ctx = turn.entries.find((x) => x.kind === 'context');
  assert.match(ctx.title, /Retrieved material/);
  assert.match(ctx.detail, /1800 chars/, 'so the volume is visible even with no titles');
});
