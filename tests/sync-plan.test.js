import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planSync, decide, stampOf, isSettled, forkConflict, advanceBases,
  CLOCK_TOLERANCE_MS, SyncError, fidelityOf,
} from '../sync-plan.js';

const T = 1_800_000_000_000;
const e = (id, updatedAt, deletedAt = 0) => ({ id, updatedAt, deletedAt });

// --------------------------------------------------------------------------
// One record
// --------------------------------------------------------------------------

test('a record only one side has is pushed or pulled, never dropped', () => {
  assert.equal(decide(e('note:a', T), null), 'push');
  assert.equal(decide(null, e('note:a', T)), 'pull');
});

test('the newer stamp wins when there is no recorded base — last-write-wins, stated plainly', () => {
  assert.equal(decide(e('note:a', T + 5000), e('note:a', T)), 'push');
  assert.equal(decide(e('note:a', T), e('note:a', T + 5000)), 'pull');
});

test('a sub-tolerance difference is not an edit, so a round trip does not flap', () => {
  // Without this, copying a record between two machines comes back a millisecond off and
  // each side re-pushes at the other forever.
  assert.equal(decide(e('note:a', T + 200), e('note:a', T)), 'none');
  assert.equal(decide(e('note:a', T + CLOCK_TOLERANCE_MS + 1), e('note:a', T)), 'push');
});

test('a deletion is compared by its tombstone, so deleting beats an older edit', () => {
  assert.equal(stampOf(e('note:a', T, T + 9000)), T + 9000);
  assert.equal(decide(e('note:a', T, T + 9000), e('note:a', T + 3000)), 'push');
});

test('both sides moving past a shared base is a conflict, not a silent overwrite', () => {
  const base = e('note:a', T);
  assert.equal(decide(e('note:a', T + 9000), e('note:a', T + 5000), { base }), 'conflict');
});

test('only one side moving past the base is a fast-forward, not a conflict', () => {
  const base = e('note:a', T);
  assert.equal(decide(e('note:a', T + 9000), e('note:a', T), { base }), 'push');
  assert.equal(decide(e('note:a', T), e('note:a', T + 9000), { base }), 'pull');
});

// --------------------------------------------------------------------------
// A whole plan
// --------------------------------------------------------------------------

test('a plan sorts every side into exactly one bucket', () => {
  const plan = planSync(
    [e('note:a', T + 9000), e('note:b', T), e('chat:c', T)],
    [e('note:a', T), e('note:b', T), e('meeting:d', T)],
  );
  assert.deepEqual(plan.push, ['chat:c', 'note:a']);
  assert.deepEqual(plan.pull, ['meeting:d']);
  assert.equal(plan.unchanged, 1);
  assert.deepEqual(plan.conflicts, []);
});

test('applying a plan and re-planning settles — running sync twice does nothing', () => {
  // This is THE property. Every sync bug eventually presents as a violation of it.
  const local = [e('note:a', T + 9000), e('note:b', T)];
  const remote = [e('note:a', T), e('meeting:d', T)];
  const plan = planSync(local, remote);

  const applied = [...remote];
  for (const id of plan.push) applied.push(local.find((x) => x.id === id));
  for (const id of plan.pull) local.push(remote.find((x) => x.id === id));

  assert.ok(isSettled(planSync(local, applied)), 'a second pass must be a no-op');
});

test('a plan over identical sides is settled and allocates nothing to do', () => {
  const both = [e('note:a', T), e('chat:b', T)];
  assert.ok(isSettled(planSync(both, both)));
});

test('two runs over the same input produce byte-identical plans', () => {
  const l = [e('note:z', T + 9000), e('note:a', T + 9000)];
  const r = [e('note:z', T), e('note:a', T)];
  assert.deepEqual(planSync(l, r), planSync(l, r));
  assert.deepEqual(planSync(l, r).push, ['note:a', 'note:z'], 'and in a stable order');
});

test('duplicate entries do not double-count — a caller concatenating pages is not punished', () => {
  const plan = planSync([e('note:a', T), e('note:a', T)], [e('note:a', T)]);
  assert.equal(plan.unchanged, 1);
});

test('entries without an id are ignored rather than crashing the pass', () => {
  const plan = planSync([{ updatedAt: T }, e('note:a', T)], [e('note:a', T)]);
  assert.equal(plan.unchanged, 1);
});

// --------------------------------------------------------------------------
// Conflicts
// --------------------------------------------------------------------------

test('a conflict keeps both sides — the loser is forked, never discarded', () => {
  const local = { id: 'note:a', title: 'Mine', updatedAt: T + 9000 };
  const remote = { id: 'note:a', title: 'Theirs', updatedAt: T + 5000 };
  const { keep, fork } = forkConflict(local, remote, { newId: () => 'fork1' });
  assert.equal(keep.title, 'Mine');
  assert.equal(fork.id, 'note:fork1');
  assert.match(fork.title, /Theirs \(conflicted copy\)/);
  assert.equal(fork.meta.conflictOf, 'note:a');
});

