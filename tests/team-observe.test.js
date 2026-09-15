// Observe, derived once: the inbox, the strip, a run's lanes, spend rows, an engine strip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeInbox, observeStrip, runLanes, spendRows, engineStrip } from '../team-observe.js';

const now = 1_000_000;
const runs = [
  { id: 'a', team: 'research', request: 'ORCL', status: 'waiting', waiting: 1, createdAt: now - 5000, lastEventAt: now - 1000, tasks: [{ id: 't1', role: 'researcher', status: 'ok', ms: 3000 }], usage: { spent: { ms: 3000, tokens: 1000, usd: 0.2 } }, roles: [{ id: 'researcher', agent: 'research-researcher' }] },
  { id: 'b', team: 'feature', request: 'naming', status: 'running', createdAt: now - 900000, lastEventAt: now - 300000, startedAt: now - 900000, tasks: [{ id: 't2', role: 'implementer', status: 'running', startedAt: now - 800000 }], usage: { spent: { ms: 600000 } }, roles: [{ id: 'implementer', agent: 'implementer' }] },
  { id: 'c', team: 'research', request: 'NVDA', status: 'completed', createdAt: now - 50000, lastEventAt: now - 40000, tasks: [{ id: 't3', role: 'writer', status: 'ok' }, { id: 't4', role: 'researcher', status: 'failed' }], usage: { spent: { ms: 9000, tokens: 2000, usd: 0.3 } }, roles: [] },
];

test('the inbox lists what needs a person — asks first, then stalled runs — with the one action', () => {
  const inbox = observeInbox(runs, { now });
  assert.deepEqual(inbox.map((i) => [i.kind, i.runId, i.action]), [['ask', 'a', 'answer'], ['stalled', 'b', 'resume']]);
  assert.equal(observeInbox([runs[2]], { now }).length, 0, 'a completed run needs nobody');
});

test('the strip counts live, stalled, asks, tasks and spend for the window', () => {
  const s = observeStrip(runs, { now });
  assert.equal(s.live, 2); assert.equal(s.stalled, 1); assert.equal(s.asks, 1);
  assert.deepEqual(s.tasks, { done: 2, failed: 1 });
  assert.equal(s.spend.usd, 0.5);
  assert.equal(s.completed, 1);
});

test('a run\'s lanes sit on its own clock, a live run ends at now, a decline is its own segment', () => {
  const run = { id: 'r', status: 'running', startedAt: 0, createdAt: 0, tasks: [
    { id: 'x', role: 'researcher', status: 'running', startedAt: 100, attempts: [{ startedAt: 0, endedAt: 90, status: 'failed', error: 'unavailable' }] },
    { id: 'y', role: 'writer', status: 'pending' },
  ] };
  const l = runLanes(run, { now: 1000 });
  assert.equal(l.span, 1000); assert.equal(l.live, true);
  assert.deepEqual(l.lanes[0].segments.map((s) => s.kind), ['declined', 'working']);
  assert.equal(l.lanes[0].segments[1].from, 0.1); assert.equal(l.lanes[0].segments[1].to, 1);
  assert.deepEqual(l.lanes[1].segments, [], 'a pending task has no bar yet');
  const done = runLanes({ status: 'completed', startedAt: 0, endedAt: 500, tasks: [{ id: 'x', status: 'ok', startedAt: 0, endedAt: 500 }] }, { now: 9999 });
  assert.equal(done.span, 500, 'a finished run\'s clock stopped when it did');
});

test('spend rows by team, agent and engine — usd null when nothing priced it, ms always', () => {
  const byTeam = spendRows(runs, { by: 'team', now });
  assert.deepEqual(byTeam.map((r) => r.key), ['research', 'feature']);
  assert.equal(byTeam[0].usd, 0.5); assert.equal(byTeam[0].runs, 2);
  assert.equal(byTeam[1].usd, null, 'the agent-tool run reported no tokens: no made-up price');
  assert.ok(byTeam[1].ms >= 600000);
  const byAgent = spendRows(runs, { by: 'agent', now });
  assert.ok(byAgent.some((r) => r.key === 'research-researcher'), 'a role that names a card is keyed by the card');
  assert.ok(byAgent.some((r) => r.key === 'implementer'));
  assert.ok(byAgent.every((r) => r.share >= 0 && r.share <= 1));
});

test('an engine card becomes one 24-cell strip', () => {
  const byHour = Array.from({ length: 24 }, (_, i) => ({ calls: i % 3 ? 1 : 0, declines: i === 5 ? 2 : 0 }));
  const s = engineStrip({ key: 'harness:codex', engine: { kind: 'harness', id: 'codex' }, calls: 16, availability: { rate: 0.88, byHour, decliningNow: true }, latency: { total: { p50: 6900 } } });
  assert.equal(s.label, 'codex'); assert.equal(s.rate, 0.88); assert.equal(s.decliningNow, true); assert.equal(s.p50, 6900);
  assert.equal(s.cells.length, 24); assert.equal(s.cells[5], 'declined'); assert.equal(s.cells[0], 'none'); assert.equal(s.cells[1], 'ok');
  assert.equal(engineStrip(null).cells.length, 24);
});
