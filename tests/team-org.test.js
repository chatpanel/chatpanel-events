// The org, derived (F8 §17): every role that can run is a card; a starter comes whole; a hole
// is a state; a team has a shape; an agent has one colour everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promoteRoles, starterTeam, missingStarters, teamHealth, teamShape, describeTeamShape, whereItWorks, rosterRows, agentKind, agentHue, agentColor, agentInitials, roleCardId, cardNumbers, upsertAgents } from '../team-org.js';
import { starterTeams, normalizeTeam } from '../team.js';
import { starterAgents, resolveTeam } from '../agent.js';
import { emptyProjectRecord, foldProject } from '../project.js';

const research = () => starterTeams().find((t) => t.name === 'research');
const feature = () => starterTeams().find((t) => t.name === 'feature');

test('saving a team with inline roles yields a card per role and a team that references them — nothing that runs is invisible', () => {
  const { team, agents } = promoteRoles(research(), [], { now: () => 1000 });
  assert.deepEqual(agents.map((a) => a.id), ['research-researcher', 'research-writer']);
  const r = agents[0];
  assert.equal(r.name, 'Researcher');
  assert.match(r.prompt, /^Research the request thoroughly/);
  assert.equal(r.purpose, 'Research the request thoroughly.');
  assert.deepEqual(r.grants, ['web', 'data']);
  assert.equal(r.engine.kind, 'auto');
  assert.equal(r.createdBy, 'team:research');
  assert.deepEqual(r.origin, { team: 'research', role: 'researcher' });
  assert.equal(r.createdAt, 1000);
  assert.equal(agents[1].engine.policy.prefer, 'best-quality', 'the writer\'s "strong" tier became its engine policy');
  // The team keeps what is the team's — ids, the judge, dependencies — and points at the cards.
  assert.deepEqual(team.roles.map((x) => x.agent), ['research-researcher', 'research-writer']);
  assert.equal(team.roles[0].prompt, '', 'the prompt moved onto the card');
  assert.equal(team.roles[0].grants, undefined, 'blank grants = the agent\'s');
  assert.equal(team.judge, 'writer');
  // And it runs exactly as the inline team did, filled from those cards.
  const resolved = resolveTeam(team, agents);
  assert.match(resolved.roles[0].prompt, /^Research the request thoroughly/);
  assert.deepEqual(resolved.roles[0].grants, ['web', 'data']);
  assert.equal(resolved.roles[1].prefer, 'strong');
});

test('promotion is idempotent and keeps a card\'s createdAt; a role that already names an agent is untouched', () => {
  const first = promoteRoles(research(), [], { now: () => 1 });
  const again = promoteRoles(first.team, first.agents, { now: () => 2 });
  assert.deepEqual(again.team, first.team);
  assert.equal(again.agents.length, 0, 'nothing new to write: every role already names a card');
  // Editing the same inline team a second time updates the card, keeping its birth date.
  const edited = { ...research(), roles: research().roles.map((r) => (r.id === 'writer' ? { ...r, prompt: 'Write it shorter.' } : r)) };
  const second = promoteRoles(edited, first.agents, { now: () => 2 });
  assert.equal(second.agents.find((a) => a.id === 'research-writer').prompt, 'Write it shorter.');
  assert.equal(second.agents.find((a) => a.id === 'research-writer').createdAt, 1);
  const f = promoteRoles(feature(), [], { now: () => 3 });
  assert.equal(f.agents.length, 0);
  assert.deepEqual(f.team.roles.map((r) => r.agent), ['architect', 'implementer', 'reviewer', 'tester', 'scribe']);
});

test('a starter team brings the agents it stands on — never half-installed', () => {
  const s = starterTeam('feature', []);
  assert.deepEqual(s.agents.map((a) => a.id).sort(), ['architect', 'implementer', 'reviewer', 'scribe', 'tester']);
  assert.equal(teamHealth(s.team, s.agents).ready, true);
  const partial = starterTeam('feature', starterAgents().filter((a) => a.id !== 'tester'));
  assert.deepEqual(partial.agents.map((a) => a.id), ['tester'], 'only what the pool lacks');
  const r = starterTeam('research', []);
  assert.deepEqual(r.agents.map((a) => a.id), ['research-researcher', 'research-writer']);
  assert.equal(starterTeam('nope'), null);
});

