// RECONCILING TWO COPIES OF THE LIBRARY — the pure half of two-way sync.
//
// The extension holds the corpus in chrome.storage; a desktop app holds it in SQLite; the
// gateway holds a warm copy. Each pair of those needs the same question answered: given what
// I have and what you have, what do I pull, what do I push, and what genuinely conflicts.
//
// It lives here because the answer must not depend on WHO is asking. If the extension
// decided ties one way and the desktop the other, two clients syncing the same record would
// flap — each would keep "winning" and re-pushing, forever. One rule, both sides.
//
// WHAT MAKES THIS SAFE TO RUN REPEATEDLY: the plan is a pure function of two index lists, so
// applying it and re-planning yields an empty plan. That is the property to hold on to —
// every bug in a sync engine eventually shows up as "running it twice does something".
//
// TOMBSTONES ARE NOT OPTIONAL, and this is the sharpest edge in the module. A record that is
// merely ABSENT from one side is indistinguishable from one that side has never seen. So a
// deletion has to be representable as a value — `deletedAt` — or "delete" and "not synced
// yet" are the same input with opposite correct answers. The extension's warm sync already
// hit this and chose, deliberately, not to tombstone (a missing browser record may simply
// have aged out of IndexedDB while remaining in a backup). That choice is why warm sync is
// one-way. A two-way sync cannot make it.
//
// Pure over arrays of `{ id, updatedAt, deletedAt }`. No storage, no network, no clock —
// `now` is never consulted, because a plan that depends on when you asked is not a plan.

export class SyncError extends Error {
  constructor(message) { super(message); this.name = 'SyncError'; }
}

/**
 * How far apart two timestamps may be and still count as "the same edit".
 *
 * Clocks on two machines are not identical, and a record copied between them can come back
 * with a millisecond of drift. Without a tolerance every round trip looks like a fresh edit
 * and the two sides push at each other indefinitely.
 */
export const CLOCK_TOLERANCE_MS = 1000;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** The comparable stamp of a record: when it last changed, deleted or not. */
export function stampOf(entry) {
  if (!entry) return 0;
  return Math.max(num(entry.updatedAt), num(entry.deletedAt));
}

function indexById(entries) {
  const m = new Map();
  for (const e of entries || []) {
    if (!e || !e.id) continue;
    // Later duplicates win: a caller concatenating pages should not be punished for it.
    m.set(e.id, e);
  }
  return m;
}

/**
 * Decide one record. Exported because it is the whole rule, and a caller that streams
 * records one at a time should not have to build two full indexes to use it.
 *
 * Returns one of:
 *   'none'     — the two sides agree
 *   'pull'     — remote is newer; take theirs
 *   'push'     — local is newer, or remote has never seen it; send ours
 *   'conflict' — both changed since the last common state and neither is clearly newer
 */
/**
 * Is this entry the COMPLETE record, or a flattened stand-in for one?
 *
 * A warm/indexed copy of a chat is its transcript as one blob of text: enough to search,
 * read and cite, and not enough to open as a conversation. Callers stamp that with
 * `meta.lossy` (or `meta.origin: 'warm'`); a stamp row may carry `lossy` directly, because a
 * sync plan works on stamps and should not have to load bodies to make this decision.
 *
 * Returns 1 for full fidelity and 0 for lossy — an ordering, so the rule below is a
 * comparison rather than a pile of branches.
 */
export function fidelityOf(entry) {
  if (!entry) return 0;
  if (entry.lossy === true) return 0;
  const meta = entry.meta || null;
  if (meta && (meta.lossy === true || meta.origin === 'warm')) return 0;
  return 1;
}

