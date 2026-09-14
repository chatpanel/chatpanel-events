// The executive loop: goal → jobs → recruit → run → review → follow-ups → done, every step
// an event on the project record, resumable from it, asking only where the gate says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProject, parseJobs, parseReview, teamForRound, jobResults, roundBudget, roundJobs, jobsPrompt, reviewPrompt, PROJECT_JOBS_SCHEMA, PROJECT_REVIEW_SCHEMA } from '../project-run.js';
import { normalizeProject, foldProject, emptyProjectRecord } from '../project.js';
import { describeSchema } from '../structured.js';

const project = () => normalizeProject({ id: 'orcl', title: 'ORCL hold or sell', goal: 'Say whether to hold or sell ORCL, with the numbers.', doneWhen: 'A hold/sell call with price, earnings and the user\'s own position cited.', budget: { tokens: 100000, ms: 600000 } });
const pool = [
  { id: 'researcher', name: 'Researcher', purpose: 'Finds facts.', skills: ['research', 'finance'], grants: ['web', 'data'], prompt: 'Research.', appliesTo: ['jobs'] },
  { id: 'writer', name: 'Writer', purpose: 'Writes.', skills: ['writing'], grants: ['none'], prompt: 'Write.', appliesTo: ['jobs'] },
];
const firstJobs = { jobs: [
  { id: 'facts', title: 'Gather the numbers', brief: 'Price, earnings, guidance, the user\'s position.', skills: ['finance'], grants: ['web', 'data'], why: 'the call needs them' },
  { id: 'memo', title: 'Write the call', brief: 'Hold or sell, from the facts.', skills: ['writing'], grants: [], dependsOn: ['facts'] },
], note: 'two jobs: the facts, then the call' };

/** A pool that recruits by a skill name, like recruit.js would. */
const recruiter = (calls = []) => async (job, opts) => {
  calls.push({ jobId: job.id, create: opts?.create || null });
  const a = pool.find((x) => (job.needs?.skills || []).some((s) => x.skills.includes(s)));
  if (!a) return { why: 'no skill matches', proposal: { name: `${job.title} agent`, purpose: 'Does it.', skills: job.needs?.skills || [], grants: job.needs?.grants || ['none'], id: 'made' }, events: [{ type: 'job.updated', at: 1, job: { id: job.id, status: 'open' }, by: 'fit' }] };
  return { role: { id: a.id, agent: a.id, name: a.name, prompt: `${a.prompt}\n\nJob: ${job.title}\n\n${job.brief}`, grants: job.needs?.grants?.length ? job.needs.grants : a.grants }, agentId: a.id, engine: { kind: 'model', id: 'mid' }, why: 'skill match', fit: 0.8, events: [{ type: 'job.updated', at: 1, job: { id: job.id, status: 'recruited', recruited: { agentId: a.id, by: 'fit', at: 1 } }, by: 'fit' }] };
};
/** A runner that answers every task and reports a spend, like runTeam's result. */
const runner = (runs = []) => async ({ team, request, round }) => {
  runs.push({ team, request, round });
  const id = `run_${round}`;
  return { runId: id, status: 'completed', startedAt: 10, endedAt: 1010, usage: { cap: team.budget, spent: { tokens: 3000 * team.roles.length, calls: team.roles.length, usd: 0, ms: 1000 } },
    tasks: team.roles.map((r) => ({ id: `t_${r.id}`, role: r.id, status: 'ok', text: `${r.id} did it`, findings: [{ kind: 'claim', text: `${r.id}: found`, refs: ['web:1'] }] })) };
};

