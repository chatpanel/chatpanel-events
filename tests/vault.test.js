import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createVault, unlockVault, sealEntry, openEntry, validateEntry, entryMeta, searchEntries,
  isLocked, lockedSummary, canAddEntry, deriveKey, VaultError, VAULT_VERSION, KDF_ITERATIONS,
  MAX_SECRET_CHARS, MAX_ENTRIES, DEFAULT_LOCK_MS, toB64, fromB64,
} from '../vault.js';

const PASS = 'correct horse battery staple';
const now = () => 1_800_000_000_000;

// Fewer iterations in tests only: 310k PBKDF2 rounds per unlock would add minutes to a suite
// that unlocks dozens of times. The parameters travel with the vault, so this is the same
// code path with a different cost.
const fast = { subtle: globalThis.crypto.subtle };

test('a new vault holds nothing and knows its own parameters', async () => {
  const { vault, key } = await createVault(PASS, { now });
  assert.equal(vault.version, VAULT_VERSION);
  assert.equal(vault.kdf.iterations, KDF_ITERATIONS);
  assert.ok(vault.kdf.salt, 'the salt must be recorded, or the key can never be re-derived');
  assert.deepEqual(vault.entries, {});
  assert.ok(key);
  // Nothing derived from the passphrase may be written down.
  const onDisk = JSON.stringify(vault);
  assert.ok(!onDisk.includes(PASS));
  assert.ok(!onDisk.toLowerCase().includes('horse'));
});

test('the right passphrase unlocks; a wrong one is TOLD APART from an empty vault', async () => {
  const { vault } = await createVault(PASS, { now });
  assert.ok(await unlockVault(vault, PASS));
  await assert.rejects(() => unlockVault(vault, 'nearly the right one'), (e) => {
    // The distinction that matters: a typo must not look like "your vault is empty".
    assert.equal(e.code, 'BAD_KEY');
    return true;
  });
  await assert.rejects(() => unlockVault({}, PASS), (e) => e.code === 'NO_VAULT');
  await assert.rejects(() => unlockVault({ ...vault, version: 99 }, PASS), (e) => e.code === 'TOO_NEW');
});

test('an entry round-trips, and nothing about it is readable on disk', async () => {
  const { vault, key } = await createVault(PASS, { now });
  const record = await sealEntry(key, { id: 'e1', title: 'Bank login', note: 'branch 402', secret: 'hunter2' }, { now });
  const onDisk = JSON.stringify(record);
  // Titles are encrypted too: a list of entry names is a list of the accounts someone has.
  for (const leak of ['Bank login', 'branch 402', 'hunter2']) {
    assert.ok(!onDisk.includes(leak), `"${leak}" is readable in the stored record`);
  }
  const back = await openEntry(key, record);
  assert.equal(back.title, 'Bank login');
  assert.equal(back.secret, 'hunter2');
  assert.equal(back.updatedAt, now());
});

test('a tampered entry is refused, not silently mis-read', async () => {
  const { vault, key } = await createVault(PASS, { now });
  const record = await sealEntry(key, { id: 'e1', title: 'x', secret: 's' }, { now });
  const flipped = fromB64(record.ct);
  flipped[0] ^= 0xff;
  await assert.rejects(() => openEntry(key, { ...record, ct: toB64(flipped) }), (e) => e.code === 'BAD_KEY');
  await assert.rejects(() => openEntry(key, { id: 'e1' }), (e) => e.code === 'CORRUPT');
});

test('a second vault with the same passphrase cannot read the first', async () => {
  // Fresh salt per vault, so identical passphrases do not produce identical keys.
  const a = await createVault(PASS, { now });
  const b = await createVault(PASS, { now });
  const record = await sealEntry(a.key, { id: 'e1', title: 'x', secret: 's' }, { now });
  await assert.rejects(() => openEntry(b.key, record), (e) => e.code === 'BAD_KEY');
});

test('every seal uses a fresh IV, so the same secret encrypts differently', async () => {
  const { key } = await createVault(PASS, { now });
  const one = await sealEntry(key, { id: 'e1', title: 'same', secret: 'same' }, { now });
  const two = await sealEntry(key, { id: 'e2', title: 'same', secret: 'same' }, { now });
  assert.notEqual(one.iv, two.iv);
  assert.notEqual(one.ct, two.ct, 'identical plaintext under a reused IV would leak that they match');
});

test('what may leave the vault without unlocking it', async () => {
  const meta = entryMeta({ id: 'e1', title: 'Bank', note: 'mother\'s maiden name is…', secret: 'hunter2', updatedAt: 5 });
  assert.deepEqual(meta, { id: 'e1', title: 'Bank', hasSecret: true, updatedAt: 5, createdAt: 0 });
  const json = JSON.stringify(meta);
  assert.ok(!json.includes('hunter2'), 'the secret must never be in the metadata');
  assert.ok(!json.includes('maiden'), 'and neither must the note — that is where the answers live');

  // A locked vault admits to a count and nothing else.
  const summary = lockedSummary({ kdf: {}, entries: { a: {}, b: {} } });
  assert.deepEqual(summary, { exists: true, entries: 2, locked: true });
});

test('search covers titles and notes, never secrets', async () => {
  const entries = [
    { id: '1', title: 'Bank login', note: 'branch 402' },
    { id: '2', title: 'Router', note: '', secret: 'bank-of-things' },
  ];
  assert.deepEqual(searchEntries(entries, 'bank').map((e) => e.id), ['1'],
    'a match inside a secret would reveal the secret through the result count');
  assert.deepEqual(searchEntries(entries, '402').map((e) => e.id), ['1']);
  assert.equal(searchEntries(entries, '').length, 2);
});

test('entries are validated before anything is sealed', () => {
  assert.throws(() => validateEntry({}), VaultError);
  assert.throws(() => validateEntry({ title: '   ' }), VaultError);
  assert.throws(() => validateEntry({ title: 'x', secret: 'y'.repeat(MAX_SECRET_CHARS + 1) }), VaultError);
  assert.throws(() => validateEntry({ title: 'x', note: 5 }), VaultError);
  assert.ok(validateEntry({ title: 'x' }), 'a note-only entry is legitimate — not everything has a password');
});

test('auto-lock is measured from the last use, not from the unlock', async () => {
  const t = 1_000_000;
  assert.equal(isLocked({ unlockedAt: 0, now: t }), true, 'never unlocked is locked');
  assert.equal(isLocked({ unlockedAt: t, now: t + 60_000 }), false);
  assert.equal(isLocked({ unlockedAt: t, now: t + DEFAULT_LOCK_MS }), true);
  // Still working in it: the clock restarts on use, or a vault locks under someone's hands.
  assert.equal(isLocked({ unlockedAt: t, lastUsedAt: t + DEFAULT_LOCK_MS - 1, now: t + DEFAULT_LOCK_MS + 1 }), false);
  assert.equal(isLocked({ unlockedAt: t, now: t + 10 * DEFAULT_LOCK_MS, timeoutMs: 0 }), false, '0 = until the session ends');
});

test('the vault is bounded', () => {
  assert.equal(canAddEntry({ entries: {} }), true);
  const full = Object.fromEntries(Array.from({ length: MAX_ENTRIES }, (_, i) => [i, {}]));
  assert.equal(canAddEntry({ entries: full }), false);
});

test('a missing passphrase is refused before any key work happens', async () => {
  await assert.rejects(() => deriveKey('', new Uint8Array(16)), (e) => e.code === 'NO_PASSPHRASE');
  await assert.rejects(() => createVault(''), (e) => e.code === 'NO_PASSPHRASE');
});
