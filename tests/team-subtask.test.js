import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeRequest, subtaskFromRequest, takeUp, jobFromSubtask, extendDependents, taskTree, holdsGrants, MAX_SUBTASKS } from '../team-subtask.js';
import { runTeam } from '../team-run.js';
import { normalizeTeam } from '../team.js';
import { runFromEvents } from '../team-record.js';
import { workLogFor, workLogEvidence } from '../team-worklog.js';
import { parsePlan } from '../team-plan.js';
import { grantsNeededFor } from '../tool-need.js';
import { createAnswerBox } from '../board-tool.js';

const team = normalizeTeam({
  name: 'research',
  roles: [
    { id: 'researcher', prompt: 'Find facts.', grants: ['web', 'history'], skills: ['research', 'finance'] },
    { id: 'writer', prompt: 'Write it up.', grants: ['none'], skills: ['writing'], dependsOn: ['researcher'] },
  ],
  merge: 'concat', budget: { tokens: 100000 },
});

test('a request is checked, becomes a sub-task under its parent, and is offered to the members that fit', () => {
  assert.equal(normalizeRequest({}).ok, false);
  const r = normalizeRequest({ title: 'Check the valuation', brief: 'Verify the $4.2B figure against a second source.', skills: 'finance', grants: ['web', 'bogus', 'none'], wait: 'false' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.request.needs, { skills: ['finance'], tools: [], grants: ['web'] });
  assert.equal(r.request.wait, false);
  const parent = { id: 't_writer', title: 'Write it up', dependsOn: ['t_researcher'], depth: 0 };
  const sub = subtaskFromRequest(r.request, parent, { id: 't_writer-s1', by: 'writer', now: 5 });
  assert.equal(sub.parent, 't_writer');
  assert.equal(sub.depth, 1);
  assert.equal(sub.role, null);
  assert.deepEqual(sub.dependsOn, ['t_researcher'], 'it may read what the parent read');
  assert.match(sub.prompt, /requested by writer while working on "Write it up"/);
  // Take-up: the requester is excluded; the researcher holds web and has finance.
  const pick = takeUp(sub, team.roles);
  assert.equal(pick.roleId, 'researcher');
  assert.ok(pick.fit >= 0.5);
  // A grant the request names is a hard need: nobody holding `none` takes a web job.
  assert.equal(holdsGrants({ grants: ['none'] }, ['web']), false);
  assert.equal(holdsGrants({ grants: ['mcp'] }, ['mcp:jira']), true);
  const none = takeUp({ ...sub, needs: { skills: [], tools: [], grants: ['shell'] } }, team.roles);
  assert.equal(none.roleId, null);
  assert.match(none.why, /researcher lacks shell/);
  // A skill the request names must be held by at least one skill of the taker.
  const noSkill = takeUp({ ...sub, needs: { skills: ['legal'], tools: [], grants: [] } }, team.roles);
  assert.equal(noSkill.roleId, null);
  assert.match(noSkill.why, /has none of: legal/);
  // A recipe cannot take an arbitrary task.
  assert.equal(takeUp(sub, [{ id: 'r', mode: 'recipe', grants: ['web'], skills: ['finance'] }]).roleId, null);
  // The posting the pool applies to is a valid job with the run standing in for a project.
  const job = jobFromSubtask(sub, { runId: 'run_1' });
  assert.equal(job.projectId, 'run_1');
  assert.equal(job.postedBy, 'writer');
  assert.deepEqual(job.needs.grants, ['web']);
  assert.equal(job.origin.kind, 'subtask');
  // Whoever depended on the requester reads the queued sub-task too.
  const tasks = [{ id: 'a', dependsOn: [] }, { id: 'b', dependsOn: ['a'] }, { id: 'c', dependsOn: ['b'] }, { id: 'a-s1', dependsOn: [], parent: 'a' }];
  assert.deepEqual(extendDependents(tasks, 'a', 'a-s1'), ['b']);
  assert.deepEqual(tasks[1].dependsOn, ['a', 'a-s1']);
  const tree = taskTree(tasks);
  assert.deepEqual(tree.map((n) => [n.task.id, n.children.map((c) => c.task.id)]), [['a', ['a-s1']], ['b', []], ['c', []]]);
});

const scripted = (answers) => {
  const calls = [];
  const callModel = async (req) => {
    calls.push(req);
    const a = answers[req.taskId] ?? answers[req.role] ?? '';
    if (typeof a === 'function') return a(req);
    return { ok: true, text: a, usage: { total_tokens: 100 } };
  };
  return { calls, callModel };
};

test('a member requests a sub-task and waits: the member that fits takes it, its findings come back in the tool result, and the record folds the tree', async () => {
  const events = [];
  let t = 0;
  const { calls, callModel } = scripted({
    t_researcher: '```json\n{"findings":[{"kind":"claim","text":"Valued at $4.2B","refs":["url:a"]}]}\n```',
    t_writer: async (req) => {
      const out = JSON.parse(await req.tools.execute('board', { action: 'request', title: 'Check the valuation', brief: 'Verify the $4.2B figure against a second source.', skills: ['finance'], grants: ['web'] }));
      assert.equal(out.takenBy, 'researcher');
      assert.equal(out.status, 'ok');
      assert.equal(out.findings[0].text, 'Confirmed: $4.2B (Reuters)');
      return { ok: true, text: `The company is valued at $4.2B — ${out.findings[0].text}.`, usage: { total_tokens: 100 } };
    },
    't_writer-s1': '```json\n{"findings":[{"kind":"claim","text":"Confirmed: $4.2B (Reuters)","refs":["url:b"]}]}\n```',
  });
  const res = await runTeam({ team, request: 'value the company', callModel, appoint: () => ({ model: 'm' }), now: () => (t += 10), newId: () => 'run_1', emit: (type, p) => events.push([type, p]) });
  assert.equal(res.status, 'completed');
  assert.deepEqual(calls.map((c) => c.taskId), ['t_researcher', 't_writer', 't_writer-s1'], 'the sub-task ran inside the writer\'s turn');
  assert.equal(calls[2].role, 'researcher');
  assert.match(calls[2].prompt, /requested by writer/);
  assert.match(calls[2].prompt, /Valued at \$4\.2B/, 'the sub-task read what its parent read');
  const sub = res.tasks.find((x) => x.id === 't_writer-s1');
  assert.equal(sub.status, 'ok');
  assert.equal(sub.parent, 't_writer');
  const kinds = events.map((e) => e[0]);
  for (const k of ['task.requested', 'task.taken', 'task.started', 'task.done']) assert.ok(kinds.includes(k), k);
  const taken = events.find((e) => e[0] === 'task.taken')[1];
  assert.equal(taken.role, 'researcher');
  assert.equal(taken.by, 'fit');
  // The board: the request in the writer's thread, the sub-task's own thread under it, held by the researcher.
  const th = res.threads.threads.find((x) => x.taskId === 't_writer-s1');
  assert.equal(th.parent, 't_writer');
  assert.equal(th.holder, 'researcher');
  assert.equal(th.status, 'resolved');
  assert.ok(res.threads.posts.some((p) => p.kind === 'request' && p.by === 'writer'), 'the request is a post in the requester\'s thread');
  assert.ok(res.threads.posts.some((p) => p.threadId === th.id && p.kind === 'decision' && /researcher took: Check the valuation/.test(p.text)));
  // The record, folded from the events alone, holds the same tree.
  const run = runFromEvents('run_1', events.map(([type, payload]) => ({ type, at: payload.at, payload })));
  const rt = run.tasks.find((x) => x.id === 't_writer-s1');
  assert.equal(rt.parent, 't_writer');
  assert.equal(rt.role, 'researcher');
  assert.equal(rt.status, 'ok');
  assert.equal(rt.takenBy.by, 'fit');
  assert.equal(run.plan.tasks.length, 3);
  assert.ok(run.threads.threads.find((x) => x.taskId === 't_writer-s1').holder === 'researcher');
  const log = workLogFor(run, 't_writer');
  assert.ok(log.some((e) => e.kind === 'post' && e.post.kind === 'request'));
  assert.equal(workLogEvidence(log).requests, 1);
  // The scorecard fact for the sub-task says it was a sub-task and who asked.
  const scored = events.filter((e) => e[0] === 'task.scored').map((e) => e[1]).find((s) => s.taskId === 't_writer-s1');
  assert.equal(scored.parent, 't_writer');
  assert.equal(scored.requestedBy, 'writer');
});

test('nobody in the run fits: without a pool the sub-task is unassigned; with one it is posted, recruited, and the recruit joins the run', async () => {
  const request = async (req) => JSON.parse(await req.tools.execute('board', { action: 'request', title: 'Run the tests', brief: 'Run npm test in the repo and report failures.', grants: ['shell'] }));
  // No recruit hook: told so, recorded unassigned, the run is partial.
  {
    const events = [];
    const { callModel } = scripted({
      t_researcher: 'facts',
      t_writer: async (req) => { const out = await request(req); assert.equal(out.takenBy, null); assert.match(out.why, /no pool to recruit from/); return { ok: true, text: 'wrote it without tests', usage: { total_tokens: 10 } }; },
    });
    const res = await runTeam({ team, request: 'ship it', callModel, appoint: () => ({ model: 'm' }), emit: (type, p) => events.push([type, p]) });
    assert.equal(res.status, 'partial');
    const sub = res.tasks.find((x) => x.id === 't_writer-s1');
    assert.equal(sub.status, 'unassigned');
    assert.ok(events.some((e) => e[0] === 'task.unassigned'));
    assert.equal(res.threads.threads.find((x) => x.taskId === 't_writer-s1').status, 'failed');
    const run = runFromEvents('r', events.map(([type, payload]) => ({ type, at: payload.at, payload })));
    assert.equal(run.tasks.find((x) => x.id === 't_writer-s1').status, 'unassigned');
  }
  // A pool: the job is posted, the host recruits, the recruit becomes a role and runs the sub-task.
  {
    const events = [];
    const jobs = [];
    const { calls, callModel } = scripted({
      t_researcher: 'facts',
      t_writer: async (req) => { const out = await request(req); assert.equal(out.takenBy, 'implementer'); assert.equal(out.status, 'ok'); return { ok: true, text: `tests: ${out.text}`, usage: { total_tokens: 10 } }; },
      't_writer-s1': 'all 12 tests pass',
    });
    const recruit = async (job, ctx) => { jobs.push([job, ctx]); return { role: { id: 'implementer', agent: 'implementer', name: 'Implementer', prompt: 'You run code.', grants: ['shell', 'scm:read'], model: 'claude/opus' }, agentId: 'implementer', engine: { kind: 'harness', id: 'claude', model: 'opus' }, why: 'the only harness with shell' }; };
    const res = await runTeam({ team, request: 'ship it', callModel, appoint: (r) => ({ model: r.model || 'm' }), recruit, emit: (type, p) => events.push([type, p]) });
    assert.equal(res.status, 'completed');
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0][0].id, 't_writer-s1');
    assert.deepEqual(jobs[0][0].needs.grants, ['shell']);
    assert.equal(jobs[0][1].requestedBy, 'writer');
    assert.equal(calls.find((c) => c.taskId === 't_writer-s1').model, 'claude/opus', 'the recruit ran on its own engine');
    assert.equal(calls.find((c) => c.taskId === 't_writer-s1').system, 'You run code.');
    const kinds = events.map((e) => e[0]);
    assert.ok(kinds.includes('task.posted'));
    assert.ok(kinds.includes('run.role-added'));
    const taken = events.find((e) => e[0] === 'task.taken')[1];
    assert.equal(taken.by, 'recruit');
    assert.equal(taken.agentId, 'implementer');
    const run = runFromEvents('r', events.map(([type, payload]) => ({ type, at: payload.at, payload })));
    assert.ok(run.roles.includes('implementer'));
    assert.equal(run.jobs.length, 1);
    assert.equal(run.jobs[0].status, 'done', 'the job\'s outcome is the sub-task\'s');
    assert.equal(run.jobs[0].recruited.agentId, 'implementer');
    assert.equal(run.recruited[0].jobId, 't_writer-s1');
  }
});