test('the shapes: the executive is asked through the shared structured layer, and its answers are coerced into jobs on the project', () => {
  const p = project();
  assert.match(jobsPrompt(p, { pool }), /Goal: Say whether/);
  assert.match(jobsPrompt(p, { pool }), /- researcher: Researcher — Finds facts\. \(skills: research, finance\)/);
  assert.ok(jobsPrompt(p, { pool }).includes(describeSchema(PROJECT_JOBS_SCHEMA)), 'the prompt block is the schema\'s own');
  const jobs = parseJobs(JSON.stringify(firstJobs), p, { now: 5 });
  assert.deepEqual(jobs.map((j) => [j.id, j.status, j.dependsOn, j.needs.grants, j.postedBy]), [['facts', 'open', [], ['web', 'data'], 'executive'], ['memo', 'open', ['facts'], [], 'executive']]);
  assert.equal(jobs[0].origin.why, 'the call needs them');
  // Ids the executive reused are suffixed; a made-up grant is dropped; a dangling dependency too.
  const more = parseJobs({ jobs: [{ id: 'facts', title: 'again', brief: 'b', grants: ['laser'], dependsOn: ['nope'] }] }, p, { existing: jobs });
  assert.deepEqual([more[0].id, more[0].needs.grants, more[0].dependsOn], ['facts-2', [], []]);
  const rec = emptyProjectRecord({ id: 'orcl' });
  foldProject(rec, { type: 'project.created', at: 1, payload: { project: p } });
  for (const j of jobs) foldProject(rec, { type: 'job.posted', at: 2, payload: { job: j } });
  assert.match(reviewPrompt(p, rec, { round: 1 }), /- facts \[open\]: Gather the numbers/);
  assert.ok(reviewPrompt(p, rec).includes(describeSchema(PROJECT_REVIEW_SCHEMA)));
  const rv = parseReview('{"done": false, "report": "so far", "followUps": [{"id": "check", "title": "Check", "brief": "c", "skills": ["finance"]}], "why": "missing the position"}', p, { existing: jobs });
  assert.equal(rv.done, false);
  assert.deepEqual(rv.followUps.map((j) => j.id), ['check']);
  assert.equal(parseReview('none', p)?.done, false);
});

test('a round is one team: a role per recruited job (the job id), the job\'s dependencies, a fixed plan, the members side by side', () => {
  const p = project();
  const jobs = parseJobs(firstJobs, p);
  const team = teamForRound(p, [{ job: jobs[0], role: { id: 'researcher', agent: 'researcher', prompt: 'r', grants: ['web'] } }, { job: jobs[1], role: { id: 'writer', agent: 'writer', prompt: 'w', grants: ['none'] } }], { budget: { tokens: 1000 }, round: 2 });
  assert.equal(team.name, 'orcl');
  assert.deepEqual(team.roles.map((r) => [r.id, r.agent, r.dependsOn]), [['facts', 'researcher', []], ['memo', 'writer', ['facts']]]);
  assert.deepEqual([team.plan, team.merge], ['fixed', 'concat']);
  const run = { runId: 'run_9', tasks: [{ id: 't_facts', role: 'facts', status: 'ok', text: 'numbers', findings: [{ kind: 'claim', text: 'price 144', refs: ['web:x'] }] }, { id: 't_memo', role: 'memo', status: 'failed', error: 'no model' }] };
  const res = jobResults(run, jobs, { now: 7 });
  assert.deepEqual(res.map((r) => [r.id, r.status]), [['facts', 'done'], ['memo', 'failed']]);
  assert.match(res[0].result.text, /- price 144 \(web:x\)/);
  assert.deepEqual(res[0].result.refs, ['run:run_9', 'web:x']);
  assert.equal(res[1].result.text, 'no model');
  // The round's budget: what is left of the project's, capped by the jobs' own shares.
  const rec = emptyProjectRecord({ id: 'orcl' });
  foldProject(rec, { type: 'project.created', at: 1, payload: { project: p } });
  foldProject(rec, { type: 'run.spent', at: 2, payload: { runId: 'r0', spent: { tokens: 40000 } } });
  assert.deepEqual(roundBudget(p, rec, jobs), { tokens: 60000, ms: 600000 });
  assert.deepEqual(roundBudget(p, rec, [{ ...jobs[0], budget: { tokens: 5000 } }]), { tokens: 5000, ms: 600000 });
  // A round is the ready CLOSURE: a chain runs as one team; a job behind a failed one waits.
  assert.deepEqual(roundJobs([{ id: 'a', status: 'open', dependsOn: [] }, { id: 'b', status: 'open', dependsOn: ['a'] }, { id: 'c', status: 'open', dependsOn: ['x'] }, { id: 'x', status: 'failed' }, { id: 'd', status: 'open', dependsOn: ['y'] }, { id: 'y', status: 'done' }]).map((j) => j.id), ['a', 'd', 'b']);
});

