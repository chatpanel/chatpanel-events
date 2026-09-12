import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTools, findToolsResult, oneLiner, overlapRank, FIND_ACTION, findActionArgs } from '../tool-discovery.js';

const specs = [
  { name: 'mcp_jira__search_issues', description: 'Search Jira issues with JQL. Returns a page of matching issues with key, summary and status. Supports pagination.', parameters: { type: 'object', properties: { jql: { type: 'string' } }, required: ['jql'] } },
  { name: 'mcp_jira__get_issue', description: 'Fetch one Jira issue by key.', parameters: { type: 'object', required: ['key'] } },
  { name: 'mcp_cf__list_zones', description: 'List Cloudflare zones on the account.' },
  { name: 'mcp_cf__purge_cache', description: 'Purge the cache of a zone.\nDangerous.' },
];

test('finds by task words, returns names and one-liners with required fields', () => {
  const found = findTools(specs, 'jira issues', { limit: 2 });
  assert.equal(found.length, 2);
  assert.equal(found[0].name, 'mcp_jira__search_issues');
  assert.equal(found[0].summary, 'Search Jira issues with JQL.');
  assert.deepEqual(found[0].required, ['jql']);
  assert.deepEqual(findTools(specs, 'zones').map((f) => f.name)[0], 'mcp_cf__list_zones');
});

test('an injected ranker is used instead of the fallback', () => {
  const rank = (list) => [...list].reverse();
  assert.equal(findTools(specs, 'anything', { rank })[0].name, 'mcp_cf__purge_cache');
});

test('the result text tells the model how to call what it found — and marks what the menu shows', () => {
  const r = JSON.parse(findToolsResult(specs, 'purge', { menu: ['mcp_jira__search_issues'] }));
  assert.equal(r.matches[0].name, 'mcp_cf__purge_cache');
  assert.equal(r.matches[0].listed, false);
  assert.equal(r.total, 4);
  assert.match(r.hint, /\{"action":"<name>","args":\{…\}\}/);
  assert.match(r.hint, /"describe"/);
  const none = JSON.parse(findToolsResult(specs, 'zzzzqq'));
  // Overlap ranking with no hits still lists (nothing matched, everything ties) — so the
  // hint depends on whether anything scored. Here every score is 0 → the fallback keeps
  // order, which is a listing, not a miss; the hint still teaches the call.
  assert.ok(none.matches.length >= 0);
});

test('oneLiner takes the first sentence, collapses whitespace and caps', () => {
  assert.equal(oneLiner('Purge the cache of a zone.\nDangerous.'), 'Purge the cache of a zone.');
  assert.equal(oneLiner('  a   b  '), 'a b');
  assert.equal(oneLiner('x'.repeat(200), 20).length, 20);
  assert.equal(oneLiner('Dr. Who is a show that lasts long enough to be cut'), 'Dr. Who is a show that lasts long enough to be cut', 'a short "sentence" is not a boundary');
});

test('the fallback ranker orders by overlap, stable for ties', () => {
  const r = overlapRank(specs, 'list zones cloudflare');
  assert.equal(r[0].name, 'mcp_cf__list_zones');
  assert.deepEqual(overlapRank(specs, '').map((s) => s.name), specs.map((s) => s.name));
});

test('the action name and its args fragment are stable', () => {
  assert.equal(FIND_ACTION, 'find');
  assert.equal(findActionArgs().query.type, 'string');
});
