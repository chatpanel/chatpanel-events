// ENTITY IDENTITY — forty mentions of one person are one subject, or they are nothing.
//
// Extraction we already have: `meeting-people.js` names the speakers on a call,
// `extraction.js` pulls topics and ENTITIES, `tags.js` folds the filing vocabulary. What
// none of them answer is the next question: are "Alex Rivera", "alex rivera" and the
// "Alex" who spoke in yesterday's standup the SAME subject? Without that answer a derived
// layer cannot exist — a brief is by definition an accumulation across records, so it needs
// something to accumulate *about*.
//
// Two rules do almost all the work, and both are deliberately conservative:
//
//   • CANONICAL FORM IS LOSSY, IDENTITY IS NOT. `subjectKey()` folds case, punctuation and
//     spacing — filing noise, exactly as in tags.js — but never folds two different names
//     together. The display name stays whatever the corpus said most often, so the user
//     reads "Alex Rivera" and not "alex-rivera".
//   • AN ALIAS IS ONLY AN ALIAS WHEN IT IS UNAMBIGUOUS. "Alex" folds into "Alex Rivera"
//     when Alex Rivera is the only Alex in the corpus. The moment a second Alex appears,
//     the bare token stops resolving to either — for good, and retroactively. Guessing here
//     is how a brief ends up attributing one person's decisions to another, which is the
//     single most expensive mistake this layer can make.
//
// Pure input → output: no storage, no clock, no model. The extension, the gateway and a
// future mobile client must agree on what "the same subject" is, and three implementations
// would mean three answers — the argument tags.js already makes for tags.

import { editDistance } from './distance.js';

/**
 * A REDACTION PLACEHOLDER IS NOT A SUBJECT — and this is the sharpest edge in the module.
 *
 * `@chatpanel/pii` writes `[[PERSON_1]]`, `[[EMAIL_2]]`, `[[LOCATION_1]]`, which is
 * character-for-character the `[[wikilink]]` grammar. So a redacted transcript reads as a
 * document full of links to pages that do not exist, and every one of them earned a "wanted
 * page" brief. The name of a person we deliberately did not learn was being filed as a thing
 * we know about.
 *
 * The tempting fix is to treat the token as a pseudonymous identity — it IS stable, and
 * within one conversation `PERSON_1` really does mean one person. It must not become a
 * subject anyway, because **the vault is scoped to a conversation**: `PERSON_1` in Monday's
 * chat and `PERSON_1` in Friday's are different people, and a global subject would merge
 * strangers under one page and attribute one person's decisions to another. That is the same
 * reason `aliasMap` refuses a bare token two people could claim — here it is guaranteed
 * rather than possible.
 *
 * So the placeholder is dropped from subject candidacy, and `curate.js` counts what was
 * dropped so the loss is REPORTED rather than silent. Never resolved against a vault into
 * anything derived and persisted, either: that would put the PII back on disk in a second
 * place, which is the one thing redaction exists to prevent.
 *
 * The pattern is duplicated from `@chatpanel/pii` rather than imported — this package ships
 * zero dependencies so the bridge can vendor it file by file, the same constraint that makes
 * the entitlement JWK live in two clients. `CLAUDE.md` lists `[[TYPE_n]]` as a wire contract
 * that only changes additively, and the extension (which vendors both) carries the drift
 * guard that fails when these two stop agreeing.
 */
export const REDACTION_TOKEN_TYPES = Object.freeze([
  'PERSON', 'ORG', 'LOCATION', 'ADDRESS', 'EMAIL', 'PHONE', 'ID', 'SSN', 'IBAN',
  'CREDITCARD', 'CARD', 'POST', 'FAC', 'GROUP', 'NRP', 'ENTITY', 'KEY', 'SECRET',
  'TERM', 'PII', 'OTHER',
]);

const BARE_TOKEN_RE = /^([A-Z][A-Z0-9]*)_\d+$/;
const unwrap = (v) => String(v ?? '').trim().replace(/^\[{1,2}|\]{1,2}$/g, '');

/**
 * Is this BARE string one of the redaction placeholders?
 *
 * Matched against the type vocabulary rather than the `[A-Z]+_\d+` shape, and everywhere —
 * inside brackets too. The shape alone eats real subjects: `[[Q3_2026]]` and `[[PHASE_2]]`
 * are links people genuinely write, and silently dropping them would trade one invisible bug
 * for another. A custom dictionary type is the accepted gap: it is user-chosen, so filing it
 * is a name the user picked, not a stranger's identity.
 *
 * Bracket-tolerant, because a wikilink parser has already stripped them by the time we ask,
 * and a model echoing a placeholder into JSON routinely mangles them.
 */