test('nobody applies: an agent is proposed to the person; approved, the host creates it and it takes the job — nothing is created without a decision', async () => {
  const request = async (req) => JSON.parse(await req.tools.execute('board', { action: 'request', title: 'Translate to German', brief: 'Translate the summary.', skills: ['german'], grants: ['web'] }));
  const answers = createAnswerBox();
  const events = [];
  const recruitCalls = [];
  const recruit = async (job, ctx) => {
    recruitCalls.push(ctx);
    if (ctx.create) return { role: { id: 'translator', agent: 'translator', name: ctx.create.name, prompt: 'Translate.', grants: ['web'] }, agentId: 'translator', why: 'created' };
    return { why: 'no applicant has german' };
  };
  const { calls, callModel } = scripted({
    t_researcher: 'facts',
    t_writer: async (req) => { const out = await request(req); assert.equal(out.takenBy, 'translator'); return { ok: true, text: `done: ${out.text}`, usage: { total_tokens: 10 } }; },
    't_writer-s1': 'Zusammenfassung…',
  });
  const emit = (type, p) => {
    events.push([type, p]);
    // The person, from either client, approves the proposal when the runner asks.
    if (type === 'run.waiting' && p.askType === 'permission') setTimeout(() => answers.answer(p.threadId, { text: 'Create it', by: 'person' }), 5);
  };
  const res = await runTeam({ team, request: 'summarise in German', callModel, appoint: () => ({ model: 'm' }), recruit, answers, askTimeoutMs: 2000, emit });
  assert.equal(res.status, 'completed');
  assert.deepEqual(recruitCalls.map((c) => !!c.create), [false, true], 'recruited once without, once with the approved card');
  assert.equal(recruitCalls[1].create.name, 'Translate to German');
  assert.deepEqual(recruitCalls[1].create.skills, ['german']);
  assert.deepEqual(recruitCalls[1].create.grants, ['web']);
  assert.equal(calls.find((c) => c.taskId === 't_writer-s1').role, 'translator');
  const proposed = events.find((e) => e[0] === 'task.proposed')[1];
  assert.equal(proposed.agent.name, 'Translate to German');
  const pth = res.threads.threads.find((x) => x.id === proposed.threadId);
  assert.equal(pth.kind, 'proposal');
  const post = res.threads.posts.find((p) => p.id === proposed.postId);
  assert.equal(post.status, 'approved');
  assert.equal(post.proposal.kind, 'agent');
  assert.equal(events.find((e) => e[0] === 'task.taken')[1].by, 'created');
  // Nobody answers: the proposal stays on the board, the sub-task is unassigned, the run goes on.
  {
    const quiet = [];
    const { callModel: cm } = scripted({ t_researcher: 'facts', t_writer: async (req) => { const out = await request(req); assert.equal(out.takenBy, null); return { ok: true, text: 'english only', usage: { total_tokens: 10 } }; } });
    const r2 = await runTeam({ team, request: 'summarise in German', callModel: cm, appoint: () => ({ model: 'm' }), recruit: async () => null, answers: createAnswerBox(), askTimeoutMs: 20, emit: (type, p) => quiet.push(type) });
    assert.equal(r2.status, 'partial');
    assert.ok(quiet.includes('task.proposed'));
    assert.ok(quiet.includes('task.unassigned'));
    assert.equal(r2.threads.posts.find((p) => p.proposal?.kind === 'agent').status, 'proposed');
  }
});

