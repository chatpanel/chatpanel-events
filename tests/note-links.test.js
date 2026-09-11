// The `[[` picker: what has been typed, and which pages it could mean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wikiQueryAt, rankLinkTargets } from '../note-links.js';

test('the [[ query is what has been typed after the brackets, spaces and all', () => {
  assert.deepEqual(wikiQueryAt('see [[Rollback run', 18), { query: 'Rollback run', start: 6, end: 18 });
  assert.deepEqual(wikiQueryAt('[[', 2), { query: '', start: 2, end: 2 });
});

test('a CLOSED link is not a query — the user is past it', () => {
  assert.equal(wikiQueryAt('see [[Rollback]] and more', 25), null);
  assert.equal(wikiQueryAt('see [[Rollback]]', 16), null);
});

test('a newline or another bracket means the [[ above belongs to something else', () => {
  assert.equal(wikiQueryAt('[[open\nnext line', 16), null);
  assert.equal(wikiQueryAt('[[a [b', 6), null);
  assert.equal(wikiQueryAt('no brackets here', 10), null);
  assert.equal(wikiQueryAt('[[Roll', 6, { hasSelection: true }), null);
});

test('link targets rank prefix first, then substring, each alphabetical', () => {
  const targets = [
    { title: 'Atlas rollback' }, { title: 'Rollback runbook' }, { title: 'Rollback plan' },
    { title: 'Unrelated' },
  ];
  assert.deepEqual(rankLinkTargets(targets, 'roll').map((t) => t.title),
    ['Rollback plan', 'Rollback runbook', 'Atlas rollback']);
  assert.deepEqual(rankLinkTargets(targets, 'zzz'), []);
  assert.equal(rankLinkTargets(targets, '').length, 4, 'an empty query offers everything');
  assert.equal(rankLinkTargets(targets, '', 2).length, 2);
  assert.deepEqual(rankLinkTargets(null, 'x'), []);
});

test('two records with the same title are ONE link target — a link addresses a title', () => {
  const dupes = [
    { id: 'note:1', title: 'Atlas' }, { id: 'brief:2', title: 'Atlas' }, { id: 'note:3', title: 'atlas' },
  ];
  const out = rankLinkTargets(dupes, 'atl');
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'note:1', 'the first the caller offered wins');
});
