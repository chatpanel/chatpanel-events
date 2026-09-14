// A task is a conversation; a model call is one attempt at continuing it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messagesFor, mergeTranscript, clipTranscript, continuationNote, createControl } from '../team-task.js';
import { runTeam, resumeTeam } from '../team-run.js';
import { normalizeTeam } from '../team.js';
import { createBoard } from '../team-board.js';

const one = () => normalizeTeam({ name: 't', merge: 'concat', roles: [{ id: 'a', prompt: 'Do the task.', grants: ['web'] }], budget: { tokens: 100000 } });
const roster = [{ id: 'first', model: 'first', usable: true }, { id: 'second', model: 'second', usable: true }];
const appointFrom = async () => { const { appoint } = await import('../cowriter-router.js'); return (role, { exclude } = {}) => { const a = appoint(role, roster, { exclude }); return a ? { model: a.model, mode: 'model' } : null; }; };

test('the transcript: a bare task starts from the prompt; a continuation carries the work and a note; a dangling tool call is closed', () => {
  assert.deepEqual(messagesFor({ transcript: [] }, { prompt: 'go' }), [{ role: 'user', content: 'go' }]);
  const t = [{ role: 'user', content: 'go' }, { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'find', arguments: '{}' } }] }];
  const m = messagesFor({ transcript: t }, { prompt: 'go', note: 'continue' });
  assert.equal(m.length, 4);
  assert.equal(m[2].role, 'tool'); assert.equal(m[2].tool_call_id, 'c1');
  assert.equal(m[3].content, 'continue');
  // What a host returns is the transcript now; a text-only host still extends it.
  assert.equal(mergeTranscript(m, { transcript: [{ role: 'system', content: 's' }, ...m, { role: 'assistant', content: 'done' }] }).length, 5);
  assert.equal(mergeTranscript(m, { text: 'done' }).at(-1).content, 'done');
  // The record's copy is bounded: old tool traffic goes first, the task and the last message never.
  const big = [{ role: 'user', content: 'task' }, ...Array.from({ length: 40 }, (_, i) => [{ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, function: { name: 'f', arguments: '{}' } }] }, { role: 'tool', tool_call_id: `c${i}`, content: 'x'.repeat(3000) }]).flat(), { role: 'assistant', content: 'final' }];
  const clipped = clipTranscript(big);
  assert.equal(clipped[0].content, 'task'); assert.equal(clipped.at(-1).content, 'final');
  assert.ok(JSON.stringify(clipped).length < 70_000);
  assert.match(continuationNote({ kind: 'handoff', from: 'codex', reason: 'exited 1' }), /previous attempt by codex stopped \(exited 1\)/);
});

test('a model that fails mid-task is rotated away from and the next model CONTINUES the transcript — the lookups already made are in front of it', async () => {
  const appoint = await appointFrom();
  const seen = [];
  const events = [];
  const callModel = async ({ model, messages, tools }) => {
    seen.push({ model, n: messages.length, last: messages.at(-1).content });
    if (model === 'first') {
      await tools.execute('board', { action: 'post', kind: 'note', text: 'Searched the calendar: Feb 15–19.' });
      // Its wire transcript: the task, then a tool round, then it died.
      return { ok: false, error: 'Codex exited 1: failed', transcript: [...messages, { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'find', arguments: '{"q":"calendar"}' } }] }, { role: 'tool', tool_call_id: 'c1', content: 'Feb 15–19' }] };
    }
    return { ok: true, text: 'Done: Feb 15–19.', transcript: [...messages, { role: 'assistant', content: 'Done: Feb 15–19.' }] };
  };
  const res = await runTeam({ team: one(), request: 'when is the break?', callModel, appoint, emit: (type, p) => events.push({ type, ...p }) });
  assert.equal(res.status, 'completed');
  assert.deepEqual(seen.map((s) => s.model), ['first', 'second']);
  assert.equal(seen[0].n, 1, 'the first attempt got the bare task');
  assert.equal(seen[1].n, 4, 'the second got the task, the tool round, and the continuation note');
  assert.match(seen[1].last, /continuing this task.*first stopped/s);
  assert.equal(res.tasks[0].transcript.length, 5, 'the record holds the whole conversation');
  assert.deepEqual(res.tasks[0].attempts.map((a) => [a.model, a.status]), [['first', 'error'], ['second', 'ok']]);
  const steps = events.filter((e) => e.type === 'task.step').flatMap((e) => e.steps);
  assert.equal(steps.length, 5, 'every message went to the record, once');
  assert.deepEqual(steps.map((m) => m.role), ['user', 'assistant', 'tool', 'user', 'assistant']);
  const posts = res.threads.posts.filter((p) => p.by === 'runner');
  assert.ok(posts.some((p) => /first stopped/.test(p.text)), 'the hand-off is said on the board');
});

