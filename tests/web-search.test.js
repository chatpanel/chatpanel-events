// One scraper, three front doors: the judgement is here, the DOM is the host's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEARCH_ENGINES, buildSearchUrl, unwrapRedirect, isResultHost, pickResults,
  mergeEngineResults, engineOrder,
} from '../web-search.js';

const a = (href, text, over = {}) => ({ href, text, ...over });

test('a search template is user input, and is refused unless it is safe to fetch', () => {
  assert.throws(() => buildSearchUrl('http://example.com/?q=%s', 'x'), /must start with https/);
  assert.throws(() => buildSearchUrl('https://example.com/search', 'x'), /placeholder/);
  assert.equal(buildSearchUrl('https://e.com/?q=%s', 'a b'), 'https://e.com/?q=a%20b');
  assert.equal(buildSearchUrl('https://e.com/?q={q}', 'a&b'), 'https://e.com/?q=a%26b');
});

test('the host guard is INJECTED, and its refusal is not swallowed', () => {
  let asked = '';
  buildSearchUrl('https://e.com/?q=%s', 'x', { assertFetchable: (u) => { asked = u; } });
  assert.equal(asked, 'https://e.com/?q=x');
  assert.throws(
    () => buildSearchUrl('https://169.254.169.254/?q=%s', 'x', { assertFetchable: () => { throw new Error('blocked'); } }),
    /blocked/,
  );
});

test('a redirector is unwrapped, so what is fetched and cited is the real destination', () => {
  assert.equal(unwrapRedirect('https://duckduckgo.com/l/?uddg=https%3A%2F%2Freal.example%2Fpage'), 'https://real.example/page');
  assert.equal(unwrapRedirect('https://e.com/go?url=https://real.example/x'), 'https://real.example/x');
  assert.equal(unwrapRedirect('https://plain.example/page'), 'https://plain.example/page');
  assert.equal(unwrapRedirect('not a url'), 'https://duckduckgo.com/not%20a%20url');
});

test('the engine\'s own pages are not results — but the real web is not filtered', () => {
  assert.equal(isResultHost('www.startpage.com', 'www.startpage.com'), false);
  assert.equal(isResultHost('startmail.com'), false, 'the promo it carries is not a result either');
  assert.equal(isResultHost('news.google.com', 'www.google.com'), false);
  // Real results legitimately point at big properties; filtering those filters the web.
  assert.equal(isResultHost('www.youtube.com', 'www.startpage.com'), true);
  assert.equal(isResultHost('en.wikipedia.org', 'html.duckduckgo.com'), true);
  assert.equal(isResultHost(''), false);
});

test('anchors become results: unwrapped, deduped on origin+path, junk dropped', () => {
  const out = pickResults([
    a('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example%2Fguide', 'The complete guide'),
    a('https://docs.example/guide?utm_source=x', 'The complete guide again'),
    a('https://html.duckduckgo.com/settings', 'Settings page here'),
    a('mailto:someone@example.com', 'Email us now'),
    a('https://other.example/p', 'Next'),
    a('https://fine.example/page', 'Another real result'),
  ], { engineHost: 'html.duckduckgo.com' });
  assert.deepEqual(out.map((r) => r.url), ['https://docs.example/guide', 'https://fine.example/page']);
  assert.equal(out[0].title, 'The complete guide');
});

test('the generic sweep is filtered harder, because it sees the whole page', () => {
  const anchors = [a('https://real.example/a', 'A genuine result link', { chrome: true })];
  assert.equal(pickResults(anchors, { engineHost: 'e.com' }).length, 1, 'trusted selectors keep it');
  assert.equal(pickResults(anchors, { engineHost: 'e.com', fallback: true }).length, 0, 'the sweep does not');
});

test('the limit is respected, and whitespace in titles and snippets is flattened', () => {
  const many = Array.from({ length: 20 }, (_, i) => a(`https://e${i}.example/p`, `Result number ${i}`));
  assert.equal(pickResults(many, { limit: 3 }).length, 3);
  const [one] = pickResults([a('https://e.example/p', '  spaced   out  title ', { snippet: 'a\n\nb' })]);
  assert.equal(one.title, 'spaced out title');
  assert.equal(one.snippet, 'a b');
});

test('engines merge in ORDER, not interleaved, and agreement shows once', () => {
  const merged = mergeEngineResults([
    [{ url: 'https://a.example/1' }, { url: 'https://b.example/2' }],
    [{ url: 'https://b.example/2?ref=x' }, { url: 'https://c.example/3' }],
  ]);
  assert.deepEqual(merged.map((r) => r.url), ['https://a.example/1', 'https://b.example/2', 'https://c.example/3']);
  assert.equal(mergeEngineResults([[{ url: 'https://a/1' }, { url: 'https://a/2' }]], 1).length, 1);
});

test('enabled engines are tried first, then the ones left off — rather than reporting failure', () => {
  const order = engineOrder([
    { id: 'off', url: 'https://o/?q=%s', enabled: false },
    { id: 'on', url: 'https://n/?q=%s', enabled: true },
    { id: 'gone', url: 'https://g/?q=%s', retired: true },
  ]);
  assert.deepEqual(order.map((e) => e.id), ['on', 'off']);
  assert.ok(engineOrder().length >= 2, 'the defaults are usable with no argument');
  assert.ok(SEARCH_ENGINES.every((e) => /^https:\/\//.test(e.url) && e.url.includes('%s')));
});
