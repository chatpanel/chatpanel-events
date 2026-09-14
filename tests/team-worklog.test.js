// THE WORK LOG: a task's thread as the record of the work. Folded from the same events the
// store and both clients fold, so a task that failed before its first post still shows
// what it did — the prompt, its calls, what came back, which models were tried, the end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFromEvents } from '../team-record.js';
import { workLogFor, workLogText, workLogEvidence, describeCall } from '../team-worklog.js';
import { clipMessage, messagesFor, isThought } from '../team-task.js';

const T0 = 1_000_000;
const ev = (type, at, payload) => ({ type, at, payload });
const events = [
  ev('run.started', T0, { team: 'research', request: 'AAPL?', roles: ['researcher', 'writer'] }),
  ev('plan.ready', T0 + 1, { by: 'fixed', tasks: [{ id: 't_r', role: 'researcher', title: 'researcher' }] }),
  ev('board.thread', T0 + 1, { thread: { id: 'th1', kind: 'task', taskId: 't_r', title: 'researcher', by: 'runner', status: 'open', at: T0 + 1, posts: 0 } }),
  ev('task.started', T0 + 2, { taskId: 't_r' }),
  ev('task.model', T0 + 3, { taskId: 't_r', model: 'local-llm', attempt: 1 }),
  ev('task.step', T0 + 4, { taskId: 't_r', steps: [{ role: 'user', content: 'Research the request.', at: T0 + 4, attempt: 1 }] }),
  ev('task.step', T0 + 10, { taskId: 't_r', steps: [{ role: 'assistant', thought: 'I should search the web first.', at: T0 + 10, attempt: 1 }] }),
  ev('task.step', T0 + 11, { taskId: 't_r', steps: [{ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'find', arguments: '{"action":"web_search","args":{"query":"AAPL news"}}' } }], at: T0 + 11, attempt: 1 }] }),
  ev('task.tool', T0 + 11, { taskId: 't_r', name: 'find' }),
  ev('task.step', T0 + 20, { taskId: 't_r', steps: [{ role: 'tool', tool_call_id: 'c1', content: 'error: network error', at: T0 + 20, attempt: 1 }] }),
  ev('task.reappointed', T0 + 21, { taskId: 't_r', model: 'claude-code', after: ['local-llm'], error: 'network error' }),
  ev('task.model', T0 + 21, { taskId: 't_r', model: 'claude-code', attempt: 2 }),
  ev('board.post', T0 + 21, { post: { id: 'p1', threadId: 'th1', by: 'runner', kind: 'note', text: 'local-llm stopped (network error); the task continues on the next model.', at: T0 + 21, refs: [], replyTo: null } }),
  // an older build's step: no stamp — it must still land under attempt 2, after the note
  ev('task.step', T0 + 30, { taskId: 't_r', steps: [{ role: 'user', content: 'Continue from where local-llm stopped.' }] }),
  ev('task.step', T0 + 40, { taskId: 't_r', steps: [{ role: 'assistant', content: 'FINDING: AAPL closed at $332.', at: T0 + 40, attempt: 2 }] }),
  ev('board.post', T0 + 41, { post: { id: 'p2', threadId: 'th1', by: 'researcher', kind: 'finding', text: 'AAPL closed at $332', at: T0 + 41, refs: ['web:1'], replyTo: null, status: 'approved' } }),
  ev('task.done', T0 + 42, { taskId: 't_r', status: 'ok', ms: 40, findings: 1 }),
];

test('the log orders attempts, steps, thoughts, calls, results, notes, posts and the end by time', () => {
  const run = runFromEvents('run_1', events);
  const log = workLogFor(run, 't_r');
  assert.deepEqual(log.map((e) => e.kind), ['attempt', 'prompt', 'thought', 'call', 'result', 'attempt', 'post', 'note', 'text', 'post', 'end']);
  assert.equal(log[0].model, 'local-llm');
  assert.equal(log[2].by, 'researcher');
  assert.equal(log[3].text, 'find web_search query="AAPL news"', 'a call reads as what it asked for');
  assert.equal(log[4].error, true, 'a result that starts with error: is one');
  assert.equal(log[5].attempt, 2);
  assert.equal(log[7].kind, 'note'); assert.equal(log[7].attempt, 2, 'an unstamped step follows its attempt');
  assert.equal(log.at(-1).status, 'ok');
  assert.match(log.at(-1).text, /done after 2 models \(local-llm → claude-code\) · 1 finding · 1 tool call/);
  const text = workLogText(log);
  assert.match(text, /researcher \(thinking\): I should search/);
  assert.match(text, /← find: error: network error/);
  const evd = workLogEvidence(log);
  assert.deepEqual([evd.calls, evd.results, evd.resultErrors, evd.attempts, evd.findings, evd.decided.approved, evd.status], [1, 1, 1, 2, 1, 1, 'ok']);
});