test('a person hands a running task to another model from the board; it continues there, and the board says so', async () => {
  const control = createControl();
  const seen = [];
  const events = [];
  const callModel = async ({ model, messages, signal }) => {
    seen.push({ model, n: messages.length });
    if (model === 'first') {
      // Working… until the person hands it off.
      await new Promise((r) => { const t = setInterval(() => { if (signal.aborted) { clearInterval(t); r(); } }, 5); });
      return { ok: true, aborted: true, text: '', transcript: [...messages, { role: 'assistant', content: 'Partial: found the calendar.' }] };
    }
    return { ok: true, text: 'Finished from the partial.' };
  };
  const run = runTeam({ team: one(), request: 'go', callModel, appoint: () => ({ model: 'first', mode: 'model' }), control, emit: (type, p) => events.push({ type, ...p }) });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(control.handoff('t_a', 'opus', 'person', 'first is slow'), true);
  const res = await run;
  assert.equal(res.status, 'completed');
  assert.deepEqual(seen.map((s) => s.model), ['first', 'opus']);
  assert.equal(seen[1].n, 3, 'the partial work and the note travel to opus');
  const h = events.find((e) => e.type === 'task.handoff');
  assert.deepEqual([h.from, h.to, h.by], ['first', 'opus', 'person']);
  assert.ok(res.threads.posts.some((p) => p.by === 'runner' && /Handed off from first to opus by person/.test(p.text)));
});

test('a run whose process died is resumed from its record: the interrupted task continues its transcript on whatever model is there now', async () => {
  const appoint = await appointFrom();
  const seen = [];
  const dies = async ({ model, messages }) => {
    seen.push({ model, n: messages.length });
    // The process is killed mid-turn: the runner's signal aborts.
    return { ok: true, aborted: true, text: '', transcript: [...messages, { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'find', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c1', content: 'looked up X' }] };
  };
  const ac = new AbortController();
  const p = runTeam({ team: one(), request: 'go', callModel: dies, appoint, signal: ac.signal });
  ac.abort();
  const first = await p;
  assert.equal(first.status, 'stopped');
  assert.ok(first.checkpoint, 'a stopped run carries its checkpoint');
  assert.equal(first.checkpoint.tasks[0].transcript.length, 3);
  // Later, elsewhere: resume from the record. The roster has moved on.
  const later = async ({ model, messages }) => { seen.push({ model, n: messages.length, last: messages.at(-1).content }); return { ok: true, text: 'Finished.' }; };
  const second = await resumeTeam({ checkpoint: first.checkpoint, team: one(), request: 'go', callModel: later, appoint: () => ({ model: 'second', mode: 'model' }) });
  assert.equal(second.status, 'completed');
  assert.equal(second.runId, first.runId);
  assert.equal(seen.at(-1).model, 'second');
  assert.equal(seen.at(-1).n, 4, 'the task, the tool round, and a resume note');
  assert.match(seen.at(-1).last, /interrupted .*resumed/s);
  assert.deepEqual(second.tasks[0].attempts.map((a) => a.model), ['first', 'second']);
});

test('the record: events fold into tasks with transcripts; a run whose client died is resumable from the record alone', async () => {
  const { runFromEvents, checkpointFrom, isResumable } = await import('../team-record.js');
  const events = [];
  const ac = new AbortController();
  const dies = async ({ messages }) => ({ ok: true, aborted: true, text: '', transcript: [...messages, { role: 'assistant', content: 'half done' }] });
  const p = runTeam({ team: one(), request: 'go', callModel: dies, appoint: () => ({ model: 'm', mode: 'model' }), signal: ac.signal, emit: (type, ev) => events.push({ type, ...ev }) });
  ac.abort();
  await p;
  // The store's view — from the events, not the runner's return value.
  const run = runFromEvents('r', events.map((e, seq) => ({ seq, type: e.type, at: e.at, payload: e })));
  assert.equal(run.status, 'stopped');
  assert.equal(run.tasks[0].transcript.length, 2, 'the task\'s conversation is on the record');
  assert.equal(run.tasks[0].attempts[0].model, 'm');
  assert.ok(isResumable(run));
  const cp = checkpointFrom(run);
  assert.equal(cp.tasks[0].transcript.length, 2);
  // And without the runner's checkpoint (a process that died before run.done): still resumable.
  const partial = runFromEvents('r2', events.filter((e) => e.type !== 'run.done').map((e, seq) => ({ seq, type: e.type, at: e.at, payload: e })));
  partial.stale = true;
  assert.ok(isResumable(partial), 'a stale live run is one whose client went away');
  const cp2 = checkpointFrom(partial);
  assert.equal(cp2.tasks[0].status, 'stopped');
  assert.equal(cp2.tasks[0].transcript.length, 2);
  const seen = [];
  const second = await resumeTeam({ checkpoint: cp2, team: one(), request: 'go', appoint: () => ({ model: 'n', mode: 'model' }), callModel: async ({ messages }) => { seen.push(messages.length); return { ok: true, text: 'finished' }; } });
  assert.equal(second.status, 'completed');
  assert.equal(seen[0], 3, 'resumed from the record\'s transcript plus the note');
});

test('the record grows as the attempt goes: a host that reports each step puts the work on the record before the attempt ends', async () => {
  const events = [];
  const ac = new AbortController();
  const callModel = async ({ messages, onStep, signal }) => {
    onStep({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'find', arguments: '{}' } }] });
    onStep({ role: 'tool', tool_call_id: 'c1', content: 'looked up X' });
    // The process dies here: no return ever comes. Simulated by aborting and returning nothing.
    ac.abort();
    return new Promise((resolve) => { signal.addEventListener('abort', () => resolve({ ok: true, aborted: true, text: '' }), { once: true }); if (signal.aborted) resolve({ ok: true, aborted: true, text: '' }); });
  };
  const p = runTeam({ team: one(), request: 'go', callModel, appoint: () => ({ model: 'm', mode: 'model' }), signal: ac.signal, emit: (type, ev) => events.push({ type, ...ev }) });
  const res = await p;
  const steps = events.filter((e) => e.type === 'task.step').flatMap((e) => e.steps);
  assert.equal(steps.length, 3, 'the task, the call and its result were each recorded when they happened');
  assert.equal(res.tasks[0].transcript.length, 3, 'nothing is recorded twice');
});

