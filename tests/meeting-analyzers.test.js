import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineMeetingAnalyzer, createAnalyzerRegistry, AnalyzerError } from '../meeting-analyzers.js';

const summary = defineMeetingAnalyzer({
  id: 'summary', label: 'Running summary', produces: 'summary',
  cadence: 'periodic', everyMs: 90_000, minTranscriptChars: 200,
  run: async ({ ask }) => ask('summarise'),
});
const insights = defineMeetingAnalyzer({
  id: 'insights', label: 'Decisions and actions', produces: 'sections', cadence: 'on-end',
  run: async () => ({}),
});

test('the model call is INJECTED, never imported', async () => {
  // An analyzer that imported a provider could not run in the gateway and could not be
  // tested without a network. Passing `ask` in is what keeps the contract portable.
  const calls = [];
  const out = await summary.run({ transcript: 'x', ask: async (p) => { calls.push(p); return 'done'; } });
  assert.equal(out, 'done');
  assert.deepEqual(calls, ['summarise']);
});

test('periodic analyzers run on their own interval, not every tick', () => {
  const reg = createAnalyzerRegistry();
  reg.add(summary);
  const due = (now, last) => reg.due({ now, lastRunAt: { summary: last }, transcriptChars: 5000 }).map((a) => a.id);
  assert.deepEqual(due(100_000, 0), ['summary'], 'a first run never happened');
  assert.deepEqual(due(100_000, 50_000), [], 'it ran again before its interval elapsed');
  assert.deepEqual(due(150_000, 50_000), ['summary']);
});

test('a short transcript is not worth a model call', () => {
  // An empty transcript summarised is a paragraph of apology.
  const reg = createAnalyzerRegistry();
  reg.add(summary);
  assert.deepEqual(reg.due({ now: 1e9, transcriptChars: 10 }), []);
});

test('cadences do not run each other', () => {
  const reg = createAnalyzerRegistry();
  reg.add(summary); reg.add(insights);
  assert.deepEqual(reg.due({ now: 1e9, transcriptChars: 5000 }).map((a) => a.id), ['summary']);
  assert.deepEqual(reg.due({ now: 1e9, cadence: 'on-end', transcriptChars: 5000 }).map((a) => a.id), ['insights']);
});

test('a disabled analyzer is never due', () => {
  const reg = createAnalyzerRegistry();
  reg.add(summary);
  assert.deepEqual(reg.due({ now: 1e9, transcriptChars: 5000, admit: (a) => a.id !== 'summary' }), []);
});

test('the registry does not remember when things ran', () => {
  // lastRunAt is passed in: a registry that stored it would be a second home for a fact the
  // meeting record already has to keep, and the two would drift.
  const reg = createAnalyzerRegistry();
  reg.add(summary);
  assert.equal(typeof reg.due, 'function');
  assert.ok(!('lastRunAt' in reg), 'the registry grew its own memory of run times');
});

test('a declaration that cannot work is rejected at declare time', () => {
  // A periodic analyzer with no interval would either never run or run every tick, and both
  // look like a bug in the analyzer rather than in its declaration.
  assert.throws(() => defineMeetingAnalyzer({ id: 'x', cadence: 'periodic', run: async () => {} }),
    (e) => e instanceof AnalyzerError && /everyMs/.test(e.message));
  assert.throws(() => defineMeetingAnalyzer({ id: 'x' }), (e) => e.code === 'BAD_ANALYZER');
  assert.throws(() => defineMeetingAnalyzer({ id: 'x', cadence: 'hourly', run: async () => {} }), (e) => e.code === 'BAD_ANALYZER');
});

test('registration is revertible', () => {
  const reg = createAnalyzerRegistry();
  const remove = reg.add(summary);
  assert.equal(reg.get('summary')?.id, 'summary');
  remove();
  assert.equal(reg.get('summary'), null);
});
