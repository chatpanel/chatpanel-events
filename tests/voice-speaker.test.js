// The gate that keeps a voice conversation to the person having it — and, more importantly,
// every case where it must get out of the way. An assistant that occasionally answers the
// television is annoying; one that ignores YOU is broken, and they look the same from outside.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpeakerGate, RE_ENROLL_MS } from '../voice-speaker.js';

const at = (clock) => ({ now: () => clock.t });

test('the first voice in a conversation is the person having it', () => {
  const clock = { t: 1000 };
  const gate = createSpeakerGate(at(clock));
  assert.deepEqual(gate.admit({ speaker: { label: 'Speaker 1' } }), { send: true, reason: 'enrolled', speaker: 'Speaker 1' });
  assert.equal(gate.primary(), 'Speaker 1');
  clock.t += 3000;
  assert.equal(gate.admit({ speaker: { label: 'Speaker 1' } }).send, true, 'and keeps the floor');
});

test('another voice mid-conversation is the room, and is held', () => {
  const clock = { t: 1000 };
  const gate = createSpeakerGate(at(clock));
  gate.admit({ speaker: { label: 'Speaker 1' } });
  clock.t += 2000;
  const other = gate.admit({ speaker: { label: 'Speaker 2' } });
  assert.equal(other.send, false);
  assert.equal(other.reason, 'other');
  assert.equal(gate.heldCount(), 1, 'and it is counted, so the UI can say what it did');
  assert.equal(gate.primary(), 'Speaker 1', 'the conversation still belongs to whoever started it');
  clock.t += 500;
  assert.equal(gate.admit({ speaker: { label: 'Speaker 1' } }).send, true, 'who is still heard');
});

test('every uncertain case SENDS — a gate that can silence you is worse than one that lets the room in', () => {
  const clock = { t: 1000 };
  const gate = createSpeakerGate(at(clock));
  // Diarization off, model missing, or the embedding failed: the final carries no speaker.
  assert.deepEqual(gate.admit({ text: 'hello' }), { send: true, reason: 'no-speaker', speaker: '' });
  assert.deepEqual(gate.admit({ speaker: null }).reason, 'no-speaker');
  assert.equal(gate.primary(), '', 'and a speakerless final never enrolls anyone');
  // Once someone IS enrolled, a later speakerless final still goes through.
  gate.admit({ speaker: { label: 'Speaker 1' } });
  assert.equal(gate.admit({ speaker: undefined }).send, true);
});

test('after a long silence the conversation may change hands', () => {
  const clock = { t: 1000 };
  const gate = createSpeakerGate(at(clock));
  gate.admit({ speaker: { label: 'Speaker 1' } });
  clock.t += RE_ENROLL_MS - 1;
  assert.equal(gate.admit({ speaker: { label: 'Speaker 2' } }).send, false, 'not yet — this is still Speaker 1\'s conversation');
  clock.t += 2;
  const adopted = gate.admit({ speaker: { label: 'Speaker 2' } });
  assert.equal(adopted.send, true);
  assert.equal(adopted.reason, 'adopted');
  assert.equal(gate.primary(), 'Speaker 2', 'the phone was handed over, or the first voice was the television');
});

test('reset gives a mislabelled voice its conversation back, without ending the session', () => {
  const gate = createSpeakerGate({ now: () => 1000 });
  gate.admit({ speaker: { label: 'Speaker 1' } });
  gate.admit({ speaker: { label: 'Speaker 2' } });
  assert.equal(gate.heldCount(), 1);
  gate.reset();
  assert.equal(gate.primary(), '');
  assert.equal(gate.heldCount(), 0);
  assert.equal(gate.admit({ speaker: { label: 'Speaker 2' } }).reason, 'enrolled', 'whoever speaks next owns the conversation');
});

test('a speaker may be a bare label or a pinned mic channel', () => {
  const gate = createSpeakerGate({ now: () => 1000 });
  assert.equal(gate.admit({ speaker: 'You' }).send, true);
  assert.equal(gate.primary(), 'You');
  assert.equal(gate.admit({ speaker: { id: 2 } }).send, false, 'an id with no label still identifies a different voice');
});
