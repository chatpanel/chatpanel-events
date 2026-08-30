import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SOURCE_TRUST, SkillSourceError, createSkillSourceRegistry, defineSkillSource,
} from '../skill-sources.js';
import { trustOf } from '../skill-manifest.js';

const rec = (id, extra = {}) => ({ id, name: id, description: `${id} does things`, ...extra });

const source = (id, over = {}) => defineSkillSource({
  id,
  label: id,
  list: async () => ({ items: [rec(`${id}-a`), rec(`${id}-b`)] }),
  read: async (skillId) => rec(skillId, { prompt: 'body' }),
  ...over,
});

test('a source declares what it may reach, and cannot claim to be built in', () => {
  assert.deepEqual(SOURCE_TRUST, ['local', 'community']);
  assert.throws(() => source('x', { trust: 'built-in' }), SkillSourceError);
  assert.throws(() => source('x', { reads: ['root'] }), SkillSourceError);
  assert.throws(() => defineSkillSource({ id: 'x', read: async () => null }), SkillSourceError);
  assert.throws(() => defineSkillSource({ id: 'x', list: async () => ({}) }), SkillSourceError);
  assert.equal(source('x', { reads: ['net'] }).reads[0], 'net');
});

test('results are grouped per source, not merged into one ranked list', async () => {
  // Merging would have to rank across hubs that share no scoring, and it would hide which
  // source an entry came from at exactly the moment that matters.
  const reg = createSkillSourceRegistry();
  reg.add(source('bridge', { trust: 'local' }));
  reg.add(source('hub'));
  const out = await reg.search({ query: 'anything' });
  assert.deepEqual(out.map((s) => s.source), ['bridge', 'hub']);
  assert.deepEqual(out[0].items.map((i) => i.id), ['bridge-a', 'bridge-b']);
  assert.equal(out[0].trust, 'local');
  assert.equal(out[1].trust, 'community');
});

test('a hub that is down costs its own section and nothing else', async () => {
  // A registry whose failure mode is "no skills anywhere" would be worse than the
  // hardcoded list it replaces.
  const reg = createSkillSourceRegistry();
  reg.add(source('broken', { list: async () => { throw new Error('ETIMEDOUT'); } }));
  reg.add(source('fine'));
  const out = await reg.search({});
  assert.equal(out[0].error, 'ETIMEDOUT');
  assert.deepEqual(out[0].items, []);
  assert.deepEqual(out[1].items.map((i) => i.id), ['fine-a', 'fine-b'], 'the healthy source is untouched');
});

test('a source that cannot answer right now is absent, not broken', async () => {
  // "The bridge is not running" is not an error the user has to interpret.
  const reg = createSkillSourceRegistry();
  reg.add(source('bridge', { trust: 'local', available: () => false }));
  const [section] = await reg.search({});
  assert.equal(section.absent, true);
  assert.equal(section.error, undefined);
  assert.deepEqual(section.items, []);
});

test('a source that returns nonsense yields nothing, not a crash', async () => {
  const reg = createSkillSourceRegistry();
  reg.add(source('weird', { list: async () => 'not a page' }));
  const [section] = await reg.search({});
  assert.deepEqual(section.items, []);
});

test('provenance is stamped by the registry, not by the record', async () => {
  // A source that could label its own results could label them as something more trusted.
  const reg = createSkillSourceRegistry();
  reg.add(source('hub', {
    list: async () => ({ items: [{ id: 'evil', name: 'Evil', builtin: true, origin: { source: 'built-in', id: 'ours' } }] }),
  }));
  const [section] = await reg.search({});
  const [skill] = section.items;
  assert.equal(skill.origin.source, 'hub', 'the registration decides, not the payload');
  assert.equal(skill.builtin, false);
  assert.equal(trustOf(skill), 'community');
});

test('a fetched hash survives the stamp — it is the content identity', async () => {
  // Only the fetcher knows what it actually downloaded; the scanner and the update check
  // both compare against that.
  const reg = createSkillSourceRegistry();
  reg.add(source('hub', { list: async () => ({ items: [{ id: 'a', name: 'A', origin: { id: 'o/r/a', hash: 'sha256-xyz' } }] }) }));
  const [section] = await reg.search({});
  assert.equal(section.items[0].origin.hash, 'sha256-xyz');
  assert.equal(section.items[0].origin.id, 'o/r/a', 'the upstream id is kept, not replaced by the local one');
});

test('search can be narrowed to named sources', async () => {
  const reg = createSkillSourceRegistry();
  reg.add(source('a'));
  reg.add(source('b'));
  const out = await reg.search({ only: ['b'] });
  assert.deepEqual(out.map((s) => s.source), ['b']);
});

test('a cursor is carried through for paging', async () => {
  const reg = createSkillSourceRegistry();
  reg.add(source('hub', { list: async ({ cursor }) => ({ items: [rec(cursor || 'first')], nextCursor: 'next-page' }) }));
  const [page] = await reg.search({ cursor: 'p2' });
  assert.deepEqual(page.items.map((i) => i.id), ['p2']);
  assert.equal(page.nextCursor, 'next-page');
});

test('reading one skill stamps it the same way', async () => {
  const reg = createSkillSourceRegistry();
  reg.add(source('bridge', { trust: 'local' }));
  const skill = await reg.read('bridge', 'bridge-a');
  assert.equal(skill.prompt, 'body');
  assert.equal(skill.origin.source, 'bridge');
  await assert.rejects(() => reg.read('nope', 'x'), SkillSourceError);
});

test('a source with no package files says so rather than pretending', async () => {
  const reg = createSkillSourceRegistry();
  reg.add(source('flat'));
  await assert.rejects(() => reg.readFile('flat', 'a', 'references/x.md'), (e) => e.code === 'NO_FILES');
});

test('registration is revertible and duplicates are refused', () => {
  const reg = createSkillSourceRegistry();
  const remove = reg.add(source('a'));
  assert.equal(reg.has('a'), true);
  assert.throws(() => reg.add(source('a')), (e) => e.code === 'DUPLICATE');
  remove();
  assert.equal(reg.has('a'), false);
});
