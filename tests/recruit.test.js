// Recruiting: the pool applies at once, an (agent, engine) pair is recruited, the evaluator
// is one optional structured call, and the decision lands as events on the project record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineRow, engineRows, needForJob, routeFor, applications, evaluatorPrompt, parseEvaluation, decide, proposalToAgent, carveBudget, recruitEvents, recruitJob, RECRUIT_SCHEMA, MIN_FIT } from '../recruit.js';
import { normalizeJob, applyAll } from '../job.js';
import { emptyProjectRecord, foldProject } from '../project.js';
import { summarize, fit } from '../scorecard.js';
import { cardOverride } from '../model-ledger.js';
import { cardOverride as fromCandidates } from '../model-candidates.js';

const candidates = [
  { id: 'small', model: 'qwen3-8b', reach: 'device', capabilities: ['tools', 'json'], quality: 0.3, latencyMs: 1500, costPer1k: 0, available: true },
  { id: 'mid', model: 'gpt-4o-mini', reach: 'any', capabilities: ['tools', 'json', 'vision'], quality: 0.6, latencyMs: 700, costPer1k: 0.0004, available: true },
  { id: 'big', model: 'claude-opus', reach: 'any', capabilities: ['tools', 'json', 'vision', 'reasoning', 'coding'], quality: 0.9, latencyMs: 900, costPer1k: 0.03, available: true },
  { id: 'claude', model: 'claude', kind: 'bridge', classUsed: 'A', reach: 'trusted', capabilities: ['tools', 'coding'], quality: 0.85, latencyMs: 3000, costPer1k: 0.02, available: true },
  { id: 'down', model: 'flaky', reach: 'any', capabilities: ['tools'], quality: 0.7, latencyMs: 500, costPer1k: 0.001, available: false },
];
const job = normalizeJob({ id: 'research', projectId: 'utah', title: 'Research the parks', brief: 'Find winter conditions and lodging for five parks.', needs: { skills: ['research'], grants: ['web', 'data'] }, budget: { tokens: 20000 } });
const codeJob = normalizeJob({ id: 'impl', projectId: 'naming', title: 'Rename the tab', brief: 'Rename Swarms to Teams in the extension.', needs: { skills: ['coding'], grants: ['shell', 'fs:write', 'scm:read'] } });
const pool = [
  { id: 'researcher', name: 'Researcher', prompt: 'Research.', skills: ['research'], grants: ['web', 'data'], engine: { kind: 'auto', policy: { prefer: 'cheapest-that-clears' } }, appliesTo: ['jobs'] },
  { id: 'analyst', name: 'Analyst', prompt: 'Analyse.', skills: ['research', 'analysis'], grants: ['web', 'data'], engine: { kind: 'auto', policy: { prefer: 'best-quality', floor: { quality: 0.5 } } }, appliesTo: ['jobs'] },
  { id: 'implementer', name: 'Implementer', prompt: 'Build.', skills: ['coding'], grants: ['shell', 'fs:write', 'scm:read'], engine: { kind: 'harness', harnessId: 'claude' }, appliesTo: ['jobs'] },
  { id: 'pinned', name: 'Pinned', prompt: 'p', skills: ['research'], grants: ['web'], engine: 'model:nowhere', appliesTo: ['jobs'] },
  { id: 'writer', name: 'Writer', prompt: 'Write.', skills: ['writing'], grants: ['none'], appliesTo: ['jobs'] },
  { id: 'notes-only', name: 'Notes', prompt: 'n', skills: ['research'], grants: ['data'], appliesTo: ['notes'] },
];

