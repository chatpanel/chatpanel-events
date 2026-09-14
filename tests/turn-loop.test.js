import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runTurnLoop, createCallRunner, roundCap, addUsage, withToolSystem, describeCall, stepResultText,
  openAiTranscript, anthropicTranscript, FINISH_NUDGES, LOOPING_NUDGE, DEFAULT_MAX_ROUNDS,
} from '../turn-loop.js';
import { createToolLoopGuard } from '../tool-loop-guard.js';
import { traitsIndex } from '../tool-traits.js';

/** A scripted model: each entry is what one request answers with. */
function scripted(turns, log = []) {
  let i = 0;
  return async (req) => {
    log.push(req);
    const t = turns[Math.min(i, turns.length - 1)];
    i += 1;
    const out = typeof t === 'function' ? t(req) : t;
    if (out.text && req.onDelta) req.onDelta(out.text);
    return { ok: true, ...out };
  };
}

const call = (id, name, input) => ({ id, name, arguments: JSON.stringify(input) });

function toolset({ onExec = null, specs = null } = {}) {
  const list = specs || [
    { name: 'web_search', description: 'search', parameters: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
    { name: 'note_write', description: 'write', parameters: { type: 'object', properties: {} } },
    { name: 'page', description: 'page', parameters: { type: 'object', properties: {} } },
  ];
  const ran = [];
  return {
    ran,
    specs: list,
    traits: traitsIndex(list),
    system: 'Use tools.',
    async execute(name, input) {
      ran.push([name, input]);
      if (onExec) return onExec(name, input);
      return `${name} → ${JSON.stringify(input)}`;
    },
  };
}

test('a turn without tools, or a model that never calls one, is one request', async () => {
  const log = [];
  const res = await runTurnLoop({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: scripted([{ text: 'hi back' }], log) });
  assert.equal(res.ok, true);
  assert.equal(res.text, 'hi back');
  assert.equal(res.rounds, 1);
  assert.equal(log.length, 1);
  assert.equal(log[0].tools, null);
  assert.deepEqual(res.transcript.at(-1), { role: 'assistant', content: 'hi back' });
});

test('the model asks, the tool runs, the answer goes back in the OpenAI shape, and text said before is kept in front', async () => {
  const tools = toolset();
  const log = [];
  const stream = scripted([
    { text: 'Let me check.', toolCalls: [call('c1', 'web_search', { query: 'x' })] },
    { text: 'Done: 42.' },
  ], log);
  const deltas = [];
  const msgs = [];
  const res = await runTurnLoop({ model: 'm', messages: [{ role: 'user', content: 'q' }], tools, stream, onDelta: (d, t) => deltas.push([d, t]), onMessage: (m) => msgs.push(m) });
  assert.equal(res.text, 'Let me check.\n\nDone: 42.');
  assert.equal(deltas.at(-1)[1], 'Let me check.\n\nDone: 42.');
  assert.deepEqual(deltas.map((d) => d[0]), ['Let me check.', '\n\n', 'Done: 42.'], 'the separator is a delta too, so a client accumulating deltas agrees with the return');
  assert.deepEqual(tools.ran, [['web_search', { query: 'x' }]]);
  assert.equal(log[0].tools.length, 3, 'canonical specs offered');
  assert.equal(log[1].messages.at(-2).role, 'assistant');
  assert.equal(log[1].messages.at(-2).tool_calls[0].function.arguments, '{"query":"x"}');
  assert.deepEqual(log[1].messages.at(-1), { role: 'tool', tool_call_id: 'c1', content: 'web_search → {"query":"x"}' });
  assert.equal(msgs.length, 3, 'asked, answered, said — each the moment it existed');
  assert.equal(res.steps.length, 1);
  assert.equal(res.steps[0].action, 'web_search');
  assert.equal(res.steps[0].model, 'm');
  assert.equal(res.rounds, 2);
});

test('the round cap: the last request offers no tools, and the turn is marked exhausted', async () => {
  const tools = toolset();
  let n = 0;
  const stream = async (req) => {
    n += 1;
    if (!req.tools) return { ok: true, text: 'last words' };
    return { ok: true, text: '', toolCalls: [call(`c${n}`, 'web_search', { query: `q${n}` })] };
  };
  const res = await runTurnLoop({ model: 'm', messages: [], tools, stream, maxRounds: 3 });
  assert.equal(n, 3, 'the cap counts model requests, the last one without tools');
  assert.equal(res.text, 'last words');
  assert.equal(res.exhausted, true);
  assert.equal(res.rounds, 3);
});

test('a relayed agent that keeps calling tools on the closing request is told the budget is spent until it answers', async () => {
  const tools = toolset();
  const script = [];
  for (let i = 0; i < 2; i += 1) script.push({ text: '', toolCalls: [call(`c${i}`, 'web_search', { query: `q${i}` })] });
  script.push({ text: '', toolCalls: [call('c20', 'web_search', { query: 'late' })] });
  script.push({ text: '', toolCalls: [call('c21', 'web_search', { query: 'later' })] });
  script.push({ text: 'Findings.' });
  const log = [];
  const res = await runTurnLoop({ model: 'm', messages: [], tools, stream: scripted(script, log), maxRounds: 3 });
  assert.equal(res.ok, true);
  assert.equal(res.exhausted, true);
  assert.equal(res.text, 'Findings.');
  assert.equal(tools.ran.length, 2, 'the late calls never ran');
  const closing = log.slice(2);
  assert.ok(closing.every((r) => r.tools === null));
  assert.equal(closing[1].messages.at(-1).content, FINISH_NUDGES[0]);
  assert.equal(closing[2].messages.at(-1).content, FINISH_NUDGES[1]);
});

test('a closing request that never yields words ends after maxFinishTries', async () => {
  const tools = toolset();
  const stream = scripted([{ text: '', toolCalls: [call('c', 'web_search', { query: 'q' })] }]);
  const res = await runTurnLoop({ model: 'm', messages: [], tools, stream, maxRounds: 2, maxFinishTries: 2 });
  assert.equal(res.exhausted, true);
  assert.equal(res.rounds, 4);
});

test('the same READ over and over is answered from memory and the model is made to answer; a WRITE is refused', async () => {
  const tools = toolset();
  const same = call('c', 'web_search', { query: 'same' });
  const script = [];
  for (let i = 0; i < 8; i += 1) script.push({ toolCalls: [same] });
  script.push({ text: 'fine' });
  const log = [];
  const res = await runTurnLoop({ model: 'm', messages: [{ role: 'user', content: 'q' }], tools, stream: scripted(script, log) });
  assert.equal(res.text, 'fine');
  // Round 1 runs; round 2 is byte-identical → stalled → round 3 offers nothing.
  assert.equal(tools.ran.length, 2);
  assert.equal(log[2].tools, null, 'a stalled turn is offered no more tools');

  const w = toolset();
  const write = call('w', 'note_write', { body: 'x' });
  const guard = createToolLoopGuard({ maxIdenticalCalls: 1, maxStalledRounds: 99 });
  const r2 = await runTurnLoop({ model: 'm', messages: [], tools: w, guard, stream: scripted([{ toolCalls: [write] }, { toolCalls: [write] }, { text: 'ok' }]) });
  assert.equal(w.ran.length, 1, 'the repeated write did not run');
  assert.equal(r2.steps[1].status.startsWith('blocked:'), true);
});

test('looping: after enough replays a system nudge is added to the transcript', async () => {
  const tools = toolset();
  const same = call('c', 'web_search', { query: 'same' });
  const guard = createToolLoopGuard({ maxIdenticalCalls: 1, maxRepeats: 1, maxStalledRounds: 99 });
  const log = [];
  await runTurnLoop({ model: 'm', messages: [], tools, guard, stream: scripted([{ toolCalls: [same] }, { toolCalls: [same] }, { text: 'ok' }], log) });
  assert.equal(log[2].messages.at(-1).content, LOOPING_NUDGE);
  assert.equal(log[2].tools, null);
});

test('a screenshot goes back as a user image message after the tool messages, or as a note without vision', async () => {
  const tools = toolset({ onExec: (name, input) => (input.action === 'screenshot' ? { text: 'shot', image: 'data:image/png;base64,AAA' } : 'x') });
  const round = [call('a', 'page', { action: 'screenshot' }), call('b', 'web_search', { query: 'q' })];
  const log = [];
  await runTurnLoop({ model: 'm', messages: [], tools, stream: scripted([{ toolCalls: round }, { text: 'seen' }], log) });
  const tail = log[1].messages.slice(-3);
  assert.deepEqual(tail.map((m) => m.role), ['tool', 'tool', 'user']);
  assert.equal(tail[2].content[1].image_url.url, 'data:image/png;base64,AAA');
  const log2 = [];
  await runTurnLoop({ model: 'm', messages: [], tools, stream: scripted([{ toolCalls: round, noVision: true }, { text: 'seen' }], log2) });
  assert.match(log2[1].messages.at(-1).content, /omitted — this model has no vision/);
});

test('the Anthropic transcript echoes the blocks and answers a round in one user turn', async () => {
  const tools = toolset({ onExec: (name, input) => (input.action === 'screenshot' ? { text: 'shot', image: 'data:image/png;base64,QUJD' } : 'found') });
  const blocks = [{ type: 'text', text: 'Looking.' }, { type: 'text', text: '' }, { type: 'tool_use', id: 'a', name: 'page', json: '{"action":"screenshot"}' }, { type: 'tool_use', id: 'b', name: 'web_search', json: '{"query":"q"}' }];
  const log = [];
  const res = await runTurnLoop({
    model: 'claude', messages: [{ role: 'user', content: 'q' }], tools, transcript: anthropicTranscript,
    stream: scripted([{ text: 'Looking.', blocks, toolCalls: [{ id: 'a', name: 'page', input: { action: 'screenshot' } }, { id: 'b', name: 'web_search', input: { query: 'q' } }] }, { text: 'Done.' }], log),
  });
  assert.equal(res.text, 'Looking.\n\nDone.');
  const asked = log[1].messages.at(-2);
  assert.equal(asked.role, 'assistant');
  assert.deepEqual(asked.content.map((b) => b.type), ['text', 'tool_use', 'tool_use'], 'empty text dropped, order kept');
  assert.deepEqual(asked.content[1].input, { action: 'screenshot' });
  const answered = log[1].messages.at(-1);
  assert.equal(answered.role, 'user');
  assert.equal(answered.content.length, 2);
  assert.equal(answered.content[0].content[0].type, 'image');
  assert.equal(answered.content[0].content[0].source.data, 'QUJD');
  assert.equal(answered.content[1].content, 'found');
});

test('usage adds up across rounds in both key styles; an unreported turn is estimated on the usage event', async () => {
  const tools = toolset();
  const events = [];
  const res = await runTurnLoop({
    model: 'm', messages: [{ role: 'user', content: 'hello there' }], tools, usageLabel: { provider: 'openai', model: 'gpt' },
    stream: scripted([{ toolCalls: [call('c', 'web_search', { query: 'q' })], usage: { prompt_tokens: 10, completion_tokens: 2 } }, { text: 'ok', usage: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 3 } }]),
    onEvent: (e) => events.push(e),
  });
  assert.equal(res.usage.inputTokens, 15);
  assert.equal(res.usage.prompt_tokens, 15);
  assert.equal(res.usage.outputTokens, 3);
  assert.equal(res.usage.cacheReadTokens, 3);
  assert.equal(res.usage.total_tokens, 18);
  assert.equal(res.usage.calls, 2);
  const u = events.find((e) => e.type === 'usage');
  assert.equal(u.estimated, false);
  assert.equal(u.provider, 'openai');
  assert.deepEqual(events.filter((e) => e.type === 'tool').map((e) => e.phase), ['start', 'done']);
  assert.equal(events.at(-1).type, 'usage');
  assert.equal(events.at(-2).type, 'finish');

  const events2 = [];
  await runTurnLoop({ model: 'm', messages: [{ role: 'user', content: 'x'.repeat(40) }], stream: scripted([{ text: 'y'.repeat(8) }]), onEvent: (e) => events2.push(e) });
  const e = events2.find((x) => x.type === 'usage');
  assert.equal(e.estimated, true);
  assert.equal(e.inputTokens, 10);
  assert.equal(e.outputTokens, 2);
  assert.equal(addUsage(null, null), null);
  assert.equal(addUsage({ usd: 0.1 }, { cost: 0.2 }).usd, 0.30000000000000004);
});

