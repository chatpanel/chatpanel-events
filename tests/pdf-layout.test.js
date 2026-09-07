import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  linesFromItems, orderLines, paragraphsFromLines, pageTextFromItems,
  looksScanned, buildPdfDocument, PDF_MAX_CHARS,
} from '../pdf-layout.js';

/** An engine text item: a glyph run at (x, y) in PDF user space, y growing upward. */
const item = (str, x, y, width, size = 10) => ({
  str, width, height: size, transform: [size, 0, 0, size, x, y],
});

// --------------------------------------------------------------------------
// Runs → lines
// --------------------------------------------------------------------------

test('runs sharing a baseline become one line, in x order', () => {
  const lines = linesFromItems([
    item('world', 120, 700, 40),
    item('Hello', 72, 700, 40),
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'Hello world');
});

// A PDF encodes a space EITHER as a character OR as a gap with nothing in it, and which one
// you get is a property of the producer. Both have to work.
test('a horizontal gap with no space character still separates two words', () => {
  const lines = linesFromItems([item('Hello', 72, 700, 30), item('world', 110, 700, 30)]);
  assert.equal(lines[0].text, 'Hello world');
});

test('kerned runs with no real gap are not pulled apart', () => {
  const lines = linesFromItems([item('Wa', 72, 700, 12), item('ter', 84, 700, 15)]);
  assert.equal(lines[0].text, 'Water');
});

// The tolerance is a fraction of the FONT SIZE. A fixed number of points either splits a
// heading's own baseline jitter or merges two lines of a footnote.
test('a 24pt heading and a 7pt footnote each keep their own idea of "same line"', () => {
  const heading = linesFromItems([item('Big', 72, 700, 40, 24), item('Title', 116, 698, 40, 24)]);
  assert.equal(heading.length, 1, 'a 2pt baseline jitter split a 24pt heading');
  const footnote = linesFromItems([item('one', 72, 100, 20, 7), item('two', 72, 96, 20, 7)]);
  assert.equal(footnote.length, 2, 'two 7pt footnote lines 4pt apart were merged');
});

test('empty runs contribute nothing', () => {
  assert.deepEqual(linesFromItems([item('', 72, 700, 0)]), []);
  assert.deepEqual(linesFromItems(null), []);
});

// --------------------------------------------------------------------------
// Lines → reading order
// --------------------------------------------------------------------------

test('a single-column page reads top to bottom', () => {
  const lines = linesFromItems([
    item('second', 72, 680, 100), item('first', 72, 700, 100), item('third', 72, 660, 100),
  ]);
  assert.deepEqual(orderLines(lines).map((l) => l.text), ['first', 'second', 'third']);
});

// THE CASE THAT MAKES NAIVE EXTRACTION USELESS. Interleaved by y, a two-column paper reads
// "left1 right1 left2 right2" — every sentence cut in half.
test('a two-column page reads down the left column, then the right', () => {
  const items = [];
  for (let i = 0; i < 6; i++) items.push(item(`L${i}`, 60, 700 - i * 14, 180));
  for (let i = 0; i < 6; i++) items.push(item(`R${i}`, 320, 700 - i * 14, 180));
  const ordered = orderLines(linesFromItems(items), { pageWidth: 520 });
  assert.deepEqual(ordered.map((l) => l.text), ['L0','L1','L2','L3','L4','L5','R0','R1','R2','R3','R4','R5']);
});

// A wrong split is worse than none, so an ambiguous page is left alone.
test('a single column with a stray indent is not split into two', () => {
  const items = [];
  for (let i = 0; i < 8; i++) items.push(item(`line ${i}`, i === 3 ? 100 : 60, 700 - i * 14, 400));
  const ordered = orderLines(linesFromItems(items), { pageWidth: 520 });
  assert.deepEqual(ordered.map((l) => l.text), ['line 0','line 1','line 2','line 3','line 4','line 5','line 6','line 7']);
});

// --------------------------------------------------------------------------
// Lines → paragraphs
// --------------------------------------------------------------------------

test('a bigger-than-usual vertical gap starts a new paragraph', () => {
  const lines = linesFromItems([
    item('one one one', 72, 700, 200), item('two two two', 72, 686, 200),
    item('a new thought', 72, 650, 200),
  ]);
  const paras = paragraphsFromLines(orderLines(lines));
  assert.equal(paras.length, 2);
  assert.equal(paras[0], 'one one one two two two');
});

// Without this, "distri-\nbuted" never matches a search for "distributed" and the model
// reads a word that does not exist.
test('a word hyphenated across a line break is put back together', () => {
  const lines = linesFromItems([item('a distri-', 72, 700, 200), item('buted system', 72, 686, 200)]);
  assert.equal(paragraphsFromLines(lines)[0], 'a distributed system');
});

test('a real hyphenated compound at a line end is not glued into one word', () => {
  // "well-" then "known" IS glued — that is the same shape as a break, and the ambiguity is
  // unresolvable without a dictionary. What must not happen is losing the hyphen mid-line.
  const lines = linesFromItems([item('a well-known result here', 72, 700, 200)]);
  assert.equal(paragraphsFromLines(lines)[0], 'a well-known result here');
});

test('a short final line ends its paragraph', () => {
  const lines = linesFromItems([
    item('a long line reaching the right margin', 72, 700, 400),
    item('short.', 72, 686, 40),
    item('another long line reaching the margin', 72, 672, 400),
  ]);
  assert.equal(paragraphsFromLines(lines).length, 2);
});

test('a page of nothing produces no paragraphs rather than an empty string', () => {
  assert.deepEqual(paragraphsFromLines([]), []);
  assert.equal(pageTextFromItems([]), '');
});

// --------------------------------------------------------------------------
// The document
// --------------------------------------------------------------------------

test('pages carry their number, so a citation into a long PDF means something', () => {
  const doc = buildPdfDocument({
    meta: { title: 'A Paper', author: 'A. Author', pageCount: 2, url: 'https://example.com/p.pdf' },
    pages: [{ page: 1, text: 'first page' }, { page: 2, text: 'second page' }],
  });
  assert.match(doc.text, /^# A Paper/);
  assert.match(doc.text, /Author: A\. Author · Pages: 2 · URL: https:\/\/example\.com\/p\.pdf/);
  assert.match(doc.text, /\[page 1\]\nfirst page/);
  assert.match(doc.text, /\[page 2\]\nsecond page/);
  assert.equal(doc.chars, doc.text.length);
  assert.equal(doc.pagesRead, 2);
});

test('an empty page is skipped rather than emitting a bare marker', () => {
  const doc = buildPdfDocument({ pages: [{ page: 1, text: '' }, { page: 2, text: 'x'.repeat(100) }] });
  assert.doesNotMatch(doc.text, /\[page 1\]/);
});

test('a document over the cap is truncated and says so', () => {
  const doc = buildPdfDocument({
    pages: [{ page: 1, text: 'x'.repeat(500) }],
    maxChars: 100,
  });
  assert.equal(doc.truncated, true);
  assert.match(doc.text, /PDF truncated at 100 characters/);
  assert.ok(PDF_MAX_CHARS > 100);
});

// A SCANNED PDF IS THE ONE THAT FAILS SILENTLY. Every extractor answers with an empty
// string, so without this the user gets a summary of nothing and no explanation.
test('a scan is recognised as a scan, not returned as an empty document', () => {
  assert.equal(looksScanned([{ page: 1, text: '' }, { page: 2, text: '3' }]), true);
  assert.equal(buildPdfDocument({ pages: [{ page: 1, text: '' }] }).scanned, true);
});

test('a real document is not mistaken for a scan', () => {
  const pages = [{ page: 1, text: 'x'.repeat(2000) }, { page: 2, text: 'y'.repeat(2000) }];
  assert.equal(looksScanned(pages), false);
  assert.equal(buildPdfDocument({ pages }).scanned, false);
});

test('no pages at all is not a scan — it is nothing, and the caller says so', () => {
  assert.equal(looksScanned([]), false);
});

// --------------------------------------------------------------------------
// End to end on one realistic page
// --------------------------------------------------------------------------

test('a two-column page with a hyphenated break reads as prose', () => {
  const items = [
    item('Abstract', 60, 720, 60, 12),
    item('We describe a distri-', 60, 700, 180),
    item('buted approach that', 60, 686, 180),
    item('scales.', 60, 672, 60),
    item('Prior work has been', 320, 700, 180),
    item('limited to one node', 320, 686, 180),
    item('per rack.', 320, 672, 80),
  ];
  const text = pageTextFromItems(items, { pageWidth: 520 });
  assert.match(text, /We describe a distributed approach that scales\./);
  assert.match(text, /Prior work has been limited to one node per rack\./);
  assert.ok(text.indexOf('We describe') < text.indexOf('Prior work'), 'the columns interleaved');
});
