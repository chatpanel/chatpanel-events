import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PREF_SECTION_IDS, pickSections, applySections, sectionValue, sectionHash, mergeStamped, changedSections } from '../client-prefs.js';

const settings = {
  version: 10, bridgeUrl: 'http://127.0.0.1:4319', bridgeToken: 'secret', activeAgentId: 'codex',
  endpoints: [{ id: 'e1', apiKey: 'sk-do-not-sync' }],
  mcpServers: [{ id: 'jira', url: 'https://mcp.example.com', enabled: true, headers: { Authorization: 'Bearer t' } }],
  skills: [{ id: 'summarize', command: 'summarize' }],
  recipes: [],
  ui: {
    theme: 'dark', webSearch: { enabled: true, engines: [{ id: 'startpage', enabled: true }] },
    mcpToolsMode: 'auto', maxToolsPerTurn: 24, historyTools: true,
    voice: { engine: 'pocket' }, meetingWindowMin: 45, alertSound: false, skillDirs: ['~/skills'],
  },
};

test('sections are cut out of the settings tree, and the secrets that must not travel are not among them', () => {
  const s = pickSections(settings);
  assert.deepEqual(s.mcpServers, settings.mcpServers);
  assert.deepEqual(s.tools, { mcpToolsMode: 'auto', maxToolsPerTurn: 24, historyTools: true });
  assert.deepEqual(s.meetings, { meetingWindowMin: 45, alertSound: false });
  assert.deepEqual(s.skillDirs, ['~/skills']);
  assert.equal(s.endpoints, undefined);
  assert.equal(s.bridgeToken, undefined);
  assert.equal(s.theme, undefined);
  assert.equal(sectionValue(settings, 'topics'), undefined, 'an absent section is absent, not {}');
  assert.equal(sectionValue(settings, 'nope'), undefined);
  for (const id of Object.keys(s)) assert.ok(PREF_SECTION_IDS.includes(id));
});

test('applySections puts values back where they live, without touching anything else', () => {
  const next = applySections(settings, {
    mcpServers: [{ id: 'linear', url: 'https://l.example.com' }],
    tools: { maxToolsPerTurn: 8 },
    voice: { engine: 'kokoro' },
    topics: { enabled: false },
    endpoints: [{ id: 'evil' }], // not a section — ignored
  });
  assert.deepEqual(next.mcpServers, [{ id: 'linear', url: 'https://l.example.com' }]);
  assert.equal(next.ui.maxToolsPerTurn, 8);
  assert.equal(next.ui.mcpToolsMode, 'auto', 'keys the section did not carry are kept');
  assert.deepEqual(next.ui.voice, { engine: 'kokoro' });
  assert.deepEqual(next.ui.topicExtraction, { enabled: false });
  assert.deepEqual(next.endpoints, settings.endpoints);
  assert.equal(next.ui.theme, 'dark');
  assert.notEqual(next, settings, 'a new object');
  assert.deepEqual(settings.mcpServers[0].id, 'jira', 'the input is untouched');
});

test('the hash ignores key order and sees a real change', () => {
  assert.equal(sectionHash({ a: 1, b: [1, { c: 2 }] }), sectionHash({ b: [1, { c: 2 }], a: 1 }));
  assert.notEqual(sectionHash({ a: 1 }), sectionHash({ a: 2 }));
});

test('mergeStamped: the newer stamp wins per section; ties keep local; each side learns what to write', () => {
  const local = { mcpServers: { value: ['L'], updatedAt: 100 }, tools: { value: { a: 1 }, updatedAt: 300 }, voice: { value: 'v', updatedAt: 50 } };
  const remote = { mcpServers: { value: ['R'], updatedAt: 200 }, tools: { value: { a: 2 }, updatedAt: 250 }, voice: { value: 'v', updatedAt: 50 }, skills: { value: ['s'], updatedAt: 10 } };
  const { merged, fromRemote, fromLocal } = mergeStamped(local, remote);
  assert.deepEqual(merged.mcpServers, { value: ['R'], updatedAt: 200 });
  assert.deepEqual(merged.tools, { value: { a: 1 }, updatedAt: 300 });
  assert.deepEqual(merged.skills, { value: ['s'], updatedAt: 10 });
  assert.deepEqual(fromRemote.sort(), ['mcpServers', 'skills']);
  assert.deepEqual(fromLocal, ['tools']);
  assert.deepEqual(mergeStamped({}, {}), { merged: {}, fromRemote: [], fromLocal: [] });
});

test('changedSections stamps only what differs from the last push, and only real sections', () => {
  const sections = { mcpServers: ['a'], tools: { x: 1 }, bogus: 1 };
  const last = { mcpServers: { hash: sectionHash(['a']) }, tools: { hash: sectionHash({ x: 0 }) } };
  const out = changedSections(sections, last, { now: 999 });
  assert.deepEqual(Object.keys(out), ['tools']);
  assert.deepEqual(out.tools, { value: { x: 1 }, updatedAt: 999 });
  assert.equal(Object.keys(changedSections(sections, {}, { now: 1 })).length, 2, 'first push sends everything real');
});