test('forkConflict insists on an id minter rather than inventing one', () => {
  assert.throws(() => forkConflict({ id: 'note:a' }, { id: 'note:a' }, {}), SyncError);
});

test('advancing the bases turns the next divergence into a detectable conflict', () => {
  let bases = advanceBases(null, [e('note:a', T)]);
  assert.equal(decide(e('note:a', T + 9000), e('note:a', T + 5000), { base: bases.get('note:a') }), 'conflict');

  bases = advanceBases(bases, [e('note:a', T + 9000)]);
  assert.equal(decide(e('note:a', T + 9000), e('note:a', T + 9000), { base: bases.get('note:a') }), 'none');
});

test('advanceBases does not mutate the map it was given', () => {
  const before = advanceBases(null, [e('note:a', T)]);
  const after = advanceBases(before, [e('note:b', T)]);
  assert.equal(before.has('note:b'), false);
  assert.equal(after.has('note:b'), true);
});

// ---------------------------------------------------------------------------
// Fidelity — a flattened stand-in must never win over the real record
// ---------------------------------------------------------------------------

test('fidelityOf reads the marks a warm copy is stamped with, on a record or a stamp row', () => {
  assert.equal(fidelityOf({ id: 'a' }), 1, 'unmarked means complete');
  assert.equal(fidelityOf({ id: 'a', lossy: true }), 0, 'a stamp row can say so directly');
  assert.equal(fidelityOf({ id: 'a', meta: { lossy: true } }), 0);
  assert.equal(fidelityOf({ id: 'a', meta: { origin: 'warm' } }), 0);
  assert.equal(fidelityOf({ id: 'a', meta: { origin: 'extension' } }), 1);
  assert.equal(fidelityOf(null), 0);
});

test('THE BUG: a complete record is pulled over a lossy one with the SAME timestamp', () => {
  // The two describe the same moment, so last-write-wins called them equal and answered
  // 'none' — a restored backup silently refused in favour of the search-index copy.
  const at = 1_700_000_000_000;
  const warm = { id: 'chat:1', updatedAt: at, meta: { origin: 'warm' } };
  const full = { id: 'chat:1', updatedAt: at, meta: { origin: 'extension' } };
  assert.equal(decide(warm, full), 'pull');
});

test('a lossy remote NEVER overwrites a complete local, even when it is newer', () => {
  const full = { id: 'chat:1', updatedAt: 1000, meta: { origin: 'extension' } };
  const warmerButLossy = { id: 'chat:1', updatedAt: 999_000, meta: { lossy: true } };
  assert.equal(decide(full, warmerButLossy), 'push');
});

test('a complete record wins even when the lossy one is much newer', () => {
  const warm = { id: 'chat:1', updatedAt: 999_000, meta: { origin: 'warm' } };
  const full = { id: 'chat:1', updatedAt: 1000, meta: { origin: 'extension' } };
  assert.equal(decide(warm, full), 'pull');
});

test('between two records of the SAME fidelity, the clocks still decide', () => {
  const a = { id: 'x', updatedAt: 5000, meta: { origin: 'warm' } };
  const b = { id: 'x', updatedAt: 9000, meta: { origin: 'warm' } };
  assert.equal(decide(a, b), 'pull');
  assert.equal(decide(b, a), 'push');
  assert.equal(decide(a, { ...a }), 'none');
});

test('DELETIONS ARE EXEMPT — fidelity must never resurrect a tombstone', () => {
  // A tombstone has no body, so it looks lossy by any measure. If fidelity outranked the
  // stamps here, every deleted record would come back the moment a fuller copy existed.
  const tombstone = { id: 'chat:1', updatedAt: 9000, deletedAt: 9000 };
  const older = { id: 'chat:1', updatedAt: 1000, meta: { origin: 'extension' } };
  assert.equal(decide(tombstone, older), 'push', 'the deletion still wins on its stamp');

  // ...and a newer deletion on the remote side is still pulled.
  const liveLocal = { id: 'chat:1', updatedAt: 1000, meta: { origin: 'extension' } };
  const remoteTomb = { id: 'chat:1', updatedAt: 9000, deletedAt: 9000 };
  assert.equal(decide(liveLocal, remoteTomb), 'pull');
});

test('a whole plan pulls every lossy id the complete side can replace', () => {
  const local = [
    { id: 'chat:1', updatedAt: 500, lossy: true },
    { id: 'chat:2', updatedAt: 500, lossy: true },
    { id: 'note:9', updatedAt: 500 },
  ];
  const remote = [
    { id: 'chat:1', updatedAt: 500 },
    { id: 'chat:2', updatedAt: 500 },
    { id: 'note:9', updatedAt: 500 },
  ];
  const plan = planSync(local, remote);
  assert.deepEqual(plan.pull.sort(), ['chat:1', 'chat:2'], 'both flattened chats are replaced');
  assert.equal(plan.unchanged, 1, 'and an equal, equally-complete record is left alone');
  assert.equal(plan.push.length, 0);
});
