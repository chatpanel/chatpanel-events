import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSourceStore, manifestText, readSource, sourceId, approxTokens } from '../sources-retrieval.js';

const long = (word, n) => Array.from({ length: n }, (_, i) => `Section ${i}. ${word} ${'filler '.repeat(30)}`).join('\n\n');

const store = makeSourceStore([
  { kind: 'page', title: 'Release notes', url: 'https://example.com/notes', text: `Intro paragraph.\n\n${long('routine', 40)}\n\nThe authentication timeout was raised to 30 seconds.\n\n${long('routine', 40)}` },
  { kind: 'page', title: 'Short note', url: 'https://example.com/s', text: 'Two lines only.\n\nThat is all.' },
]);

test('the manifest describes what exists without including it', () => {
  const m = manifestText(store);
  assert.match(m, /page-1 — Release notes/);
  assert.match(m, /page-2 — Short note/);
  // The size is the point: a model that can see one source is huge and another tiny can read
  // the small one whole and query the large one.
  assert.match(m, /~\d+ tokens/);
  // And the content itself is NOT in it — that is the entire change.
  assert.equal(m.includes('authentication timeout'), false);
  assert.ok(approxTokens(m) < 60, 'A manifest that costs as much as the content saves nothing.');
});

test('a small source is returned whole — a round trip costs more than the tokens', () => {
  const r = readSource(store, { id: 'page-2' });
  assert.equal(r.truncated, false);
  assert.match(r.text, /Two lines only/);
});

test('a query returns the part that matters, not the first N characters', () => {
  // Truncation gives you the beginning, which is rarely the part being asked about. Here the
  // answer sits in the middle of 80 sections of filler.
  const r = readSource(store, { id: 'page-1', query: 'authentication timeout', maxTokens: 400 });
  assert.match(r.text, /authentication timeout was raised/);
  assert.equal(r.truncated, true);
  assert.ok(r.of > 400, 'and it says how much there was');
});

test('selected sections keep their original order', () => {
  // Ranking by score and presenting in score order rearranges the document, and a reordered
  // document reads as a different argument.
  const s = makeSourceStore([{ kind: 'doc', title: 'Doc', text: 'alpha keyword one.\n\nfiller.\n\nbeta keyword two.\n\nfiller.\n\ngamma keyword three.' }]);
  const r = readSource(s, { id: 'doc-1', query: 'keyword', maxTokens: 200 });
  assert.ok(r.text.indexOf('alpha') < r.text.indexOf('beta'));
  assert.ok(r.text.indexOf('beta') < r.text.indexOf('gamma'));
});

test('truncation is stated, never silent', () => {
  // A model handed a silently-cut document answers confidently about the part it was not
  // given, and neither it nor the reader can tell.
  const r = readSource(store, { id: 'page-1', maxTokens: 300 });
  assert.equal(r.truncated, true);
  assert.match(r.note, /Showing the first/);
  assert.match(r.note, /query/, 'and says how to get the relevant part instead');
});

test('a query that matches nothing says so rather than pretending', () => {
  const r = readSource(store, { id: 'page-1', query: 'zzzznothing', maxTokens: 300 });
  assert.match(r.note, /Nothing in this source matched/);
  assert.equal(r.truncated, true);
});

test('an unknown id lists what there is', () => {
  const r = readSource(store, { id: 'page-9' });
  assert.match(r.error, /No attached source/);
  assert.match(r.error, /page-1, page-2/, 'so the model can recover in one step rather than guessing');
  assert.match(readSource(makeSourceStore([]), { id: 'x' }).error, /Nothing is attached/);
});

test('ids are derived from the source, not random', () => {
  // The model has to type this back. 'page-2' is recoverable from a half-remembered manifest
  // in a way that a random string is not.
  assert.equal(sourceId({ kind: 'page' }, 1), 'page-2');
  assert.equal(sourceId({ kind: 'note' }, 0), 'note-1');
  assert.equal(sourceId({}, 0), 'src-1');
});

test('sources with no text and no url are not offered at all', () => {
  // An entry the model can ask for and get nothing from is worse than no entry.
  assert.equal(makeSourceStore([{ title: 'empty' }, null, { title: 'real', text: 'x' }]).entries.length, 1);
});
