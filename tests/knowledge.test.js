import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MAX_CLAIMS, briefId, briefTerms, briefToText, checkKnowledgeInvariants, contentHash, parseBriefText,
} from '../knowledge.js';
import { deriveBriefs, driftedRefs } from '../knowledge-derive.js';

const NOW = Date.UTC(2026, 8, 9);
const day = 86_400_000;

// A corpus dense enough that a couple of subjects earn a page under the default threshold.
function corpus() {
  const recs = [];
  for (let i = 0; i < 6; i += 1) {
    recs.push({
      id: `meeting:m${i}`, type: 'meeting', title: `Atlas review ${i}`, date: NOW - (10 - i) * day,
      text: 'the migration needs [[Atlas Charter]] signed off',
      meta: { people: i % 2 ? ['Alex Rivera'] : ['Alex'], tags: ['atlas'], terms: ['migration'] },
    });
  }
  for (let i = 0; i < 4; i += 1) {
    recs.push({
      id: `chat:c${i}`, type: 'chat', title: `Chat ${i}`, date: NOW - i * 3600_000,
      text: 'atlas migration questions', meta: { tags: ['atlas'], terms: ['migration'] },
    });
  }
  return recs;
}

test('a brief id is stable across rebuilds and safe as a key', () => {
  assert.equal(briefId('person:Alex Rivera'), briefId('person:alex  rivera'));
  assert.match(briefId('person:Alex Rivera'), /^brief:person-alex-rivera-[0-9a-f]{6}$/);
  assert.equal(briefId(''), '');
  assert.equal(briefId('person:'), '');
  // Punctuation is filing noise, so these are ONE subject and share an id by design.
  assert.equal(briefId('topic:q3/q4'), briefId('topic:q3 q4'));
  // The slug is cut at 48 chars while a subject may run to 60, so two subjects can share a
  // slug and differ only past the cut. The hash of the full canonical key separates them.
  const long = (tail) => `topic:${'x'.repeat(48)} ${tail}`;
  assert.equal(briefId(long('alpha')).split('-').slice(0, -1).join('-'), briefId(long('beta')).split('-').slice(0, -1).join('-'));
  assert.notEqual(briefId(long('alpha')), briefId(long('beta')));
  // The same name under two kinds is two subjects.
  assert.notEqual(briefId('person:atlas'), briefId('topic:atlas'));
});

test('the drift hash is stable, cheap and sensitive to a real edit', () => {
  assert.equal(contentHash('hello'), contentHash('hello'));
  assert.notEqual(contentHash('hello'), contentHash('hello '));
  assert.notEqual(contentHash('ab'), contentHash('ba'));
  assert.equal(contentHash(null), contentHash(''));
});

test('deriving is the only way a brief is made, and every claim cites raw', () => {
  const briefs = deriveBriefs(corpus(), { now: NOW });
  assert.ok(briefs.length >= 3, `expected several subjects to earn a page, got ${briefs.length}`);
  for (const b of briefs) {
    assert.deepEqual(checkKnowledgeInvariants(b), [], `${b.id} broke an invariant`);
    for (const c of b.claims) assert.ok(c.refs.length, `claim ${c.id} of ${b.id} cites nothing`);
  }
});

test('the same corpus derives the same briefs — a projection, not a document', () => {
  const a = deriveBriefs(corpus(), { now: NOW });
  const b = deriveBriefs(corpus(), { now: NOW });
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
});

test('a person brief accumulates the records and folds the short speaker label in', () => {
  const briefs = deriveBriefs(corpus(), { now: NOW });
  const alex = briefs.find((b) => b.kind === 'person');
  assert.equal(alex.subject.name, 'Alex Rivera');
  assert.deepEqual(alex.subject.aliases, ['alex']);
  assert.equal(alex.stats.records, 6);
  assert.match(alex.claims[0].text, /Appears in 6 records — 6 meetings\./);
  assert.match(alex.claims.find((c) => c.kind === 'timeline').text, /Runs from 2026-08-30 to 2026-09-04/);
  assert.match(alex.claims.find((c) => c.kind === 'together').text, /Usually alongside/);
});