test('a request without wait is queued: it runs after the requester, and whoever depended on the requester reads it; the run caps sub-tasks and depth', async () => {
  const three = normalizeTeam({ name: 'chain', roles: [{ id: 'a', prompt: 'A', grants: ['web'], skills: ['x'] }, { id: 'b', prompt: 'B', grants: ['none'] }, { id: 'c', prompt: 'C', grants: ['none'], dependsOn: ['b'] }], merge: 'concat', budget: { tokens: 100000 } });
  const order = [];
  const { callModel } = scripted({
    t_a: 'a done',
    t_b: async (req) => { order.push('b'); const out = JSON.parse(await req.tools.execute('board', { action: 'request', title: 'look this up', brief: 'find x', skills: ['x'], wait: false })); assert.equal(out.queued, true); assert.match(out.hint, /t_c will read it too/); return { ok: true, text: 'b done', usage: { total_tokens: 10 } }; },
    't_b-s1': async () => { order.push('b-s1'); return { ok: true, text: 'looked up', usage: { total_tokens: 10 } }; },
    t_c: async (req) => { order.push('c'); assert.match(req.prompt, /looked up/, 'c read the sub-task\'s thread'); return { ok: true, text: 'c done', usage: { total_tokens: 10 } }; },
  });
  const res = await runTeam({ team: three, request: 'go', callModel, appoint: () => ({ model: 'm' }) });
  assert.equal(res.status, 'completed');
  assert.deepEqual(order, ['b', 'b-s1', 'c']);
  assert.deepEqual(res.plan.tasks.find((x) => x.id === 't_c').dependsOn, ['t_b', 't_b-s1']);
  // Caps: a sub-task cannot delegate past MAX_DEPTH, and a run stops at MAX_SUBTASKS.
  let deepest = '';
  const { callModel: cm } = scripted({
    t_a: 'a',
    t_b: async (req) => { const out = JSON.parse(await req.tools.execute('board', { action: 'request', title: 'one', brief: 'one', skills: ['x'] })); return { ok: true, text: `b: ${out.status}`, usage: { total_tokens: 10 } }; },
    't_b-s1': async (req) => { const out = JSON.parse(await req.tools.execute('board', { action: 'request', title: 'two', brief: 'two' })); return { ok: true, text: `s1: ${out.takenBy || out.error}`, usage: { total_tokens: 10 } }; },
    't_b-s1-s2': async (req) => { const out = JSON.parse(await req.tools.execute('board', { action: 'request', title: 'three', brief: 'three' })); deepest = out.error || ''; return { ok: true, text: 's2', usage: { total_tokens: 10 } }; },
    t_c: 'c',
  });
  const r2 = await runTeam({ team: three, request: 'go', callModel: cm, appoint: () => ({ model: 'm' }) });
  assert.equal(r2.status, 'completed');
  assert.match(deepest, /cannot delegate further/);
  const { callModel: many } = scripted({
    t_a: 'a', t_c: 'c',
    t_b: async (req) => { let last = null; for (let i = 0; i < MAX_SUBTASKS + 1; i++) last = JSON.parse(await req.tools.execute('board', { action: 'request', title: `n${i}`, brief: 'n', skills: ['x'] })); return { ok: true, text: last.error || 'no cap', usage: { total_tokens: 10 } }; },
  });
  const r3 = await runTeam({ team: three, request: 'go', callModel: many, appoint: () => ({ model: 'm' }) });
  assert.match(r3.tasks.find((x) => x.id === 't_b').text, /limit of 8 sub-tasks/);
});

