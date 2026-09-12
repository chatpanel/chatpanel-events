import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortRecords, filterRecords, groupRecords, dayBucket, rowTime, sortStamp } from '../record-list.js';

const NOW = new Date('2026-09-12T10:00:00').getTime();
const H = 3_600_000; const D = 24 * H;
const rows = [
  { id: 'a', title: 'stock price of orcl', snippet: 'Apple performed better', updatedAt: NOW - H, createdAt: NOW - 2 * H },
  { id: 'b', title: 'Cutover questions', snippet: 'rollback plan', updatedAt: NOW - 3 * H, createdAt: NOW - 3 * D },
  { id: 'c', title: 'what is 1+3', snippet: 'Assistant: 4', updatedAt: NOW - D - H, createdAt: NOW - D - H },
  { id: 'd', title: 'Minecraft mods', snippet: '', updatedAt: NOW - 4 * D, createdAt: NOW - 4 * D },
  { id: 'e', title: 'August planning', snippet: '', updatedAt: NOW - 30 * D, createdAt: NOW - 30 * D },
];

test('recent sorts by last activity, started by creation, title alphabetically', () => {
  assert.deepEqual(sortRecords(rows, 'recent').map((r) => r.id), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(sortRecords(rows, 'started').map((r) => r.id), ['a', 'c', 'b', 'd', 'e']);
  assert.deepEqual(sortRecords(rows, 'title').map((r) => r.id), ['e', 'b', 'd', 'a', 'c']);
  assert.equal(sortStamp({ createdAt: 5 }, 'recent'), 5, 'a record with no updatedAt sorts by when it was made');
});

test('the filter matches every word against title and snippet, any case', () => {
  assert.deepEqual(filterRecords(rows, 'apple ORCL').map((r) => r.id), ['a']);
  assert.deepEqual(filterRecords(rows, 'rollback').map((r) => r.id), ['b']);
  assert.equal(filterRecords(rows, '   ').length, rows.length);
  assert.equal(filterRecords(rows, 'nothing here').length, 0);
});

test('day buckets: today, yesterday, this week, this month, then months', () => {
  assert.equal(dayBucket(NOW - H, NOW).label, 'Today');
  assert.equal(dayBucket(NOW - D - H, NOW).label, 'Yesterday');
  assert.equal(dayBucket(NOW - 4 * D, NOW).label, 'Earlier this week');
  assert.equal(dayBucket(NOW - 9 * D, NOW).label, 'Earlier this month');
  assert.equal(dayBucket(NOW - 30 * D, NOW).label, 'August');
  assert.equal(dayBucket(NOW - 400 * D, NOW).label, 'August 2025');
  assert.equal(dayBucket(0, NOW).label, 'Undated');
});

test('a row shows a clock today and yesterday, a weekday this week, a date after', () => {
  assert.match(rowTime(NOW - H, NOW), /9:00/);
  assert.match(rowTime(NOW - D - H, NOW), /9:00/);
  assert.equal(rowTime(NOW - 4 * D, NOW), 'Tuesday');
  assert.match(rowTime(NOW - 30 * D, NOW), /Aug 13/);
  assert.match(rowTime(NOW - 400 * D, NOW), /2025/);
  assert.equal(rowTime(0, NOW), '');
});

test('groupRecords sorts, filters and files rows under headings in reading order', () => {
  const g = groupRecords(rows, { now: NOW });
  assert.deepEqual(g.map((x) => x.label), ['Today', 'Yesterday', 'Earlier this week', 'August']);
  assert.deepEqual(g[0].items.map((r) => r.id), ['a', 'b']);
  const started = groupRecords(rows, { now: NOW, mode: 'started' });
  assert.deepEqual(started[0].items.map((r) => r.id), ['a'], 'started files by creation');
  const byTitle = groupRecords(rows, { now: NOW, mode: 'title' });
  assert.equal(byTitle.length, 1);
  assert.equal(byTitle[0].label, '');
  assert.deepEqual(groupRecords(rows, { now: NOW, query: 'zzz' }), []);
});