test('a deterministic brief may auto-promote, because none of it is an opinion', () => {
  for (const b of deriveBriefs(corpus(), { now: NOW })) {
    assert.equal(b.state, 'promoted');
    assert.equal(b.cls, 'R');
  }
});

test('a wanted page becomes a brief that says why it is thin', () => {
  const wanted = deriveBriefs(corpus(), { now: NOW }).find((b) => b.kind === 'title');
  assert.ok(wanted, 'the unresolved [[Atlas Charter]] link should earn a page');
  assert.equal(wanted.subject.name, 'Atlas Charter');
  assert.match(wanted.claims.find((c) => c.kind === 'wanted').text, /no record carries this title/);
  assert.equal(wanted.stats.wanted, true);
});

test('memory folds in as the highest-confidence claim, and ambient kinds do not', () => {
  const memories = [
    { id: 'mem1', kind: 'fact', text: 'Alex Rivera owns the Atlas rollback plan.', updatedAt: NOW, confidence: 1 },
    { id: 'mem2', kind: 'preference', text: 'Alex Rivera prefers terse summaries.', updatedAt: NOW },
    { id: 'mem3', kind: 'project', text: 'Shipping the pricing model this quarter.', updatedAt: NOW },
  ];
  const alex = deriveBriefs(corpus(), { memories, now: NOW }).find((b) => b.kind === 'person');
  const stated = alex.claims.filter((c) => c.kind === 'stated');
  assert.equal(stated.length, 1, 'only the non-ambient memory naming the subject should land');
  assert.equal(stated[0].text, 'Alex Rivera owns the Atlas rollback plan.');
  assert.deepEqual(stated[0].refs.map((r) => r.kind), ['memory']);
  assert.equal(stated[0].refs[0].id, 'mem1');
});

test('a memory only matches on whole tokens, never a substring', () => {
  const recs = corpus().map((r) => ({ ...r, meta: { ...r.meta, terms: ['pricing'] } }));
  const memories = [{ id: 'm', kind: 'fact', text: 'Repricing the enterprise tier is on hold.', updatedAt: NOW }];
  const pricing = deriveBriefs(recs, { memories, now: NOW }).find((b) => b.subject.name === 'pricing');
  assert.ok(pricing);
  assert.equal(pricing.claims.filter((c) => c.kind === 'stated').length, 0);
});

test('an edited record is reported as drift rather than silently re-read', () => {
  const records = corpus();
  const brief = deriveBriefs(records, { now: NOW }).find((b) => b.kind === 'person');
  assert.deepEqual(driftedRefs(brief, records), []);

  const edited = records.map((r) => (r.id === 'meeting:m5' ? { ...r, text: 'entirely different now' } : r));
  const drift = driftedRefs(brief, edited);
  assert.ok(drift.some((d) => d.ref.id === 'm5' && d.resolution === 'drifted'));

  const deleted = records.filter((r) => r.id !== 'meeting:m5');
  assert.ok(driftedRefs(brief, deleted).some((d) => d.resolution === 'verified-but-unavailable'));
});

test('a brief renders to searchable text and to graph terms', () => {
  const alex = deriveBriefs(corpus(), { now: NOW }).find((b) => b.kind === 'person');
  const text = briefToText(alex);
  assert.match(text, /^BRIEF: Alex Rivera/);
  assert.match(text, /Also known as: alex/);
  assert.match(text, /RECORDS:/);
  assert.ok(briefTerms(alex).includes('Alex Rivera'));
  assert.ok(briefTerms(alex).length > 1, 'co-occurring subjects should be terms too');
  assert.equal(briefToText(null), '');
});