test('the tool guard: a member that answers from memory while holding a tool the task calls for is nudged once, on the same model', async () => {
  assert.deepEqual(grantsNeededFor('What is the latest price of ACME stock?', { held: ['web', 'history'] }), ['web']);
  assert.deepEqual(grantsNeededFor('What did we decide in the standup about pricing?', { held: ['web', 'history'] }), ['web', 'history']);
  assert.deepEqual(grantsNeededFor('Write a limerick about ducks', { held: ['web'] }), []);
  assert.deepEqual(grantsNeededFor('latest news', { held: ['none'] }), [], 'nothing held, nothing to nudge');
  const solo = normalizeTeam({ name: 'solo', roles: [{ id: 'r', prompt: 'Research.', grants: ['web'] }], merge: 'first', budget: { tokens: 100000 } });
  const events = [];
  let n = 0;
  const callModel = async (req) => {
    n += 1;
    if (n === 1) return { ok: true, text: 'From memory: about $10.', usage: { total_tokens: 10 } };
    assert.equal(req.model, 'm', 'the nudge continues on the same model');
    assert.match(req.messages.at(-1).content, /without using web/);
    assert.equal(req.messages.filter((m) => m.role === 'assistant').length, 1, 'the transcript continues');
    return { ok: true, text: 'Looked it up: $12 today.', usage: { total_tokens: 10 }, transcript: [...req.messages, { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'find', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c1', content: '$12' }, { role: 'assistant', content: 'Looked it up: $12 today.' }] };
  };
  const res = await runTeam({ team: solo, request: 'latest price of ACME', callModel, appoint: () => ({ model: 'm' }), emit: (type, p) => events.push([type, p]) });
  assert.equal(res.status, 'completed');
  assert.equal(n, 2);
  assert.match(res.proposal.text, /\$12 today/);
  assert.equal(events.filter((e) => e[0] === 'task.nudged').length, 1);
  assert.ok(res.threads.posts.some((p) => p.by === 'runner' && /answered without using web/.test(p.text)));
  // A second answer without tools stands — one nudge, never a loop.
  let k = 0;
  const stubborn = async () => { k += 1; return { ok: true, text: 'still from memory', usage: { total_tokens: 10 } }; };
  const r2 = await runTeam({ team: solo, request: 'latest price of ACME', callModel: stubborn, appoint: () => ({ model: 'm' }) });
  assert.equal(k, 2);
  assert.equal(r2.status, 'completed');
  // No nudge for a harness (its tools are its own) or when the task names no source.
  let h = 0;
  const r3 = await runTeam({ team: solo, request: 'latest price of ACME', callModel: async () => { h += 1; return { ok: true, text: 'x', usage: { total_tokens: 1 } }; }, appoint: () => ({ model: 'claude', engine: { kind: 'harness', id: 'claude' } }) });
  assert.equal(h, 1);
  assert.equal(r3.status, 'completed');
  // The planner's proposal counts too: a task told it needs `history` is held to it.
  const planned = normalizeTeam({ name: 'p', plan: 'planner', roles: [{ id: 'r', prompt: 'Research.', grants: ['web', 'history'] }], merge: 'first', budget: { tokens: 100000 } });
  const seen = [];
  let c = 0;
  const r4 = await runTeam({
    team: planned, request: 'write a poem',
    callModel: async (req) => {
      c += 1;
      if (req.taskId === 'plan') return { ok: true, text: '{"tasks":[{"id":"t1","role":"r","title":"poem","prompt":"write a poem about our team","grants":["history"],"why":"the team is in the notes"}]}', usage: { total_tokens: 10 } };
      seen.push(req.messages.at(-1).content);
      return { ok: true, text: 'Roses are red', usage: { total_tokens: 10 } };
    },
    appoint: () => ({ model: 'm' }),
  });
  assert.equal(r4.status, 'completed');
  assert.equal(c, 3, 'plan, answer, nudged answer');
  assert.match(seen[1], /without using history/);
  const tools = r4.threads.threads.find((x) => x.kind === 'proposal' && x.title === 'Tools per task');
  assert.ok(tools, 'the planner\'s tool proposal is a thread');
  assert.match(r4.threads.posts.find((p) => p.threadId === tools.id).text, /r \(t1\): history — the team is in the notes/);
  assert.deepEqual(parsePlan('{"tasks":[{"id":"t1","role":"r","title":"x","prompt":"y","grants":["web","shell","none","bogus"],"why":"w"}]}', planned)[0].grants, ['web', 'shell']);
});
