import { test } from 'node:test';
import assert from 'node:assert/strict';
import { teamLine, teamLanes } from '../team-trail.js';

test('every runner event has a trail line except the delta stream', () => {
  const ev = [
    { type: 'run.started', team: 'research', roles: ['researcher', 'writer'] },
    { type: 'plan.ready', tasks: [{ id: 't1' }], by: 'fixed' },
    { type: 'task.started', taskId: 't1', role: 'researcher', title: 'find sources' },
    { type: 'task.tool', role: 'researcher', name: 'web_search', text: 'q' },
    { type: 'task.finding', role: 'researcher', finding: { text: 'x'.repeat(200) } },
    { type: 'task.done', role: 'researcher', findings: 1 },
    { type: 'task.failed', role: 'writer', status: 'skipped', error: 'budget' },
    { type: 'run.merging', policy: 'judge' },
    { type: 'run.done', status: 'completed', usage: { spent: { tokens: 1234 } } },
  ];
  const lines = ev.map(teamLine);
  assert.ok(lines.every((l) => l && l.type && l.text));
  assert.equal(lines[0].text, 'team research: researcher, writer');
  assert.equal(lines[1].text, 'plan: 1 task (fixed)');
  assert.equal(lines[3].type, 'tool');
  assert.ok(lines[4].text.length < 160, 'a finding is clipped for the trail');
  assert.equal(lines[6].type, 'error');
  assert.match(lines[8].text, /1234 tokens/);
  assert.equal(teamLine({ type: 'task.delta', taskId: 't1', text: 'partial' }), null);
});

test('lanes fold from events: one per task, findings counted, status from the run', () => {
  let lanes = null;
  const feed = (e) => { lanes = teamLanes(lanes, { runId: 'r1', ...e }); };
  feed({ type: 'run.started', team: 'research', roles: ['a', 'b'] });
  feed({ type: 'plan.ready', tasks: [{ id: 't1', role: 'a', title: 'one' }, { id: 't2', role: 'b', title: 'two' }] });
  feed({ type: 'task.started', taskId: 't1', role: 'a' });
  feed({ type: 'task.delta', taskId: 't1', text: 'so far' });
  feed({ type: 'task.finding', taskId: 't1', finding: { text: 'f' } });
  feed({ type: 'task.done', taskId: 't1', status: 'ok', ms: 5 });
  feed({ type: 'task.failed', taskId: 't2', status: 'skipped' });
  feed({ type: 'run.done', status: 'over-budget', usage: { spent: { tokens: 9 } } });
  assert.equal(lanes.runId, 'r1');
  assert.equal(lanes.team, 'research');
  assert.deepEqual(Object.keys(lanes.tasks), ['t1', 't2']);
  assert.equal(lanes.tasks.t1.status, 'ok');
  assert.equal(lanes.tasks.t1.text, 'so far');
  assert.equal(lanes.tasks.t1.findings, 1);
  assert.equal(lanes.tasks.t2.status, 'skipped');
  assert.equal(lanes.findings, 1);
  assert.equal(lanes.status, 'over-budget');
  assert.equal(lanes.usage.spent.tokens, 9);
});

test('folding never mutates the previous lanes', () => {
  const a = teamLanes(null, { runId: 'r', type: 'plan.ready', tasks: [{ id: 't', role: 'x' }] });
  const b = teamLanes(a, { runId: 'r', type: 'task.started', taskId: 't', role: 'x' });
  assert.equal(a.tasks.t.status, 'pending');
  assert.equal(b.tasks.t.status, 'running');
});

test('lanes know who is doing what and what it has cost so far — model per task, tool count, live spend', () => {
  let lanes = null;
  const feed = (e) => { lanes = teamLanes(lanes, { runId: 'r', ...e }); };
  feed({ type: 'plan.ready', tasks: [{ id: 't1', role: 'researcher' }] });
  feed({ type: 'task.started', taskId: 't1', role: 'researcher' });
  feed({ type: 'task.model', taskId: 't1', role: 'researcher', model: 'claude/opus', attempt: 1 });
  feed({ type: 'task.tool', taskId: 't1', role: 'researcher', name: 'web_search', text: '"Zion winter"' });
  feed({ type: 'task.tool', taskId: 't1', role: 'researcher', name: 'read', text: '' });
  feed({ type: 'run.usage', usage: { cap: { tokens: 30000 }, spent: { tokens: 1200, calls: 2, usd: 0, ms: 5000 } } });
  assert.equal(lanes.tasks.t1.model, 'claude/opus');
  assert.equal(lanes.tasks.t1.tools, 2);
  assert.equal(lanes.tasks.t1.lastTool, 'read');
  assert.equal(lanes.usage.spent.tokens, 1200);
  assert.equal(teamLine({ type: 'task.model', model: 'x' }), null, 'no trail line for it; the ledger draws it');
});
