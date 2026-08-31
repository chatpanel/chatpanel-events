import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  candidatesFrom, reconcile, recall, memoryBlock, normalizeMemory, memoryKey, similarity,
  matchForForget, pruneMemories, markUsed, slotOf, containment,
  MAX_MEMORY_CHARS, MEMORY_TOOL_SPEC, MemoryError,
} from '../memory.js';

const NOW = 1_800_000_000_000;
let n = 0;
const newId = () => `m${(n += 1)}`;
const mem = (over = {}) => normalizeMemory({ id: newId(), text: 'x'.repeat(10), ...over }, { now: NOW });

// --------------------------------------------------------------------------
// Capture
// --------------------------------------------------------------------------

test('a command saves itself, stripped of the instruction that wrapped it', () => {
  // The point of the capture group: storing "remember that I deploy on Fridays" verbatim
  // means the model is later told the user once issued an instruction, not the fact itself.
  const [c] = candidatesFrom('remember that I deploy on Fridays');
  assert.equal(c.op, 'remember');
  assert.equal(c.text, 'I deploy on Fridays');
  assert.equal(c.explicit, true);
});

test('the command form decides the kind, so the user never has to', () => {
  assert.equal(candidatesFrom('call me Alex')[0].kind, 'identity');
  assert.equal(candidatesFrom('call me Alex')[0].text, 'Goes by Alex');
  assert.equal(candidatesFrom('my name is Jordan Blake')[0].text, 'Name is Jordan Blake');
  assert.equal(candidatesFrom('from now on, keep answers under three sentences')[0].kind, 'preference');
  assert.equal(candidatesFrom('never open with a preamble')[0].kind, 'preference');
});

test('"never X" keeps the negation — the fact is the prohibition', () => {
  // Capturing only the group would store "open with a preamble" as a preference, which is
  // the exact opposite of what was said. This is why that rule rebuilds from the raw line.
  assert.equal(candidatesFrom('never open with a preamble')[0].text, 'Never open with a preamble');
});

test('a question that mentions remembering is not a command', () => {
  // The single most obvious way to make this feature look broken: ask "do you remember what
  // we decided?" and watch it get stored as a durable fact about you.
  for (const q of [
    'do you remember what we decided?',
    'can you remember the port number',
    'what do you remember about the demo',
  ]) {
    assert.deepEqual(candidatesFrom(q), [], `"${q}" was captured`);
  }
});

test('a complaint about memory is not a command either', () => {
  assert.deepEqual(candidatesFrom("I can't remember the staging password"), []);
  assert.deepEqual(candidatesFrom('I never remember to run the migration'), []);
});

test('a reveal is offered, not taken', () => {
  // The whole capture policy in one assertion: inference produces an offer the user taps,
  // never a silent write.
  const [c] = candidatesFrom('I prefer terse answers with no preamble');
  assert.equal(c.explicit, false);
  assert.equal(c.kind, 'preference');
  assert.ok(c.confidence < 1);
});

test('reveals can be suppressed for surfaces with nowhere to show an offer', () => {
  assert.deepEqual(candidatesFrom('I prefer terse answers', { includeReveals: false }), []);
  // …but a command is consent and still applies there.
  assert.equal(candidatesFrom('remember I prefer terse answers', { includeReveals: false }).length, 1);
});

test('fenced code is material, not speech', () => {
  // A README pasted into the composer must not tell ChatPanel who the user is.
  const text = 'have a look at this\n```\nI prefer terse answers\nremember that PORT=8080\n```';
  assert.deepEqual(candidatesFrom(text), []);
});

test('forgetting is recognised as its own operation', () => {
  const [c] = candidatesFrom('forget that I deploy on Fridays');
  assert.equal(c.op, 'forget');
  assert.equal(c.text, 'I deploy on Fridays');
  // Otherwise "forget that X" is stored as the fact X — the worst possible outcome.
  assert.notEqual(c.op, 'remember');
});

test('candidates are capped so a long message cannot produce a wall of chips', () => {
  const many = Array.from({ length: 9 }, (_, i) => `remember that fact number ${i} matters`).join('\n');
  assert.equal(candidatesFrom(many).length, 3);
  assert.equal(candidatesFrom(many, { maxCandidates: 5 }).length, 5);
});

test('over-long captures are clipped rather than rejected', () => {
  const [c] = candidatesFrom(`remember that ${'word '.repeat(200)}`);
  assert.ok(c.text.length <= MAX_MEMORY_CHARS);
});

// --------------------------------------------------------------------------
// The record
// --------------------------------------------------------------------------

test('a memory longer than the limit is refused, and told why', () => {
  // The size cap is the feature: memory that can hold an essay becomes a second corpus,
  // and a second corpus needs search instead of being carried.
  assert.throws(() => normalizeMemory({ text: 'x'.repeat(MAX_MEMORY_CHARS + 1) }, { now: NOW }), MemoryError);
  assert.throws(() => normalizeMemory({ text: '' }, { now: NOW }), MemoryError);
});

test('an unknown kind degrades to fact rather than throwing', () => {
  assert.equal(normalizeMemory({ text: 'something true', kind: 'nonsense' }, { now: NOW }).kind, 'fact');
});

