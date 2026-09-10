// THE COMMAND BAR — what one line of typing means.
//
// Every ChatPanel surface is growing the same input: a single field that searches the
// corpus, asks the model, jumps to a subject, filters by tag, or runs a command. The
// extension has an omni modal, the desktop has an ambient composer, mobile will have a
// search sheet. If each decides on its own what `#atlas` means, muscle memory stops
// transferring between them — which is the whole value of a command bar.
//
// So the GRAMMAR lives here and the surfaces only decide how to paint it. Pure string in,
// structured intent out. No storage, no search, no model.
//
// WHY PREFIXES RATHER THAN A MODE PICKER: a picker costs a click before every query and has
// to be reset afterwards. A prefix is typed in the same keystroke as the query and is
// self-evident on screen. The set is deliberately tiny — five modes, each one character —
// because a grammar nobody can recall is a grammar nobody uses.
//
// AMBIGUITY RESOLVES TOWARD SEARCH. Anything unrecognised is a search, never an error: a bar
// that refuses input is worse than one that searches for a literal "?" .

export const OMNI_MODES = Object.freeze(['search', 'ask', 'subject', 'tag', 'command']);

/**
 * The grammar. `prefix` is what the user types; `hint` is what a surface shows in the
 * mode strip. Order is display order.
 */
export const OMNI_GRAMMAR = Object.freeze([
  Object.freeze({ mode: 'search', prefix: '', hint: 'search' }),
  Object.freeze({ mode: 'ask', prefix: '?', hint: 'ask' }),
  Object.freeze({ mode: 'subject', prefix: '@', hint: 'subject' }),
  Object.freeze({ mode: 'tag', prefix: '#', hint: 'tag' }),
  Object.freeze({ mode: 'command', prefix: '>', hint: 'command' }),
]);

const BY_PREFIX = new Map(OMNI_GRAMMAR.filter((g) => g.prefix).map((g) => [g.prefix, g.mode]));

/**
 * Filters a surface may apply inside a search. Kept here so `type:note since:7d` means the
 * same thing in the extension's omni and the desktop's bar — and the same thing the
 * gateway's `search_history` already accepts.
 */
const FILTER_KEYS = new Set(['type', 'since', 'before', 'in', 'limit']);

/**
 * Parse one line.
 *
 * Returns `{ mode, query, prefix, filters, raw }`. `query` has the prefix and any recognised
 * `key:value` filters removed, so it is ready to hand to a search or a model verbatim.
 */
export function parseOmni(input) {
  const raw = String(input ?? '');
  const trimmed = raw.trimStart();
  const first = trimmed.slice(0, 1);
  const mode = BY_PREFIX.get(first) || 'search';
  const prefix = mode === 'search' ? '' : first;

  // Only strip the prefix when it IS one — a search for "#" alone should still search.
  let rest = prefix ? trimmed.slice(1) : trimmed;
  rest = rest.replace(/^\s+/, '');

  const { query, filters } = extractFilters(rest);
  return { mode, prefix, query, filters, raw };
}

/**
 * Pull `key:value` pairs out of a query.
 *
 * A value may be quoted (`in:"cutover review"`). Unknown keys are LEFT IN the query rather
 * than dropped, because `http://example.com` and `note:` typed by mistake are both far more
 * likely than a user inventing a filter we forgot to implement.
 */
export function extractFilters(text) {
  const filters = {};
  const kept = [];
  // The `key:` prefix has to be part of the quoted alternative. Without it `\S+` matches
  // `in:"cutover` first and the value loses everything after its first space.
  const tokens = String(text || '').match(/(?:[A-Za-z]+:)?"[^"]*"|\S+/g) || [];

  for (const tok of tokens) {
    const m = /^([a-z]+):(.*)$/i.exec(tok);
    if (m && FILTER_KEYS.has(m[1].toLowerCase())) {
      const key = m[1].toLowerCase();
      const value = m[2].replace(/^"|"$/g, '');
      if (value) filters[key] = value;
      continue;
    }
    kept.push(tok.replace(/^"|"$/g, ''));
  }
  return { query: kept.join(' ').trim(), filters };
}

/**
 * A relative duration (`7d`, `24h`, `30m`) or a date, resolved against an injected `now`.
 *
 * `now` is a parameter for the reason it is one in `loop.js`: a function that reads the
 * clock cannot be tested, and "since 7d" must mean the same span in every client.
 */
export function resolveSince(value, now = Date.now()) {
  const s = String(value || '').trim().toLowerCase();
  if (!s) return 0;
  if (s === 'today') { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); }
  if (s === 'yesterday') { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime() - 86_400_000; }
  const rel = /^(\d+)\s*([mhdw])$/.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[rel[2]];
    return now - n * unit;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

/** Does this line ask for a model turn? Surfaces use it to decide whether to warm a target. */
export function wantsModel(parsed) {
  return !!parsed && parsed.mode === 'ask';
}

/**
 * Is the line worth acting on yet? Guards the "search on every keystroke" path so a bare
 * prefix does not run an empty query against the whole corpus.
 */
export function isActionable(parsed, { minChars = 2 } = {}) {
  if (!parsed) return false;
  if (parsed.mode === 'command') return parsed.query.length >= 1;
  return parsed.query.length >= minChars;
}