export function decide(local, remote, { tolerance = CLOCK_TOLERANCE_MS, base = null } = {}) {
  if (!local && !remote) return 'none';
  if (!remote) return 'push';
  if (!local) return 'pull';

  const l = stampOf(local);
  const r = stampOf(remote);

  // FIDELITY BEATS RECENCY, BOTH WAYS.
  //
  // The two sides are not always describing the same kind of thing. One may hold the whole
  // record and the other a flattened stand-in for it — and those two arrive with the SAME
  // timestamp, because they describe the same moment. Last-write-wins then reads them as
  // equal and answers 'none', which is how a complete conversation restored from a backup
  // gets silently refused in favour of a search-index summary of itself that is already
  // there. The user restores, is told it worked, and still sees the flattened copy.
  //
  // So a complete record always wins over a partial one whatever the clocks say. The
  // converse — never let a partial overwrite a complete one — is the same rule read the
  // other way, and it is the one callers usually remember to enforce by hand.
  //
  // DELETIONS ARE EXEMPT. A tombstone carries no body, so it is 'lossy' by any measure, and
  // resurrecting deleted records because their replacement looks fuller would be a far worse
  // bug than the one this fixes. When either side is deleted, the stamps decide.
  const deleted = num(local.deletedAt) > 0 || num(remote.deletedAt) > 0;
  if (!deleted) {
    const lf = fidelityOf(local);
    const rf = fidelityOf(remote);
    if (lf !== rf) return rf > lf ? 'pull' : 'push';
  }

  const delta = l - r;
  if (Math.abs(delta) <= tolerance) return 'none';

  // With a recorded base (what both sides last agreed on) we can tell a genuine divergence
  // from a simple fast-forward: a conflict is when BOTH moved. Without a base the newer
  // stamp wins, which is last-write-wins and is all a first sync can honestly offer.
  if (base) {
    const b = stampOf(base);
    const localMoved = l - b > tolerance;
    const remoteMoved = r - b > tolerance;
    if (localMoved && remoteMoved) return 'conflict';
  }
  return delta > 0 ? 'push' : 'pull';
}

/**
 * Plan a full two-way reconcile.
 *
 * `bases` is optional — a map (or array) of the stamps both sides last agreed on, which is
 * what upgrades last-write-wins into real conflict detection. Callers that keep a sync
 * journal pass it; callers that do not get LWW and no false conflicts.
 *
 * Returns `{ pull, push, conflicts, unchanged }` as arrays of ids, plus `counts`.
 */
export function planSync(localEntries, remoteEntries, {
  tolerance = CLOCK_TOLERANCE_MS, bases = null,
} = {}) {
  const local = indexById(localEntries);
  const remote = indexById(remoteEntries);
  const baseMap = bases instanceof Map ? bases : indexById(bases);

  const pull = [];
  const push = [];
  const conflicts = [];
  let unchanged = 0;

  for (const id of new Set([...local.keys(), ...remote.keys()])) {
    const verdict = decide(local.get(id), remote.get(id), { tolerance, base: baseMap.get(id) || null });
    if (verdict === 'pull') pull.push(id);
    else if (verdict === 'push') push.push(id);
    else if (verdict === 'conflict') conflicts.push(id);
    else unchanged += 1;
  }

  // Stable order so two runs over the same input produce byte-identical plans — which is
  // what makes a plan diffable in a log and testable without sorting at every assertion.
  pull.sort();
  push.sort();
  conflicts.sort();

  return {
    pull, push, conflicts, unchanged,
    counts: { pull: pull.length, push: push.length, conflicts: conflicts.length, unchanged },
  };
}

/** Nothing to do — the property a correct sync reaches and stays at. */
export function isSettled(plan) {
  return !!plan && plan.pull.length === 0 && plan.push.length === 0 && plan.conflicts.length === 0;
}

/**
 * Resolve a conflict by keeping both: the loser is preserved under a new id rather than
 * overwritten.
 *
 * Silently discarding one side of a conflict is how a sync engine loses the paragraph
 * someone wrote on a plane. The caller supplies `newId` because id minting is a host
 * concern; this only decides WHAT the two resulting records are.
 */
export function forkConflict(localRecord, remoteRecord, { newId, label = 'conflicted copy' } = {}) {
  if (typeof newId !== 'function') throw new SyncError('forkConflict needs a newId() function');
  const keep = stampOf(localRecord) >= stampOf(remoteRecord) ? localRecord : remoteRecord;
  const fork = keep === localRecord ? remoteRecord : localRecord;
  const parsedKind = String(fork.id || '').split(':')[0];
  return {
    keep,
    fork: {
      ...fork,
      id: `${parsedKind}:${newId()}`,
      title: `${fork.title || 'Untitled'} (${label})`,
      meta: { ...(fork.meta || {}), conflictOf: keep.id },
    },
  };
}

/**
 * Fold applied ids back into a base map, so the NEXT plan can tell a fast-forward from a
 * divergence. Returns a new Map; the input is not mutated.
 */
export function advanceBases(bases, applied = []) {
  const next = bases instanceof Map ? new Map(bases) : indexById(bases);
  for (const entry of applied) {
    if (!entry || !entry.id) continue;
    next.set(entry.id, { id: entry.id, updatedAt: num(entry.updatedAt), deletedAt: num(entry.deletedAt) });
  }
  return next;
}