test('the invariants are a check that can actually fail', () => {
  const [b] = deriveBriefs(corpus(), { now: NOW });
  assert.deepEqual(checkKnowledgeInvariants({ ...b, state: 'sideways' }).map((f) => f.invariant), ['I-K3']);
  assert.deepEqual(
    checkKnowledgeInvariants({ ...b, claims: [{ id: 'x', kind: 'presence', text: 't', refs: [] }] }).map((f) => f.invariant),
    ['I-K1'],
  );
  // Model prose cannot be promoted without the gate — I-K3, the finding the whole design turns on.
  assert.ok(checkKnowledgeInvariants({ ...b, cls: 'C' }).some((f) => f.invariant === 'I-K3'));
  const fat = { ...b, claims: Array.from({ length: MAX_CLAIMS + 2 }, (_, i) => ({ id: `c${i}`, kind: 'presence', text: 't', refs: b.claims[0].refs })) };
  assert.ok(checkKnowledgeInvariants(fat).some((f) => f.invariant === 'I-K4'));
  assert.equal(checkKnowledgeInvariants(null)[0].invariant, 'I-K1');
});

test('an empty corpus derives nothing rather than throwing', () => {
  assert.deepEqual(deriveBriefs([]), []);
  assert.deepEqual(deriveBriefs(null), []);
});

test('the model half does not drag the derivation half onto a service worker', () => {
  // Reading a brief and BUILDING one have different costs, and only pages ever build. The
  // worker syncs stored briefs onward, so knowledge.js reaching curate.js/entity resolution
  // would put ~60 KB of derivation on its cold start for code it never runs.
  const src = readFileSync(new URL('../knowledge.js', import.meta.url), 'utf8');
  assert.ok(!/from '\.\/curate\.js'/.test(src), 'knowledge.js must not import curate.js');
  assert.ok(!/from '\.\/knowledge-derive\.js'/.test(src), 'the model must not import the pass');
});

test('the text form round-trips — an agent over MCP gets structure, not a blob', () => {
  // The warm store holds { id, title, type, date, text } and nothing else, so a brief's
  // claims and refs cross to the gateway only through the text. That makes the text a
  // grammar this module owns at both ends, and this is the test that keeps it one.
  const brief = deriveBriefs(corpus(), {
    memories: [{ id: 'mem1', kind: 'fact', text: 'Alex Rivera owns the Atlas rollback plan.', updatedAt: NOW }],
    now: NOW,
  }).find((b) => b.kind === 'person');
  const parsed = parseBriefText(briefToText(brief));
  assert.equal(parsed.name, 'Alex Rivera');
  assert.deepEqual(parsed.aliases, ['alex']);
  assert.equal(parsed.kind, 'person');
  assert.equal(parsed.claims.length, brief.claims.length);
  for (let i = 0; i < brief.claims.length; i += 1) {
    assert.equal(parsed.claims[i].text, brief.claims[i].text);
    assert.deepEqual(parsed.claims[i].refs, brief.claims[i].refs.map((r) => ({ kind: r.kind, id: r.id })));
  }
  assert.ok(parsed.claims.some((c) => c.refs.some((r) => r.kind === 'memory')), 'a stated claim keeps its memory ref');
  assert.ok(parsed.records.length > 0);
  assert.equal(parseBriefText('MEETING: not a brief'), null, 'a record that is not a brief is null, not an empty brief');
  assert.equal(parseBriefText(''), null);
});

test('briefToText survives a brief from a FILE, not only one its deriver just built', () => {
  // Briefs now arrive in backups, written by whatever build made them. A missing collection
  // is an older shape, not a bug to crash on — and crashing here took the whole brief
  // section of a restore with it.
  const minimal = { id: 'b1', kind: 'person', subject: { name: 'Alex Rivera' }, claims: [] };
  assert.match(briefToText(minimal), /BRIEF: Alex Rivera/);
  assert.match(briefToText({ ...minimal, claims: [{ text: 'Leads platform.' }] }), /Leads platform\./);
  assert.equal(briefToText({ ...minimal, subject: {} }), '', 'no subject name is nothing to say');
  assert.equal(briefToText(null), '');
  assert.equal(briefToText({}), '');
});
