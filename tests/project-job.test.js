// A project is the page a goal starts on; a job is a posting the pool applies to; the gate
// says how far a team may go without a person.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateProject, normalizeProject, projectFromForm, canTransition as canProject, emptyProjectRecord, foldProject, projectProgress } from '../project.js';
import { normalizeJob, canTransition as canJob, applyAll, jobToRole, readyJobs, jobFromForm } from '../job.js';
import { normalizeGate, effectiveGate, gateAllows, DEFAULT_GATE } from '../gate.js';
import { fit } from '../scorecard.js';

test('a project needs a goal and a budget; the form shapes it; the status machine holds', () => {
  assert.equal(validateProject({ id: 'utah', title: 'Utah trip' }).ok, false, 'no goal, no budget');
  const p = normalizeProject({ id: 'utah', title: 'Utah trip', goal: 'A 5-day plan under $4,000', doneWhen: 'a day-by-day itinerary and a line-item budget the stakeholder approved', budget: { tokens: 100000 }, repos: ['hub'] });
  assert.equal(p.status, 'draft'); assert.equal(p.stakeholder, 'person'); assert.deepEqual(p.repos, ['hub']);
  const f = projectFromForm({ id: 'Utah Trip!', title: 'Utah', goal: 'g', budget: { tokens: '5000', ms: '' }, repos: 'hub, site' });
  assert.equal(f.ok, true); assert.equal(f.project.id, 'utah-trip'); assert.deepEqual(f.project.budget, { tokens: 5000 }); assert.deepEqual(f.project.repos, ['hub', 'site']);
  assert.equal(canProject('draft', 'open'), true); assert.equal(canProject('draft', 'done'), false); assert.equal(canProject('active', 'done'), true);
  assert.equal(validateProject({ ...p, gate: { autonomy: 'fly' } }).ok, false, 'a bad gate is refused');
});

test('the project record folds jobs, runs and spend; progress reads it', () => {
  const rec = emptyProjectRecord({ id: 'utah', now: 1 });
  const ev = (type, payload, at = 2) => foldProject(rec, { type, at, payload });
  ev('project.created', { project: { id: 'utah', title: 'Utah', goal: 'g', status: 'draft', budget: { tokens: 1000 } } });
  ev('job.posted', { job: { id: 'j1', projectId: 'utah', title: 'Research', status: 'open' } });
  ev('job.posted', { job: { id: 'j1', projectId: 'utah', title: 'Research (dup)', status: 'open' } });
  assert.equal(rec.jobs.length, 1, 'a job posts once'); assert.equal(rec.status, 'open');
  ev('job.updated', { job: { id: 'j1', status: 'recruited', recruited: { agentId: 'researcher' } } });
  assert.equal(rec.status, 'active'); assert.equal(rec.jobs[0].recruited.agentId, 'researcher');
  ev('run.linked', { runId: 'r1', jobId: 'j1' });
  ev('run.spent', { runId: 'r1', spent: { tokens: 300 } });
  ev('run.spent', { runId: 'r1', spent: { tokens: 700 } });
  assert.equal(rec.spend.tokens, 700, 'a run reports its running total; the project sums the latest of each');
  ev('run.spent', { runId: 'r2', spent: { tokens: 100 } });
  assert.equal(rec.spend.tokens, 800);
  ev('job.updated', { job: { id: 'j1', status: 'done' } });
  ev('project.report', { text: 'the plan', by: 'planner' });
  const pr = projectProgress(rec);
  assert.equal(pr.done, 1); assert.equal(pr.open, 0); assert.equal(pr.budgetUsed, 0.8); assert.equal(pr.hasReport, true);
});

