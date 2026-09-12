import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createResultStore, shieldToolResult, runResultQuery, withResultShield, describeShape, compactValue,
  RESULT_TOOL_NAME, resultToolSpec,
} from '../tool-result.js';

const issues = (n) => Array.from({ length: n }, (_, i) => ({
  id: i + 1, key: `ATLAS-${i + 1}`, summary: `Issue number ${i + 1} about the thing`, status: i % 3 ? 'open' : 'done',
  description: 'x'.repeat(600), assignee: { name: 'Alex Rivera', id: `u${i}` },
}));

let seq = 0;
const store = () => createResultStore({ now: () => 1000, newId: () => `r_${++seq}` });

test('a small result passes through untouched', () => {
  const out = shieldToolResult('{"ok":true}', { store: store(), maxChars: 100 });
  assert.equal(out.truncated, false);
  assert.equal(out.text, '{"ok":true}');
});

test('a large JSON array is previewed, stored, and the note says how to page it', () => {
  const s = store();
  const full = JSON.stringify(issues(240));
  const out = shieldToolResult(full, { tool: 'mcp_jira__search', store: s, maxChars: 8000 });
  assert.equal(out.truncated, true);
  assert.ok(out.text.length < full.length / 4, 'the preview is a fraction of the result');
  assert.ok(out.text.length <= 8000 + 800, `preview + note stays near the budget (${out.text.length})`);
  assert.equal(out.shape.kind, 'array');
  assert.equal(out.shape.items, 240);
  assert.ok(out.shape.keys.includes('summary'));
  // The retrieval note is the point: a ref, the shape, and a call the model can send as-is.
  assert.match(out.text, /stored as ref "r_\d+"/);
  assert.match(out.text, /an array of 240 objects with keys id, key, summary/);
  assert.match(out.text, new RegExp(`\\{"ref":"${out.ref}","offset":\\d+,"limit":50\\}`));
  assert.equal(s.size, 1);
  assert.deepEqual(s.get(out.ref).value.length, 240, 'the FULL result is what was stored');
  // The preview itself is still valid JSON — a compacted copy, not a hard cut.
  const preview = JSON.parse(out.text.slice(0, out.text.lastIndexOf('\n[ChatPanel result shield')));
  assert.ok(Array.isArray(preview) && preview.length < 240);
});

test('a large plain-text result is cut and paged by character', () => {
  const s = store();
  const transcript = Array.from({ length: 2000 }, (_, i) => `line ${i}: the quick brown fox`).join('\n');
  const out = shieldToolResult(transcript, { store: s, maxChars: 5000 });
  assert.equal(out.truncated, true);
  assert.equal(out.shape.kind, 'text');
  assert.ok(out.text.startsWith('line 0:'));
  assert.match(out.text, /"offset":5000,"limit":8000\} continues the text/);
  const page = JSON.parse(runResultQuery(s, { ref: out.ref, offset: 5000, limit: 100 }));
  assert.equal(page.text.length, 100);
  assert.equal(page.chars, transcript.length);
  assert.deepEqual(page.next, { offset: 5100, limit: 100 });
  const found = JSON.parse(runResultQuery(s, { ref: out.ref, search: 'line 1999' }));
  assert.equal(found.matches.length, 1);
  assert.match(found.matches[0].excerpt, /line 1999: the quick/);
});

test('get_result pages, filters and projects an array; the page shrinks to fit', () => {
  const s = store();
  const out = shieldToolResult(JSON.stringify(issues(240)), { store: s, maxChars: 4000 });
  const p1 = JSON.parse(runResultQuery(s, { ref: out.ref, offset: 0, limit: 10, fields: ['key', 'status'] }));
  assert.equal(p1.total, 240);
  assert.equal(p1.count, 10);
  assert.deepEqual(Object.keys(p1.items[0]), ['key', 'status']);
  assert.deepEqual(p1.next, { offset: 10, limit: 10 });
  const done = JSON.parse(runResultQuery(s, { ref: out.ref, search: 'done', fields: ['key'] }));
  assert.equal(done.matched, 80);
  assert.ok(done.items.every((it) => /^ATLAS-/.test(it.key)));
  // Asking for 200 fat items with a 3,000-char budget: the page halves until it fits.
  const big = runResultQuery(s, { ref: out.ref, limit: 200 }, { maxChars: 3000 });
  assert.ok(big.length <= 3000, `page respects the budget (${big.length})`);
  assert.ok(JSON.parse(big).count < 200);
});

test('get_result descends a path and explains a wrong one', () => {
  const s = store();
  const value = { meta: { total: 3 }, data: { items: issues(3), note: 'n' } };
  const ref = s.put({ value });
  const items = JSON.parse(runResultQuery(s, { ref, path: 'data.items', limit: 2 }));
  assert.equal(items.count, 2);
  const one = JSON.parse(runResultQuery(s, { ref, path: 'data.items.1.key' }));
  assert.equal(one.text, 'ATLAS-2', 'a string leaf reads as text');
  const bad = JSON.parse(runResultQuery(s, { ref, path: 'data.rows' }));
  assert.match(bad.error, /No "rows" at "data"/);
  assert.deepEqual(bad.available, ['items', 'note']);
  const root = JSON.parse(runResultQuery(s, { ref }));
  assert.equal(root.shape.kind, 'object');
  assert.match(root.hint, /"data.items"/);
});

