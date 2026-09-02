import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTag, normalizeTags, addTag, removeTag, toggleTag, hasTag, sameTags, formatTag,
  parseTagQuery, formatTagQuery, hasTagTerms, matchesTagFilter, filterByTags, tagFacets,
  suggestExistingTags, tagsSearchText, MAX_TAGS, MAX_TAG_LENGTH,
} from '../tags.js';

// --------------------------------------------------------------------------
// Normalization — one tag, however it was typed
// --------------------------------------------------------------------------

test('case, punctuation and spacing are filing noise, not identity', () => {
  assert.equal(normalizeTag('Design Review'), 'design-review');
  assert.equal(normalizeTag('#DesignReview!'), 'designreview');
  assert.equal(normalizeTag('  design---review  '), 'design-review');
  assert.equal(normalizeTag('design_review'), 'design-review');
  assert.equal(normalizeTag('##nested'), 'nested');
});

test('normalizing is idempotent, so a re-save cannot drift a tag', () => {
  for (const raw of ['Design Review', '#q3/plan', 'a  b', 'x'.repeat(50)]) {
    assert.equal(normalizeTag(normalizeTag(raw)), normalizeTag(raw));
  }
});

test('a tag written in any script survives — stripping to a-z erases it', () => {
  assert.equal(normalizeTag('日本語'), '日本語');
  assert.equal(normalizeTag('Ελλάδα'), 'ελλάδα');
  assert.equal(normalizeTag('café-notes'), 'café-notes');
});

test('nothing usable normalizes to empty rather than to a stray dash', () => {
  assert.equal(normalizeTag('#'), '');
  assert.equal(normalizeTag('   '), '');
  assert.equal(normalizeTag('!!!'), '');
  assert.equal(normalizeTag(null), '');
});

test('a long tag is capped without leaving a trailing separator', () => {
  const t = normalizeTag(`${'a'.repeat(30)} words here`);
  assert.equal(t.length <= MAX_TAG_LENGTH, true);
  assert.equal(/-$/.test(t), false);
});

test('a list dedupes on the canonical form and keeps the order typed', () => {
  assert.deepEqual(normalizeTags(['Design', 'design', '#DESIGN', 'ship']), ['design', 'ship']);
  assert.deepEqual(normalizeTags(['b', 'a']), ['b', 'a']); // insertion order, not sorted
  assert.deepEqual(normalizeTags(null), []);
});

test('the tag count is capped', () => {
  const many = Array.from({ length: MAX_TAGS + 8 }, (_, i) => `t${i}`);
  assert.equal(normalizeTags(many).length, MAX_TAGS);
});

// --------------------------------------------------------------------------
// Mutation
// --------------------------------------------------------------------------

