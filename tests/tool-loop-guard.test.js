import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createToolLoopGuard, roundSignature, stableToolCallKey, toolMadeProgress, isLoopableTool,
} from '../tool-loop-guard.js';

test('a repeated identical write is refused after the threshold; every other tool stays available', () => {
  const g = createToolLoopGuard({ maxIdenticalCalls: 2 });
  assert.equal(g.check('click_element', { sel: '#a' }).blocked, false);
  assert.equal(g.check('click_element', { sel: '#a' }).blocked, false);
  const third = g.check('click_element', { sel: '#a' });
  assert.equal(third.blocked, true);
  assert.match(third.result, /tool_loop_blocked/);
  assert.equal(JSON.parse(third.result).identicalCallCount, 3);
  assert.equal(g.check('click_element', { sel: '#b' }).blocked, false, 'a different input is a different call');
  assert.equal(g.repeats, 1);
});

test('a repeated READ is answered from its first result, with a note, never refused', () => {
  const g = createToolLoopGuard({ maxIdenticalCalls: 1 });
  const first = g.check('web_search', { query: 'weather' });
  g.remember(first.key, 'web_search', { query: 'weather' }, 'sunny', { readOnly: true });
  const again = g.check('web_search', { query: 'weather' });
  assert.equal(again.blocked, false);
  assert.equal(again.replayed, true);
  assert.match(again.result, /^sunny\n\n\[This exact call was already made/);
  // An object result keeps its shape, the note rides on `text`.
  const g2 = createToolLoopGuard({ maxIdenticalCalls: 1 });
  const k = g2.check('history_search', { query: 'q' }).key;
  g2.remember(k, 'history_search', { query: 'q' }, { text: 'hit', note: 'n' }, { readOnly: true });
  const r = g2.check('history_search', { query: 'q' });
  assert.equal(r.replayed, true);
  assert.equal(r.result.note, 'n');
  assert.match(r.result.text, /^hit\n\n\[This exact call/);
  // A write is never remembered, whatever the caller says.
  const g3 = createToolLoopGuard({ maxIdenticalCalls: 1 });
  const kw = g3.check('click_at', { x: 1 }).key;
  g3.remember(kw, 'click_at', { x: 1 }, '{"ok":true}', { readOnly: false });
  assert.equal(g3.check('click_at', { x: 1 }).blocked, true);
});

test('observation tools never count, through the dispatcher too', () => {
  const g = createToolLoopGuard({ maxIdenticalCalls: 1 });
  for (let i = 0; i < 10; i += 1) {
    assert.equal(g.check('screenshot', {}).blocked, false);
    assert.equal(g.check('page', { action: 'screenshot', args: {} }).blocked, false);
    assert.equal(g.check('page', { action: 'inspect_page' }).blocked, false);
  }
  let blocked = false;
  for (let i = 0; i < 4 && !blocked; i += 1) blocked = g.check('page', { action: 'click_at', args: { x: 5 } }).blocked;
  assert.ok(blocked, 'a repeated mutation through the dispatcher still trips');
});

test('progress clears a discrete input\'s count; a failing one still trips', () => {
  const g = createToolLoopGuard({ maxIdenticalCalls: 1 });
  for (let i = 0; i < 5; i += 1) {
    const r = g.check('press_key', { key: 'Enter' });
    assert.equal(r.blocked, false, `Enter #${i + 1}`);
    assert.equal(toolMadeProgress('press_key', '{"ok":true}'), true);
    g.reset(r.key);
  }
  assert.equal(toolMadeProgress('press_key', '{"ok":false}'), false);
  assert.equal(toolMadeProgress('page', '{"atBottom":false}', { action: 'scroll' }), true, 'scroll through the dispatcher');
  assert.equal(toolMadeProgress('scroll', '{"atBottom":true}'), false);
  assert.equal(toolMadeProgress('web_search', '{"ok":true}'), false);
});

test('a round that repeats itself stalls the turn; varying rounds do not', () => {
  const g = createToolLoopGuard({ maxStalledRounds: 2 });
  const calls = [{ name: 'web_search', input: { query: 'a' } }, { name: 'page', input: { action: 'screenshot' } }];
  g.noteRound(0, 2, roundSignature(calls));
  assert.equal(g.stalled, false);
  g.noteRound(0, 2, roundSignature([...calls].reverse()));
  assert.equal(g.stalled, true, 'the same loopable calls in another order is the same round');
  const h = createToolLoopGuard({ maxStalledRounds: 2 });
  h.noteRound(0, 1, roundSignature([{ name: 'web_search', input: { query: 'a' } }]));
  h.noteRound(0, 1, roundSignature([{ name: 'web_search', input: { query: 'b' } }]));
  assert.equal(h.stalled, false);
  h.noteRound(1, 1, '');
  h.noteRound(1, 1, '');
  assert.equal(h.stalled, true, 'every call blocked, twice');
  h.noteRound(0, 1, roundSignature([{ name: 'web_search', input: { query: 'c' } }]));
  assert.equal(h.stalled, false, 'progress resets the count');
});

test('round signatures ignore observations, inputs and scrolls; keys are order-stable', () => {
  assert.equal(roundSignature([{ name: 'screenshot', input: {} }, { name: 'scroll', input: {} }, { name: 'press_key', input: { key: 'a' } }]), '');
  assert.equal(stableToolCallKey('t', { b: 1, a: [2, { d: 1, c: 2 }] }), stableToolCallKey('t', { a: [2, { c: 2, d: 1 }], b: 1 }));
  assert.equal(isLoopableTool('web_search'), true);
  assert.equal(isLoopableTool('scroll'), false);
});

test('looping: enough replays or refusals in one turn', () => {
  const g = createToolLoopGuard({ maxIdenticalCalls: 1, maxRepeats: 2 });
  g.check('x', { a: 1 }); g.check('x', { a: 1 });
  assert.equal(g.looping, false);
  g.check('x', { a: 1 });
  assert.equal(g.looping, true);
});