test('an engine row keys like the ledger and takes the card over the guess; cardOverride lives with the card', () => {
  assert.equal(cardOverride, fromCandidates, 'one function, re-exported from the seam it feeds');
  const card = { quality: { overall: { avg: 0.55, count: 12 }, byJobKind: { research: { avg: 0.8, count: 6 } } }, latency: { ttft: { p50: 420, n: 12 } }, cost: { perTask: 0.004, per1kIn: 0.0002, per1kOut: 0.0006 }, availability: { rate: 0.96, decliningNow: false }, capabilities: { withdrawn: ['vision'] } };
  const r = engineRow(candidates[1], { card, jobKind: 'research' });
  assert.equal(r.key, 'model:gpt-4o-mini');
  assert.equal(r.quality, 0.8, 'the job kind\'s observed rating, not the guess');
  assert.equal(r.latencyMs, 420); assert.equal(r.costPer1k, 0.0004); assert.equal(r.costPerTask, 0.004); assert.equal(r.availability, 0.96);
  assert.deepEqual(r.capabilities, ['tools', 'json'], 'a withdrawn capability is gone');
  assert.deepEqual(r.observed.sort(), ['capabilities', 'costPer1k', 'latencyMs', 'quality']);
  assert.equal(engineRow(candidates[3]).key, 'harness:claude', 'a bridge agent is a harness');
  assert.equal(engineRow({ id: 'x', model: 'claude/opus', kind: 'bridge' }).key, 'harness:claude/opus');
  assert.equal(engineRow({ engine: { kind: 'model', id: 'ep1', model: 'gpt-4o' } }).key, 'model:ep1/gpt-4o', 'a ref is taken as is');
  assert.equal(engineRow(candidates[4]).available, false);
  const rows = engineRows([...candidates, candidates[0]], { cards: { 'model:gpt-4o-mini': card }, jobKind: 'research' });
  assert.equal(rows.length, 5, 'deduplicated by key'); assert.equal(rows[1].quality, 0.8);
});

test('what a job needs of an engine: a work grant needs a harness, tools need tools, reach is the project\'s ceiling', () => {
  assert.deepEqual(needForJob(job), { capabilities: ['tools'], harness: false, reach: 'any', why: ['the job uses tools'] });
  const n = needForJob(codeJob, { reach: 'trusted' });
  assert.equal(n.harness, true); assert.equal(n.reach, 'trusted'); assert.match(n.why[1], /shell, fs:write, scm:read/);
  assert.deepEqual(needForJob({ needs: { grants: ['none'] } }).capabilities, []);
});

