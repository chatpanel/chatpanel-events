import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRecordId, makeRecordId, isRecordId, normalizeStoredRecord, isValidStoredRecord,
  toSearchRecord, searchTextFor, toIndexEntry, deriveTitle, snippetOf, wordCount,
  RECORD_KINDS, MAX_TITLE_LEN, LibraryError,
} from '../library.js';

const NOW = 1_800_000_000_000;

// --------------------------------------------------------------------------
// The id grammar
// --------------------------------------------------------------------------

test('the four kinds round-trip through the id grammar', () => {
  for (const kind of RECORD_KINDS) {
    const id = makeRecordId(kind, 'abc123');
    assert.equal(id, `${kind}:abc123`);
    assert.deepEqual(parseRecordId(id), { kind, localId: 'abc123' });
  }
});

test('an unknown kind is refused rather than minted', () => {
  // The failure this prevents: a client inventing `chats:` and silently never joining
  // anything in the warm index.
  assert.throws(() => makeRecordId('chats', 'a'), LibraryError);
  assert.equal(parseRecordId('chats:a'), null);
  assert.equal(isRecordId('chats:a'), false);
});

test('a local id containing a colon is refused, because parsing it back is ambiguous', () => {
  assert.throws(() => makeRecordId('note', 'a:b'), LibraryError);
});

test('a bare id with no prefix is not a record id', () => {
  assert.equal(parseRecordId('abc123'), null);
  assert.equal(parseRecordId(''), null);
  assert.equal(parseRecordId('chat:'), null);
});

// --------------------------------------------------------------------------
// Normalization
// --------------------------------------------------------------------------

test('updatedAt falls back to createdAt, so an un-stamped record does not sort to the bottom', () => {
  const rec = normalizeStoredRecord({ id: 'note:a', createdAt: NOW });
  assert.equal(rec.updatedAt, NOW);
});

test('createdAt falls back to `now` only when the record carries no time at all', () => {
  const rec = normalizeStoredRecord({ id: 'note:a' }, { now: NOW });
  assert.equal(rec.createdAt, NOW);
  assert.equal(rec.updatedAt, NOW);
});

test('a note with no title derives one from its body', () => {
  const rec = normalizeStoredRecord({ id: 'note:a', body: { markdown: '# Rollback runbook\n\nbody' } });
  assert.equal(rec.title, 'Rollback runbook');
});

test('the body is carried verbatim — normalization never flattens it', () => {
  const body = { messages: [{ role: 'user', content: 'hi' }] };
  const rec = normalizeStoredRecord({ id: 'chat:a', body });
  assert.deepEqual(rec.body, body);
});

test('a deletion is representable, because absence and deletion are different facts', () => {
  const rec = normalizeStoredRecord({ id: 'note:a', deletedAt: NOW });
  assert.equal(rec.deletedAt, NOW);
  assert.equal(toSearchRecord(rec), null, 'a tombstone must never enter the search index');
});

test('duplicate and blank tags are dropped without reordering the rest', () => {
  const rec = normalizeStoredRecord({ id: 'note:a', tags: ['atlas', '', 'atlas', 'runbook', null] });
  assert.deepEqual(rec.tags, ['atlas', 'runbook']);
});

test('a record without a valid id is refused', () => {
  assert.equal(isValidStoredRecord({ id: 'nope' }), false);
  assert.throws(() => normalizeStoredRecord({ id: 'nope' }), LibraryError);
});

// --------------------------------------------------------------------------
// Projection
// --------------------------------------------------------------------------

test('a chat projects to role-labelled turns', () => {
  const text = searchTextFor(normalizeStoredRecord({
    id: 'chat:a',
    title: 'Rollback',
    body: { messages: [
      { role: 'user', content: 'who owns it' },
      { role: 'assistant', content: 'nobody' },
    ] },
  }));
  assert.match(text, /^CHAT: Rollback/);
  assert.match(text, /You: who owns it/);
  assert.match(text, /Assistant: nobody/);
});

test('multimodal content contributes its text and never "[object Object]"', () => {
  // The real bug this guards: JSON-stringifying a content part list poisons the index.
  const text = searchTextFor(normalizeStoredRecord({
    id: 'chat:a',
    body: { messages: [{ role: 'user', content: [
      { type: 'text', text: 'look at this' },
      { type: 'image_url', image_url: { url: 'data:...' } },
    ] }] },
  }));
  assert.match(text, /look at this/);
  assert.doesNotMatch(text, /object Object/);
});

test('a meeting projects its summary and its segments together', () => {
  const text = searchTextFor(normalizeStoredRecord({
    id: 'meeting:a',
    title: 'Cutover',
    body: { notes: 'moved to the 24th', segments: [{ speaker: 'Speaker 1', text: 'lag is high' }] },
  }));
  assert.match(text, /moved to the 24th/);
  assert.match(text, /Speaker 1: lag is high/);
});

test('a brief projects its summary and claim texts', () => {
  const text = searchTextFor(normalizeStoredRecord({
    id: 'brief:atlas',
    title: 'Atlas',
    body: { summary: 'a migration', claims: [{ text: 'cutover is 24 Sep' }] },
  }));
  assert.match(text, /a migration/);
  assert.match(text, /cutover is 24 Sep/);
});

test('tags reach the indexed text, so tag: queries find what the UI shows', () => {
  const text = searchTextFor(normalizeStoredRecord({ id: 'note:a', title: 'N', tags: ['atlas'], body: 'x' }));
  assert.match(text, /Tags: atlas/);
});

test('the search record is the flat shape the warm index already stores', () => {
  const sr = toSearchRecord({ id: 'note:a', title: 'N', body: 'hello', updatedAt: NOW });
  assert.deepEqual(Object.keys(sr).sort(), ['date', 'id', 'text', 'title', 'type']);
  assert.equal(sr.type, 'note');
  assert.equal(sr.date, NOW);
});

// --------------------------------------------------------------------------
// Titles and previews
// --------------------------------------------------------------------------

test('a derived title strips markdown furniture and skips blank lines', () => {
  assert.equal(deriveTitle('\n\n## **Cutover** review\n\nbody'), 'Cutover review');
});

test('a long title is clamped with an ellipsis rather than cut mid-glyph', () => {
  const t = deriveTitle('x'.repeat(200));
  assert.ok(t.length <= MAX_TITLE_LEN, `got ${t.length}`);
  assert.ok(t.endsWith('…'));
});

test('an empty body falls back rather than producing an empty title', () => {
  assert.equal(deriveTitle('   \n\n  ', 'Untitled note'), 'Untitled note');
});

test('a snippet skips the first line, because that line is already the title', () => {
  assert.equal(snippetOf('# Title\nthe body continues'), 'the body continues');
});

test('word count is one rule, so two surfaces cannot disagree', () => {
  assert.equal(wordCount('  one   two\nthree '), 3);
  assert.equal(wordCount(''), 0);
});

test('an index entry carries everything a list row draws and nothing that needs a second read', () => {
  const e = toIndexEntry({ id: 'note:a', title: 'N', body: 'alpha beta', updatedAt: NOW });
  assert.equal(e.kind, 'note');
  assert.equal(e.words, 2);
  assert.equal(e.chars, 10);
});
