// THE BACKUP ENVELOPE — one wire format, one implementation.
//
// A ChatPanel backup is the only LOSSLESS channel the corpus has between clients: the
// extension writes one, the gateway reads one, and a desktop client has to do both. Today
// that format is implemented twice — the extension's `crypto-backup.js` (both directions)
// and the gateway's `backup-decrypt.js` (decrypt only, re-derived from the format's shape).
// Two implementations of a CRYPTO format is the worst kind of duplication: a divergence does
// not show up as a wrong pixel, it shows up as a backup nobody can open.
//
// Envelope, unchanged and frozen:
//   { type:'chatpanel-backup-encrypted', version, kdf:{iterations,salt},
//     cipher:'AES-GCM', compression:'brotli'|'gzip'|'none'|absent, iv, ct }
//
// COMPRESSION IS INJECTED, crypto is not. WebCrypto is on every runtime we target
// (browser, Node 19+, Electron), so it is imported as a global. Compression is not: the
// browser has CompressionStream, Node has zlib, and neither can be reached from the other.
// So the caller passes a `codec` — which is the same shape as the `page-capability.js`
// factory and the `loop.js` clock, and for the same reason.
//
// COMPRESS THEN ENCRYPT, never the reverse. Ciphertext is indistinguishable from random and
// does not compress, so the order is load-bearing rather than stylistic. The envelope
// records which codec was used so a gzip backup written in 2025 still opens forever.

export class BackupError extends Error {
  constructor(message) { super(message); this.name = 'BackupError'; }
}

export const ENCRYPTED_TYPE = 'chatpanel-backup-encrypted';

/** PBKDF2-SHA256 rounds. Recorded IN the envelope so this can be raised without breaking old files. */
export const KDF_ITERATIONS = 250_000;

export const COMPRESSIONS = Object.freeze(['brotli', 'gzip', 'none']);

// --------------------------------------------------------------------------
// Bytes ↔ base64, without Buffer or atob assumptions
// --------------------------------------------------------------------------

const CHUNK = 0x8000;

export function toB64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function fromB64(s) {
  const str = String(s || '');
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(str, 'base64'));
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// --------------------------------------------------------------------------
// Codecs
// --------------------------------------------------------------------------

/**
 * The no-op codec. A backup written with it is still encrypted — it is just larger.
 * Useful in tests and on a runtime that offers no compression at all.
 */
export const identityCodec = Object.freeze({
  name: 'none',
  async compress(bytes) { return bytes; },
  async decompress(bytes) { return bytes; },
});

/**
 * The browser/Electron-renderer codec, built from CompressionStream.
 * Returns `null` when the runtime lacks the format, so a caller can fall back rather than
 * discover the gap at write time.
 */