test('two phrasings of one standing fact share a key', () => {
  assert.equal(memoryKey('I deploy on Fridays'), memoryKey('deploy on fridays'));
  assert.equal(memoryKey('Prefers terse answers'), memoryKey('the user prefers terse answers.'));
  // Token overlap is not a synonym engine: 'answers' and 'replies' share no words, so near
  // phrasings score middling, not high. What matters is the ORDER — a restatement outranks
  // an unrelated memory by a wide margin, which is all reconcile and forget-matching need.
  assert.ok(similarity('prefers terse answers', 'prefers terse replies') > 0.3);
  assert.ok(similarity('prefers terse answers', 'runs Postgres in Frankfurt') < 0.2);
});

test('a slot is the subject a statement is about, derived from its own text', () => {
  // Token overlap cannot see that a name changed: "Goes by Alex" and "Goes by Sam" share half
  // their words, which is what two UNRELATED memories look like. The slot is what makes a
  // correction recognisable as one.
  assert.equal(slotOf('Goes by Alex'), 'name');
  assert.equal(slotOf('Name is Jordan Blake'), 'name');
  assert.equal(slotOf('Goes by Alex'), slotOf('Goes by Sam'));
  assert.equal(slotOf('The staging cluster is in Frankfurt'), 'staging cluster');
  // Most statements are not slot-shaped, and must not be forced into one.
  assert.equal(slotOf('Deploys on Fridays'), '');
  assert.equal(slotOf('Prefers terse answers'), '');
});

test('a slot is derived for a tool write too, not just a captured phrase', () => {
  // An agent calling `memory` has never heard of slots. Deriving from the text means its
  // writes reconcile exactly like the panel's.
  const rec = normalizeMemory({ text: 'Timezone is CET', kind: 'identity' }, { now: NOW });
  assert.equal(rec.slot, 'timezone');
});

test('containment finds a memory named by one distinctive word', () => {
  // The asymmetric measure: "the Frankfurt thing" restates almost nothing, so a symmetric
  // score puts it near zero and forget silently matches nothing.
  assert.ok(containment('the Frankfurt thing', 'Runs Postgres in Frankfurt') >= 0.5);
  assert.ok(containment('the Frankfurt thing', 'Prefers terse answers') < 0.5);
});

// --------------------------------------------------------------------------
// Reconcile
// --------------------------------------------------------------------------

test('restating a memory does not create a second one', () => {
  const store = [mem({ text: 'Deploys on Fridays', kind: 'fact' })];
  const r = reconcile(store, { text: 'deploys on fridays', kind: 'fact' }, { now: NOW + 1, newId });
  assert.equal(r.action, 'duplicate');
  assert.equal(r.record.id, store[0].id);
});

test('changing your mind supersedes in place and keeps the old value', () => {
  const store = [mem({ text: 'Goes by Alex', kind: 'identity' })];
  const r = reconcile(store, { text: 'Goes by Sam', kind: 'identity' }, { now: NOW + 5, newId });
  assert.equal(r.action, 'update');
  assert.equal(r.record.id, store[0].id);
  assert.equal(r.record.text, 'Goes by Sam');
  assert.equal(r.record.history.at(-1).text, 'Goes by Alex');
  assert.equal(r.replaces.id, store[0].id);
});

test('a corrected slot supersedes even when the wording barely overlaps', () => {
  const store = [mem({ text: 'The staging cluster is in Frankfurt', kind: 'fact' })];
  const r = reconcile(store, { text: 'The staging cluster is in Dublin', kind: 'fact' }, { now: NOW + 5, newId });
  assert.equal(r.action, 'update');
  assert.equal(r.record.text, 'The staging cluster is in Dublin');
  assert.equal(r.record.history.at(-1).text, 'The staging cluster is in Frankfurt');
});

test('a genuinely new fact is created', () => {
  const store = [mem({ text: 'Goes by Alex', kind: 'identity' })];
  assert.equal(reconcile(store, { text: 'Runs Postgres in Frankfurt', kind: 'fact' }, { now: NOW, newId }).action, 'create');
});

test('scopes do not collide', () => {
  // A preference set for one agent must not silently overwrite the global one.
  const store = [mem({ text: 'Prefers terse answers', kind: 'preference', scope: 'global' })];
  const r = reconcile(store, { text: 'Prefers terse answers', kind: 'preference', scope: 'agent:claude-code' }, { now: NOW, newId });
  assert.equal(r.action, 'create');
});

test('forget finds a memory the way a person names it', () => {
  const store = [
    mem({ text: 'Runs Postgres in Frankfurt', kind: 'fact' }),
    mem({ text: 'Prefers terse answers', kind: 'preference' }),
  ];
  assert.equal(matchForForget(store, 'the Frankfurt thing')[0].text, 'Runs Postgres in Frankfurt');
  assert.equal(matchForForget(store, store[1].id)[0].id, store[1].id);
  assert.deepEqual(matchForForget(store, 'something else entirely'), []);
});

// --------------------------------------------------------------------------
// Recall
// --------------------------------------------------------------------------