test('routeFor: policy orders what clears, requirements eliminate, the agent\'s own record breaks ties, a pinned engine is checked', () => {
  const rows = engineRows(candidates);
  const cheap = routeFor(pool[0], job, { rows });
  assert.equal(cheap.key, 'model:qwen3-8b', 'cheapest that clears'); assert.equal(cheap.clears, true);
  assert.match(cheap.reasons[0], /cheapest that clears/); assert.equal(cheap.alternatives.length, 3, 'the down engine is not an alternative');
  const best = routeFor(pool[1], job, { rows });
  assert.equal(best.key, 'model:claude-opus'); assert.match(best.reasons.at(-1), /3 of 5 engines clear/);
  // Reach caps: a device-only project leaves one model.
  const dev = routeFor(pool[1], job, { rows, reach: 'device' });
  assert.equal(dev.clears, false, 'the floor 0.5 rules the 8B out and nothing else is on the device'); assert.match(dev.reasons[0], /within reach device/);
  assert.equal(routeFor(pool[0], job, { rows, reach: 'device' }).key, 'model:qwen3-8b');
  // A code job needs a harness, whatever the policy prefers.
  const code = routeFor(pool[0], codeJob, { rows });
  assert.equal(code.key, 'harness:claude'); assert.match(code.reasons.join(' '), /needs a harness/);
  // The agent's own record on an engine breaks a tie between equals.
  const twins = engineRows([{ id: 'a', model: 'a', reach: 'any', capabilities: ['tools'], quality: 0.6, latencyMs: 700, costPer1k: 0.001 }, { id: 'b', model: 'b', reach: 'any', capabilities: ['tools'], quality: 0.6, latencyMs: 700, costPer1k: 0.001 }]);
  const summary = { byEngine: [{ key: 'model:b', rating: { avg: 0.9, count: 3 } }] };
  const tied = routeFor({ engine: 'auto' }, job, { rows: twins, summary });
  assert.equal(tied.key, 'model:b'); assert.match(tied.reasons.join(' '), /rated 90% on it before/);
  // Fixed engines: found and usable → pinned; not here → does not clear; down → does not clear.
  assert.equal(routeFor(pool[2], codeJob, { rows }).key, 'harness:claude');
  assert.deepEqual(routeFor(pool[2], codeJob, { rows }).reasons[0], 'pinned by the agent');
  assert.equal(routeFor(pool[3], job, { rows }).clears, false);
  assert.match(routeFor(pool[3], job, { rows }).reasons[0], /not installed or configured/);
  assert.equal(routeFor({ engine: 'model:flaky' }, job, { rows }).clears, false);
  assert.equal(routeFor({ engine: 'model:flaky' }, job, { rows: [] }).clears, true, 'no roster: a fixed spec is trusted');
  assert.equal(routeFor({ engine: 'auto' }, job, { rows: [] }).clears, false, 'no roster: auto has nothing to pick from');
  // The chat's model stands in for the Assistant.
  assert.equal(routeFor({ engine: 'assistant' }, job, { rows, chatModel: 'gpt-4o-mini' }).key, 'model:gpt-4o-mini');
  // Allow / deny lists and ceilings.
  assert.equal(routeFor({ engine: { kind: 'auto', policy: { prefer: 'best-quality', deny: ['model:claude-opus'] } } }, job, { rows }).key, 'harness:claude');
  assert.equal(routeFor({ engine: { kind: 'auto', policy: { prefer: 'best-quality', ceiling: { latencyMs: 800 } } } }, job, { rows }).key, 'model:gpt-4o-mini');
  // Exploration: one tier cheaper than the policy's pick, never a harness.
  const ex = routeFor(pool[1], job, { rows, explore: true });
  assert.equal(ex.exploration, true);
  assert.equal(ex.key, 'model:gpt-4o-mini', 'the next cheaper model under opus (the harness costs less but is never an exploration)');
  assert.equal(routeFor(pool[2], codeJob, { rows, explore: true }).exploration, false);
});

test('applications: the whole pool at once, recruitable first, the adjusted rating in the reasons', () => {
  const rows = engineRows(candidates);
  // A researcher rated 0.7 whose tasks all ran on the 0.3 engine reads better adjusted.
  const entries = [
    { seq: 0, agentId: 'researcher', kind: 'task.done', engine: { kind: 'model', id: 'qwen3-8b' }, size: { steps: 8, tokens: 4000 }, runId: 'r1', taskId: 't1', roleKind: 'ic' },
    { seq: 1, agentId: 'researcher', kind: 'rating', runId: 'r1', taskId: 't1', rating: { by: 'person', score: 0.7 } },
    { seq: 2, agentId: 'researcher', kind: 'task.done', engine: { kind: 'model', id: 'qwen3-8b' }, size: { steps: 6, tokens: 3000 }, runId: 'r2', taskId: 't1', roleKind: 'ic' },
    { seq: 3, agentId: 'researcher', kind: 'rating', runId: 'r2', taskId: 't1', rating: { by: 'person', score: 0.7 } },
  ];
  const summaries = { researcher: summarize(entries) };
  const apps = applications(job, pool, { summaries, rows });
  assert.deepEqual(apps.map((a) => a.agentId), ['researcher', 'analyst', 'implementer', 'writer', 'pinned'], 'notes-only does not apply; recruitable before not; then by fit');
  assert.equal(apps[0].engine.id, 'qwen3-8b'); assert.equal(apps[1].engine.id, 'claude-opus');
  assert.match(apps[0].reasons.join(' '), /rated 70% raw, 79% adjusted/);
  assert.equal(apps[4].engine, undefined); assert.match(apps[4].reasons.join(' '), /not installed/);
  assert.ok(apps[3].fit < MIN_FIT, 'the writer lacks the skill and the grants');
  // applyAll with a plain fit still sorts by fit alone.
  assert.deepEqual(applyAll(job, pool, fit).map((a) => a.agentId).slice(0, 2), ['researcher', 'analyst']);
  // The evaluator's prompt says who is recruitable and on what.
  const prompt = evaluatorPrompt(job, apps, pool, { rows });
  assert.match(prompt, /- researcher \(fit \d+%\)[^\n]*engine: model:qwen3-8b/);
  assert.match(prompt, /- pinned[^\n]*NOT RECRUITABLE NOW/);
  assert.match(prompt, /"pick"/);
});

