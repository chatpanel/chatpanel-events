// The co-writer suggests; it does not rewrite. Every test here is that sentence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lintText, wordDiff, filterTypoEdits, editKey, applyEdits, COWRITER_SYSTEM,
} from '../cowriter.js';

const apply = (text, edits) => applyEdits(text, edits);

test('the free pass catches the mechanical mistakes — and applying them fixes the text', () => {
  const src = 'i went  to the the shop , then home';
  const edits = lintText(src);
  assert.equal(apply(src, edits), 'I went to the shop, then home');
});

test('"i.e." is an abbreviation, not a lowercase pronoun', () => {
  assert.deepEqual(lintText('i.e. the plan'), []);
  assert.equal(apply('i can, i.e. maybe', lintText('i can, i.e. maybe')), 'I can, i.e. maybe');
});

test('lint edits never overlap — two fixes over the same characters cannot both apply', () => {
  const edits = lintText('the the  the');
  for (let i = 1; i < edits.length; i++) assert.ok(edits[i].start >= edits[i - 1].end);
  assert.equal(apply('the the  the', edits).includes('  '), false);
});

test('clean text costs nothing — the model is only called when this finds nothing', () => {
  assert.deepEqual(lintText('A perfectly ordinary sentence.'), []);
  assert.deepEqual(lintText(''), []);
});

test('a diff is the WORDS that changed, not the sentence around them', () => {
  const a = 'The quick brown fox jumps';
  const edits = wordDiff(a, 'The quick red fox jumps');
  assert.deepEqual(edits, [{ start: 10, end: 15, before: 'brown', after: 'red' }]);
  assert.equal(apply(a, edits), 'The quick red fox jumps');
});

test('an insertion carries its space, so the new word is not glued to its neighbour', () => {
  const a = 'fix cat';
  const edits = wordDiff(a, 'fix the cat');
  assert.equal(apply(a, edits), 'fix the cat');
  const b = 'fix';
  assert.equal(apply(b, wordDiff(b, 'fix it')), 'fix it');
});

test('a deletion absorbs one space, leaving neither a double nor a leading one', () => {
  const a = 'the very big cat';
  assert.equal(apply(a, wordDiff(a, 'the big cat')), 'the big cat');
  const b = 'really go now';
  assert.equal(apply(b, wordDiff(b, 'go now')), 'go now');
  const c = 'go now really';
  assert.equal(apply(c, wordDiff(c, 'go now')), 'go now');
});

test('identical text produces no edits at all', () => {
  assert.deepEqual(wordDiff('same words here', 'same words here'), []);
});

test('no single suggestion is bigger than a glance — that is what the filter guarantees', () => {
  const original = 'We should probably drain the replica first and then check the snapshot.';
  const rewritten = 'Drain the replica, then verify the snapshot identifier before proceeding with any further steps in the rollback runbook.';
  const kept = filterTypoEdits(wordDiff(original, rewritten));
  for (const e of kept) {
    assert.ok(e.before.length <= 48 && e.after.length <= 48, `too long to check at a glance: ${JSON.stringify(e)}`);
    assert.ok(Math.max(e.before.split(/\s+/).length, e.after.split(/\s+/).length) <= 5);
  }
  // The tail the rewrite invented — a whole clause of new content — is dropped outright.
  assert.equal(kept.some((e) => /proceeding|runbook/.test(e.after)), false);
  // NOTE THE LIMIT: a restructure decomposes into several individually-small edits, and those
  // are kept. Size is the only thing a diff can judge; COWRITER_SYSTEM is what asks the model
  // not to restructure in the first place, and these two together are the guardrail.
});

test('a preamble the model added is not offered as an insertion into the note', () => {
  const original = 'teh cat sat';
  const answered = 'Sure, here is the corrected text: the cat sat';
  const kept = filterTypoEdits(wordDiff(original, answered));
  assert.equal(kept.some((e) => /Sure/.test(e.after)), false);
});

test('the co-writer prompt forbids the rewrite the filter would otherwise have to catch', () => {
  assert.match(COWRITER_SYSTEM, /Do NOT rewrite/);
  assert.match(COWRITER_SYSTEM, /Output ONLY the corrected text/);
});

test('a dismissed fix has a stable identity, whatever its offset', () => {
  assert.equal(editKey({ before: 'teh', after: 'the' }), editKey({ before: 'teh', after: 'the', start: 99 }));
  assert.notEqual(editKey({ before: 'teh', after: 'the' }), editKey({ before: 'teh', after: 'The' }));
});

test('applying several edits keeps every offset valid', () => {
  const src = 'teh quick brown fox';
  const edits = wordDiff(src, 'the quick red fox');
  assert.equal(edits.length, 2);
  assert.equal(apply(src, edits), 'the quick red fox');
});