test('identity and preference are carried whether or not the turn mentions them', () => {
  // "How do I want to be spoken to" applies to a turn about Kubernetes exactly as much as to
  // a turn about names. That is what ambient means, and it is a retrieval rule, not a label.
  const store = [
    mem({ text: 'Goes by Alex', kind: 'identity' }),
    mem({ text: 'Prefers terse answers', kind: 'preference' }),
    mem({ text: 'Runs Postgres in Frankfurt', kind: 'fact' }),
  ];
  const got = recall(store, { text: 'help me write a haiku', now: NOW });
  const texts = got.map((m) => m.text);
  assert.ok(texts.includes('Goes by Alex'));
  assert.ok(texts.includes('Prefers terse answers'));
  assert.ok(!texts.includes('Runs Postgres in Frankfurt'), 'an unrelated fact bought tokens');
});

test('a non-ambient memory earns its tokens when the turn is about it', () => {
  const store = [mem({ text: 'Runs Postgres in Frankfurt', kind: 'fact' })];
  assert.equal(recall(store, { text: 'is postgres reachable from frankfurt?', now: NOW }).length, 1);
  assert.equal(recall(store, { text: 'write me a limerick', now: NOW }).length, 0);
});

test('pinned outranks everything, of any kind', () => {
  const store = [
    mem({ text: 'Prefers terse answers', kind: 'preference' }),
    mem({ text: 'Ships the release on the last Thursday', kind: 'fact', pinned: true }),
  ];
  assert.equal(recall(store, { text: 'unrelated question', now: NOW })[0].text, 'Ships the release on the last Thursday');
});

test('recall stays inside its character budget', () => {
  const store = Array.from({ length: 40 }, (_, i) => mem({ text: `Preference number ${i} about formatting`, kind: 'preference' }));
  const got = recall(store, { text: 'anything', now: NOW, maxChars: 200 });
  assert.ok(got.length < 40);
  assert.ok(got.reduce((n2, m) => n2 + m.text.length, 0) <= 200);
});

test('scope filters what a turn can see', () => {
  const store = [
    mem({ text: 'Prefers terse answers', kind: 'preference', scope: 'global' }),
    mem({ text: 'Prefers verbose logs', kind: 'preference', scope: 'agent:codex' }),
  ];
  assert.equal(recall(store, { text: 'hi', scopes: ['global'], now: NOW }).length, 1);
  assert.equal(recall(store, { text: 'hi', scopes: ['global', 'agent:codex'], now: NOW }).length, 2);
});

test('expired memories are never recalled', () => {
  const store = [mem({ text: 'On call this week', kind: 'fact', pinned: true, expiresAt: NOW - 1 })];
  assert.equal(recall(store, { text: 'on call', now: NOW }).length, 0);
});

// --------------------------------------------------------------------------
// Rendering, use, pruning
// --------------------------------------------------------------------------

test('an empty set renders to nothing, so callers can concatenate blindly', () => {
  assert.equal(memoryBlock([]), '');
  assert.equal(memoryBlock(null), '');
});

test('the block names each memory with its kind and tells the model to correct them', () => {
  const block = memoryBlock([mem({ text: 'Goes by Alex', kind: 'identity' })]);
  assert.match(block, /\(identity\) Goes by Alex/);
  assert.match(block, /`memory` tool/);
});

test('use is recorded, because recall quality depends on it', () => {
  const store = [mem({ text: 'Goes by Alex', kind: 'identity' })];
  const after = markUsed(store, [store[0].id], { now: NOW + 9 });
  assert.equal(after[0].useCount, 1);
  assert.equal(after[0].usedAt, NOW + 9);
});

test('pruning evicts the least valuable and reports what it dropped', () => {
  // Silently shrinking someone's memory is the one behaviour that would make it untrustworthy.
  const store = [
    mem({ text: 'Pinned and rarely used', kind: 'fact', pinned: true }),
    mem({ text: 'Ambient preference here', kind: 'preference' }),
    mem({ text: 'Cold unused trivia one', kind: 'fact' }),
    mem({ text: 'Cold unused trivia two', kind: 'fact' }),
  ];
  const { kept, dropped } = pruneMemories(store, { now: NOW, max: 2 });
  assert.equal(kept.length, 2);
  assert.equal(dropped.length, 2);
  assert.ok(kept.some((m) => m.pinned));
  assert.ok(kept.some((m) => m.kind === 'preference'));
});

test('expired memories are pruned even under the size cap', () => {
  const store = [mem({ text: 'On call this week', kind: 'fact', expiresAt: NOW - 1 })];
  const { kept, dropped } = pruneMemories(store, { now: NOW, max: 100 });
  assert.equal(kept.length, 0);
  assert.equal(dropped.length, 1);
});

test('the tool contract is one closed set of actions', () => {
  assert.equal(MEMORY_TOOL_SPEC.name, 'memory');
  assert.deepEqual(MEMORY_TOOL_SPEC.parameters.properties.action.enum, ['remember', 'forget', 'list']);
  assert.deepEqual(MEMORY_TOOL_SPEC.parameters.required, ['action']);
});