export function isRedactionToken(value) {
  const m = BARE_TOKEN_RE.exec(unwrap(value));
  return !!m && REDACTION_TOKEN_TYPES.includes(m[1]);
}

/** What a subject can be. `title` is a record title someone linked to with [[…]]. */
export const SUBJECT_KINDS = Object.freeze(['person', 'topic', 'tag', 'title']);

/**
 * A subject earns a brief with EVIDENCE, not on first sight (I-K4).
 *
 * PROVISIONAL. These numbers are the W0 measurement's whole point: `surveyCorpus()` reports
 * how many subjects clear them so they can be set from a real corpus instead of taste. Do
 * not treat them as decided until that report has been run.
 */
export const DEFAULT_THRESHOLD = Object.freeze({ records: 3, mentions: 5 });

/** Ceiling on the set of briefs, for the same reason memory.js caps memories. Provisional. */
export const MAX_SUBJECTS = 500;

/** Longest name we will treat as a subject — past this it is a sentence, not a subject. */
export const MAX_SUBJECT_CHARS = 60;

// Words that are never a subject on their own. A one-token candidate has to survive this
// list before it can become a page, because "notes", "meeting" and "update" appear in every
// record and would each clear any threshold instantly.
const STOP_SUBJECTS = new Set([
  'chat', 'chats', 'note', 'notes', 'meeting', 'meetings', 'call', 'calls', 'update',
  'updates', 'summary', 'summaries', 'agenda', 'todo', 'todos', 'task', 'tasks', 'item',
  'items', 'thing', 'things', 'stuff', 'misc', 'other', 'general', 'test', 'testing',
  'untitled', 'draft', 'drafts', 'new', 'old', 'today', 'yesterday', 'tomorrow', 'week',
  'day', 'month', 'year', 'time', 'people', 'person', 'team', 'work',
]);

/**
 * Labels a meeting platform uses for the person holding the microphone.
 *
 * Zoom, Meet and Teams all write the local participant as "You" — so the user appears in
 * their own corpus under a name that is not a name, alongside however their colleagues'
 * clients spelled them. Resolving these needs one fact only the host has: who "you" IS.
 * `resolveSubjects` takes it rather than guessing, and with no `self` supplied these stay
 * unresolved instead of collapsing every meeting's local speaker into one fictional person.
 */
export const SELF_LABELS = Object.freeze(['you', 'me', 'myself', 'yourself', 'i']);

/**
 * Is this the platform's label for the local participant?
 *
 * Exported because two layers need the SAME exception and getting the order wrong is subtle:
 * a self-label fails `isSubjectCandidate` (it is a pronoun), so any pass that filters
 * candidacy BEFORE `resolveSubjects` can fold it has already thrown the user away. `curate.js
 * mentionsFrom` keeps them for exactly this reason and lets resolution decide.
 */
export function isSelfLabel(name) {
  return SELF_LABELS.includes(normalizeSubject(name));
}

/**
 * Strip the decoration a directory or a conference client hangs off a person's name.
 *
 * The same human arrives as "Alex Rivera", "Alex Rivera (ACME)", "Alex Rivera - Host" and
 * "Alex Rivera (he/him)" depending on which client wrote the label. The part in parentheses
 * or after a dash is an org, a role or a pronoun set — decoration, never identity — so it is
 * removed before folding.
 *
 * NOT removed for non-person subjects: "Migration (Phase 2)" is a different topic from
 * "Migration", where "Alex Rivera (ACME)" is not a different person from "Alex Rivera".
 */
export function stripQualifiers(name) {
  return String(name ?? '')
    .replace(/\s*[([{][^)\]}]*[)\]}]\s*/g, ' ')   // (ACME), [external], {guest}
    .replace(/\s+[-–—|·,]\s+.*$/, '')             // - Host, — Guest, | ACME
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fold a name to its canonical form: lowercase, Unicode-aware, separators collapsed.
 *
 * Spaces survive as spaces (unlike normalizeTag, which folds them to '-') because a person's
 * name is read back to the user and "alex rivera" has to be recognisable as one.
 */
