import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  outlineOf, parseListItem, continueList, indentSelection,
  toggleWrap, toggleLinePrefix, toggleTask, toggleLink, docStats, selectionStats,
} from '../markdown-authoring.js';

test('the outline reads ATX headings with their levels', () => {
  const o = outlineOf('# One\n\ntext\n\n## Two\n### Three');
  assert.deepEqual(o.map((h) => [h.level, h.text]), [[1, 'One'], [2, 'Two'], [3, 'Three']]);
});

test('headings inside fenced code are code, not structure', () => {
  const o = outlineOf('# Real\n\n```sh\n# not a heading\n```\n\n## Also real');
  assert.deepEqual(o.map((h) => h.text), ['Real', 'Also real']);
});

test('setext headings are recognised', () => {
  const o = outlineOf('Title\n=====\n\nSub\n---');
  assert.deepEqual(o.map((h) => [h.level, h.text]), [[1, 'Title'], [2, 'Sub']]);
});

test('outline offsets point at the heading line in the document', () => {
  const doc = 'intro\n\n## Section\nbody';
  const [h] = outlineOf(doc);
  assert.equal(doc.slice(h.start, h.end), '## Section');
});

test('a trailing closing-hash sequence is not part of the heading text', () => {
  assert.equal(outlineOf('## Tidy ##')[0].text, 'Tidy');
});

test('list items are parsed with indent, marker and checkbox', () => {
  assert.deepEqual(parseListItem('  - [ ] task'), {
    indent: '  ', marker: '-', ordered: false, checkbox: '[ ]', content: 'task',
  });
  assert.equal(parseListItem('3. item').ordered, true);
  assert.equal(parseListItem('plain text'), null);
});

test('Enter continues a bullet list at the same indent', () => {
  const doc = '- one';
  const r = continueList(doc, doc.length);
  assert.equal(r.text, '- one\n- ');
  assert.equal(r.selStart, r.text.length);
});

test('Enter increments an ordered list', () => {
  const doc = '1. one';
  assert.equal(continueList(doc, doc.length).text, '1. one\n2. ');
  const paren = '3) three';
  assert.equal(continueList(paren, paren.length).text, '3) three\n4) ');
});

test('a checked item continues as unchecked — the next item is new work', () => {
  const doc = '- [x] done';
  assert.equal(continueList(doc, doc.length).text, '- [x] done\n- [ ] ');
});

test('Enter on an empty item ends the list instead of adding another', () => {
  const doc = '- one\n- ';
  const r = continueList(doc, doc.length);
  // The marker goes, and a blank line separates the list from what comes next — without it
  // the prose the user is about to type is a lazy continuation of the list item and renders
  // back INSIDE the bullet.
  assert.equal(r.text, '- one\n\n');
  assert.equal(r.selStart, 7, 'caret lands below the blank line, ready for a paragraph');
});

test('Enter outside a list falls through', () => {
  assert.equal(continueList('just prose', 5), null);
});

test('indent shifts every line the selection touches, outdent removes one level', () => {
  const doc = '- a\n- b';
  const inned = indentSelection(doc, 0, doc.length, 1);
  assert.equal(inned.text, '  - a\n  - b');
  assert.equal(indentSelection(inned.text, 0, inned.text.length, -1).text, doc);
});

test('bold wraps, and toggles back off from inside or outside the markers', () => {
  const on = toggleWrap('hello', 0, 5, 'bold');
  assert.equal(on.text, '**hello**');
  assert.equal(toggleWrap(on.text, 0, on.text.length, 'bold').text, 'hello', 'markers inside the selection');
  assert.equal(toggleWrap(on.text, 2, 7, 'bold').text, 'hello', 'markers hugging the selection');
});

test('bold with no selection takes the word under the caret', () => {
  const r = toggleWrap('one two three', 5, 5, 'bold');
  assert.equal(r.text, 'one **two** three');
});

test('every inline format round-trips', () => {
  for (const [kind, mark] of [['italic', '*'], ['code', '`'], ['strike', '~~'], ['highlight', '==']]) {
    const on = toggleWrap('x', 0, 1, kind);
    assert.equal(on.text, `${mark}x${mark}`, kind);
    assert.equal(toggleWrap(on.text, 0, on.text.length, kind).text, 'x', kind);
  }
});

test('a line prefix applies to a mixed selection and only toggles off when all lines have it', () => {
  const doc = 'a\n> b';
  const all = toggleLinePrefix(doc, 0, doc.length, 'quote');
  assert.equal(all.text, '> a\n> b', 'mixed selection → add to all');
  assert.equal(toggleLinePrefix(all.text, 0, all.text.length, 'quote').text, 'a\nb');
});

test('numbering renumbers from one across the selection', () => {
  const doc = 'a\nb\nc';
  assert.equal(toggleLinePrefix(doc, 0, doc.length, 'number').text, '1. a\n2. b\n3. c');
});

test('converting between list kinds replaces the old marker', () => {
  const bullets = toggleLinePrefix('a\nb', 0, 3, 'bullet').text;
  assert.equal(bullets, '- a\n- b');
  assert.equal(toggleLinePrefix(bullets, 0, bullets.length, 'task').text, '- [ ] a\n- [ ] b');
});

test('a task checkbox flips both ways', () => {
  assert.equal(toggleTask('- [ ] x', 3).text, '- [x] x');
  assert.equal(toggleTask('- [x] x', 3).text, '- [ ] x');
  assert.equal(toggleTask('no box', 2), null);
});

test('a selected URL becomes the link target, other text becomes the label', () => {
  assert.equal(toggleLink('https://example.com', 0, 19).text, '[](https://example.com)');
  assert.equal(toggleLink('click me', 0, 8).text, '[click me]()');
});

test('document stats count words, characters and a reading estimate', () => {
  const s = docStats('one two three');
  assert.equal(s.words, 3);
  assert.equal(s.chars, 13);
  assert.equal(s.charsNoSpaces, 11);
  assert.equal(s.readingMinutes, 1, 'a short note still reads as one minute, never zero');
  assert.equal(docStats('').readingMinutes, 0, 'an empty note has no reading time at all');
});

test('stats describe the selection when there is one', () => {
  const doc = 'one two three';
  assert.equal(selectionStats(doc, 0, 0).words, 3);
  assert.equal(selectionStats(doc, 0, 0).selection, false);
  assert.equal(selectionStats(doc, 0, 7).words, 2);
  assert.equal(selectionStats(doc, 0, 7).selection, true);
});