test('a hole is a state a client draws, with the fix; resolveTeam still refuses beneath', () => {
  const pool = starterAgents().filter((a) => a.id !== 'tester');
  const h = teamHealth(feature(), pool);
  assert.equal(h.ready, false);
  assert.deepEqual(h.holes, [{ role: 'tester', agent: 'tester', fix: 'add-builtin' }]);
  assert.equal(h.reason, 'a role names an agent not in the pool: tester');
  assert.deepEqual(missingStarters(feature(), pool).map((a) => a.id), ['tester']);
  assert.throws(() => resolveTeam(feature(), pool), /NO_AGENT|not in the pool/);
  const custom = normalizeTeam({ name: 't', roles: [{ id: 'a', agent: 'someone-i-deleted' }], budget: { ms: 1000 } });
  assert.deepEqual(teamHealth(custom, []).holes[0].fix, 'pick');
  const off = teamHealth(feature(), starterAgents().map((a) => (a.id === 'scribe' ? { ...a, enabled: false } : a)));
  assert.deepEqual(off.disabled, [{ role: 'scribe', agent: 'scribe' }]);
  assert.equal(off.reason, 'scribe is off');
  assert.equal(teamHealth(feature(), starterAgents()).ready, true);
  assert.deepEqual(teamHealth(feature(), starterAgents()).inline, []);
  const r = teamHealth(research(), []);
  assert.deepEqual(r.inline, ['researcher', 'writer'], 'roles not yet cards are named, so a client can offer to promote them');
  assert.equal(r.ready, true, 'but an inline role is not a hole');
  assert.equal(teamHealth({ ...feature(), enabled: false }, starterAgents()).reason, 'the team is off');
});

test('a team has a shape: columns by dependency, the judge last, and a kind', () => {
  const f = teamShape(feature());
  assert.equal(f.kind, 'sequence');
  assert.deepEqual(f.columns.map((c) => c.roles.map((r) => r.id)), [['implementer'], ['reviewer', 'tester'], ['scribe']], 'the architect judges, so the merge is its task and it is not a column');
  assert.equal(f.columns[1].parallel, true);
  assert.deepEqual(f.judge, { id: 'architect', name: 'architect', agent: 'architect' });
  assert.equal(f.lands, 'person');
  assert.equal(describeTeamShape(f), '5 roles in 3 steps, architect judges');
  const r = teamShape(research());
  assert.equal(r.kind, 'quorum');
  assert.deepEqual(r.columns.map((c) => c.roles.map((x) => x.id)), [['researcher']]);
  assert.equal(r.judge.id, 'writer');
  assert.equal(describeTeamShape(r), '2 roles in parallel, writer judges');
  const rv = teamShape(starterTeams().find((t) => t.name === 'review'));
  assert.equal(rv.kind, 'quorum');
  assert.equal(rv.judge, null);
  assert.equal(describeTeamShape(rv), '2 roles in parallel, reconciled');
  assert.equal(teamShape({ roles: [{ id: 'one' }] }).kind, 'solo');
  assert.equal(teamShape({ roles: [{ id: 'a' }, { id: 'b', mode: 'team' }] }).kind, 'hierarchy');
  // A cycle does not hang: the back edge is dropped, every role is drawn once.
  const cyc = teamShape({ roles: [{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }] });
  assert.deepEqual(cyc.columns.flatMap((c) => c.roles.map((r) => r.id)).sort(), ['a', 'b']);
});