test('the evaluator\'s answer is read through the schema and checked against the applications', () => {
  const apps = [{ agentId: 'researcher', engine: { kind: 'model', id: 'x' }, fit: 0.8, reasons: [] }, { agentId: 'pinned', fit: 0.7, reasons: [] }];
  assert.deepEqual(parseEvaluation('```json\n{"pick":"researcher","why":"has the skills and a record","confidence":0.8}\n```', apps), { pick: 'researcher', why: 'has the skills and a record', confidence: 0.8, proposal: null });
  const nr = parseEvaluation('{"pick":"pinned","why":"best"}', apps);
  assert.equal(nr.pick, ''); assert.match(nr.why, /no engine can run/);
  const nobody = parseEvaluation('{"pick":"","why":"nobody knows travel","proposalName":"Travel planner","proposalSkills":["travel"],"proposalGrants":["web","page"]}', apps);
  assert.equal(nobody.pick, ''); assert.deepEqual(nobody.proposal.skills, ['travel']);
  assert.deepEqual(parseEvaluation('none', apps), { pick: '', why: 'none fits', confidence: null, proposal: null });
  assert.equal(parseEvaluation('', apps), null);
  assert.equal(RECRUIT_SCHEMA.nothing.pick, '');
});

test('decide: the evaluator when it spoke, the best fit above the floor when it did not, a proposal when no one fits', () => {
  const apps = [{ agentId: 'researcher', engine: { kind: 'model', id: 'x' }, fit: 0.8, reasons: ['has every skill'] }, { agentId: 'analyst', engine: { kind: 'model', id: 'y' }, fit: 0.75, reasons: [] }, { agentId: 'pinned', fit: 0.9, reasons: ['pinned but not installed'] }];
  const d1 = decide(job, apps, { evaluation: { pick: 'analyst', why: 'the brief needs analysis' } });
  assert.equal(d1.kind, 'recruit'); assert.equal(d1.agentId, 'analyst'); assert.equal(d1.by, 'evaluator');
  const d2 = decide(job, apps);
  assert.equal(d2.agentId, 'researcher'); assert.equal(d2.by, 'fit'); assert.match(d2.why, /best fit \(80%\)/);
  const d3 = decide(job, apps, { evaluation: { pick: '', why: 'nobody knows travel', proposal: { name: 'Travel planner', skills: ['travel'], grants: ['web'] } } });
  assert.equal(d3.kind, 'none'); assert.equal(d3.proposal.name, 'Travel planner');
  const d4 = decide(job, [{ agentId: 'writer', engine: { kind: 'model', id: 'x' }, fit: 0.3, reasons: ['missing skills: research'] }]);
  assert.equal(d4.kind, 'none'); assert.match(d4.why, /30%, under the 50% floor: missing skills: research/);
  assert.deepEqual(d4.proposal, { name: 'Research the parks', purpose: 'Does jobs like "Research the parks".', skills: ['research'], grants: ['web', 'data'] });
  assert.match(decide(job, []).why, /no one in the pool applies/);
  assert.match(decide(job, [{ agentId: 'pinned', fit: 0.9, reasons: ['pinned by the agent but is not installed'] }]).why, /no engine clears/);
  // A proposal becomes a card a person approves — validated by the pool's own form, never stored here.
  const card = proposalToAgent(d3.proposal, job);
  assert.equal(card.ok, true); assert.equal(card.agent.id, 'travel-planner'); assert.deepEqual(card.agent.grants, ['web']); assert.equal(card.agent.engine.kind, 'auto'); assert.equal(card.agent.createdBy, 'evaluator'); assert.equal(card.agent.origin.jobId, 'research');
  assert.deepEqual(proposalToAgent({ name: 'X', grants: ['page', 'web'] }, job).agent.grants, ['web'], 'page is never grantable');
});

