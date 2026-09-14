import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourcePolicySettings, sourceUrlsOf, sourceGuardFor, sourceGate, isSourceGateError, withinReach } from '../source-gate.js';
import { createCitationCollector } from '../citations.js';
import { PREF_SECTION_IDS, pickSections } from '../client-prefs.js';

test('the policy: built-ins until the user edits the list; an edited list is theirs, even empty', () => {
  const d = sourcePolicySettings(undefined);
  assert.equal(d.enabled, true);
  assert.ok(d.patterns.includes('localhost'));
  assert.equal(d.ceiling, 'device');
  const edited = sourcePolicySettings({ internalPatterns: [], internalGuard: true, internalCeiling: 'trusted' });
  assert.deepEqual(edited.patterns, []);
  assert.equal(edited.ceiling, 'trusted');
  assert.equal(sourcePolicySettings({ internalPatterns: 'Wiki.example, jira.example' }).patterns.join(','), 'wiki.example,jira.example');
  assert.equal(sourcePolicySettings({ internalGuard: false }).enabled, false);
});

test('sources are every address the conversation carries — attachments, bodies, and what the caller states', () => {
  const urls = sourceUrlsOf([
    { role: 'user', content: 'see http://localhost:3000/admin and https://example.com/x', attachments: [{ url: 'https://wiki.internal/page' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'not a string' }] },
  ], ['https://jira.example/T-1', { url: 'https://h.example' }]);
  assert.deepEqual(urls, ['https://wiki.internal/page', 'http://localhost:3000/admin', 'https://example.com/x', 'https://jira.example/T-1', 'https://h.example']);
});

test('the gate refuses a remote model for internal content, lets a local one through, and says which rule and the way out', () => {
  const policy = sourcePolicySettings({});
  const messages = [{ role: 'user', content: 'summarise http://localhost:8080/report' }];
  const remote = sourceGate({ policy, messages, target: { kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1' }, label: 'openrouter/free' });
  assert.equal(remote.blocked, true);
  assert.equal(remote.reach, 'device');
  assert.match(remote.message, /^Not sent: localhost matches 'localhost' — kept on this device\. "openrouter\/free" is outside that/);
  assert.match(remote.message, /Settings → Privacy → Internal sites/);
  assert.equal(isSourceGateError(new Error(remote.message)), true);
  assert.equal(isSourceGateError(new Error('HTTP 402')), false);
  assert.equal(sourceGate({ policy, messages, target: { kind: 'openai', baseUrl: 'http://localhost:11434/v1' } }), null, 'a local model is within reach');
  // A bridge agent is TRUSTED, not device: with the default 'device' ceiling it is refused;
  // with a 'trusted' ceiling it may answer.
  assert.equal(sourceGate({ policy, messages, target: { kind: 'bridge' } })?.blocked, true);
  assert.equal(sourceGate({ policy: sourcePolicySettings({ internalCeiling: 'trusted' }), messages, target: { kind: 'bridge' } }), null);
  assert.match(sourceGate({ policy: sourcePolicySettings({ internalCeiling: 'trusted' }), messages, target: { kind: 'openai', baseUrl: 'https://api.openai.com' } }).message, /stay inside your workspace/);
  // A target whose reach the caller already knows is taken at its word.
  assert.equal(sourceGate({ policy, messages, target: { reach: 'device' } }), null);
  // No internal source, or the guard off: nothing to gate.
  assert.equal(sourceGate({ policy, messages: [{ role: 'user', content: 'hi' }], target: { kind: 'openai', baseUrl: 'https://x.example' } }), null);
  assert.equal(sourceGate({ policy: sourcePolicySettings({ internalGuard: false }), messages, target: { kind: 'openai', baseUrl: 'https://x.example' } }), null);
  assert.equal(sourceGuardFor(policy, []), null);
});

test('withinReach narrows a roster to what the guard allows — so Codex is appointed, not refused', () => {
  const policy = sourcePolicySettings({ internalCeiling: 'trusted' });
  const guard = sourceGuardFor(policy, ['http://localhost:3000']);
  const roster = [
    { id: 'or', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1' },
    { id: 'codex', kind: 'bridge', bridgeAgent: 'codex' },
    { id: 'ollama', kind: 'openai', baseUrl: 'http://127.0.0.1:11434/v1' },
    { id: 'known', reach: 'any' },
  ];
  assert.deepEqual(withinReach(roster, guard).map((c) => c.id), ['codex', 'ollama']);
  assert.deepEqual(withinReach(roster, sourceGuardFor(sourcePolicySettings({}), ['http://localhost:3000'])).map((c) => c.id), ['ollama'], 'a device ceiling keeps only the device');
  assert.equal(withinReach(roster, null).length, 4);
});

test('the internal-sites policy travels in the shared preferences', () => {
  assert.ok(PREF_SECTION_IDS.includes('internalSites'));
  const s = pickSections({ privacy: { internalGuard: true, internalPatterns: ['wiki.example'] }, ui: {} });
  assert.deepEqual(s.internalSites, { internalGuard: true, internalPatterns: ['wiki.example'] });
});

test('the citation collector gathers numbered sources as tools return them, reports retrieval, and links the answer', async () => {
  const retrieved = [];
  const tools = { specs: [], async execute(name) { return name === 'find' ? 'Results:\n[1] [ORCL closed](https://example.com/orcl) — 150.28\n[2] [Earnings](https://example.com/q) — up' : 'nothing here'; } };
  const c = createCitationCollector(tools, { onRetrieved: (r) => retrieved.push(r) });
  assert.match(await c.tools.execute('find', {}), /^Results/);
  await c.tools.execute('history_search', {});
  await c.tools.execute('note_write', {});
  assert.equal(c.list().length, 2);
  assert.deepEqual(retrieved.map((r) => [r.tool, r.count]), [['find', 2], ['history_search', 0]], 'a retrieval tool with no links is still reported; a write is not');
  const out = c.apply('It closed at 150.28 [1] and earnings were up [2].');
  assert.match(out, /\[1\]\(https:\/\/example\.com\/orcl\)/);
  assert.match(out, /Sources/);
  assert.equal(c.apply(''), '');
  assert.equal(createCitationCollector(tools).apply('no sources [1]'), 'no sources [1]', 'nothing retrieved, nothing invented');
  assert.equal(createCitationCollector(null).tools, null);
});