test('a run that died DURING THE MERGE resumes the merge from its transcript — the researcher is carried, the judge is not started over', async () => {
  const { runFromEvents, checkpointFrom } = await import('../team-record.js');
  const judged = normalizeTeam({ name: 'r', merge: 'judge', judge: 'w', roles: [{ id: 'a', prompt: 'Research.', grants: ['web'] }, { id: 'w', prompt: 'Write.', prefer: 'strong', grants: ['none'] }], budget: { tokens: 100000 } });
  const events = [];
  const ac = new AbortController();
  const calls = [];
  const callModel = async ({ taskId, messages }) => {
    calls.push({ taskId, n: messages.length });
    if (taskId === 'a' || taskId === 't_a') return { ok: true, text: '{"findings":[{"kind":"claim","text":"X is 1","refs":["n:1"]}]}' };
    // The merge: half-way through its answer the process dies.
    ac.abort();
    return { ok: true, aborted: true, text: '', transcript: [...messages, { role: 'assistant', content: 'Final answer so far: X' }] };
  };
  const first = await runTeam({ team: judged, request: 'what is X?', callModel, appoint: (r) => ({ model: r.prefer === 'strong' ? 'big' : 'mid', mode: 'model' }), signal: ac.signal, emit: (type, ev) => events.push({ type, ...ev }) });
  assert.equal(first.status, 'stopped');
  assert.equal(first.tasks.find((x) => x.id === 'merge')?.status, 'stopped');
  // From the record, as a client would.
  const run = runFromEvents('r', events.map((e, seq) => ({ seq, type: e.type, at: e.at, payload: e })));
  assert.equal(run.tasks.find((x) => x.id === 'merge')?.kind, 'merge');
  assert.ok(run.plan.tasks.some((x) => x.id === 'merge' && x.kind === 'merge'), 'the merge is on the plan the checkpoint carries');
  const cp = checkpointFrom(run);
  const second = await resumeTeam({ checkpoint: cp, team: judged, request: 'what is X?', appoint: () => ({ model: 'big', mode: 'model' }), callModel: async ({ taskId, messages }) => { calls.push({ taskId, n: messages.length, resumed: true }); return { ok: true, text: 'Final: X is 1.' }; } });
  assert.equal(second.status, 'completed');
  assert.deepEqual(calls.filter((c) => c.resumed).map((c) => c.taskId), ['merge'], 'only the merge ran again; the researcher was carried');
  assert.equal(calls.at(-1).n, 3, 'the merge continued its transcript (prompt, the half answer, the resume note)');
  assert.match(second.proposal.text, /Final: X is 1/);
  assert.equal(second.proposal.by, 'w');
  assert.equal(second.threads.threads.filter((t) => t.taskId === 'merge').length, 1, 'one merge thread, not one per attempt');
});
