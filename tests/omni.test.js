import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseOmni, extractFilters, resolveSince, wantsModel, isActionable, OMNI_GRAMMAR,
} from '../omni.js';

const NOW = Date.parse('2026-09-10T12:00:00Z');

test('every mode in the grammar parses back to itself', () => {
  for (const g of OMNI_GRAMMAR) {
    assert.equal(parseOmni(`${g.prefix}atlas`).mode, g.mode, g.mode);
  }
});

test('the prefix is stripped from the query handed on to search or the model', () => {
  assert.equal(parseOmni('?who owns the rollback').query, 'who owns the rollback');
  assert.equal(parseOmni('@Atlas').query, 'Atlas');
});

test('whitespace after a prefix is not part of the query', () => {
  assert.equal(parseOmni('?   who owns it').query, 'who owns it');
});

test('an unrecognised line is a search, never an error', () => {
  assert.equal(parseOmni('!!!').mode, 'search');
  assert.equal(parseOmni('!!!').query, '!!!');
});

test('a bare prefix searches for the literal character rather than refusing', () => {
  const p = parseOmni('#');
  assert.equal(p.mode, 'tag');
  assert.equal(p.query, '');
  assert.equal(isActionable(p), false, 'and is not actionable, so it never queries the whole corpus');
});

test('known filters are lifted out; unknown ones stay in the query', () => {
  const { query, filters } = extractFilters('rollback type:note since:7d note:keepme');
  assert.deepEqual(filters, { type: 'note', since: '7d' });
  assert.equal(query, 'rollback note:keepme');
});

test('a quoted filter value survives its spaces', () => {
  const { filters, query } = extractFilters('in:"cutover review" lag');
  assert.equal(filters.in, 'cutover review');
  assert.equal(query, 'lag');
});

test('a url is not mistaken for a filter', () => {
  const { query, filters } = extractFilters('see http://example.com/x');
  assert.deepEqual(filters, {});
  assert.equal(query, 'see http://example.com/x');
});

test('relative spans resolve against an injected clock, not the real one', () => {
  assert.equal(resolveSince('7d', NOW), NOW - 7 * 86400000);
  assert.equal(resolveSince('24h', NOW), NOW - 24 * 3600000);
  assert.equal(resolveSince('30m', NOW), NOW - 30 * 60000);
});

test('an unparseable since is 0, so a bad filter widens rather than hides', () => {
  assert.equal(resolveSince('whenever', NOW), 0);
  assert.equal(resolveSince('', NOW), 0);
});

test('only ask mode wants a model turn', () => {
  assert.equal(wantsModel(parseOmni('?x')), true);
  assert.equal(wantsModel(parseOmni('x')), false);
});

test('a one-character command is actionable but a one-character search is not', () => {
  assert.equal(isActionable(parseOmni('>n')), true);
  assert.equal(isActionable(parseOmni('n')), false);
});