test('a failed request ends the turn with what was said; an abort keeps the words and the transcript', async () => {
  const tools = toolset();
  const r1 = await runTurnLoop({ model: 'm', messages: [], tools, stream: async () => ({ ok: false, error: 'gateway down', text: '' }) });
  assert.equal(r1.ok, false);
  assert.equal(r1.error, 'gateway down');
  const r2 = await runTurnLoop({ model: 'm', messages: [], tools, stream: async () => ({ ok: true, aborted: true, text: 'partial' }) });
  assert.equal(r2.aborted, true);
  assert.equal(r2.ok, true);
  assert.equal(r2.text, 'partial');
  assert.deepEqual(r2.transcript.at(-1), { role: 'assistant', content: 'partial' });
  // A signal that fires while the tools run ends the turn after the round, not mid-call.
  const ac = new AbortController();
  const t = toolset({ onExec: () => { ac.abort(); return 'done'; } });
  const r3 = await runTurnLoop({ model: 'm', messages: [], tools: t, signal: ac.signal, stream: scripted([{ text: 'first', toolCalls: [call('c', 'web_search', { query: 'q' })] }, { text: 'never' }]) });
  assert.equal(r3.aborted, true);
  assert.equal(r3.text, 'first');
  assert.equal(r3.transcript.filter((m) => m.role === 'tool').length, 1);
  // A thrown error propagates untouched — the extension's failover reads it.
  await assert.rejects(runTurnLoop({ model: 'm', messages: [], stream: async () => { throw new Error('402 credits'); } }), /402 credits/);
});

