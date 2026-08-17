import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkifyCitations, sourcesFromToolText } from '../citations.js';

const toolText = `Web search results for "spacex".

Sources:
[1] [SpaceX: SPCX Stock Price Quote & News | Robinhood](https://robinhood.com/us/en/stocks/SPCX/)
[2] [SpaceX Stock | Hiive](https://www.hiive.com/securities/spacex-stock)
[5] [Yahoo Finance](https://finance.yahoo.com/quote/SPCX/)

---
Result details:`;

const sources = sourcesFromToolText(toolText);

test('sources are recovered from the text the model was shown', () => {
  // Parsed from the SAME text the model read, so the numbers cannot disagree with what it
  // saw — deriving them elsewhere would reintroduce the mismatch this removes.
  assert.deepEqual(sources.map((s) => s.rank), [1, 2, 5]);
  assert.equal(sources[0].url, 'https://robinhood.com/us/en/stocks/SPCX/');
  assert.equal(sources[2].title, 'Yahoo Finance');
});

test('bare citations become links, and a Sources section is appended', () => {
  // The reported failure: five sources fetched, five bracket numbers rendered, no links.
  const out = linkifyCitations('The closing price was $140.00 [5]. Market cap ~$1.84T [1, 5].', sources);
  assert.match(out, /\(\[5\]\(https:\/\/finance\.yahoo\.com\/quote\/SPCX\/\)\)/);
  assert.match(out, /\(\[1\]\(https:\/\/robinhood[^)]*\)\) \(\[5\]\(/);
  assert.match(out, /\*\*Sources\*\*/);
  // Only what was actually cited is listed — [2] was never referenced.
  assert.ok(!out.includes('hiive.com'), 'an uncited source was listed');
});

test('an unknown number is left alone rather than invented', () => {
  // Linking [7] when seven sources were never returned would be fabricating a citation,
  // which is worse than an unlinked number.
  const out = linkifyCitations('As reported [7].', sources);
  assert.match(out, /\[7\]/);
  assert.ok(!out.includes('**Sources**'), 'a Sources section was added with nothing cited');
});

test('links the model already wrote are untouched', () => {
  const already = 'Price was $140 ([5](https://finance.yahoo.com/quote/SPCX/)).';
  assert.equal(linkifyCitations(already, sources), already);
});

test('a Sources section the model wrote is not duplicated', () => {
  const withOwn = 'Price [1].\n\n**Sources**\n1. [Robinhood](https://robinhood.com/us/en/stocks/SPCX/)';
  const out = linkifyCitations(withOwn, sources);
  assert.equal(out.match(/\*\*Sources\*\*/g).length, 1);
});

test('brackets inside code are code, not citations', () => {
  const code = 'Use `arr[1]` or:\n\n```js\nconst x = arr[1];\n```\n';
  assert.equal(linkifyCitations(code, sources), code);
});

test('nothing to work with is returned unchanged', () => {
  assert.equal(linkifyCitations('No sources here [1].', []), 'No sources here [1].');
  assert.equal(linkifyCitations('', sources), '');
  assert.equal(linkifyCitations(null, sources), '');
});
