import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  redactAccessArgs, makeAccessEvent, createAccessLog, makeStorageTier, formatBytes, ACCESS_LOG_VERSION,
} from '../observability.js';

test('redactAccessArgs NEVER records a search query (the whole point)', () => {
  // A search query can carry PII — the note must say a search happened, not what was searched.
  assert.equal(redactAccessArgs('search_history', { query: 'my SSN is 123-45-6789', limit: 5 }), 'limit=5');
  assert.equal(redactAccessArgs('list_history', { query: 'secret', limit: 10, offset: 20 }), 'limit=10 offset=20');
  // Unknown tools get nothing — whitelist, not blocklist.
  assert.equal(redactAccessArgs('mystery_tool', { anything: 'here' }), '');
  // Skill names / ids ARE safe and useful.
  assert.equal(redactAccessArgs('open_skill', { skill: 'grammar' }), 'skill=grammar');
  assert.equal(redactAccessArgs('read_skill_file', { skill: 'deploy', path: 'references/aws.md' }), 'skill=deploy path=references/aws.md');
  assert.equal(redactAccessArgs('get_record', { id: 'meeting_abc' }), 'id=meeting_abc');
});

test('redactAccessArgs caps long fields so content cannot smuggle through', () => {
  const long = 'a'.repeat(200);
  const note = redactAccessArgs('read_skill_file', { skill: 'x', path: long });
  assert.ok(note.length < 120, 'path is capped');
  assert.ok(note.endsWith('…'), 'truncation marked');
});

test('makeAccessEvent normalizes an untrusted client name and never leaks args', () => {
  const e = makeAccessEvent({ ts: 1000, client: '  Codex CLI  ', tool: 'search_history', ok: true, ms: 12.7, args: { query: 'PII here', limit: 3 } });
  assert.equal(e.v, ACCESS_LOG_VERSION);
  assert.equal(e.client, 'Codex CLI');
  assert.equal(e.tool, 'search_history');
  assert.equal(e.ms, 13);
  assert.equal(e.note, 'limit=3');
  assert.ok(!JSON.stringify(e).includes('PII here'), 'no query text anywhere in the event');
});

test('createAccessLog is a bounded ring, newest-first snapshot', () => {
  const log = createAccessLog(3);
  for (let i = 1; i <= 5; i++) log.push(makeAccessEvent({ ts: i, client: 'c', tool: 't' }));
  assert.equal(log.size, 3, 'capped at 3');
  const snap = log.snapshot();
  assert.deepEqual(snap.map((e) => e.ts), [5, 4, 3], 'newest first, oldest dropped');
  assert.deepEqual(log.snapshot(2).map((e) => e.ts), [5, 4], 'limit honored');
});

test('formatBytes + makeStorageTier', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  const t = makeStorageTier({ tier: 'warm', label: 'Gateway', records: 1061, bytes: 2_000_000, newest: 123 });
  assert.equal(t.records, 1061); assert.equal(t.present, true); assert.equal(t.newest, 123);
  const cold = makeStorageTier({ tier: 'cold', label: 'Cloud', present: false });
  assert.equal(cold.present, false); assert.equal(cold.records, null);
});
