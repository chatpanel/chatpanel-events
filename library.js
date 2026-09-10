// THE LIBRARY — one record model for chats, notes, meetings and briefs.
//
// WHY THIS IS IN THE SHARED PACKAGE. "What is a record" is currently answered three times
// and the three answers already disagree:
//
//   • the extension builds rich source records (conversationSource / meetingSource /
//     noteSource / briefSource), each with its own title, date and body rules;
//   • the gateway re-derives them in `backup-ingest.js`, whose own comment calls it "a
//     SIMPLIFIED MIRROR of the extension's" — a mirror is a copy that drifts;
//   • a desktop or mobile client would make a third, and three implementations of "what is
//     the title of a meeting" become three different titles for the same meeting.
//
// The projection is pure: records in, a normalized record out. No storage, no crypto, no
// platform. Each host keeps its own persistence (IndexedDB, SQLite, Core Data) and calls
// this to decide WHAT it is storing — the P8 split the store already uses.
//
// THE ID GRAMMAR IS THE CONTRACT. `chat:<id>`, `note:<id>`, `meeting:<id>`, `brief:<id>`.
// The gateway's warm index, the MCP tools, `find_related`, the omni bar and every citation
// already speak it; writing it down here is what stops a fourth client inventing
// `chats/<id>` and silently failing to join.
//
// NAMED `normalizeStoredRecord`, NOT `normalizeStoredRecord`, on purpose: `curate.js` already
// exports the latter and it does the OTHER job — coercing anything into the flat survey
// shape a curation pass reads. Two functions named the same in one package, one lossy and
// one lossless, is a trap for whoever imports the wrong one.
//
// LOSSY AND LOSSLESS ARE DIFFERENT QUESTIONS, and conflating them is what made the gateway's
// mirror drift. `toSearchRecord` is deliberately lossy — it is the flat {id,title,type,date,
// text} the BM25 index wants. `normalizeStoredRecord` is lossless — it is the full record a client
// stores and round-trips. A client that needs to SHOW a chat must never reconstruct it from
// a search record.

export class LibraryError extends Error {
  constructor(message) { super(message); this.name = 'LibraryError'; }
}

/** The four record kinds. Ordered as the UI orders them, not alphabetically. */
export const RECORD_KINDS = Object.freeze(['chat', 'note', 'meeting', 'brief']);

const KIND_SET = new Set(RECORD_KINDS);

/** `chat:abc` → { kind:'chat', localId:'abc' }; anything else → null. */
export function parseRecordId(recordId) {
  const s = String(recordId || '');
  const colon = s.indexOf(':');
  if (colon <= 0) return null;
  const kind = s.slice(0, colon);
  const localId = s.slice(colon + 1);
  if (!KIND_SET.has(kind) || !localId) return null;
  return { kind, localId };
}

/** The inverse. Throws rather than producing an id nothing else will match. */
export function makeRecordId(kind, localId) {
  if (!KIND_SET.has(kind)) throw new LibraryError(`unknown record kind: ${kind}`);
  const id = String(localId || '');
  if (!id) throw new LibraryError('a record id needs a local id');
  if (id.includes(':')) throw new LibraryError(`local id may not contain ":" — got ${id}`);
  return `${kind}:${id}`;
}

export function isRecordId(value) {
  return parseRecordId(value) !== null;
}

// --------------------------------------------------------------------------
// Titles
// --------------------------------------------------------------------------

/** The single length a record title may be — the extension's MAX_TITLE_LEN, shared. */
export const MAX_TITLE_LEN = 48;

/**
 * First non-empty line, stripped of markdown furniture, clamped.
 *
 * Notes derive their title from the body when the user has not set one, and the meeting
 * autotitler falls back here too. Keeping it in one place is what stops "# Rollback runbook"
 * becoming the title in one client and "Rollback runbook" in another.
 */