test('add / remove / toggle work on canonical forms', () => {
  assert.deepEqual(addTag(['a'], ' B '), ['a', 'b']);
  assert.deepEqual(addTag(['a'], 'A'), ['a']);       // already there
  assert.deepEqual(addTag(['a'], '#'), ['a']);       // nothing usable
  assert.deepEqual(removeTag(['a', 'b'], 'A'), ['b']);
  assert.deepEqual(toggleTag(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(toggleTag(['a', 'b'], 'B'), ['a']);
  assert.equal(hasTag(['design-review'], 'Design Review'), true);
});

test('adding past the cap is a no-op, not a silent truncation of older tags', () => {
  const full = Array.from({ length: MAX_TAGS }, (_, i) => `t${i}`);
  assert.deepEqual(addTag(full, 'extra'), full);
});

test('sameTags compares sets, so re-ordering does not look like an edit', () => {
  assert.equal(sameTags(['a', 'b'], ['B', 'A']), true);
  assert.equal(sameTags(['a'], ['a', 'b']), false);
});

test('one display form everywhere', () => {
  assert.equal(formatTag('Design Review'), '#design-review');
  assert.equal(formatTag('  '), '');
});

// --------------------------------------------------------------------------
// Query language
// --------------------------------------------------------------------------

test('tag terms come out of the query and the free text stays clean', () => {
  const q = parseTagQuery('tag:design pricing notes -tag:done');
  assert.deepEqual(q.include, ['design']);
  assert.deepEqual(q.exclude, ['done']);
  assert.equal(q.text, 'pricing notes');
});

test('the # shorthand people already type is accepted', () => {
  const q = parseTagQuery('#design #q3 roadmap');
  assert.deepEqual(q.include, ['design', 'q3']);
  assert.equal(q.text, 'roadmap');
});

test('a # inside a word is text, not a tag — "C#" and "issue #12" still search', () => {
  const q = parseTagQuery('C# generics');
  assert.deepEqual(q.include, []);
  assert.equal(q.text, 'C# generics');
});

test('a quoted tag term folds to one tag', () => {
  const q = parseTagQuery('tag:"deep work" focus');
  assert.deepEqual(q.include, ['deep-work']);
  assert.equal(q.text, 'focus');
});

test('an unusable tag term stays in the free text instead of vanishing', () => {
  const q = parseTagQuery('tag:!!! hello');
  assert.deepEqual(q.include, []);
  assert.equal(q.text, 'tag:!!! hello');
});

test('a plain query is untouched and reports no tag terms', () => {
  assert.deepEqual(parseTagQuery('quarterly planning'), { include: [], exclude: [], text: 'quarterly planning' });
  assert.equal(hasTagTerms('quarterly planning'), false);
  assert.equal(hasTagTerms('#design'), true);
});

test('formatTagQuery round-trips a parsed filter', () => {
  const raw = 'tag:design -tag:done pricing';
  const parsed = parseTagQuery(raw);
  assert.equal(formatTagQuery(parsed), 'tag:design -tag:done pricing');
  assert.deepEqual(parseTagQuery(formatTagQuery(parsed)), parsed);
});

// --------------------------------------------------------------------------
// Matching & filtering
// --------------------------------------------------------------------------

test('includes narrow (AND) — that is what a filter is for', () => {
  const filter = { include: ['design', 'q3'] };
  assert.equal(matchesTagFilter(['design', 'q3', 'x'], filter), true);
  assert.equal(matchesTagFilter(['design'], filter), false);
  assert.equal(matchesTagFilter(['design'], filter, { mode: 'any' }), true);
});

test('an exclusion beats an include', () => {
  assert.equal(matchesTagFilter(['design', 'done'], { include: ['design'], exclude: ['done'] }), false);
});

test('an empty filter matches everything, including untagged records', () => {
  assert.equal(matchesTagFilter([], {}), true);
  assert.equal(matchesTagFilter(undefined, { include: [] }), true);
});

test('filterByTags preserves order and passes the list through when nothing is selected', () => {
  const rows = [{ id: 1, tags: ['design'] }, { id: 2, tags: [] }, { id: 3, tags: ['design', 'done'] }];
  assert.deepEqual(filterByTags(rows, { include: ['design'] }).map((r) => r.id), [1, 3]);
  assert.deepEqual(filterByTags(rows, { include: ['design'], exclude: ['done'] }).map((r) => r.id), [1]);
  assert.deepEqual(filterByTags(rows, {}).map((r) => r.id), [1, 2, 3]);
});

// --------------------------------------------------------------------------
// Facets
// --------------------------------------------------------------------------

test('facets rank by use, then alphabetically so the bar does not jitter on ties', () => {
  const rows = [{ tags: ['b'] }, { tags: ['a', 'b'] }, { tags: ['c', 'a', 'b'] }];
  assert.deepEqual(tagFacets(rows), [{ tag: 'b', count: 3 }, { tag: 'a', count: 2 }, { tag: 'c', count: 1 }]);
});

test('a selected tag stays in the bar even when the filter leaves it at zero', () => {
  const facets = tagFacets([{ tags: ['a'] }], undefined, { selected: ['zz'] });
  assert.deepEqual(facets.find((f) => f.tag === 'zz'), { tag: 'zz', count: 0 });
});

test('truncating the bar never hides an active selection', () => {
  const rows = [{ tags: ['a', 'a2', 'a3', 'a4'] }, { tags: ['a', 'a2'] }, { tags: ['rare'] }];
  const facets = tagFacets(rows, undefined, { limit: 2, selected: ['rare'] });
  assert.equal(facets.length, 2);
  assert.equal(facets.some((f) => f.tag === 'rare'), true);
});

test('suggestions reuse tags already in the corpus and skip the ones already on the record', () => {
  const facets = [{ tag: 'design', count: 5 }, { tag: 'q3', count: 2 }];
  assert.deepEqual(suggestExistingTags(facets, ['design']), ['q3']);
  assert.deepEqual(suggestExistingTags(['design', 'q3'], []), ['design', 'q3']);
});

// --------------------------------------------------------------------------
// Search text
// --------------------------------------------------------------------------

test('both forms are indexed so "#design" and "design" each hit', () => {
  assert.equal(tagsSearchText(['Design Review']), '#design-review design-review');
  assert.equal(tagsSearchText([]), '');
});