export function streamCodec(format = 'gzip') {
  if (typeof CompressionStream === 'undefined' || typeof DecompressionStream === 'undefined') return null;
  try {
    new CompressionStream(format);
    new DecompressionStream(format);
  } catch {
    return null;
  }
  const run = async (bytes, Stream) => {
    const stream = new Blob([bytes]).stream().pipeThrough(new Stream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };
  return Object.freeze({
    name: format,
    compress: (b) => run(b, CompressionStream),
    decompress: (b) => run(b, DecompressionStream),
  });
}

/**
 * Build a codec from Node's zlib without importing it here — the caller passes the module,
 * so this file stays dependency-free and loadable in a browser.
 *
 *   import zlib from 'node:zlib';
 *   const codec = nodeCodec(zlib, 'brotli');
 */
export function nodeCodec(zlib, format = 'brotli') {
  if (!zlib) return null;
  const pair = format === 'brotli'
    ? [zlib.brotliCompressSync, zlib.brotliDecompressSync]
    : format === 'gzip' ? [zlib.gzipSync, zlib.gunzipSync] : null;
  if (!pair || !pair[0] || !pair[1]) return null;
  const [enc, dec] = pair;
  return Object.freeze({
    name: format,
    async compress(bytes) { return new Uint8Array(enc(Buffer.from(bytes))); },
    async decompress(bytes) { return new Uint8Array(dec(Buffer.from(bytes))); },
  });
}

/** Pick the best codec a runtime offers, preferring the smallest output. */
export function bestCodec({ zlib = null } = {}) {
  if (zlib) return nodeCodec(zlib, 'brotli') || nodeCodec(zlib, 'gzip') || identityCodec;
  return streamCodec('brotli') || streamCodec('gzip') || identityCodec;
}

// --------------------------------------------------------------------------
// Key derivation
// --------------------------------------------------------------------------

async function deriveKey(passphrase, salt, iterations, usages, subtle) {
  const crypto_ = subtle || globalThis.crypto?.subtle;
  if (!crypto_) throw new BackupError('no WebCrypto available on this runtime');
  const base = await crypto_.importKey(
    'raw', new TextEncoder().encode(String(passphrase)), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto_.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    usages,
  );
}

// --------------------------------------------------------------------------
// The two directions
// --------------------------------------------------------------------------

export function isEncryptedBackup(obj) {
  return !!obj && typeof obj === 'object' && obj.type === ENCRYPTED_TYPE;
}

/**
 * data + passphrase → envelope.
 *
 * `version` is the ENVELOPE's version, not the payload's — the backup body carries its own.
 */
export async function encryptBackup(data, passphrase, {
  codec = null, iterations = KDF_ITERATIONS, subtle = null, random = null, version = 3,
} = {}) {
  if (!passphrase) throw new BackupError('a passphrase is required to encrypt a backup');
  const c = codec || bestCodec();
  const rand = random || ((n) => globalThis.crypto.getRandomValues(new Uint8Array(n)));

  const plain = new TextEncoder().encode(JSON.stringify(data));
  const packed = await c.compress(plain);

  const salt = rand(16);
  const iv = rand(12);
  const key = await deriveKey(passphrase, salt, iterations, ['encrypt'], subtle);
  const cryptoSubtle = subtle || globalThis.crypto.subtle;
  const ct = new Uint8Array(await cryptoSubtle.encrypt({ name: 'AES-GCM', iv }, key, packed));

  return {
    type: ENCRYPTED_TYPE,
    version,
    kdf: { iterations, salt: toB64(salt) },
    cipher: 'AES-GCM',
    compression: c.name,
    iv: toB64(iv),
    ct: toB64(ct),
  };
}

/**
 * envelope + passphrase → the original data object.
 *
 * A wrong passphrase and a tampered file are the SAME failure here, and deliberately so:
 * AES-GCM's auth tag catches both, and telling them apart would be an oracle.
 */
export async function decryptBackup(envelope, passphrase, { codec = null, subtle = null } = {}) {
  if (!isEncryptedBackup(envelope)) throw new BackupError('not an encrypted ChatPanel backup');
  if (!passphrase) throw new BackupError('a passphrase is required to decrypt this backup');

  const salt = fromB64(envelope.kdf?.salt);
  const iterations = Number(envelope.kdf?.iterations) || KDF_ITERATIONS;
  const key = await deriveKey(passphrase, salt, iterations, ['decrypt'], subtle);
  const cryptoSubtle = subtle || globalThis.crypto?.subtle;
  if (!cryptoSubtle) throw new BackupError('no WebCrypto available on this runtime');

  let payload;
  try {
    payload = new Uint8Array(await cryptoSubtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(envelope.iv) }, key, fromB64(envelope.ct),
    ));
  } catch {
    throw new BackupError('wrong passphrase, or the backup file is corrupted');
  }

  // v1 wrote plaintext, v2 gzip, v3 may use brotli. The envelope says which; an absent
  // field means the oldest behaviour, which is why `none` and absent must agree.
  const want = envelope.compression || 'none';
  if (want !== 'none') {
    const c = codec || bestCodec();
    if (c.name !== want) {
      // Being explicit beats returning garbage: a gzip envelope handed a brotli-only codec
      // fails here with a readable reason instead of a JSON parse error twenty lines later.
      throw new BackupError(`this backup is ${want}-compressed; supply a matching codec`);
    }
    payload = await c.decompress(payload);
  }
  return JSON.parse(new TextDecoder().decode(payload));
}