export function deriveTitle(body, fallback = 'Untitled') {
  const first = String(body || '')
    .split('\n')
    .map((l) => l.replace(/^\s*#{1,6}\s*/, '').replace(/[*_`>~]+/g, '').trim())
    .find((l) => l.length > 0);
  if (!first) return fallback;
  return first.length > MAX_TITLE_LEN ? `${first.slice(0, MAX_TITLE_LEN - 1).trimEnd()}…` : first;
}

// --------------------------------------------------------------------------
// Normalization — the lossless shape
// --------------------------------------------------------------------------

const num = (v, dflt = 0) => (Number.isFinite(Number(v)) ? Number(v) : dflt);
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/**
 * A stored record, whatever client wrote it.
 *
 * `body` is the kind-specific payload and is carried VERBATIM — messages for a chat,
 * segments for a meeting, markdown for a note. This module refuses to flatten it, because
 * flattening is exactly the lossy step that belongs in `toSearchRecord` and nowhere else.
 */
export function normalizeStoredRecord(input = {}, { now = 0 } = {}) {
  const parsed = parseRecordId(input.id);
  if (!parsed) throw new LibraryError(`not a record id: ${JSON.stringify(input.id)}`);
  const createdAt = num(input.createdAt, num(input.date, now));
  return {
    id: input.id,
    kind: parsed.kind,
    localId: parsed.localId,
    title: str(input.title).trim() || defaultTitleFor(parsed.kind, input),
    tags: normalizeTagList(input.tags),
    createdAt,
    // A record with no updatedAt sorts by when it was made, not to the bottom of the list.
    updatedAt: num(input.updatedAt, createdAt),
    // Soft delete. A removal has to be REPRESENTABLE or it cannot replicate: a record that
    // is merely absent from one side is indistinguishable from one that side has not seen.
    deletedAt: num(input.deletedAt, 0) || 0,
    body: input.body ?? null,
    meta: input.meta && typeof input.meta === 'object' ? input.meta : {},
  };
}

function defaultTitleFor(kind, input) {
  if (kind === 'note') return deriveTitle(input?.body?.markdown ?? input?.body, 'Untitled note');
  if (kind === 'meeting') return 'Untitled meeting';
  if (kind === 'brief') return 'Untitled brief';
  return 'New chat';
}

/**
 * Tags are a shared vocabulary — `tags.js` owns the rules. This is the shallow guard for
 * callers that hand us junk; it deliberately does NOT re-implement normalization, so a
 * client that cares passes tags through `normalizeTags` first.
 */
function normalizeTagList(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (const t of tags) {
    const s = str(t).trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

export function isValidStoredRecord(rec) {
  try { normalizeStoredRecord(rec); return true; } catch { return false; }
}

// --------------------------------------------------------------------------
// Projection — the lossy shape the search index wants
// --------------------------------------------------------------------------

const ROLE_LABEL = { assistant: 'Assistant', system: 'System', user: 'You' };

/**
 * A record → the flat `{ id, type, title, date, text }` the warm index stores.
 *
 * This is the function the gateway's `backupToRecords` was a copy of. Note what it does NOT
 * do: it never invents an id, never guesses a kind, and never returns a record for something
 * it does not understand — a silent wrong answer in a search index is worse than a gap,
 * because the gap is visible.
 */
export function toSearchRecord(record) {
  const rec = normalizeStoredRecord(record);
  if (rec.deletedAt) return null;
  return {
    id: rec.id,
    type: rec.kind,
    title: rec.title,
    date: rec.updatedAt || rec.createdAt,
    text: searchTextFor(rec),
  };
}

/** The body of a record as one searchable string. Exported because callers index in batches. */
export function searchTextFor(record) {
  const rec = record.kind ? record : normalizeStoredRecord(record);
  const head = `${kindLabel(rec.kind)}: ${rec.title}`;
  const tagLine = rec.tags.length ? `\nTags: ${rec.tags.join(', ')}` : '';
  return `${head}${tagLine}\n\n${bodyText(rec)}`.trim();
}

function kindLabel(kind) {
  return kind === 'chat' ? 'CHAT' : kind === 'note' ? 'NOTE' : kind === 'meeting' ? 'MEETING' : 'BRIEF';
}

function bodyText(rec) {
  const b = rec.body;
  if (b == null) return '';
  if (typeof b === 'string') return b;

  if (rec.kind === 'chat') {
    return (b.messages || [])
      .filter((m) => m && m.content)
      .map((m) => `${ROLE_LABEL[m.role] || 'You'}: ${textOfContent(m.content)}`)
      .join('\n\n');
  }
  if (rec.kind === 'note') return str(b.markdown ?? b.text);
  if (rec.kind === 'meeting') {
    const notes = str(b.notes);
    const segs = (b.segments || [])
      .map((s) => `${str(s.speaker) || '?'}: ${str(s.text)}`)
      .join('\n');
    return [notes, segs].filter(Boolean).join('\n\n');
  }
  if (rec.kind === 'brief') {
    const claims = (b.claims || []).map((c) => str(c.text)).filter(Boolean).join('\n');
    return [str(b.summary), claims].filter(Boolean).join('\n\n');
  }
  return '';
}

/**
 * A message's content may be a string or a multimodal part list. An image part contributes
 * nothing to a text index, and stringifying the object would put `[object Object]` into the
 * corpus — which is not a hypothetical, it is what naive JSON handling does here.
 */
function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : part && part.type === 'text' ? str(part.text) : ''))
    .filter(Boolean)
    .join(' ');
}

// --------------------------------------------------------------------------
// Counting — so every surface reports the same number
// --------------------------------------------------------------------------

/** Words in a note body, by the same rule everywhere. */
export function wordCount(text) {
  const t = str(text).trim();
  return t ? t.split(/\s+/).length : 0;
}

/** A short preview for a list row, so a list renders without opening every body. */
export function snippetOf(text, max = 110) {
  const b = str(text);
  const nl = b.indexOf('\n');
  const rest = nl >= 0 ? b.slice(nl + 1) : b;
  return rest.replace(/[#*_`>~]+/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * The index entry a list view renders from — everything needed to draw a row and nothing
 * that requires reading the body a second time.
 */
export function toIndexEntry(record) {
  const rec = normalizeStoredRecord(record);
  const text = bodyText(rec);
  return {
    id: rec.id,
    kind: rec.kind,
    title: rec.title,
    tags: rec.tags,
    snippet: snippetOf(text),
    words: wordCount(text),
    chars: text.length,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    deletedAt: rec.deletedAt,
  };
}