test('an unknown ref, and another owner\'s ref, are refused', () => {
  const s = store();
  const mine = s.put({ value: 'secret', owner: 'session-a' });
  assert.match(runResultQuery(s, { ref: 'r_nope' }), /Unknown or expired ref/);
  assert.match(runResultQuery(s, { ref: mine }, { owner: 'session-b' }), /Unknown or expired ref/);
  assert.match(runResultQuery(s, { ref: mine }, { owner: 'session-a' }), /secret/);
  // Unowned entries are readable by anyone — the single-user client case.
  const open = s.put({ value: 'open' });
  assert.match(runResultQuery(s, { ref: open }, { owner: 'whoever' }), /open/);
});

test('the store evicts oldest-first by count and by bytes', () => {
  const s = createResultStore({ maxEntries: 3, maxBytes: 100, newId: () => `r_${++seq}` });
  const a = s.put({ value: 'a'.repeat(40) });
  const b = s.put({ value: 'b'.repeat(40) });
  const c = s.put({ value: 'c'.repeat(40) }); // 120 bytes > 100 → a goes
  assert.equal(s.get(a), null);
  assert.ok(s.get(b) && s.get(c));
  s.put({ value: 'd' }); s.put({ value: 'e' }); s.put({ value: 'f' }); // count cap 3
  assert.equal(s.size, 3);
  assert.equal(s.get(b), null);
});

test('an envelope keeps the untrusted fence and puts the note OUTSIDE it', () => {
  const OPEN = '⟦EXTERNAL⟧\n';
  const CLOSE = '\n⟦/EXTERNAL⟧';
  const envelope = {
    open: (t) => (t.startsWith(OPEN) && t.endsWith(CLOSE) ? { body: t.slice(OPEN.length, -CLOSE.length), close: (b) => OPEN + b + CLOSE } : null),
  };
  const s = store();
  const out = shieldToolResult(OPEN + JSON.stringify(issues(100)) + CLOSE, { store: s, envelope, maxChars: 3000 });
  assert.equal(out.truncated, true);
  assert.ok(out.text.startsWith(OPEN));
  const fenceEnd = out.text.indexOf(CLOSE);
  const noteAt = out.text.indexOf('[ChatPanel result shield');
  assert.ok(fenceEnd > 0 && noteAt > fenceEnd, 'the retrieval note follows the closing fence');
  // The fence itself is not counted against the budget, so a body under the limit passes.
  const small = shieldToolResult(OPEN + '{"ok":1}' + CLOSE, { store: s, envelope, maxChars: 10 });
  assert.equal(small.truncated, false);
});

test('withResultShield adds get_result, shields results, and leaves exempt tools alone', async () => {
  const s = store();
  const calls = [];
  const toolset = {
    specs: [{ name: 'big', description: 'b', parameters: {} }, { name: 'page', description: 'p', parameters: {} }],
    system: 'sys',
    remoteTools: new Set(['big']),
    async execute(name) {
      calls.push(name);
      if (name === 'big') return JSON.stringify(issues(200));
      if (name === 'page') return { text: 'p'.repeat(9000), image: 'data:image/png;base64,x' };
      return 'small';
    },
  };
  const wrapped = withResultShield(toolset, { store: s, exempt: (n) => n === 'page', limits: { maxChars: 3000 } });
  assert.deepEqual(wrapped.specs.map((x) => x.name), ['big', 'page', RESULT_TOOL_NAME]);
  assert.equal(wrapped.system, 'sys', 'everything else on the toolset is kept');
  assert.ok(wrapped.remoteTools.has('big'));
  const big = await wrapped.execute('big', {});
  assert.match(big, /stored as ref/);
  const page = await wrapped.execute('page', {});
  assert.equal(page.text.length, 9000, 'an exempt tool is untouched');
  assert.ok(page.image);
  const ref = /ref "(r_\d+)"/.exec(big)[1];
  const paged = JSON.parse(await wrapped.execute(RESULT_TOOL_NAME, { ref, limit: 3, fields: ['key'] }));
  assert.equal(paged.count, 3);
  assert.deepEqual(calls, ['big', 'page'], 'get_result never reaches the underlying executor');
  // Wrapping twice does not double the spec.
  assert.equal(withResultShield(wrapped, { store: s }).specs.filter((x) => x.name === RESULT_TOOL_NAME).length, 1);
});

test('an object result with images keeps the image and shields only the text', async () => {
  const s = store();
  const toolset = { specs: [], async execute() { return { text: 'z'.repeat(10_000), image: 'data:x' }; } };
  const out = await withResultShield(toolset, { store: s, limits: { maxChars: 2000 } }).execute('t', {});
  assert.equal(out.image, 'data:x');
  assert.ok(out.text.length < 3000);
  assert.equal(out.shielded.totalChars, 10_000);
});

test('shape and compaction describe nested data faithfully', () => {
  const v = { a: { rows: issues(3), deep: { list: [1, 2] } }, b: 'x'.repeat(50) };
  const shape = describeShape(v);
  assert.equal(shape.kind, 'object');
  assert.deepEqual(shape.arrays.map((x) => x.path), ['a.rows', 'a.deep.list']);
  const c = compactValue(v, { maxStringChars: 10, maxArrayItems: 1 });
  assert.equal(c.truncated, true);
  assert.equal(c.value.a.rows.length, 2, 'one item plus the "+N more" marker');
  assert.match(c.value.b, /^x{10}…\[\+40 chars\]$/);
  assert.deepEqual(compactValue({ n: 1 }), { value: { n: 1 }, truncated: false });
});

test('the spec is read-only and small', () => {
  const spec = resultToolSpec();
  assert.equal(spec.annotations.readOnlyHint, true);
  assert.deepEqual(spec.parameters.required, ['ref']);
  assert.ok(JSON.stringify(spec).length < 1200, 'the spec is on every armed turn; it stays terse');
});
