// An agent is the role promoted out of the team: one card, many teams; the engine is a field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAgent, normalizeAgent, defineAgent, assistantAgent, engineOf, resolveTeam, starterAgents, agentFromForm, poolFor, describeAgent, AgentError } from '../agent.js';
import { normalizeEngineSpec, engineRef, engineKeyOf, describeEngine, tierOf, normalizePolicy, validateEngineSpec } from '../engine.js';
import { normalizeTeam, validateTeam, starterTeams, scmAllows, grantAllows, TeamError, teamFromForm, GRANT_RE } from '../team.js';
import { engineKey } from '../scorecard.js';
import { dryRunTeam } from '../team-run.js';

test('an engine spec reads four ways, and the record shape keys the same as the scorecard', () => {
  assert.deepEqual(normalizeEngineSpec('assistant'), { kind: 'assistant' });
  assert.deepEqual(normalizeEngineSpec(undefined), { kind: 'auto', policy: { prefer: 'balanced' } });
  assert.deepEqual(normalizeEngineSpec('harness:claude'), { kind: 'harness', harnessId: 'claude' });
  assert.deepEqual(normalizeEngineSpec('gpt-4o'), { kind: 'model', model: 'gpt-4o' });
  assert.deepEqual(normalizeEngineSpec({ kind: 'model', providerId: 'ep1', model: 'gpt-4o' }), { kind: 'model', providerId: 'ep1', model: 'gpt-4o' });
  assert.deepEqual(normalizeEngineSpec({ harnessId: 'codex', model: 'o3' }), { kind: 'harness', harnessId: 'codex', model: 'o3' }, 'kind inferred from the field');
  assert.deepEqual(normalizeEngineSpec({ kind: 'auto', policy: { prefer: 'fastest', ceiling: { costPerTask: 0.02 }, floor: { quality: 2 }, allow: ['harness:claude', { kind: 'model', model: 'x' }] } }),
    { kind: 'auto', policy: { prefer: 'fastest', floor: { quality: 1 }, ceiling: { costPerTask: 0.02 }, allow: ['harness:claude', 'model:x'] } });
  assert.equal(normalizePolicy({ prefer: 'made-up' }).prefer, 'balanced');
  // The record's shape — what ran — keys identically to scorecard.js's engineKey.
  assert.deepEqual(engineRef({ kind: 'model', providerId: 'ep1', model: 'gpt-4o' }), { kind: 'model', id: 'ep1', model: 'gpt-4o' });
  assert.equal(engineKeyOf({ kind: 'model', providerId: 'ep1', model: 'gpt-4o' }), engineKey({ kind: 'model', id: 'ep1', model: 'gpt-4o' }));
  assert.equal(engineKeyOf('harness:claude'), 'harness:claude');
  assert.equal(engineRef('auto'), null, 'auto ran nothing yet');
  assert.equal(describeEngine({ kind: 'model', providerId: 'ep1', model: 'gpt-4o' }, { providerName: () => 'OpenRouter' }), 'gpt-4o at OpenRouter');
  assert.equal(describeEngine('auto'), 'auto · balanced');
  assert.equal(tierOf({ kind: 'auto', policy: { prefer: 'best-quality' } }), 'strong');
  assert.deepEqual(validateEngineSpec({ kind: 'harness' }, 'e'), ['e.harnessId: which harness']);
  assert.deepEqual(validateEngineSpec({ kind: 'nope' }, 'e'), ['e.kind: one of model, harness, auto, assistant']);
});

test('an agent validates like a team: id, prompt, grants (never page), engine; trust is derived', () => {
  assert.equal(validateAgent({ id: 'x' }).ok, false, 'no prompt');
  assert.match(validateAgent({ id: 'x', prompt: 'p', grants: ['page'] }).errors[0], /page/);
  assert.match(validateAgent({ id: 'x', prompt: 'p', engine: { kind: 'harness' } }).errors[0], /harnessId/);
  assert.match(validateAgent({ id: 'x', prompt: 'p', egress: 'raw' }).errors[0], /egress/);
  assert.throws(() => normalizeAgent({ id: 'r', prompt: 'p', grants: ['shell', 'page'] }), /page/, 'refused, not silently dropped');
  const a = normalizeAgent({ id: 'reviewer', prompt: 'Review.', skills: 'review, graphify', grants: ['shell', 'scm:read', 'scm:read'], engine: 'harness:claude', builtin: true });
  assert.deepEqual(a.skills, ['review', 'graphify']);
  assert.deepEqual(a.grants, ['shell', 'scm:read'], 'deduplicated');
  assert.deepEqual(a.engine, { kind: 'harness', harnessId: 'claude' });
  assert.equal(a.builtin, undefined, 'a stored builtin does not survive');
  assert.equal(normalizeAgent({ id: 'r', prompt: 'p' }, { builtin: true }).builtin, true);
  assert.equal(a.memoryScope, 'agent:reviewer');
  assert.deepEqual(a.appliesTo, ['jobs']);
  assert.throws(() => defineAgent({ id: 'bad id', prompt: 'p' }), (e) => e instanceof AgentError && e.code === 'INVALID');
  assert.equal(describeAgent(a), 'reviewer — claude · tools: shell, scm:read · skills: review, graphify');
});