test('a job: needs are grants the runner knows; applications are computed for the whole pool at once; the pick becomes a role; dependencies gate readiness', () => {
  assert.throws(() => normalizeJob({ id: 'research', projectId: 'utah', title: 't', brief: 'b', needs: { grants: ['web', 'page'] } }), /not grantable: page/, 'a tab is one person\'s; a job may not ask for it');
  const job = normalizeJob({ id: 'research', projectId: 'utah', title: 'Research the parks', brief: 'Find winter conditions and lodging.', needs: { skills: 'research, travel', tools: ['find'], grants: ['web', 'data'] }, budget: { tokens: 20000 }, dependsOn: ['research'] });
  assert.deepEqual(job.needs.grants, ['web', 'data']);
  assert.deepEqual(job.dependsOn, [], 'a job does not depend on itself');
  assert.equal(canJob('open', 'in-progress'), false); assert.equal(canJob('recruited', 'in-progress'), true); assert.equal(canJob('done', 'open'), false);
  const pool = [
    { id: 'researcher', name: 'Researcher', prompt: 'Research.', skills: ['research', 'travel'], tools: ['find'], grants: ['web', 'data'], appliesTo: ['jobs'] },
    { id: 'writer', name: 'Writer', prompt: 'Write.', skills: ['writing'], tools: [], grants: ['none'], appliesTo: ['jobs'] },
    { id: 'scribe', name: 'Scribe', prompt: 'Notes.', skills: ['research'], grants: ['data'], appliesTo: ['notes'] },
  ];
  const apps = applyAll(job, pool, fit, { cards: { researcher: { entries: 3, jobsDone: 3, jobsFailed: 0, rating: { avg: 0.9 }, roles: { orchestrator: 0, manager: 0, 'manager-of-managers': 0 }, size: { largestSteps: 20 } } } });
  assert.deepEqual(apps.map((a) => a.agentId), ['researcher', 'writer'], 'only agents that apply to jobs, best first');
  assert.ok(apps[0].fit > apps[1].fit);
  assert.ok(apps[1].reasons.some((r) => /missing skills/.test(r)));
  const role = jobToRole(job, pool[0]);
  assert.equal(role.agent, 'researcher'); assert.match(role.prompt, /Job: Research the parks/); assert.deepEqual(role.grants, ['web', 'data']);
  const jobs = [{ id: 'a', status: 'done' }, { id: 'b', status: 'open', dependsOn: ['a'] }, { id: 'c', status: 'open', dependsOn: ['b'] }, { id: 'd', status: 'recruited' }];
  assert.deepEqual(readyJobs(jobs).map((j) => j.id), ['b']);
  const f = jobFromForm({ id: 'Write Up', projectId: 'utah', title: 'Write it up', brief: 'b', needs: { grants: 'none' }, budget: { tokens: '' } });
  assert.equal(f.ok, true); assert.equal(f.job.id, 'write-up'); assert.equal(f.job.budget, undefined);
});

test('the gate: ChatPanel\'s own is the strictest; a project loosens it over the org\'s; the loop asks where it says no', () => {
  assert.equal(gateAllows(DEFAULT_GATE, 'push', { branch: 'cp/utah/research' }).allowed, true);
  assert.equal(gateAllows(DEFAULT_GATE, 'push', { branch: 'main' }).allowed, false);
  assert.equal(gateAllows(DEFAULT_GATE, 'merge').allowed, false);
  assert.equal(gateAllows(DEFAULT_GATE, 'recruit').allowed, true, 'recruiting within the budget needs no person');
  assert.equal(gateAllows(DEFAULT_GATE, 'newAgent').allowed, false);
  const org = normalizeGate({ autonomy: 'merge', human: { merge: false } }, { partial: true });
  assert.equal(gateAllows(org, 'merge', { branch: 'feature/x' }).allowed, true);
  assert.equal(gateAllows(org, 'merge', { branch: 'main' }).allowed, false, 'protected stays protected');
  const eff = effectiveGate(org, { human: { budgetRaise: false } });
  assert.equal(eff.autonomy, 'merge'); assert.equal(eff.human.budgetRaise, false); assert.equal(eff.human.newTool, true);
  assert.throws(() => normalizeGate({ human: { fly: true } }), /unknown flag/);
});