test('where an agent works: the teams that name it and the jobs it holds', () => {
  const rec = emptyProjectRecord({ id: 'orcl', now: 1 });
  foldProject(rec, { type: 'project.created', at: 1, payload: { project: { id: 'orcl', title: 'ORCL — hold or sell?' } } });
  foldProject(rec, { type: 'job.posted', at: 2, payload: { job: { id: 'gather', status: 'open' } } });
  foldProject(rec, { type: 'job.updated', at: 3, payload: { job: { id: 'gather', status: 'in-progress', recruited: { agentId: 'research-researcher' } } } });
  const w = whereItWorks('research-researcher', { teams: [promoteRoles(research()).team], projects: [rec] });
  assert.deepEqual(w.teams, [{ team: 'research', role: 'researcher' }]);
  assert.deepEqual(w.jobs, [{ project: 'orcl', title: 'ORCL — hold or sell?', job: 'gather', status: 'in-progress' }]);
  assert.deepEqual(whereItWorks('nobody', { teams: [], projects: [rec] }), { teams: [], jobs: [] });
});

test('the roster: proposed first, then holes, then the pool by name — with counts for the filter bar', () => {
  const pool = [...starterAgents().filter((a) => a.id !== 'tester'), { id: 'my-analyst', name: 'Analyst', prompt: 'x', createdBy: 'person' }, { id: 'checker-2', name: 'Checker 2', prompt: 'x', createdBy: 'evaluator' }];
  const { rows, counts } = rosterRows(pool, { teams: [feature()], proposals: [{ agent: { id: 'budget-checker', name: 'Budget checker', prompt: 'x' }, from: { project: 'orcl' } }] });
  assert.equal(rows[0].kind, 'proposed');
  assert.equal(rows[0].from.project, 'orcl');
  assert.equal(rows[1].kind, 'missing');
  assert.deepEqual(rows[1].namedBy, ['feature']);
  assert.equal(rows[1].fix, 'add-builtin');
  assert.equal(counts.builtin, 7, 'the eight starters minus the tester');
  assert.equal(counts.mine, 1);
  assert.equal(counts.created, 1);
  assert.equal(counts.proposed, 1);
  assert.equal(counts.missing, 1);
  assert.equal(counts.onTeam, 5, 'architect, implementer, reviewer, scribe — and the missing tester counts as on a team');
  assert.equal(agentKind({ id: 'research-researcher', createdBy: 'team:research' }), 'team-role');
  assert.equal(agentKind({ id: 'assistant' }), 'builtin');
});

test('an agent has one colour everywhere — deterministic, the org well apart, initials readable', () => {
  assert.equal(agentHue('research-researcher'), agentHue('research-researcher'));
  assert.notEqual(agentHue('architect'), agentHue('implementer'));
  assert.ok(agentHue('anything-at-all') >= 0 && agentHue('anything-at-all') < 360);
  assert.equal(roleCardId('Research', 'Researcher'), 'research-researcher');
  assert.match(agentColor('architect'), /^hsl\(212 /);
  assert.match(agentColor('architect', { dark: true }), /62%\)$/);
  assert.equal(agentInitials('Budget checker'), 'Bc');
  assert.equal(agentInitials({ id: 'researcher' }), 'Re');
  assert.equal(agentInitials(''), '?');
});

test('the four card numbers are the same four everywhere, and say "—" rather than 0 for nothing', () => {
  assert.deepEqual(cardNumbers(null).map((t) => t.value), ['—', '—', '—', '—']);
  const t = cardNumbers({ entries: 14, jobsDone: 12, jobsFailed: 2, rating: { avg: 0.84, count: 5 }, byEngine: [{}, {}, {}], engineIndependence: 0.9, scm: { commits: 3 } }, { attested: { ok: true } });
  assert.deepEqual(t.map((x) => x.value), ['14', '84%', '3', '✓']);
  assert.equal(t[0].detail, '12 done · 2 failed');
  assert.equal(t[3].detail, '14 entries, attested · 3 commits');
});

test('upsert keeps the pool\'s order, replaces by id, appends the rest', () => {
  const pool = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }];
  assert.deepEqual(upsertAgents(pool, [{ id: 'b', v: 2 }, { id: 'c', v: 1 }]), [{ id: 'a', v: 1 }, { id: 'b', v: 2 }, { id: 'c', v: 1 }]);
  assert.deepEqual(upsertAgents(undefined, []), []);
});
