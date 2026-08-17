import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnRunner, defineLoop, LoopError } from '../loop.js';
import { createKernel } from '../kernel.js';

const mkRunner = (over = {}) => {
  const events = [];
  let t = 1000; let n = 0;
  const runner = createTurnRunner({
    now: () => (t += 5),
    newId: () => `t${n++}`,
    emit: (type, payload) => events.push({ type, payload }),
    ...over,
  });
  return { runner, events, types: () => events.map((e) => e.type) };
};

// ---- THE BUG CLASS THIS EXISTS TO REMOVE ----
// Every one of these loops would have left a turn open under the old hand-rolled
// lifetime. None of them can now, because none of them holds it.

test('a loop that returns early still closes its turn', async () => {
  const { runner, types } = mkRunner();
  await runner.run(defineLoop({ id: 'early', run: () => 'done' }));
  assert.deepEqual(types(), ['turn.started', 'turn.ended']);
});

test('a loop that throws still closes its turn, as an error', async () => {
  const { runner, events } = mkRunner();
  await assert.rejects(() => runner.run(defineLoop({ id: 'boom', run: () => { throw new Error('x'); } })));
  assert.equal(events.at(-1).type, 'turn.ended');
  assert.equal(events.at(-1).payload.reason, 'error');
});

test('an aborted loop closes as aborted, not as an error', async () => {
  // "Did it fail, or did I stop it?" is the question people actually ask, and collapsing
  // the two makes the log unable to answer it.
  const { runner, events } = mkRunner();
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => runner.run(
    defineLoop({ id: 'stop', run: () => { throw new Error('aborted'); } }),
    { signal: ac.signal },
  ));
  assert.equal(events.at(-1).payload.reason, 'aborted');
});

test('a loop is not given any way to close its own turn', async () => {
  let ctx;
  const { runner } = mkRunner();
  await runner.run(defineLoop({ id: 'peek', run: (c) => { ctx = c; return 'ok'; } }));
  for (const forbidden of ['close', 'end', 'turn', 'finish']) {
    assert.equal(typeof ctx[forbidden], 'undefined', `loop context exposed '${forbidden}' — lifetime leaked back to the author`);
  }
});

test('a turn closes exactly once', async () => {
  const { runner, events } = mkRunner();
  await runner.run(defineLoop({ id: 'once', run: () => 'ok' }));
  assert.equal(events.filter((e) => e.type === 'turn.ended').length, 1);
});

// ---- identity, so runs do not split in the activity view ----

test('a caller-supplied turnId is used verbatim', async () => {
  const { runner, events } = mkRunner();
  await runner.run(defineLoop({ id: 'chat', kind: 'chat', run: () => 'hi' }), { turnId: 'msg-42' });
  assert.ok(events.every((e) => e.payload.turnId === 'msg-42'));
});

test('domain events a loop emits carry the turn id without the loop tracking it', async () => {
  const { runner, events } = mkRunner();
  await runner.run(defineLoop({ id: 'tools', run: (c) => { c.emit('capability.invoked', { capability: 'page' }); return 'ok'; } }), { turnId: 'x1' });
  const inv = events.find((e) => e.type === 'capability.invoked');
  assert.equal(inv.payload.turnId, 'x1');
});

test('the surface is recorded, so every entry point is distinguishable', async () => {
  const { runner, events } = mkRunner();
  await runner.run(defineLoop({ id: 'scribe', kind: 'meeting', run: () => 'notes' }));
  assert.equal(events[0].payload.kind, 'meeting');
});

test('a background loop is marked as such', async () => {
  const { runner, events } = mkRunner();
  await runner.run(defineLoop({ id: 'title', kind: 'note', background: true, run: () => 'A title' }));
  assert.equal(events[0].payload.background, true);
});

// ---- the guard runs below the loop, which is the point of P15 ----