export function normalizeSubject(name) {
  const raw = String(name ?? '').normalize('NFKC').trim().replace(/^[#@]+/, '');
  if (!raw) return '';
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .slice(0, MAX_SUBJECT_CHARS)
    .trim();
}

/** `person:alex rivera` — the identity a brief is filed under. '' when nothing survives. */
export function subjectKey(kind, name) {
  const norm = normalizeSubject(name);
  if (!norm || !SUBJECT_KINDS.includes(kind)) return '';
  return `${kind}:${norm}`;
}

/** Tokens of a canonical name. */
export function subjectTokens(name) {
  const norm = normalizeSubject(name);
  return norm ? norm.split(' ').filter(Boolean) : [];
}

/**
 * Is this string worth considering as a subject at all?
 *
 * Rejects blanks, over-long phrases, pure numbers and the stop list above. A multi-token
 * phrase is allowed even when one of its tokens is a stop word ("design review" is a real
 * topic, "review" alone is not).
 */
export function isSubjectCandidate(name, { kind = 'topic' } = {}) {
  // Length is judged BEFORE folding: normalizeSubject truncates at MAX_SUBJECT_CHARS, so a
  // check on its output can never fire and a whole sentence would slip through as a subject.
  if (String(name ?? '').trim().length > MAX_SUBJECT_CHARS) return false;
  // Checked on the RAW value, before folding: normalizeSubject lowercases, and the pattern
  // is upper-case by construction.
  if (isRedactionToken(name)) return false;
  // "You" is a pronoun, not a person. Without a `self` name to fold it into (resolveSubjects
  // takes one), it must not become a subject of its own — every meeting has a "You" and they
  // are not all the same participant.
  if (kind === 'person' && isSelfLabel(name)) return false;
  const norm = normalizeSubject(name);
  if (!norm || norm.length < 2) return false;
  const tokens = norm.split(' ').filter(Boolean);
  if (!tokens.length) return false;
  if (tokens.every((t) => /^\p{N}+$/u.test(t))) return false;
  if (tokens.length === 1 && STOP_SUBJECTS.has(tokens[0])) return false;
  // A person needs at least two characters of actual letters — "j r" is initials, not an
  // identity we can accumulate against.
  if (kind === 'person' && !/\p{L}{2}/u.test(norm)) return false;
  return true;
}

/**
 * Resolve short forms to full names, but ONLY when the corpus leaves no doubt.
 *
 * Given the canonical names seen for one kind, returns `alias -> canonical`. A bare token
 * maps to a multi-token name when it is that name's first or last token AND exactly one
 * name in the corpus claims it. Two people called Alex means neither owns "alex", so the
 * bare token maps to nothing and stays a subject of its own — visible, unmerged, and
 * therefore checkable, which is the failure mode we want.
 */
export function aliasMap(names) {
  const canonical = new Set();
  for (const n of names || []) {
    const norm = normalizeSubject(n);
    if (norm && norm.includes(' ')) canonical.add(norm);
  }
  const claims = new Map(); // token -> Set(full names claiming it)
  for (const full of canonical) {
    const tokens = full.split(' ');
    for (const t of [tokens[0], tokens[tokens.length - 1]]) {
      if (!t || t.length < 2 || STOP_SUBJECTS.has(t)) continue;
      if (!claims.has(t)) claims.set(t, new Set());
      claims.get(t).add(full);
    }
  }
  const out = new Map();
  for (const [token, owners] of claims) {
    if (owners.size !== 1) continue; // ambiguous — resolve to nothing, on purpose
    out.set(token, [...owners][0]);
  }
  return out;
}

/**
 * Fold a list of raw mentions into subjects.
 *
 * `mentions` is `[{ kind, name, recordId }]` — whatever the corpus said, in whatever form.
 * The result is one entry per identity, carrying every surface form that reached it, the
 * distinct records it appeared in, and the display name the corpus used most often.
 *
 * Aliases are resolved per KIND: two topics can share a word without being the same topic,
 * and the person rule above must not leak into tags.
 */
export function resolveSubjects(mentions = [], { merges = null, self = '' } = {}) {
  // The user's own name, however they told us. Everything the platforms call "you" folds
  // into it — and with no name supplied, nothing does.
  const selfName = String(self ?? '').trim();
  const selfCanonical = normalizeSubject(selfName);
  // User-authored merges: `alias canonical form -> the canonical form it belongs to`. These
  // are an INPUT to derivation, never an edit to its output, which is what keeps I-K2 true —
  // a rebuild that dropped the user's corrections would teach them not to make any.
  const merged = new Map();
  for (const [from, to] of merges instanceof Map ? merges : Object.entries(merges || {})) {
    const a = normalizeSubject(from); const b = normalizeSubject(to);
    if (a && b && a !== b) merged.set(a, b);
  }
  // One hop only. A chain (a→b, b→c) is resolved here rather than at read time, and a cycle
  // simply stops, because a merge loop must not hang a rebuild.
  const resolveMerge = (key) => {
    let cur = key;
    for (let i = 0; i < 8 && merged.has(cur); i += 1) {
      const next = merged.get(cur);
      if (next === cur) break;
      cur = next;
    }
    return cur;
  };

  const byKind = new Map();
  for (const m of mentions) {
    const kind = m?.kind;
    if (!SUBJECT_KINDS.includes(kind)) continue;
    // A self-label survives candidacy ONLY when there is a name to fold it into. Otherwise
    // it is a pronoun, and every meeting's "You" would pile into one fictional participant.
    const isSelf = kind === 'person' && !!selfCanonical && isSelfLabel(m.name);
    if (!isSelf && !isSubjectCandidate(m.name, { kind })) continue;
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(m);
  }

  const subjects = new Map();
  for (const [kind, list] of byKind) {
    // Only PERSON names carry the short-form rule. A topic named "design" is not the
    // "design review" topic, and folding them would silently merge two pages.
    const aliases = kind === 'person'
      ? aliasMap(list.map((m) => stripQualifiers(m.name)).filter((n) => !isSelfLabel(n)))
      : new Map();
    for (const m of list) {
      const raw = String(m.name ?? '').trim();
      // For a PERSON, the qualifier is decoration and the platform's "You" is the user.
      // Both are resolved before the alias rule, so "Alex Rivera (ACME)" and "You" reach the
      // same identity that a bare "Alex" does.
      let norm = normalizeSubject(kind === 'person' ? stripQualifiers(raw) : raw);
      if (kind === 'person' && selfCanonical && SELF_LABELS.includes(norm)) norm = selfCanonical;
      const canonical = resolveMerge(aliases.get(norm) || norm);
      const key = `${kind}:${canonical}`;
      let s = subjects.get(key);
      if (!s) {
        s = { key, kind, name: '', canonical, aliases: [], records: new Set(), mentions: 0, forms: new Map() };
        subjects.set(key, s);
      }
      s.mentions += 1;
      if (m.recordId) s.records.add(m.recordId);
      const display = String(m.name ?? '').normalize('NFKC').trim();
      if (display) s.forms.set(display, (s.forms.get(display) || 0) + 1);
      if (norm !== canonical && !s.aliases.includes(norm)) s.aliases.push(norm);
    }
  }

  for (const s of subjects.values()) {
    // The name the user reads is a surface form of the CANONICAL identity, most common
    // first, ties broken alphabetically so the choice is stable across runs rather than
    // insertion-ordered. Forms that only reached this subject through an alias are ranked
    // last: `person:alex rivera` displayed as "Alex" because the short form happened to be
    // one mention commoner would be a page whose title is not the subject's name.
    const forms = [...s.forms.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    s.name = forms.find(([f]) => normalizeSubject(f) === s.canonical)?.[0]
      || forms[0]?.[0]
      || s.canonical;
    s.aliases.sort();
    delete s.forms;
  }
  return subjects;
}

/** Does this subject have enough evidence to deserve a page? */
export function earnsBrief(subject, threshold = DEFAULT_THRESHOLD) {
  if (!subject) return false;
  const records = subject.records instanceof Set ? subject.records.size : (subject.records?.length || 0);
  const mentions = Number(subject.mentions) || 0;
  return records >= (threshold.records ?? DEFAULT_THRESHOLD.records)
      && mentions >= (threshold.mentions ?? DEFAULT_THRESHOLD.mentions);
}

/**
 * Rank subjects and keep the ones that earned a page, strongest first.
 *
 * `limit` is the I-K4 count ceiling made concrete: a corpus with 4000 qualifying subjects
 * does not get 4000 briefs, it gets the best `limit` of them, and the rest stay subjects
 * without pages until the evidence moves.
 */
export function rankSubjects(subjects, { threshold = DEFAULT_THRESHOLD, limit = MAX_SUBJECTS } = {}) {
  const list = [...(subjects instanceof Map ? subjects.values() : subjects || [])];
  return list
    .filter((s) => earnsBrief(s, threshold))
    .map((s) => ({ ...s, recordCount: s.records instanceof Set ? s.records.size : (s.records?.length || 0) }))
    .sort((a, b) => b.recordCount - a.recordCount || b.mentions - a.mentions || a.key.localeCompare(b.key))
    .slice(0, Math.max(0, limit));
}

/**
 * PROPOSE merges; never apply them.
 *
 * The alias rule folds what it can prove. Everything it cannot is left visible — "A. Rivera"
 * beside "Alex Rivera", an initialism beside a full name, a second spelling of a project —
 * and a user staring at two pages for one person has no way to say so. This is that way: a
 * deterministic, model-free list of pairs worth asking about, ranked by how likely they are.
 *
 * PROPOSING is the whole design. The pairs below are exactly the ones the alias rule refuses
 * to decide on its own, because deciding wrongly merges two people permanently and silently.
 * A human answers in one click, the answer is stored as a merge rule, and every later rebuild
 * applies it — so the correction survives I-K2 rather than being erased by the next pass.
 *
 * Three signals, strongest first:
 *   • initials — "A. Rivera" against "Alex Rivera"
 *   • containment — one name's tokens are a subset of the other's
 *   • near-spelling — one edit apart, or a transposition, which catches the common typos
 *
 * A shared SURNAME is deliberately not a signal: two people with one last name are usually
 * two people, and proposing every such pair would bury the real suggestions.
 */
export function suggestMerges(subjects, { limit = 40, distance = 1 } = {}) {
  const list = [...(subjects instanceof Map ? subjects.values() : subjects || [])]
    .filter((s) => s && s.canonical);
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i]; const b = list[j];
      if (a.kind !== b.kind) continue; // a person and a topic are never the same subject
      const reason = mergeReason(a.canonical, b.canonical, a.kind, distance);
      if (!reason) continue;
      // The better-evidenced side is proposed as the survivor: it has more records behind it
      // and is more likely the name the user actually thinks in.
      const [keep, drop] = countOf(a) >= countOf(b) ? [a, b] : [b, a];
      out.push({ kind: a.kind, keep: keep.key, keepName: keep.name, drop: drop.key, dropName: drop.name, reason });
    }
  }
  const rank = { initials: 0, containment: 1, spelling: 2 };
  return out
    .sort((x, y) => (rank[x.reason] - rank[y.reason]) || x.keepName.localeCompare(y.keepName))
    .slice(0, Math.max(0, limit));
}

