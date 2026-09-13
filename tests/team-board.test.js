// The board as a message board — threads, posts, replies, asks, decisions — and the runner
// as its moderator: an ask pauses one member, a person answers from either client, an
// unanswered ask checkpoints the run and resumeTeam continues it with the answer in hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBoard, foldBoard, emptyBoardState, boardText, findingsOf } from '../team-board.js';
import { boardToolProvider, createAnswerBox, withBoardTool } from '../board-tool.js';
import { runTeam, resumeTeam } from '../team-run.js';
import { normalizeTeam } from '../team.js';
import { teamLine, teamLanes } from '../team-trail.js';

const team = () => normalizeTeam({
  name: 'travel', merge: 'concat',
  roles: [
    { id: 'researcher', prompt: 'Find facts.', grants: ['web'] },
    { id: 'planner', prompt: 'Plan.', grants: ['none'], dependsOn: ['researcher'] },
  ],
  budget: { tokens: 100000 },
});

test('threads, posts, replies and decisions fold from events into the same state the live board holds', () => {
  const events = [];
  let t = 0;
  const b = createBoard({ now: () => (t += 1), newId: (p) => `${p}${t}`, onEvent: (type, ev) => events.push({ type, ...ev }) });
  const th = b.openThread({ taskId: 't1', kind: 'task', title: 'Find facts', by: 'runner' });
  assert.equal(b.openThread({ taskId: 't1', kind: 'task', title: 'again' }).id, th.id, 'a task has one thread');
  const f = b.post({ threadId: th.id, by: 'researcher', kind: 'finding', text: 'Rooms are $180–260', refs: ['web:x'], finding: { kind: 'claim', confidence: 0.7 } });
  const r = b.reply({ postId: f.id, by: 'budget', kind: 'note', text: 'I see $140–190', refs: ['web:y'] });
  assert.equal(r.threadId, th.id); assert.equal(r.replyTo, f.id);
  b.decide(f.id, 'approved', 'person');
  b.setThreadStatus(th.id, 'resolved');
  const folded = events.reduce((st, ev) => foldBoard(st, ev), emptyBoardState());
  assert.deepEqual(folded, b.state(), 'the fold reproduces the live board');
  assert.equal(folded.posts[0].status, 'approved');
  assert.equal(folded.threads[0].posts, 2);
  // Idempotent: the same event twice lands once (an answer echoed by two clients).
  const again = foldBoard(JSON.parse(JSON.stringify(folded)), events.find((e) => e.type === 'board.post'));
  assert.equal(again.posts.length, 2);
  // The legacy finding view still reads finding posts.
  assert.equal(findingsOf(folded)[0].taskId, 't1');
  assert.equal(b.all()[0].confidence, 0.7);
});