test('a running task shows what it is saying now; a failed one says why', () => {
  const run = runFromEvents('run_2', [...events.slice(0, 9), ev('task.delta', T0 + 15, { taskId: 't_r', text: 'Looking at the results…' })]);
  const live = workLogFor(run, 't_r');
  assert.equal(live.at(-1).kind, 'text'); assert.equal(live.at(-1).live, true);
  const failed = runFromEvents('run_3', [...events.slice(0, 10), ev('task.failed', T0 + 22, { taskId: 't_r', status: 'failed', error: 'network error', ms: 20 })]);
  const end = workLogFor(failed, 't_r').at(-1);
  assert.equal(end.kind, 'end'); assert.equal(end.status, 'failed'); assert.match(end.text, /failed: network error/);
  assert.deepEqual(workLogFor(run, 'nope'), []);
});

test('a thought is on the record, never on the wire', () => {
  const thought = clipMessage({ role: 'assistant', thought: 'hmm', at: 5, attempt: 1 });
  assert.equal(thought.thought, 'hmm'); assert.equal(thought.at, 5); assert.equal(thought.attempt, 1);
  assert.equal(isThought(thought), true);
  assert.equal(isThought({ role: 'assistant', content: 'x', thought: 'y' }), false);
  const sent = messagesFor({ transcript: [{ role: 'user', content: 'q' }, thought, { role: 'assistant', content: 'a' }] }, { prompt: 'q' });
  assert.deepEqual(sent.map((m) => m.role), ['user', 'assistant']);
  assert.equal(sent.some((m) => 'thought' in m), false);
});

test('describeCall', () => {
  assert.equal(describeCall({ function: { name: 'history_search', arguments: '{"query":"aapl","limit":5}' } }), 'history_search query="aapl"');
  assert.equal(describeCall({ function: { name: 'board', arguments: 'not json' } }), 'board raw="not json"');
});

test('spendOf measures a live run\'s time now, not as of its last task; describeSpend names only the capped dimensions', async () => {
  const { spendOf, describeSpend } = await import('../team-record.js');
  const run = { status: 'running', startedAt: 1000, budget: { tokens: 40000, ms: 900000 }, usage: null };
  const s = spendOf(run, { now: 131000 });
  assert.equal(s.spent.ms, 130000, 'live elapsed with no run.usage yet');
  assert.equal(s.spent.tokens, 0);
  assert.equal(describeSpend(s), '0 / 40,000 tokens · 2m10s / 15m00s');
  const done = { status: 'completed', startedAt: 1000, usage: { cap: { tokens: 40000, calls: 20, usd: 2 }, spent: { tokens: 1240, calls: 3, usd: 0.1234, ms: 5000 } } };
  const d = spendOf(done, { now: 999999 });
  assert.equal(d.spent.ms, 5000, 'a finished run keeps its recorded time');
  assert.equal(d.pct, 3);
  assert.equal(describeSpend(d), '1,240 / 40,000 tokens · 3 / 20 calls · $0.12 / $2.00');
  assert.equal(spendOf({ status: 'running' }), null);
});