test('the loop, end to end: jobs posted, recruited, run as a team, folded back, reviewed, follow-ups posted, closed on the person\'s say — every step on the record', async () => {
  const events = []; const asks = []; const runs = []; const recruits = [];
  const plans = [];
  const plan = async (prompt, schema) => {
    plans.push(schema.name);
    if (schema.name === 'project_jobs') return firstJobs;
    // Round 1: not done, one follow-up. Round 2: done.
    return plans.filter((x) => x === 'project_review').length === 1
      ? { done: false, report: 'Facts and a first call; the position is unverified.', followUps: [{ id: 'position', title: 'Verify the position', brief: 'From the user\'s history.', skills: ['finance'], grants: ['data'] }], why: 'the position is missing' }
      : { done: true, report: 'Hold. Price 144, earnings beat, 783 shares at ~142.', followUps: [], why: 'every part of done-when is cited' };
  };
  const ask = async (q) => { asks.push(q); return { text: q.options[0], by: 'person' }; };
  // The stakeholder keeps scope (gate: a person decides recruiting); closing is theirs by default.
  const out = await runProject({ project: project(), pool, plan, recruit: recruiter(recruits), runJobs: runner(runs), ask, gate: { human: { recruit: true } }, emit: (type, ev) => events.push({ type, ...ev }), now: (() => { let t = 100; return () => (t += 1); })() });
  assert.equal(out.status, 'done');
  assert.equal(out.rounds, 2);
  assert.deepEqual(out.jobs.map((j) => [j.id, j.status, j.agentId]), [['facts', 'done', 'researcher'], ['memo', 'done', 'writer'], ['position', 'done', 'researcher']]);
  assert.match(out.report, /^Hold\./);
  assert.equal(out.spend.tokens, 9000, 'two runs\' spend added up (2 + 1 members)');
  // Round 1 ran BOTH jobs as one team — memo after facts, by its dependency — round 2 the follow-up.
  assert.deepEqual(runs.map((r) => [r.round, r.team.roles.map((x) => `${x.id}:${x.agent}${x.dependsOn?.length ? `<${x.dependsOn}` : ''}`)]), [[1, ['facts:researcher', 'memo:writer<facts']], [2, ['position:researcher']]]);
  assert.equal(runs[0].team.name, 'orcl');
  assert.match(runs[0].request, /Done when:/);
  // What the person was asked, in order: post the first jobs, post the follow-up, close.
  assert.deepEqual(asks.map((a) => [a.type, a.options[0]]), [['direction', 'Post them'], ['direction', 'Post them'], ['permission', 'Close as done']]);
  // The record, from the events alone — what both clients draw.
  const rec = emptyProjectRecord({ id: 'orcl' });
  for (const e of events) { const { type, at, projectId: _p, ...payload } = e; foldProject(rec, { type, at, payload }); }
  assert.equal(rec.status, 'done');
  assert.deepEqual(rec.jobs.map((j) => [j.id, j.status, j.runId]), [['facts', 'done', 'run_1'], ['memo', 'done', 'run_1'], ['position', 'done', 'run_2']]);
  assert.deepEqual(rec.runs.map((r) => r.runId), ['run_1', 'run_2']);
  assert.match(rec.report.text, /^Hold\./);
  assert.deepEqual(rec.decisions.map((d) => d.kind), ['status', 'plan', 'ask', 'answer', 'recruit', 'recruit', 'run', 'review', 'ask', 'answer', 'recruit', 'run', 'review', 'ask', 'answer', 'status'], 'the executive\'s every step is a decision a person reads');
  assert.match(rec.decisions.find((d) => d.kind === 'plan').text, /two jobs: the facts, then the call/);
  assert.match(rec.decisions.filter((d) => d.kind === 'review')[0].text, /does not hold yet — the position is missing; 1 follow-up/);
  assert.ok(rec.jobs[0].result.refs.includes('run:run_1'));
});

test('the gate: with recruit and writeBack allowed the executive posts and closes on its own; nothing is asked', async () => {
  const asks = [];
  const plan = async (_p, schema) => schema.name === 'project_jobs' ? firstJobs : { done: true, report: 'done', followUps: [], why: 'ok' };
  const out = await runProject({ project: project(), pool, plan, recruit: recruiter(), runJobs: runner(), ask: async (q) => { asks.push(q); return null; }, gate: { human: { recruit: false, writeBack: false } }, emit: () => {} });
  assert.equal(out.status, 'done');
  assert.deepEqual(asks, []);
  assert.equal(out.record.decisions.at(-1).by, 'gate');
});