test('the Assistant is an agent whose engine is the chat’s model', () => {
  const asst = assistantAgent();
  assert.equal(asst.builtin, true); assert.deepEqual(asst.engine, { kind: 'assistant' });
  assert.deepEqual(engineOf(asst, { chatModel: { providerId: 'ep1', model: 'gpt-4o' } }), { kind: 'model', providerId: 'ep1', model: 'gpt-4o' });
  assert.deepEqual(engineOf(asst, { chatModel: 'harness:claude' }), { kind: 'harness', harnessId: 'claude' });
  assert.equal(engineOf(asst).kind, 'auto', 'no chat → the recruiter picks');
  // A legacy role reads as what it pins, or auto at its tier.
  assert.deepEqual(engineOf({ id: 'w', prompt: 'p', model: 'opus' }), { kind: 'model', model: 'opus' });
  assert.deepEqual(engineOf({ id: 'w', prompt: 'p', prefer: 'strong' }), { kind: 'auto', policy: { prefer: 'best-quality' } });
});

test('a team role may stand for an agent; resolveTeam fills it from the pool and the runner sees a normal role', () => {
  const pool = [
    { id: 'researcher', name: 'Researcher', prompt: 'Research it.', grants: ['web', 'data', 'mcp'], skills: ['search'], engine: { kind: 'auto', policy: { prefer: 'cheapest-that-clears' } } },
    { id: 'coder', name: 'Coder', prompt: 'Code it.', grants: ['shell', 'fs:write', 'scm:push'], engine: { kind: 'harness', harnessId: 'claude' }, workdir: '~/projects/x' },
  ];
  const team = { name: 't', roles: [
    { id: 'r', agent: 'researcher', prompt: 'focus on 2026', grants: ['web', 'mcp:notion', 'history'] },
    { id: 'c', agent: 'coder' },
    { id: 'w', prompt: 'Write.', prefer: 'strong', grants: ['none'] },
  ], budget: { tokens: 1000 } };
  assert.equal(validateTeam(team).ok, true, 'an agent role needs no prompt');
  const stored = normalizeTeam(team);
  assert.equal(stored.roles[1].grants, undefined, 'no list means the agent’s — not stored as none');
  assert.deepEqual(stored.roles[0].grants, ['web', 'mcp:notion', 'history']);
  const t = resolveTeam(stored, pool);
  const [r, c, w] = t.roles;
  assert.equal(r.name, 'Researcher');
  assert.equal(r.prompt, 'Research it.\n\nIn this team: focus on 2026');
  assert.deepEqual(r.grants, ['web', 'mcp:notion'], 'narrowed to what the agent holds; history was not the agent’s to lend');
  assert.equal(r.prefer, 'cheap'); assert.equal(r.engine.kind, 'auto'); assert.deepEqual(r.skills, ['search']);
  assert.equal(c.model, 'claude', 'a harness engine is the target the host calls'); assert.equal(c.workdir, '~/projects/x');
  assert.deepEqual(c.grants, ['shell', 'fs:write', 'scm:push']);
  assert.equal(w.prompt, 'Write.', 'a plain role is untouched');
  assert.equal(t.agents.r.id, 'researcher');
  // The host maps engines to its own target ids.
  const t2 = resolveTeam(stored, pool, { targetFor: (e) => (e.kind === 'harness' ? `bridge:${e.harnessId}` : null) });
  assert.equal(t2.roles[1].model, 'bridge:claude');
  // The resolved team is a team the runner accepts as is, with what the pool gave it.
  const dry = dryRunTeam(t, 'go');
  assert.equal(dry.roles[1].model, 'claude');
  assert.equal(normalizeTeam(t).roles[1].workdir, '~/projects/x', 'the runner’s own normalize keeps it');
  // A hole is refused.
  assert.throws(() => resolveTeam({ ...team, roles: [{ id: 'x', agent: 'ghost' }] }, pool), (e) => e instanceof TeamError && e.code === 'NO_AGENT');
  assert.throws(() => resolveTeam({ ...team, roles: [{ id: 'x', agent: 'coder' }] }, [{ ...pool[1], enabled: false }]), /disabled/);
  // The Assistant needs no pool entry.
  assert.equal(resolveTeam({ name: 'a', roles: [{ id: 'a', agent: 'assistant' }], budget: { tokens: 1 } }, [], { chatModel: 'gpt-4o' }).roles[0].model, 'gpt-4o');
});

