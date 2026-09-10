import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  encryptBackup, decryptBackup, isEncryptedBackup, bestCodec, nodeCodec, identityCodec,
  toB64, fromB64, ENCRYPTED_TYPE, KDF_ITERATIONS, BackupError,
} from '../backup-envelope.js';

const DATA = {
  type: 'chatpanel-backup',
  version: 8,
  conversations: [{ id: 'c1', title: 'Rollback', messages: [{ role: 'user', content: 'hi' }] }],
  notes: [{ id: 'n1', title: 'Runbook', body: '# Runbook' }],
};

const brotli = nodeCodec(zlib, 'brotli');
const gzip = nodeCodec(zlib, 'gzip');

test('a backup round-trips through the envelope unchanged', async () => {
  const env = await encryptBackup(DATA, 'correct horse', { codec: brotli });
  assert.deepEqual(await decryptBackup(env, 'correct horse', { codec: brotli }), DATA);
});

test('the envelope is the frozen wire format the extension and gateway already speak', async () => {
  const env = await encryptBackup(DATA, 'pw', { codec: gzip });
  assert.equal(env.type, ENCRYPTED_TYPE);
  assert.equal(env.cipher, 'AES-GCM');
  assert.equal(env.compression, 'gzip');
  assert.equal(env.kdf.iterations, KDF_ITERATIONS);
  assert.ok(env.kdf.salt && env.iv && env.ct);
  assert.ok(isEncryptedBackup(env));
});

test('a wrong passphrase fails, and fails the same way a tampered file does', async () => {
  // Distinguishing the two would be an oracle; AES-GCM catches both as one condition.
  const env = await encryptBackup(DATA, 'right', { codec: brotli });
  await assert.rejects(() => decryptBackup(env, 'wrong', { codec: brotli }), BackupError);

  const tampered = { ...env, ct: toB64(fromB64(env.ct).map((b, i) => (i === 4 ? b ^ 0xff : b))) };
  await assert.rejects(() => decryptBackup(tampered, 'right', { codec: brotli }), BackupError);
});

test('every codec round-trips, so an old gzip backup opens forever', async () => {
  for (const codec of [brotli, gzip, identityCodec]) {
    const env = await encryptBackup(DATA, 'pw', { codec });
    assert.deepEqual(await decryptBackup(env, 'pw', { codec }), DATA, codec.name);
  }
});

test('compression happens before encryption — ciphertext does not compress', async () => {
  const big = { ...DATA, filler: 'x'.repeat(50_000) };
  const packed = await encryptBackup(big, 'pw', { codec: brotli });
  const plain = await encryptBackup(big, 'pw', { codec: identityCodec });
  assert.ok(packed.ct.length < plain.ct.length / 5, 'a compressible payload must actually shrink');
});

test('a mismatched codec is refused with a readable reason, not a JSON parse error', async () => {
  const env = await encryptBackup(DATA, 'pw', { codec: gzip });
  await assert.rejects(
    () => decryptBackup(env, 'pw', { codec: brotli }),
    (err) => err instanceof BackupError && /gzip-compressed/.test(err.message),
  );
});

test('an absent compression field means the oldest behaviour, not a failure', async () => {
  const env = await encryptBackup(DATA, 'pw', { codec: identityCodec });
  delete env.compression;
  assert.deepEqual(await decryptBackup(env, 'pw', { codec: identityCodec }), DATA);
});

test('a passphrase is required in both directions', async () => {
  await assert.rejects(() => encryptBackup(DATA, '', { codec: brotli }), BackupError);
  const env = await encryptBackup(DATA, 'pw', { codec: brotli });
  await assert.rejects(() => decryptBackup(env, '', { codec: brotli }), BackupError);
});

test('something that is not an envelope is refused', async () => {
  await assert.rejects(() => decryptBackup({ type: 'something-else' }, 'pw'), BackupError);
  assert.equal(isEncryptedBackup(null), false);
  assert.equal(isEncryptedBackup({}), false);
});

test('two encryptions of the same data differ — salt and iv are fresh each time', async () => {
  const a = await encryptBackup(DATA, 'pw', { codec: brotli });
  const b = await encryptBackup(DATA, 'pw', { codec: brotli });
  assert.notEqual(a.kdf.salt, b.kdf.salt);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct);
});

test('base64 helpers round-trip binary that is not valid utf-8', () => {
  const bytes = new Uint8Array([0, 255, 128, 13, 10, 200]);
  assert.deepEqual(fromB64(toB64(bytes)), bytes);
});

test('bestCodec prefers brotli when zlib is supplied', () => {
  assert.equal(bestCodec({ zlib }).name, 'brotli');
});