test('a tool suppressed by the adaptive policy is withheld on the next round', async () => {
  const tools = toolset({ onExec: (name) => (name === 'note_write' ? JSON.stringify({ error: 'MCP error -32602: Invalid request parameters' }) : 'ok') });
  const log = [];
  await runTurnLoop({ model: 'm', messages: [], tools, stream: scripted([{ toolCalls: [call('a', 'note_write', { x: 1 })] }, { toolCalls: [call('b', 'web_search', { query: 'q' })] }, { text: 'ok' }], log) });
  assert.equal(log[0].tools.length, 3);
  assert.ok(!log[1].tools.some((s) => s.name === 'note_write'), 'the tool that rejected its own parameters is off the menu');
});

test('the call runner answers a call on its own (a relayed agent) with the same guard, and caps the calls', async () => {
  const tools = toolset();
  const steps = [];
  const runner = createCallRunner({ tools, maxCalls: 2, onStep: (s) => steps.push(s), modelLabel: () => 'claude/opus' });
  assert.equal(await runner.one({ id: '1', name: 'web_search', arguments: '{"query":"a"}' }), 'web_search → {"query":"a"}');
  assert.equal(await runner.one({ id: '2', name: 'web_search', input: { query: 'b' } }, { session: 's' }), 'web_search → {"query":"b"}');
  assert.equal(runner.exhausted, true);
  const spent = JSON.parse(await runner.one({ id: '3', name: 'web_search', input: { query: 'c' } }));
  assert.equal(spent.budget, 'spent');
  assert.equal(spent.message, FINISH_NUDGES[0], 'the first stray call gets the first nudge');
  assert.equal(tools.ran.length, 2);
  assert.equal(steps.filter((s) => s.phase === 'done').length, 3);
  assert.equal(steps[0].model, 'claude/opus');
  // A throwing tool still produces a result — the bridge is blocked until one is posted.
  const bad = createCallRunner({ tools: { specs: [], execute: async () => { throw new Error('boom'); } } });
  assert.match(await bad.one({ id: 'x', name: 't', input: {} }), /boom/);
});