test('the budget is the job\'s, else an equal share of what the project has left; the pass lands as events the fold reads', async () => {
  const rec = emptyProjectRecord({ id: 'utah', now: 1 });
  const ev = (type, payload) => foldProject(rec, { type, at: 2, payload });
  ev('project.created', { project: { id: 'utah', title: 'Utah', goal: 'g', status: 'open', budget: { tokens: 10000, usd: 3 } } });
  ev('job.posted', { job: { id: 'research', projectId: 'utah', title: 'Research', status: 'open' } });
  ev('job.posted', { job: { id: 'write', projectId: 'utah', title: 'Write', status: 'open' } });
  ev('run.spent', { runId: 'r0', spent: { tokens: 4000, usd: 1 } });
  assert.deepEqual(carveBudget({ budget: { tokens: 500 } }, rec), { tokens: 500 }, 'the job\'s own');
  assert.deepEqual(carveBudget({}, rec), { tokens: 3000, usd: 1 }, '6000 left over two waiting jobs');
  assert.equal(carveBudget({}, null), null);

  const rows = engineRows(candidates);
  const out = await recruitJob(job, pool, { rows, record: rec, ask: async (prompt) => { assert.match(prompt, /You are the evaluator/); return '{"pick":"analyst","why":"the brief wants a comparison"}'; } });
  assert.equal(out.decision.kind, 'recruit'); assert.equal(out.decision.agentId, 'analyst');
  assert.equal(out.events.length, 2);
  assert.equal(out.events[0].job.status, 'evaluating'); assert.equal(out.events[0].job.applications.length, 5);
  assert.equal(out.events[1].job.status, 'recruited'); assert.equal(out.events[1].job.recruited.engine.id, 'claude-opus'); assert.deepEqual(out.events[1].job.recruited.budget, { tokens: 20000 });
  for (const e of out.events) ev(e.type, e);
  assert.equal(rec.jobs[0].status, 'recruited'); assert.equal(rec.jobs[0].recruited.why, 'the brief wants a comparison'); assert.equal(rec.status, 'active');

  // No model: the fit decides. A failing model: the fit decides.
  const noAsk = await recruitJob(job, pool, { rows });
  assert.equal(noAsk.decision.by, 'fit'); assert.equal(noAsk.decision.agentId, 'researcher'); assert.equal(noAsk.evaluation, null);
  const broken = await recruitJob(job, pool, { rows, ask: async () => { throw new Error('down'); } });
  assert.equal(broken.decision.by, 'fit');
  // No one fits: the job goes back to open and the proposal is a decision a person reads.
  const none = await recruitJob(normalizeJob({ id: 'legal', projectId: 'utah', title: 'Check the permits', brief: 'b', needs: { skills: ['law'] } }), pool, { rows, record: rec });
  assert.equal(none.decision.kind, 'none'); assert.match(none.decision.why, /no applicant has a skill the job names \(law\)/);
  assert.equal(none.events[1].job.status, 'open'); assert.equal(none.events[2].type, 'project.decision'); assert.equal(none.events[2].kind, 'proposal');
  assert.match(none.events[2].text, /No one in the pool fits "Check the permits"/); assert.match(none.events[2].text, /Proposed: Check the permits — skills law/);
  assert.deepEqual(recruitEvents(job, [], { kind: 'none', why: 'w' }).map((e) => e.type), ['job.updated', 'job.updated', 'project.decision']);
});
