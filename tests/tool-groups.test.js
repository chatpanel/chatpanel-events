import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineToolGroup, createToolGroupRegistry, ToolGroupError } from '../tool-groups.js';

const grp = (id, priority, over = {}) => defineToolGroup({
  id, priority, build: async () => ({ specs: [{ name: id }] }), ...over,
});

test('order is stated priority, not who finished first', async () => {
  // Groups build concurrently because one of them connects to remote servers, and
  // serialising would add that latency to every turn. The order the model sees must not
  // depend on which finished.
  const reg = createToolGroupRegistry();
  reg.add(grp('slow', 10, { build: async () => { await new Promise((r) => setTimeout(r, 20)); return { specs: [] }; } }));
  reg.add(grp('fast', 5));
  const out = await reg.build({});
  assert.deepEqual(out.map((g) => g.id), ['slow', 'fast']);
});

test('a group that throws is dropped, not propagated', async () => {
  // A broken MCP server must not cost the user their history tools.
  const errs = [];
  const reg = createToolGroupRegistry();
  reg.add(grp('broken', 10, { build: async () => { throw new Error('server down'); } }));
  reg.add(grp('history', 5));
  const out = await reg.build({}, { onError: (id, e) => errs.push(`${id}:${e.message}`) });
  assert.deepEqual(out.map((g) => g.id), ['history']);
  assert.deepEqual(errs, ['broken:server down']);
});

test('applies is asked without paying to build', async () => {
  // MCP construction connects to servers; asking whether it should be offered must not.
  let built = 0;
  const reg = createToolGroupRegistry();
  reg.add(grp('off', 0, { applies: () => false, build: async () => { built++; return { specs: [] }; } }));
  await reg.build({});
  assert.equal(built, 0);
});

test('an applies that throws excludes only that group', async () => {
  const reg = createToolGroupRegistry();
  reg.add(grp('bad', 10, { applies: () => { throw new Error('nope'); } }));
  reg.add(grp('good', 5));
  assert.deepEqual((await reg.build({})).map((g) => g.id), ['good']);
});

test('building nothing is normal, not an error', async () => {
  // Returning null means "nothing configured" — the common case for a user with no MCP
  // servers, and it must not look like a failure.
  const reg = createToolGroupRegistry();
  reg.add(grp('empty', 0, { build: async () => null }));
  assert.deepEqual(await reg.build({}), []);
});

test('registration is revertible and declarations are checked at declare time', () => {
  const reg = createToolGroupRegistry();
  const remove = reg.add(grp('x', 0));
  assert.equal(reg.list().length, 1);
  remove();
  assert.equal(reg.list().length, 0);
  assert.throws(() => defineToolGroup({ id: 'y' }), (e) => e instanceof ToolGroupError);
});

test('a group the user disabled never does its work', async () => {
  // Filtering the RESULT would still pay the cost: for MCP that cost is connecting to
  // servers, which is what once made a first turn wait 45 seconds.
  let built = 0;
  const reg = createToolGroupRegistry();
  reg.add(defineToolGroup({ id: 'mcp', build: async () => { built++; return { specs: [] }; } }));
  reg.add(grp('data', 5));
  const out = await reg.build({}, { admit: (g) => g.id !== 'mcp' });
  assert.equal(built, 0, 'a disabled group still ran');
  assert.deepEqual(out.map((g) => g.id), ['data']);
});
