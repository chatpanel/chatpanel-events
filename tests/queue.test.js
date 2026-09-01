import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pendingQueue, isQueued, dequeue, moveQueued, promoteQueued } from '../queue.js';

const u = (id, content = id) => ({ id, role: 'user', content });
const a = (id, content = id) => ({ id, role: 'assistant', content });

test('the queue is the trailing run of user messages — nothing above the last reply', () => {
  const messages = [u('u1'), a('a1'), u('u2'), a('a2'), u('q1'), u('q2')];
  assert.deepEqual(pendingQueue(messages).map((e) => e.id), ['q1', 'q2']);
  // Positions are queue-local; indexes point back into the transcript.
  assert.deepEqual(pendingQueue(messages).map((e) => e.position), [0, 1]);
  assert.deepEqual(pendingQueue(messages).map((e) => e.index), [4, 5]);
});

test('an answered conversation has an empty queue', () => {
  assert.deepEqual(pendingQueue([u('u1'), a('a1')]), []);
  assert.deepEqual(pendingQueue([]), []);
  assert.deepEqual(pendingQueue(undefined), []);
});

test('a streaming (empty) assistant bubble still separates the queue from the turn it answers', () => {
  // The client pushes the assistant BEFORE the first token, so the message being answered
  // must not read as queued — otherwise the drain would re-send it.
  const messages = [u('asked'), { id: 'pending', role: 'assistant', content: '', pending: true }, u('q1')];
  assert.deepEqual(pendingQueue(messages).map((e) => e.id), ['q1']);
});

test('dequeue removes a queued message and leaves the answered transcript alone', () => {
  const messages = [u('u1'), a('a1'), u('q1'), u('q2')];
  assert.deepEqual(dequeue(messages, 'q1').map((m) => m.id), ['u1', 'a1', 'q2']);
  // A stale click on an already-answered turn must never delete history.
  assert.equal(dequeue(messages, 'u1'), messages);
  assert.equal(dequeue(messages, 'nope'), messages);
});

test('reorder swaps within the queue, and stops at both ends', () => {
  const messages = [a('a1'), u('q1'), u('q2'), u('q3')];
  assert.deepEqual(moveQueued(messages, 'q3', -1).map((m) => m.id), ['a1', 'q1', 'q3', 'q2']);
  assert.deepEqual(moveQueued(messages, 'q1', 1).map((m) => m.id), ['a1', 'q2', 'q1', 'q3']);
  // Off either end is a no-op, by identity — a caller can skip the re-render.
  assert.equal(moveQueued(messages, 'q1', -1), messages);
  assert.equal(moveQueued(messages, 'q3', 1), messages);
  assert.equal(moveQueued(messages, 'q2', 0), messages);
});

test('a queued message cannot be reordered out of the queue and into answered history', () => {
  // The one move that would corrupt the transcript: dragging a pending question above the
  // reply it came after. `q1` is already at the top of the queue, so up is refused.
  const messages = [u('u1'), a('a1'), u('q1')];
  assert.equal(moveQueued(messages, 'q1', -1), messages);
  assert.equal(moveQueued(messages, 'q1', -5), messages);
  assert.equal(promoteQueued(messages, 'q1'), messages);
});

test('steer promotes to the front and the rest keep their order behind it', () => {
  const messages = [a('a1'), u('q1'), u('q2'), u('q3')];
  assert.deepEqual(promoteQueued(messages, 'q3').map((m) => m.id), ['a1', 'q3', 'q1', 'q2']);
  assert.equal(promoteQueued(messages, 'q1'), messages); // already first
  assert.equal(promoteQueued(messages, 'gone'), messages);
});

test('transforms never mutate the array they were given', () => {
  const messages = [a('a1'), u('q1'), u('q2')];
  const before = messages.map((m) => m.id);
  dequeue(messages, 'q1');
  moveQueued(messages, 'q1', 1);
  promoteQueued(messages, 'q2');
  assert.deepEqual(messages.map((m) => m.id), before);
});

test('isQueued answers for the pending run only', () => {
  const messages = [u('u1'), a('a1'), u('q1')];
  assert.equal(isQueued(messages, 'q1'), true);
  assert.equal(isQueued(messages, 'u1'), false);
});
