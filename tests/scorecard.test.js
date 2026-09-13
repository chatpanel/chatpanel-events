// A scorecard is an immutable, attested record of what an agent did — and matching reads it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { canonical, makeEntry, verifyChain, attest, verifyAttested, summarize, fit } from '../scorecard.js';
import { runTeam } from '../team-run.js';
import { normalizeTeam } from '../team.js';

const subtle = webcrypto.subtle;
const key = new TextEncoder().encode('the-store-holds-this');

test('entries chain: every link is checked, and an edit anywhere after the fact breaks the chain from there', async () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
  const e0 = await makeEntry({ agentId: 'researcher', kind: 'task.done', runId: 'r1', size: { ms: 100, steps: 4, tools: 2, findings: 3 }, roleKind: 'ic', tools: ['find', 'board'], with: ['writer'] }, null, { now: () => 1, subtle });
  const e1 = await makeEntry({ agentId: 'researcher', kind: 'rating', runId: 'r1', rating: { by: 'person', score: 0.9, note: 'good' } }, e0, { now: () => 2, subtle });
  const e2 = await makeEntry({ agentId: 'researcher', kind: 'task.failed', runId: 'r2', error: 'timed out' }, e1, { now: () => 3, subtle });
  assert.equal(e0.seq, 0); assert.equal(e2.prev, e1.hash);
  assert.deepEqual(await verifyChain([e0, e1, e2], { subtle }), { ok: true, at: null, length: 3 });
  const forged = [e0, { ...e1, rating: { ...e1.rating, score: 1 } }, e2];
  const v = await verifyChain(forged, { subtle });
  assert.equal(v.ok, false); assert.equal(v.at, 1); assert.equal(v.why, 'hash');
  const dropped = [e0, e2];
  assert.equal((await verifyChain(dropped, { subtle })).why, 'seq');
  await assert.rejects(() => makeEntry({ agentId: 'x', kind: 'made-up' }, null, { subtle }), /kind/);
});

test('the store attests; an entry written elsewhere is honest about being unattested', async () => {
  const e0 = await attest(await makeEntry({ agentId: 'a', kind: 'task.done', runId: 'r' }, null, { subtle }), key, { subtle });
  const e1 = await makeEntry({ agentId: 'a', kind: 'rating', rating: { score: 1 } }, e0, { subtle }); // no sig
  const v = await verifyAttested([e0, e1], key, { subtle });
  assert.deepEqual([v.ok, v.attested, v.of], [false, 1, 2]);
  assert.equal((await verifyAttested([e0], new TextEncoder().encode('another key'), { subtle })).ok, false, 'a mark from another key is no mark');
  assert.equal((await verifyChain([e0, e1], { subtle })).ok, true, 'the chain itself holds; only the mark is missing');
});

test('the card: what it did, how big, with whom, in which roles, how it was rated — and fit reads it', async () => {
  let prev = null;
  const facts = [
    { agentId: 'r', kind: 'task.done', runId: 'r1', model: 'claude', size: { ms: 100, steps: 10, tools: 4, findings: 5 }, roleKind: 'ic', tools: ['find', 'board'], with: ['w'], refs: ['run:r1'] },
    { agentId: 'r', kind: 'rating', runId: 'r1', rating: { by: 'judge', score: 0.8 } },
    { agentId: 'r', kind: 'task.done', runId: 'r2', model: 'opus', size: { ms: 200, steps: 30, tools: 12, findings: 20 }, roleKind: 'orchestrator', tools: ['find', 'board', 'web_search'], with: ['w', 'b'], created: ['checker'], refs: ['run:r2'] },
    { agentId: 'r', kind: 'task.failed', runId: 'r3', model: 'codex', roleKind: 'ic', error: 'exited' },
    { agentId: 'r', kind: 'rating', runId: 'r2', rating: { by: 'person', score: 1 } },
  ];
  const entries = [];
  for (const f of facts) { prev = await makeEntry(f, prev, { subtle }); entries.push(prev); }
  const card = summarize(entries);
  assert.equal(card.jobsDone, 2); assert.equal(card.jobsFailed, 1);
  assert.equal(card.size.steps, 40); assert.equal(card.size.largestSteps, 30);
  assert.deepEqual(card.tools, ['board', 'find', 'web_search']);
  assert.deepEqual(card.workedWith, ['b', 'w']); assert.deepEqual(card.created, ['checker']);
  assert.deepEqual(card.roles, { ic: 2, orchestrator: 1, manager: 0, 'manager-of-managers': 0 });
  assert.equal(card.rating.avg, 0.9); assert.equal(card.rating.count, 2);
  assert.equal(card.models[0].model, 'claude');
  assert.equal(card.head, entries.at(-1).hash);
  // Fit: the needs first, then the record.
  const type = { id: 'r', skills: ['research', 'travel'], tools: ['find', 'web_search'], grants: ['web', 'data'] };
  const job = { needs: { skills: ['research'], tools: ['find'], grants: ['web'] }, size: { steps: 20 } };
  const withRecord = fit(job, type, card);
  const fresh = fit(job, type, null);
  assert.ok(withRecord.score > fresh.score, `a proven type fits better than a fresh one (${withRecord.score} vs ${fresh.score})`);
  assert.ok(withRecord.reasons.some((x) => /2 done, 1 failed, rated 90%/.test(x)));
  const wrong = fit({ needs: { tools: ['mcp_jira__create'] } }, type, card);
  assert.ok(wrong.score < fresh.score, 'a type without the tool the job names scores below a fresh fit');
  assert.ok(wrong.reasons.some((x) => /missing tools: mcp_jira__create/.test(x)));
});

test('the runner says the fact for every finished task — size, tools, who with, the role kind — and the judge as orchestrator', async () => {
  const events = [];
  const team = normalizeTeam({ name: 't', merge: 'judge', judge: 'w', roles: [{ id: 'r', prompt: 'find', grants: ['web'] }, { id: 'w', prompt: 'write', grants: ['none'] }], budget: { tokens: 10000 } });
  await runTeam({
    team, request: 'q', appoint: () => ({ model: 'm', mode: 'model' }), emit: (type, ev) => events.push({ type, ...ev }),
    toolsFor: (role) => (role.grants.includes('web') ? { specs: [{ name: 'find', annotations: { readOnlyHint: true } }], execute: async () => 'x' } : undefined),
    callModel: async ({ role, messages, onStep }) => {
      if (role === 'r') { onStep({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'find', arguments: '{}' } }] }); onStep({ role: 'tool', tool_call_id: 'c1', content: 'x' }); return { ok: true, text: 'FINDING: a [ref: x]', usage: { input_tokens: 50, output_tokens: 10 } }; }
      return { ok: true, text: 'the answer' };
    },
  });
  const scored = events.filter((e) => e.type === 'task.scored');
  assert.equal(scored.length, 2, 'the member and the judge');
  const r = scored.find((e) => e.role === 'r');
  assert.equal(r.outcome, 'task.done'); assert.equal(r.roleKind, 'ic'); assert.equal(r.model, 'm');
  assert.deepEqual(r.tools, ['find']); assert.deepEqual(r.with, ['w']);
  assert.equal(r.size.tools, 1); assert.equal(r.size.tokens, 60); assert.equal(r.size.findings, 1);
  assert.ok(r.refs.some((x) => x.startsWith('run:')) && r.refs.some((x) => x.startsWith('thread:')));
  const j = scored.find((e) => e.role === 'w');
  assert.equal(j.roleKind, 'orchestrator');
});
