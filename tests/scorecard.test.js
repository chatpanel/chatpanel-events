// A scorecard is an immutable, attested record of what an agent did — and matching reads it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { canonical, makeEntry, verifyChain, attest, verifyAttested, summarize, fit, normalizeEngine, engineKey, normalizeScm } from '../scorecard.js';
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

test('the engine is on the fact: the card splits by it, ratings follow their task, independence needs two engines', async () => {
  assert.deepEqual(normalizeEngine('gpt-4o'), { kind: 'model', id: 'gpt-4o' });
  assert.deepEqual(normalizeEngine({ kind: 'harness', id: 'claude', model: 'opus' }), { kind: 'harness', id: 'claude', model: 'opus' });
  assert.deepEqual(normalizeEngine({ harnessId: 'codex' }), { kind: 'harness', id: 'codex' }, 'harnessId implies the kind');
  assert.equal(engineKey({ kind: 'harness', id: 'claude', model: 'opus' }), 'harness:claude/opus');
  assert.equal(engineKey({ id: 'ep1', model: 'ep1' }), 'model:ep1', 'a model equal to the id is not repeated');
  assert.equal(normalizeEngine(null), null);
  assert.deepEqual(normalizeScm({ repo: '/r', branch: 'cp/p/j', head: 'a'.repeat(40), headAfter: 'b'.repeat(40), commits: '2', merged: 'yes', extra: 1 }),
    { repo: '/r', branch: 'cp/p/j', head: 'a'.repeat(40), headAfter: 'b'.repeat(40), commits: 2 }, 'merged is only ever a boolean; unknown keys are dropped');
  let prev = null; const entries = [];
  const facts = [
    { agentId: 'r', kind: 'task.done', runId: 'r1', taskId: 't1', engine: { kind: 'harness', id: 'claude', model: 'opus' }, size: { tokens: 1000 }, scm: { repo: '/r', branch: 'cp/p/j', commits: 2, pr: 'https://x/pr/1', merged: true } },
    { agentId: 'r', kind: 'rating', runId: 'r1', taskId: 't1', rating: { by: 'person', score: 0.9 } },
    { agentId: 'r', kind: 'task.done', runId: 'r2', taskId: 't1', engine: { kind: 'model', id: 'haiku' }, size: { tokens: 200 } },
    { agentId: 'r', kind: 'rating', runId: 'r2', rating: { by: 'judge', score: 0.6 } }, // no taskId: r2 had one task, so it is that one
    { agentId: 'r', kind: 'task.failed', runId: 'r3', taskId: 't1', engine: 'haiku', error: 'x' },
    { agentId: 'r', kind: 'rating', rating: { by: 'person', score: 0.7, about: 0 } }, // by seq
    { agentId: 'r', kind: 'task.done', runId: 'r4', taskId: 't1' }, // an old fact with no engine: counted on the card, absent from byEngine
  ];
  for (const f of facts) { prev = await makeEntry(f, prev, { subtle }); entries.push(prev); }
  assert.deepEqual(entries[0].engine, { kind: 'harness', id: 'claude', model: 'opus' });
  assert.equal(entries[0].scm.merged, true);
  assert.ok((await verifyChain(entries, { subtle })).ok);
  const card = summarize(entries);
  assert.equal(card.jobsDone, 3);
  assert.deepEqual(card.byEngine.map((r) => [r.key, r.tasks, r.done, r.failed, r.failRate, r.tokens, r.rating.avg, r.rating.count]), [
    ['model:haiku', 2, 1, 1, 0.5, 100, 0.6, 1],
    ['harness:claude/opus', 1, 1, 0, 0, 1000, 0.8, 2],
  ]);
  assert.equal(card.engineIndependence, 0.8, '1 − (0.8 − 0.6)');
  assert.deepEqual(card.scm, { tasks: 1, commits: 2, prs: 1, merged: 1 });
  assert.equal(summarize(entries.slice(0, 2)).engineIndependence, null, 'one engine says nothing about independence');
});

test('the runner says task.routed for every appointment — engine, reasons, alternatives — and the fact carries engine and scm', async () => {
  const events = [];
  const team = normalizeTeam({ name: 't', merge: 'judge', judge: 'w', roles: [{ id: 'r', prompt: 'code', grants: ['none'] }, { id: 'w', prompt: 'write', grants: ['none'], model: 'pinned' }], budget: { tokens: 10000 } });
  await runTeam({
    team, request: 'q', emit: (type, ev) => events.push({ type, ...ev }),
    appoint: (role) => (role.id === 'r'
      ? { model: 'claude/opus', mode: 'model', engine: { kind: 'harness', id: 'claude', model: 'opus' }, reasons: ['nearest to strong'], alternatives: [{ kind: 'model', id: 'gpt-4o' }] }
      : { model: role.model, mode: 'model' }),
    callModel: async ({ role }) => (role === 'r'
      ? { ok: true, text: 'done', scm: { repo: '/r', remote: 'git@x:o/r.git', branch: 'cp/p/j', head: 'a1', headAfter: 'b2', commits: 1 } }
      : { ok: true, text: 'the answer' }),
  });
  const routed = events.filter((e) => e.type === 'task.routed');
  assert.deepEqual(routed.map((e) => [e.role, e.engine, e.reasons, e.exploration]), [
    ['r', { kind: 'harness', id: 'claude', model: 'opus' }, ['nearest to strong'], false],
    ['w', { kind: 'model', id: 'pinned' }, ['pinned by the role'], false],
  ]);
  assert.deepEqual(routed[0].alternatives, [{ kind: 'model', id: 'gpt-4o' }]);
  const scm = events.find((e) => e.type === 'task.scm');
  assert.equal(scm.role, 'r'); assert.equal(scm.commits, 1); assert.equal(scm.branch, 'cp/p/j');
  const scored = events.filter((e) => e.type === 'task.scored');
  const r = scored.find((e) => e.role === 'r');
  assert.deepEqual(r.engine, { kind: 'harness', id: 'claude', model: 'opus' });
  assert.equal(r.scm.headAfter, 'b2');
  const j = scored.find((e) => e.role === 'w');
  assert.equal(j.model, 'pinned'); assert.deepEqual(j.engine, { kind: 'model', id: 'pinned' }); assert.equal(j.scm, undefined);
});

test('a re-appointment is routed again with the reason, and the fact names the engine that answered', async () => {
  const events = [];
  const team = normalizeTeam({ name: 't', merge: 'first', roles: [{ id: 'r', prompt: 'x', grants: ['none'] }], budget: { tokens: 10000 } });
  const roster = [{ model: 'codex', engine: { kind: 'harness', id: 'codex' } }, { model: 'haiku', engine: { kind: 'model', id: 'haiku' } }];
  await runTeam({
    team, request: 'q', emit: (type, ev) => events.push({ type, ...ev }),
    appoint: (_role, { exclude } = {}) => roster.find((c) => !exclude?.has(c.model)) || null,
    callModel: async ({ model }) => (model === 'codex' ? { ok: false, error: 'codex exited 1' } : { ok: true, text: 'ok' }),
  });
  const routed = events.filter((e) => e.type === 'task.routed');
  assert.deepEqual(routed.map((e) => [e.attempt, e.engine.id]), [[1, 'codex'], [2, 'haiku']]);
  assert.deepEqual(routed[1].reasons, ['after codex (unavailable)']);
  assert.equal(events.find((e) => e.type === 'task.scored').engine.id, 'haiku');
});