test('runState reads the record against the clock: a live record with no events for minutes is stalled, and the clock stops where its writer stopped', async () => {
  const { runState, spendOf, describeSpend, priorWorkFor } = await import('../team-record.js');
  const live = { status: 'running', startedAt: 1000, lastEventAt: 31000, budget: { ms: 300000, tokens: 1000 } };
  assert.equal(runState(live, { now: 40000 }).key, 'running');
  assert.match(runState(live, { now: 40000 }).detail, /last event 9 s ago/);
  const st = runState(live, { now: 20 * 60000 });
  assert.equal(st.key, 'stalled');
  assert.equal(st.tone, 'err');
  assert.match(st.detail, /no events for 19 min/);
  assert.equal(spendOf(live, { now: 20 * 60000 }).spent.ms, 30000, 'the clock stopped at the last event');
  assert.equal(spendOf(live, { now: 40000 }).spent.ms, 39000, 'a running one counts to now');
  assert.equal(runState({ ...live, stale: true }, { now: 40000 }).key, 'stalled', 'the store\'s own stale mark counts too');
  assert.equal(runState({ status: 'waiting' }).key, 'waiting');
  assert.equal(runState({ status: 'partial' }).label, 'done with failures');
  const over = spendOf({ status: 'completed', startedAt: 1, usage: { cap: { ms: 300000, tokens: 1000 }, spent: { ms: 400000, tokens: 10 } } });
  assert.deepEqual(over.over, ['ms']);
  assert.match(describeSpend(over), /6m40s \/ 5m00s \(over\)/);
  // Prior work: the same team, a request that says the same thing, findings on the record, not live.
  const runs = [
    { id: 'r1', team: 'research', status: 'completed', request: 'Research ORCL stock: recent news, earnings, analyst sentiment', findings: 37, createdAt: 1000 },
    { id: 'r2', team: 'research', status: 'running', request: 'Research ORCL stock: recent news, earnings, analyst sentiment', findings: 5, createdAt: 2000 },
    { id: 'r3', team: 'review', status: 'completed', request: 'Research ORCL stock: recent news', findings: 4, createdAt: 3000 },
    { id: 'r4', team: 'research', status: 'failed', request: 'Plan a trip to Lisbon', findings: 2, createdAt: 4000 },
    { id: 'r5', team: 'research', status: 'completed', request: 'research orcl stock recent news earnings and analyst sentiment', findings: 0, createdAt: 5000 },
  ];
  const got = priorWorkFor(runs, { team: 'research', request: 'Research ORCL stock — recent news, earnings, analyst sentiment', excludeId: 'r6', now: 6000 });
  assert.deepEqual(got.map((x) => x.id), ['r1'], 'not the live one, not another team, not another question, not one with nothing');
  assert.ok(got[0].similarity >= 0.8);
  assert.deepEqual(priorWorkFor(runs, { team: '', request: 'Research ORCL stock: recent news', now: 6000 }).map((x) => x.id), ['r3', 'r1']);
});

test('every work-log entry has a stable id — the step\'s index, the call\'s id, the post\'s id — so a board keeps the row a person opened while the log grows', async () => {
  const { workLogFor } = await import('../team-worklog.js');
  const run = { startedAt: 1, tasks: [{ id: 'a', role: 'r', status: 'running', attempts: [{ model: 'm', at: 1 }], transcript: [{ role: 'user', content: 'p', at: 2 }, { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'find', arguments: '{}' } }], at: 3 }], text: 'typing…' }], lastEventAt: 8, threads: { threads: [{ id: 'th', kind: 'task', taskId: 'a' }], posts: [{ id: 'p1', threadId: 'th', text: 'hi', at: 7 }] } };
  const before = workLogFor(run, 'a').map((e) => e.id);
  assert.deepEqual(before, ['attempt:1', 'step:0', 'call:c1', 'post:p1', 'live']);
  // A step lands: earlier ids do not move.
  run.tasks[0].transcript.push({ role: 'tool', tool_call_id: 'c1', content: 'x', at: 4 });
  run.lastEventAt = 9;
  const after = workLogFor(run, 'a').map((e) => e.id);
  assert.deepEqual(after, ['attempt:1', 'step:0', 'call:c1', 'step:2', 'post:p1', 'live']);
  assert.ok(new Set(after).size === after.length, 'ids are unique');
});

test('an attempt is named by its label when the id is a generated one — the log reads as models, not ids', () => {
  const run = runFromEvents('run_2', [
    ev('run.started', T0, { team: 'T', request: 'q', roles: ['r'] }),
    ev('plan.ready', T0 + 1, { by: 'fixed', tasks: [{ id: 't', role: 'r', title: 'r' }] }),
    ev('task.started', T0 + 2, { taskId: 't' }),
    // The runner says the label with the model; an older run said only the id.
    ev('task.model', T0 + 3, { taskId: 't', model: 'mqk41ucyhmz1au', label: 'openrouter/free', attempt: 1 }),
    ev('task.routed', T0 + 3, { taskId: 't', attempt: 1, engine: { kind: 'model', id: 'mqk41ucyhmz1au', model: 'openrouter/free' } }),
    ev('task.model', T0 + 20, { taskId: 't', model: 'mqqzh4970js34c', attempt: 2 }),
    ev('task.routed', T0 + 20, { taskId: 't', attempt: 2, engine: { kind: 'harness', id: 'codex', model: 'gpt-5-codex' } }),
    ev('task.model', T0 + 30, { taskId: 't', model: 'bare-id', attempt: 3 }),
    ev('task.failed', T0 + 50, { taskId: 't', status: 'error', error: 'no model left', ms: 48 }),
  ]);
  const log = workLogFor(run, 't');
  const attempts = log.filter((e) => e.kind === 'attempt');
  assert.deepEqual(attempts.map((a) => a.model), ['openrouter/free', 'gpt-5-codex', 'bare-id']);
  assert.equal(attempts[0].modelId, 'mqk41ucyhmz1au', 'the id is still on the row');
  assert.match(log.at(-1).text, /failed after 3 models \(openrouter\/free → gpt-5-codex → bare-id\)/);
});
