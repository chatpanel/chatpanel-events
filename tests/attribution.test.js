// Authorship: who wrote which run, and the versions you can go back to.
//
// The invariant under every test here is that the run-list SUMS TO THE BODY LENGTH. A
// ledger that drifts from its text does not fail loudly — it silently attributes the wrong
// paragraphs to the wrong author, which is worse than having no ledger at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HUMAN, blankAttribution, diffRange, mergeRuns, spliceAttribution, applyAttribution,
  attributionSummary, normalizeAttribution, pushVersion, restoreVersion, MAX_VERSIONS,
} from '../attribution.js';

const total = (runs) => runs.reduce((n, r) => n + r.len, 0);

test('a blank ledger covers the whole body, and an empty body has no runs', () => {
  assert.deepEqual(blankAttribution(5), [{ len: 5, author: HUMAN, at: 0 }]);
  assert.deepEqual(blankAttribution(0), []);
});

test('the diff is the MINIMAL replaced range, not the whole line', () => {
  assert.deepEqual(diffRange('hello world', 'hello brave world'), { start: 6, end: 6, insLen: 6 });
  assert.deepEqual(diffRange('abcdef', 'abcXYZdef'), { start: 3, end: 3, insLen: 3 });
  assert.deepEqual(diffRange('abcdef', 'abdef'), { start: 2, end: 3, insLen: 0 });
  assert.deepEqual(diffRange('same', 'same'), { start: 4, end: 4, insLen: 0 });
});

test('only the CHANGED span is reattributed — untouched text keeps its author', () => {
  const prev = 'The agent wrote this.';
  const runs = blankAttribution(prev.length, 'Claude', 100);
  const next = 'The agent wrote this. And I added a sentence.';
  const out = applyAttribution(runs, prev, next, HUMAN, 200);

  assert.equal(total(out), next.length, 'the ledger still sums to the body');
  assert.equal(out[0].author, 'Claude', 'the agent keeps what it wrote');
  assert.equal(out[0].len, prev.length);
  assert.equal(out[1].author, HUMAN);
});

test('an edit that changes nothing returns the ledger untouched', () => {
  const runs = blankAttribution(4);
  assert.equal(applyAttribution(runs, 'same', 'same', 'Claude', 1), runs);
});

test('deleting across a boundary shortens both authors and still sums', () => {
  // 'AAAABBBB' — four chars each.
  const runs = [{ len: 4, author: 'A', at: 1 }, { len: 4, author: 'B', at: 2 }];
  const out = spliceAttribution(runs, 2, 6, 0, HUMAN, 3);
  assert.equal(total(out), 4);
  assert.deepEqual(out, [{ len: 2, author: 'A', at: 1 }, { len: 2, author: 'B', at: 2 }]);
});

test('adjacent runs by the same author at the same moment are one run', () => {
  assert.deepEqual(
    mergeRuns([{ len: 2, author: 'A', at: 1 }, { len: 3, author: 'A', at: 1 }]),
    [{ len: 5, author: 'A', at: 1 }],
  );
  // ...but not when the moment differs — that is two separate contributions.
  assert.equal(mergeRuns([{ len: 2, author: 'A', at: 1 }, { len: 3, author: 'A', at: 2 }]).length, 2);
  assert.deepEqual(mergeRuns([{ len: 0, author: 'A', at: 1 }]), [], 'an empty run is not a run');
});

test('the summary ranks authors by how much they wrote', () => {
  const s = attributionSummary([
    { len: 10, author: 'You', at: 1 },
    { len: 30, author: 'Claude', at: 2 },
    { len: 5, author: 'You', at: 3 },
  ]);
  assert.equal(s.total, 45);
  assert.deepEqual(s.by, [{ author: 'Claude', chars: 30 }, { author: 'You', chars: 15 }]);
});

test('a ledger that does not match the body is REPLACED, not trusted', () => {
  // This is the note-imported-from-an-older-build case.
  const stale = [{ len: 99, author: 'Claude', at: 1 }];
  assert.deepEqual(normalizeAttribution(stale, 4, 7), [{ len: 4, author: HUMAN, at: 7 }]);
  // One that DOES match is kept.
  const good = [{ len: 4, author: 'Claude', at: 1 }];
  assert.deepEqual(normalizeAttribution(good, 4, 7), good);
});

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

test('a snapshot identical to the newest one is not a new version', () => {
  let v = pushVersion([], { body: 'one', by: 'You', at: 1 });
  assert.equal(v.length, 1);
  v = pushVersion(v, { body: 'one', by: 'You', at: 2 });
  assert.equal(v.length, 1, 'nothing changed, so nothing was snapshotted');
  v = pushVersion(v, { body: 'two', by: 'You', at: 3 });
  assert.equal(v.length, 2);
});

test('a snapshot carries a ledger that fits its own body, never a mismatched one', () => {
  const v = pushVersion([], { body: 'hello', attribution: [{ len: 99, author: 'Claude', at: 1 }], by: 'Claude', at: 5 });
  assert.equal(total(v[0].attribution), 5);
  assert.equal(v[0].attribution[0].author, 'Claude');
  // A matching one is carried verbatim.
  const good = [{ len: 5, author: 'Claude', at: 1 }];
  assert.deepEqual(pushVersion([], { body: 'hello', attribution: good, by: 'Claude' })[0].attribution, good);
});

test('the list is bounded — an afternoon of edits is not an unbounded store', () => {
  let v = [];
  for (let i = 0; i < MAX_VERSIONS + 12; i += 1) v = pushVersion(v, { body: `body ${i}`, by: 'You', at: i });
  assert.equal(v.length, MAX_VERSIONS);
  assert.equal(v[v.length - 1].body, `body ${MAX_VERSIONS + 11}`, 'the newest survives');
});

test('restoring keeps the current draft first, so the restore is itself undoable', () => {
  const v = pushVersion([], { body: 'the original', by: 'You', at: 1 });
  const out = restoreVersion(v, 0, { currentBody: 'a draft I am mid-way through', at: 9 });
  assert.equal(out.body, 'the original');
  assert.equal(total(out.attribution), 'the original'.length);
  assert.ok(out.versions.some((x) => x.body === 'a draft I am mid-way through'), 'the draft was kept');
});

test('flip-flopping between two versions does not spam identical snapshots', () => {
  let v = pushVersion([], { body: 'A', by: 'You', at: 1 });
  v = pushVersion(v, { body: 'B', by: 'You', at: 2 });
  const back = restoreVersion(v, 0, { currentBody: 'B', at: 3 });
  // 'B' is already in the list, so restoring to 'A' must not add a second copy of it.
  assert.equal(back.versions.length, 2);
  assert.equal(back.body, 'A');
});

test('restoring an index that is not there returns null rather than an empty note', () => {
  assert.equal(restoreVersion([], 0, { currentBody: 'x' }), null);
  assert.equal(restoreVersion(null, 3, { currentBody: 'x' }), null);
});