test('what a member reads is threaded: a reply under its post, a person\'s word marked settled, rejected posts gone', () => {
  const b = createBoard({ now: () => 1, newId: (p) => `${p}${Math.random().toString(36).slice(2, 6)}` });
  const th = b.openThread({ taskId: 't1', kind: 'task', title: 'Find facts' });
  const f = b.post({ threadId: th.id, by: 'researcher', kind: 'finding', text: 'Rooms are $260', finding: { kind: 'claim' } });
  b.reply({ postId: f.id, by: 'budget', kind: 'note', text: 'more like $160' });
  const bad = b.post({ threadId: th.id, by: 'researcher', kind: 'finding', text: 'Wrong thing', finding: { kind: 'claim' } });
  b.decide(bad.id, 'rejected', 'person');
  const d = b.openThread({ kind: 'discussion', title: 'LAS or SLC?', by: 'budget' });
  b.post({ threadId: d.id, by: 'budget', kind: 'question', text: 'LAS is cheaper; SLC closer.' });
  b.post({ threadId: d.id, by: 'person', kind: 'decision', text: 'LAS.' });
  const text = boardText(b, { taskIds: ['t1'], role: 'planner' });
  assert.match(text, /## task: Find facts\n- \[claim · researcher\] Rooms are \$260\n  - \[note · budget\] more like \$160/);
  assert.doesNotMatch(text, /Wrong thing/);
  assert.match(text, /## discussion by budget: LAS or SLC\?/);
  assert.match(text, /\[decision · person · SETTLED\] LAS\./);
});

test('a member asks, its task waits, a person answers, the member goes on with the answer', async () => {
  const box = createAnswerBox();
  const events = [];
  const prompts = [];
  const callModel = async ({ role, prompt, tools }) => {
    prompts.push([role, prompt]);
    if (role === 'researcher') {
      const r = JSON.parse(await tools.execute('board', { action: 'ask', type: 'info', text: 'Which week is the break?', options: ['Feb 13–17', 'Feb 20–24'] }));
      assert.equal(r.answered, true);
      return { ok: true, text: `Break is ${r.answer}.\n\`\`\`json\n{"findings":[{"kind":"claim","text":"Break is ${r.answer}"}]}\n\`\`\`` };
    }
    return { ok: true, text: 'plan' };
  };
  const run = runTeam({ team: team(), request: 'trip', callModel, appoint: () => ({ model: 'm', mode: 'model' }), answers: box, askTimeoutMs: 5000, emit: (type, p) => events.push({ type, ...p }) });
  // The other client sees `task.waiting` on the store's tail and answers the thread.
  await new Promise((r) => setTimeout(r, 10));
  const waiting = events.find((e) => e.type === 'task.waiting');
  assert.ok(waiting, 'the trail says the task is waiting');
  assert.equal(teamLine(waiting).type, 'status');
  assert.match(teamLine(waiting).text, /waiting on you/);
  box.answer(waiting.threadId, { text: 'Feb 13–17', by: 'person' });
  const res = await run;
  assert.equal(res.status, 'completed');
  assert.match(prompts.find(([r]) => r === 'planner')[1], /Break is Feb 13–17/, 'the planner read the researcher\'s finding');
  const ask = res.threads.threads.find((t) => t.kind === 'ask');
  assert.equal(ask.status, 'waiting', 'the ask thread stays as the member left it until the runner resolves… (below)');
});

test('an unanswered ask checkpoints the run as waiting; resumeTeam continues with the answer on the board', async () => {
  const box = createAnswerBox();
  const events = [];
  let askedOnce = false;
  const callModel = async ({ role, prompt, tools, signal }) => {
    if (role === 'researcher' && !askedOnce) {
      askedOnce = true;
      const r = JSON.parse(await tools.execute('board', { action: 'ask', type: 'info', text: 'Which week?' }));
      // The runner aborted this turn on timeout; a real model call would reject here.
      if (signal.aborted) return { ok: false, aborted: true, text: '' };
      return { ok: true, text: `got ${r.answer}` };
    }
    if (role === 'researcher') return { ok: true, text: `The break: ${/answered\)[\s\S]*?\[answer · person[^\]]*\] ([^\n]+)/.exec(prompt)?.[1] || 'unknown'}` };
    return { ok: true, text: 'plan' };
  };
  const first = await runTeam({ team: team(), request: 'trip', callModel, appoint: () => ({ model: 'm', mode: 'model' }), answers: box, askTimeoutMs: 30, emit: (type, p) => events.push({ type, ...p }) });
  assert.equal(first.status, 'waiting');
  assert.ok(first.checkpoint, 'a waiting run carries its checkpoint');
  assert.deepEqual(first.tasks.map((x) => [x.id, x.status]), [['t_researcher', 'waiting'], ['t_planner', 'skipped']]);
  const done = events.find((e) => e.type === 'run.done');
  assert.equal(done.status, 'waiting');
  assert.deepEqual(done.waitingTaskIds, ['t_researcher']);
  const lanes = events.reduce((l, e) => teamLanes(l, e), null);
  assert.equal(lanes.status, 'waiting');
  assert.equal(lanes.tasks.t_researcher.status, 'waiting');

  // Later, from any client: the person answers on the board; the run resumes from the checkpoint.
  const askThread = first.checkpoint.board.threads.find((t) => t.kind === 'ask');
  const seed = createBoard({ state: first.checkpoint.board });
  seed.answer(askThread.id, { text: 'Feb 13–17', by: 'person' });
  const second = await resumeTeam({ checkpoint: { ...first.checkpoint, board: seed.state() }, team: team(), request: 'trip', callModel, appoint: () => ({ model: 'm', mode: 'model' }), answers: box, askTimeoutMs: 30 });
  assert.equal(second.runId, first.runId, 'the same run continues');
  assert.equal(second.status, 'completed');
  assert.deepEqual(second.tasks.map((x) => [x.id, x.status]), [['t_researcher', 'ok'], ['t_planner', 'ok']]);
  assert.match(second.tasks[0].text, /Feb 13–17/, 'the resumed member read the answer from its own ask thread');
});

test('over budget with work left asks the person once; "raise" continues, silence stops', async () => {
  const mk = (answer) => {
    const box = createAnswerBox();
    const events = [];
    const t = normalizeTeam({ name: 'b', merge: 'concat', roles: [{ id: 'a', prompt: 'p', grants: ['none'] }, { id: 'b', prompt: 'p', grants: ['none'], dependsOn: ['a'] }], budget: { tokens: 100 } });
    const run = runTeam({ team: t, request: 'x', appoint: () => ({ model: 'm', mode: 'model' }), answers: box, askTimeoutMs: 40, emit: (type, p) => { events.push({ type, ...p }); if (type === 'run.waiting' && answer) setTimeout(() => box.answer(p.threadId, { text: answer }), 5); }, callModel: async () => ({ ok: true, text: 'done', usage: { input_tokens: 90, output_tokens: 20 } }) });
    return run.then((res) => ({ res, events }));
  };
  const raised = await mk('Raise by half');
  assert.equal(raised.res.status, 'completed', 'the raise let the last task run; a budget spent on the last task is a run that finished');
  assert.deepEqual(raised.res.tasks.map((x) => x.status), ['ok', 'ok']);
  assert.equal(raised.events.filter((e) => e.type === 'run.waiting').length, 1, 'asked once');
  assert.equal(raised.res.usage.cap.tokens, 150);
  const stopped = await mk(null);
  assert.equal(stopped.res.status, 'over-budget');
  assert.deepEqual(stopped.res.tasks.map((x) => x.status), ['ok', 'skipped']);
});

test('the board tool: read, post, reply — and a member that asks where nobody can answer is told to go on', async () => {
  const b = createBoard({ now: () => 1, newId: (p) => `${p}${Math.random().toString(36).slice(2, 6)}` });
  b.openThread({ taskId: 't1', kind: 'task', title: 'Find facts' });
  const th2 = b.openThread({ taskId: 't2', kind: 'task', title: 'Plan' });
  const other = b.post({ threadId: b.threadForTask('t1').id, by: 'researcher', kind: 'finding', text: 'Rooms $260', finding: { kind: 'claim' } });
  const tool = boardToolProvider({ board: b, role: 'planner', taskId: 't2', taskIds: ['t1'] });
  const read = JSON.parse(await tool.execute('board', { action: 'read' }));
  assert.match(read.board, /Rooms \$260/);
  assert.ok(read.postIds.some((p) => p.id === other.id));
  const posted = JSON.parse(await tool.execute('board', { action: 'post', kind: 'draft', text: 'Day 1…' }));
  assert.equal(posted.threadId, th2.id, 'a post lands in the member\'s own task thread');
  const replied = JSON.parse(await tool.execute('board', { action: 'reply', postId: other.id, text: 'Cheaper on two sites' }));
  assert.equal(replied.replyTo, other.id);
  assert.equal(b.posts(b.threadForTask('t1').id).at(-1).by, 'planner', 'a member posts as itself, never as another');
  const asked = JSON.parse(await tool.execute('board', { action: 'ask', text: 'Which week?' }));
  assert.equal(asked.error !== undefined, true, 'no answer box: the member is told to decide');
  // withBoardTool: the board's tool comes first and the host's execute still owns its own.
  const host = { specs: [{ name: 'find' }], system: 'host', execute: async (n) => `host:${n}` };
  const merged = withBoardTool(host, tool);
  assert.deepEqual(merged.specs.map((s) => s.name), ['board', 'find']);
  assert.equal(await merged.execute('find', {}), 'host:find');
  assert.match(merged.system, /host/);
});

test('a model that was not there for one member is skipped for the next — and for the judge', async () => {
  const roster = [{ id: 'a-dead', model: 'a-dead', usable: true }, { id: 'z-alive', model: 'z-alive', usable: true }];
  const { appoint } = await import('../cowriter-router.js');
  const ap = (role, { exclude } = {}) => { const a = appoint(role, roster, { exclude }); return a ? { model: a.model, mode: 'model' } : null; };
  const t = normalizeTeam({ name: 'x', merge: 'judge', judge: 'w', roles: [{ id: 'a', prompt: 'p', grants: ['none'] }, { id: 'b', prompt: 'p', grants: ['none'], dependsOn: ['a'] }, { id: 'w', prompt: 'p', grants: ['none'] }], budget: { tokens: 10000 } });
  const tried = [];
  const res = await runTeam({ team: t, request: 'go', appoint: ap, callModel: async ({ taskId, model }) => { tried.push([taskId, model]); return model === 'a-dead' ? { ok: false, error: 'Codex exited 1: failed' } : { ok: true, text: `ok from ${taskId}` }; } });
  assert.equal(res.status, 'completed');
  assert.deepEqual(tried, [['t_a', 'a-dead'], ['t_a', 'z-alive'], ['t_b', 'z-alive'], ['merge', 'z-alive']], 'the dead model was tried once in the whole run');
});