test('the work grants: shell, fs:write and the scm ladder; a chat role may not hold page', () => {
  for (const g of ['shell', 'fs:write', 'scm:read', 'scm:push', 'scm:pr', 'scm:merge']) assert.ok(GRANT_RE.test(g), g);
  assert.equal(GRANT_RE.test('scm:admin'), false);
  assert.equal(scmAllows(['scm:pr'], 'push'), true, 'a PR needs its branch pushed');
  assert.equal(scmAllows(['scm:pr'], 'merge'), false, 'merge is the Gate’s');
  assert.equal(scmAllows(['scm:push'], 'read'), true);
  assert.equal(scmAllows(['shell'], 'read'), false);
  assert.equal(scmAllows(['none', 'scm:merge'], 'read'), false, 'none wins');
  assert.equal(grantAllows(['shell'], 'shell'), true);
  assert.equal(grantAllows(['shell'], 'page'), false);
});

test('the standing org: the executive and the seven starter agents the four engineering starter teams stand on', () => {
  const agents = starterAgents();
  assert.deepEqual(agents.map((a) => a.id), ['executive', 'architect', 'implementer', 'reviewer', 'tester', 'librarian', 'scribe', 'release']);
  for (const a of agents) assert.equal(validateAgent(a).ok, true, a.id);
  assert.equal(scmAllows(agents.find((a) => a.id === 'implementer').grants, 'merge'), false, 'no Implementer merges');
  assert.equal(agents.find((a) => a.id === 'reviewer').grants.includes('fs:write'), false, 'the Reviewer is read-only');
  const teams = starterTeams();
  assert.deepEqual(teams.map((t) => t.name), ['research', 'review', 'feature', 'fix', 'docs', 'release']);
  for (const t of teams) {
    assert.equal(validateTeam(t).ok, true, t.name);
    const resolved = resolveTeam(t, agents);
    for (const r of resolved.roles) { assert.ok(r.prompt, `${t.name}/${r.id} has a prompt`); assert.ok(Array.isArray(r.grants)); }
  }
  const feature = resolveTeam(teams.find((t) => t.name === 'feature'), agents);
  assert.equal(feature.judge, 'architect');
  assert.equal(feature.roles.find((r) => r.id === 'implementer').engine.kind, 'harness');
  assert.deepEqual(feature.roles.find((r) => r.id === 'scribe').dependsOn, ['reviewer', 'tester']);
  agents[0].prompt = 'changed';
  assert.notEqual(starterAgents()[0].prompt, 'changed', 'a starter is a template');
});

test('the editor’s forms: an agent from text fields, a team role that names an agent', () => {
  assert.match(agentFromForm({ name: 'x', prompt: 'p', grants: 'web, page' }).errors[0], /page/);
  const r = agentFromForm({ name: 'Fact Checker', prompt: 'Check facts.', skills: 'review', grants: 'web, data', engine: { kind: 'auto', prefer: 'best-quality' }, appliesTo: ['jobs', 'notes'] });
  assert.equal(r.ok, true);
  assert.equal(r.agent.id, 'fact-checker');
  assert.deepEqual(r.agent.grants, ['web', 'data']);
  assert.deepEqual(r.agent.engine, { kind: 'auto', policy: { prefer: 'best-quality' } });
  assert.equal(agentFromForm({ name: 'x' }).ok, false);
  const t = teamFromForm({ name: 'Check', roles: [{ id: 'c', agent: 'fact-checker', grants: '' }], budget: { tokens: 100 } });
  assert.equal(t.ok, true); assert.equal(t.team.roles[0].agent, 'fact-checker'); assert.equal(t.team.roles[0].grants, undefined);
  assert.deepEqual(poolFor([{ id: 'a', appliesTo: ['notes'] }, { id: 'b' }, { id: 'c', enabled: false }]).map((a) => a.id), ['b']);
});

test('the team tool fills a team from the pool on the way to a run, and says so when an agent is missing', async () => {
  const { teamToolProvider, TEAM_TOOL_NAME } = await import('../team-tool.js');
  const pool = [{ id: 'researcher', prompt: 'Research.', grants: ['web'] }];
  const team = { name: 'r', roles: [{ id: 'r', agent: 'researcher' }], budget: { tokens: 100 } };
  let ranWith = null;
  const p = teamToolProvider({ teams: [team], appoint: () => ({ model: 'm', mode: 'model' }), resolve: (t) => resolveTeam(t, pool), run: async ({ team: t }) => { ranWith = t; return { runId: 'x', status: 'completed', board: [], tasks: [] }; } });
  const dry = JSON.parse((await p.execute(TEAM_TOOL_NAME, { action: 'dry_run', name: 'r' })).content?.[0]?.text || (await p.execute(TEAM_TOOL_NAME, { action: 'dry_run', name: 'r' })));
  assert.equal(dry.ok, true);
  await p.execute(TEAM_TOOL_NAME, { action: 'run', name: 'r', request: 'go' });
  assert.equal(ranWith.roles[0].prompt, 'Research.');
  const p2 = teamToolProvider({ teams: [team], appoint: () => ({ model: 'm', mode: 'model' }), resolve: (t) => resolveTeam(t, []) });
  const out = await p2.execute(TEAM_TOOL_NAME, { action: 'dry_run', name: 'r' });
  assert.match(JSON.stringify(out), /not in the pool/);
});