test('a security guard can deny a turn before anything runs', async () => {
  const k = createKernel();
  k.define({ id: 'security', activate: (ctx) => ctx.guard('turn.start', (req) => (req.kind === 'watch' ? false : null)) });
  await k.start();
  const { runner, events } = mkRunner({ decide: k.decide });

  let ran = false;
  await assert.rejects(
    () => runner.run(defineLoop({ id: 'w', kind: 'watch', run: () => { ran = true; } })),
    (e) => e instanceof LoopError && e.code === 'DENIED',
  );
  assert.equal(ran, false, 'the loop ran despite being denied');
  // A denied turn leaves no started/ended pair — it never began.
  assert.deepEqual(events.map((e) => e.type), ['policy.denied']);
});

test('a permitted turn is unaffected by the presence of guards', async () => {
  const k = createKernel();
  k.define({ id: 'security', activate: (ctx) => ctx.guard('turn.start', () => null) });
  await k.start();
  const { runner, types } = mkRunner({ decide: k.decide });
  assert.equal(await runner.run(defineLoop({ id: 'ok', run: () => 'yes' })), 'yes');
  assert.deepEqual(types(), ['turn.started', 'turn.ended']);
});

// ---- purity: the package must not invent identity or read a clock ----

test('the runner refuses to be built without an id source', () => {
  assert.throws(() => createTurnRunner({}), (e) => e.code === 'BAD_RUNNER');
});

test('duration comes from the injected clock, so replay is reproducible', async () => {
  let t = 0;
  const events = [];
  const runner = createTurnRunner({ now: () => (t += 100), newId: () => 'z', emit: (type, p) => events.push({ type, p }) });
  await runner.run(defineLoop({ id: 'timed', run: () => 'ok' }));
  assert.equal(events.at(-1).p.ms, 100);
});

test('a loop contributes facts to its turn without gaining control of it', async () => {
  const { runner, events } = mkRunner();
  await runner.run(defineLoop({ id: 'chat', kind: 'chat', run: (c) => { c.report({ tokensIn: 4100, tokensOut: 320, model: 'x' }); return 'ok'; } }), { turnId: 'r1' });
  const ended = events.at(-1).payload;
  assert.equal(ended.tokensIn, 4100);
  assert.equal(ended.model, 'x');
  assert.equal(ended.reason, 'ok');
});

test('a loop cannot overwrite the fields the runner owns', async () => {
  // Rewriting its own turnId or reason would be holding lifetime again under another name.
  const { runner, events } = mkRunner();
  await runner.run(
    defineLoop({ id: 'sneaky', kind: 'chat', run: (c) => { c.report({ turnId: 'other', reason: 'ok', ms: 0, kind: 'note' }); throw new Error('x'); } }),
    { turnId: 'r2' },
  ).catch(() => {});
  const ended = events.at(-1).payload;
  assert.equal(ended.turnId, 'r2');
  assert.equal(ended.reason, 'error');
  assert.equal(ended.kind, 'chat');
  assert.ok(ended.ms > 0);
});

test('facts reported before a throw still reach the record', async () => {
  const { runner, events } = mkRunner();
  await runner.run(defineLoop({ id: 'partial', run: (c) => { c.report({ tokensIn: 12 }); throw new Error('boom'); } })).catch(() => {});
  assert.equal(events.at(-1).payload.tokensIn, 12);
});

test('duration counts from when the user acted, not when the model call started', async () => {
  // Setup — assembling tools, connecting to MCP servers — is time the user waited. A
  // duration that starts at the model call reported 2.6s for a message that took 48.
  let t = 10_000;
  const events = [];
  const runner = createTurnRunner({ now: () => t, newId: () => 'z', emit: (type, p) => events.push({ type, p }) });
  await runner.run(defineLoop({ id: 'slow', run: () => { t = 58_000; return 'ok'; } }), { startedAt: 10_000 });
  assert.equal(events.at(-1).p.ms, 48_000);
});

test('a caller that does not know when the user acted still gets a sane duration', async () => {
  let t = 0;
  const events = [];
  const runner = createTurnRunner({ now: () => (t += 250), newId: () => 'z', emit: (type, p) => events.push({ type, p }) });
  await runner.run(defineLoop({ id: 'x', run: () => 'ok' }));
  assert.ok(events.at(-1).p.ms >= 0);
});
