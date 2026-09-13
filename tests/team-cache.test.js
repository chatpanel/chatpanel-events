import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunCache, withRunCache } from '../team-cache.js';
import { runTeam } from '../team-run.js';
import { normalizeTeam } from '../team.js';

test('a read-only lookup runs once per run; a second member gets the first answer, marked shared; writes and paging never cache', async () => {
  const ran = [];
  const host = {
    specs: [{ name: 'find', annotations: { readOnlyHint: true } }, { name: 'get_result' }, { name: 'mcp_x__delete', annotations: { readOnlyHint: false } }],
    execute: async (name, input) => { ran.push([name, JSON.stringify(input)]); return `${name}:${input?.q || ''}`; },
  };
  const cache = createRunCache();
  const a = withRunCache(host, cache, { role: 'a' });
  const b = withRunCache(host, cache, { role: 'b' });
  assert.equal(await a.execute('find', { q: 'calendar', action: 'web_search' }), 'find:calendar');
  const again = await b.execute('find', { action: 'web_search', q: 'calendar' });
  assert.match(again, /^\[shared: a already ran this in this run\]\nfind:calendar/, 'same call, keys ordered differently, one run');
  await a.execute('get_result', { ref: 'r1' }); await b.execute('get_result', { ref: 'r1' });
  await a.execute('mcp_x__delete', { id: 1 }); await b.execute('mcp_x__delete', { id: 1 });
  assert.equal(ran.length, 5, 'find once, paging twice, the write twice');
  assert.equal(cache.shared, 1);
});

test('inside a run, members in one wave share lookups and the result reports it', async () => {
  const team = normalizeTeam({ name: 't', merge: 'concat', roles: [{ id: 'a', prompt: 'p', grants: ['web'] }, { id: 'b', prompt: 'p', grants: ['web'] }], budget: { tokens: 1000 } });
  let searches = 0;
  const toolsFor = () => ({ specs: [{ name: 'web_search', annotations: { readOnlyHint: true } }], execute: async () => { searches += 1; return 'result'; } });
  const callModel = async ({ tools }) => { await tools.execute('web_search', { q: 'same' }); return { ok: true, text: 'done' }; };
  const res = await runTeam({ team, request: 'x', callModel, toolsFor, appoint: () => ({ model: 'm', mode: 'model' }) });
  assert.equal(res.status, 'completed');
  assert.equal(searches, 1, 'two members, one search');
  assert.deepEqual(res.lookups, { distinct: 1, shared: 1 });
});
