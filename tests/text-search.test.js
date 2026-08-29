import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileQuery, findMatches, matchIndexFor, expandReplacement,
  replaceMatch, replaceAll, replaceAllInRange,
} from '../text-search.js';

test('a literal query matches case-insensitively by default', () => {
  const m = findMatches('Foo foo FOO', 'foo');
  assert.equal(m.length, 3);
  assert.deepEqual(m.map((x) => x.start), [0, 4, 8]);
});

test('case sensitivity is honoured when asked for', () => {
  assert.equal(findMatches('Foo foo FOO', 'foo', { caseSensitive: true }).length, 1);
});

test('regex metacharacters are literal unless regex mode is on', () => {
  assert.equal(findMatches('a.c abc', 'a.c').length, 1, 'the dot must not match "b"');
  assert.equal(findMatches('a.c abc', 'a.c', { regex: true }).length, 2);
});

test('whole-word does not require a word character on the query boundary', () => {
  // `\bfoo(\b` can never match — the lookaround form is the only one that answers this.
  assert.equal(findMatches('call foo( x', 'foo(', { wholeWord: true }).length, 1);
  assert.equal(findMatches('foobar foo', 'foo', { wholeWord: true }).length, 1);
});

test('an empty-matching pattern terminates instead of hanging the editor', () => {
  // A find bar runs on every keystroke; `a*` on a global regex would spin forever.
  assert.deepEqual(findMatches('bbb', 'a*', { regex: true }), []);
  assert.deepEqual(findMatches('bbb', '^', { regex: true }), []);
});

test('an invalid regex is reported, not thrown', () => {
  const r = compileQuery('(', { regex: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /./);
  assert.deepEqual(findMatches('anything', '(', { regex: true }), []);
});

test('an empty query matches nothing', () => {
  assert.deepEqual(findMatches('abc', ''), []);
  assert.equal(compileQuery('').error, 'empty');
});

test('find next takes the first match at or after the caret, and wraps', () => {
  const m = findMatches('x foo y foo z', 'foo');
  assert.equal(matchIndexFor(m, 0, 1), 0);
  assert.equal(matchIndexFor(m, 3, 1), 1, 'a caret inside match 0 moves on to match 1');
  assert.equal(matchIndexFor(m, 99, 1), 0, 'past the last match it wraps to the first');
});

test('find previous takes the last match before the caret, and wraps', () => {
  const m = findMatches('x foo y foo z', 'foo'); // matches at 2..5 and 8..11
  // Caret INSIDE the second match — where "find next" leaves it. Previous must move off it.
  assert.equal(matchIndexFor(m, 9, -1), 0);
  assert.equal(matchIndexFor(m, 8, -1), 0, 'from the start of a match, previous is the one before');
  assert.equal(matchIndexFor(m, 0, -1), 1, 'before the first match it wraps to the last');
  assert.equal(matchIndexFor([], 0, -1), -1);
});

test('$1 and $& expand only in regex mode', () => {
  const [m] = findMatches('hello world', '(\\w+) (\\w+)', { regex: true });
  assert.equal(expandReplacement('$2 $1', m, true), 'world hello');
  assert.equal(expandReplacement('[$&]', m, true), '[hello world]');
  assert.equal(expandReplacement('$$', m, true), '$');
});

test('a literal replacement keeps its dollar signs', () => {
  // Otherwise there would be no way to type a price into a document.
  const [m] = findMatches('cost: X', 'X');
  assert.equal(expandReplacement('$5', m, false), '$5');
  assert.equal(replaceMatch('cost: X', m, '$5').text, 'cost: $5');
});

test('replace all rewrites every match even when lengths differ', () => {
  // Left-to-right splicing would shift later offsets and corrupt the tail.
  const { text, count } = replaceAll('a a a', 'a', 'LONGER');
  assert.equal(count, 3);
  assert.equal(text, 'LONGER LONGER LONGER');
  assert.equal(replaceAll('aaa', 'a', '').text, '');
});

test('replace all is a no-op when nothing matches', () => {
  const { text, count } = replaceAll('abc', 'zzz', 'x');
  assert.equal(count, 0);
  assert.equal(text, 'abc');
});

test('replace all in a range leaves the rest of the document alone', () => {
  const { text, count } = replaceAllInRange('foo foo foo', 'foo', 'bar', 4, 7);
  assert.equal(count, 1);
  assert.equal(text, 'foo bar foo');
});

test('replace reports where to leave the caret', () => {
  const [m] = findMatches('one two', 'one');
  const r = replaceMatch('one two', m, 'ONE!');
  assert.equal(r.text, 'ONE! two');
  assert.equal(r.cursor, 4);
});