test('nobody fits: the agent the job describes is PROPOSED, created only on the person\'s say, and then takes the job', async () => {
  const recruits = []; const asks = []; const events = [];
  const plan = async (_p, schema) => schema.name === 'project_jobs' ? { jobs: [{ id: 'tax', title: 'Tax lots', brief: 'Which lots to sell.', skills: ['tax'], grants: ['data'] }] } : { done: true, report: 'r', followUps: [], why: '' };
  // The recruiter: nobody fits until the card is created.
  const recruit = async (job, opts) => {
    recruits.push(opts?.create ? `create:${opts.create.name}` : 'pass');
    if (!opts?.create) return { why: 'no skill matches', proposal: { name: 'Tax agent', purpose: 'Tax lots.', skills: ['tax'], grants: ['data'] }, events: [] };
    return { role: { id: 'tax-agent', agent: 'tax-agent', prompt: 'p', grants: ['data'] }, agentId: 'tax-agent', why: 'created for this job', events: [] };
  };
  const out = await runProject({ project: project(), pool, plan, recruit, runJobs: runner(), ask: async (q) => { asks.push(q); return { text: q.options[0], by: 'person' }; }, gate: { human: { recruit: false, writeBack: false } }, emit: (t, e) => events.push({ type: t, ...e }) });
  assert.equal(out.status, 'done');
  assert.deepEqual(recruits, ['pass', 'create:Tax agent']);
  assert.deepEqual(asks.map((a) => [a.type, a.options]), [['permission', ['Create it', 'Skip']]]);
  const prop = events.find((e) => e.type === 'project.decision' && e.kind === 'proposal');
  assert.equal(prop.proposal.agent.name, 'Tax agent', 'the card rides on the decision for a client to draw');
  assert.equal(out.jobs[0].agentId, 'tax-agent');
  // Declined: the job fails, nothing is created, the loop says so.
  const declined = await runProject({ project: project(), pool, plan, recruit, runJobs: runner(), ask: async () => ({ text: 'Skip', by: 'person' }), gate: { human: { recruit: false } }, emit: () => {} });
  assert.equal(declined.status, 'failed');
  assert.equal(declined.jobs[0].status, 'failed');
});

test('a resume from the record: done jobs are not redone; one left in-progress by a dead loop is opened, recruited and run again', async () => {
  const runs = [];
  const plan = async (_p, schema) => schema.name === 'project_jobs' ? firstJobs : { done: true, report: 'done', followUps: [], why: '' };
  // A record the last loop left: facts done, memo in-progress when the process died.
  const p = project();
  const rec = emptyProjectRecord({ id: 'orcl' });
  const jobs = parseJobs(firstJobs, p);
  foldProject(rec, { type: 'project.created', at: 1, payload: { project: p } });
  for (const j of jobs) foldProject(rec, { type: 'job.posted', at: 2, payload: { job: j } });
  foldProject(rec, { type: 'job.updated', at: 3, payload: { job: { id: 'facts', status: 'done', result: { text: 'numbers', by: 'facts', at: 3 }, runId: 'run_old' } } });
  foldProject(rec, { type: 'job.updated', at: 3, payload: { job: { id: 'memo', status: 'in-progress' } } });
  const out = await runProject({ project: p, record: rec, pool, plan, recruit: recruiter(), runJobs: runner(runs), ask: async (q) => ({ text: q.options[0], by: 'person' }), gate: { human: { recruit: false, writeBack: false } }, emit: () => {} });
  assert.equal(out.status, 'done');
  assert.deepEqual(runs.map((r) => r.team.roles.map((x) => x.id)), [['memo']], 'only memo ran again');
  assert.equal(out.record.decisions.find((d) => d.kind === 'resume')?.text, 'resumed: memo back to open (left in-progress by the last loop)');
  assert.equal(out.jobs.find((j) => j.id === 'facts').runId, 'run_old');
});

test('over budget: the loop asks before spending more; "stop" ends with the report so far; a stop signal ends a round', async () => {
  const asks = [];
  const small = normalizeProject({ ...project(), budget: { tokens: 100 } });
  const plan = async (_p, schema) => schema.name === 'project_jobs' ? firstJobs : { done: false, report: 'partial', followUps: [{ id: 'more', title: 'More', brief: 'm', skills: ['finance'] }], why: 'not yet' };
  const out = await runProject({ project: small, pool, plan, recruit: recruiter(), runJobs: runner(), ask: async (q) => { asks.push(q.type); return { text: q.type === 'budget' ? 'Stop here' : q.options[0], by: 'person' }; }, gate: { human: { recruit: false } }, emit: () => {} });
  assert.equal(out.status, 'over-budget');
  assert.ok(asks.includes('budget'), 'the person was asked for budget');
  assert.equal(out.report, 'partial', 'the report so far stands');
  // With no one to ask, an ask is a no: the loop stops where it would have asked.
  const alone = await runProject({ project: project(), pool, plan: async () => firstJobs, recruit: recruiter(), runJobs: runner(), gate: { human: { recruit: true } }, emit: () => {} });
  assert.equal(alone.status, 'stopped');
  assert.equal(alone.jobs.length, 0, 'nothing posted without the stakeholder');
});