test('roundCap: the agent wins, then the preference, then the default; no tools is one request', () => {
  assert.equal(roundCap({ tools: null }), 1);
  assert.equal(roundCap({ tools: { specs: [{}] } }), DEFAULT_MAX_ROUNDS);
  assert.equal(roundCap({ tools: { specs: [{}] }, settings: { ui: { maxToolRoundsPerTurn: 12 } } }), 12);
  assert.equal(roundCap({ tools: { specs: [{}] }, agent: { maxRequestsPerTurn: 5 }, settings: { ui: { maxToolRoundsPerTurn: 12 } } }), 5);
  assert.equal(roundCap({ tools: { specs: [{}] }, agent: { maxRequestsPerTurn: 500 } }), DEFAULT_MAX_ROUNDS, 'the ceiling holds');
  assert.equal(roundCap({ tools: { specs: [{}] }, settings: { ui: { maxToolRoundsPerTurn: 0 } } }), DEFAULT_MAX_ROUNDS, '0 = default');
});

test('helpers: system merge, step description, result slice, transcripts', () => {
  assert.deepEqual(withToolSystem([{ role: 'user', content: 'u' }], 'T'), [{ role: 'system', content: 'T' }, { role: 'user', content: 'u' }]);
  assert.deepEqual(withToolSystem([{ role: 'system', content: 'S' }], 'T'), [{ role: 'system', content: 'S\n\nT' }]);
  assert.equal(describeCall('find', { action: 'web_search', args: { query: 'ORCL' } }), 'web_search "ORCL"');
  assert.equal(describeCall('get_result', {}), 'get_result');
  assert.equal(stepResultText('x'.repeat(5000)).length, 4001);
  const asked = openAiTranscript.asked({ text: '' }, [{ id: '1', name: 't', input: { a: 1 } }]);
  assert.equal(asked.content, null);
  assert.equal(asked.tool_calls[0].function.arguments, '{"a":1}');
  assert.deepEqual(anthropicTranscript.system('s'), { role: 'user', content: 's' });
});