function countOf(s) {
  return s.records instanceof Set ? s.records.size : (s.records?.length || 0);
}

const sortedChars = (s) => [...s.replace(/ /g, '')].sort().join('');
// "q3 planning" and "q4 planning" are one edit apart and are not the same subject; nor are
// "phase 2" and "phase 3", or "atlas sync 1" and "atlas sync 2". If masking the digits makes
// two names identical, the difference IS the digits, and that is a SERIES. duplicateTitles
// makes the same argument for trailing numbers; this is the in-word case.
const digitSeries = (a, b) => a !== b && a.replace(/\d/g, '#') === b.replace(/\d/g, '#');

function mergeReason(a, b, kind, distance) {
  if (a === b) return null;
  const ta = a.split(' ').filter(Boolean);
  const tb = b.split(' ').filter(Boolean);

  // "a. rivera" / "ar" against "alex rivera" — same last token, first token abbreviates.
  const last = ta[ta.length - 1] === tb[tb.length - 1];
  if (last && ta.length > 1 && tb.length > 1) {
    const [fa, fb] = [ta[0], tb[0]];
    if (fa !== fb && (fa.startsWith(fb) || fb.startsWith(fa))) return 'initials';
  }
  if (ta.length === 1 && tb.length === 1 && ta[0] !== tb[0]) {
    const [short, long] = ta[0].length <= tb[0].length ? [ta[0], tb[0]] : [tb[0], ta[0]];
    if (short.length >= 2 && long.startsWith(short)) return 'initials';
  }

  // One name's tokens are all present in the other's.
  const setA = new Set(ta); const setB = new Set(tb);
  const [small, big] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  if (small.size && [...small].every((t) => big.has(t)) && small.size !== big.size) return 'containment';

  if (digitSeries(a, b)) return null;

  // Too short for an edit to mean anything — see duplicateTitles for the same guard.
  if (Math.min(a.length, b.length) > distance * 3) {
    if (editDistance(a, b, distance) <= distance) return 'spelling';
    // A transposition costs TWO edits in Levenshtein, and "atals" for "atlas" is the single
    // commonest typo there is. Admitted only when the two are anagrams, so widening the
    // budget cannot also admit "q3 planning" against "q4 planning".
    if (editDistance(a, b, 2) <= 2 && sortedChars(a) === sortedChars(b)) return 'spelling';
  }

  // A SHARED SURNAME IS NOT A SIGNAL, and it was tempting. Two people with the same last
  // name are usually two people — colleagues, relatives — so proposing every such pair on
  // every rebuild would bury the three real suggestions under thirty. A list nobody reads
  // is worse than no list, which is the same finding that keeps briefs bounded.
  return null;
}
