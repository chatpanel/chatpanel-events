import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  duplicateTitles, formatSurvey, mentionsFrom, normalizeRecord, orphanRecords,
  redactionCost, spanningQuestions, surveyCorpus, thresholdSweep, vocabularyDrift,
  wantedPages, wikilinksIn,
} from '../curate.js';

const rec = (id, over = {}) => ({ id, type: 'note', title: id, date: 1, text: '', ...over });

test('a record is accepted in the extension Source shape or flat', () => {
  const fromSource = normalizeRecord({
    id: 'note:1', type: 'note', title: 'Atlas', date: 5, text: 'body',
    meta: { tags: ['Design'], terms: ['atlas'], people: ['Alex Rivera'] },
  });
  assert.deepEqual(fromSource.tags, ['Design']);
  assert.deepEqual(fromSource.topics, ['atlas']);
  assert.deepEqual(fromSource.people, ['Alex Rivera']);

  const flat = normalizeRecord({ id: 'x', kind: 'MEETING', title: ' T ', startedAt: 9, contentText: 'b', tags: ['a'] });
  assert.equal(flat.type, 'meeting');
  assert.equal(flat.title, 'T');
  assert.equal(flat.date, 9);
  assert.equal(flat.text, 'b');

  assert.equal(normalizeRecord(null), null);
  assert.equal(normalizeRecord({ title: 'no id' }), null);
});

test('wikilinks are parsed the way the notes index parses them, plus the |alias form', () => {
  assert.deepEqual(wikilinksIn('see [[Atlas]] and [[Pricing]]'), ['Atlas', 'Pricing']);
  assert.deepEqual(wikilinksIn('[[Atlas]] again [[Atlas]]'), ['Atlas']);
  assert.deepEqual(wikilinksIn('[[Atlas|the migration]]'), ['Atlas']);
  assert.deepEqual(wikilinksIn('[[ ]] [[]]'), []);
  assert.deepEqual(wikilinksIn(null), []);
  // A newline inside the brackets is not a link — the same guard store-notes.js uses.
  assert.deepEqual(wikilinksIn('[[Atlas\nMigration]]'), []);
});

test('the regex is not stateful across calls', () => {
  const text = '[[A]] [[B]]';
  assert.deepEqual(wikilinksIn(text), wikilinksIn(text));
});

test('wanted pages are links resolving to no record, ranked by how many records want them', () => {
  const records = [
    rec('n1', { title: 'Kickoff', text: 'see [[Atlas]] and [[Pricing]]' }),
    rec('n2', { title: 'Retro', text: '[[Atlas]] again' }),
    rec('n3', { title: 'Atlas Notes', text: '[[Atlas Notes]] resolves' }),
  ];
  const wanted = wantedPages(records);
  assert.deepEqual(wanted.map((w) => w.target), ['Atlas', 'Pricing']);
  assert.equal(wanted[0].recordCount, 2);
  assert.equal(wanted[1].recordCount, 1);
  // A link to an existing title is not "wanted" — it already has a record.
  assert.ok(!wanted.some((w) => w.norm === 'atlas notes'));
});

test('a record linking only to itself is still an orphan', () => {
  const records = [rec('n1', { title: 'Solo', text: 'I link [[Solo]]' }), rec('n2', { title: 'Other' })];
  assert.deepEqual(orphanRecords(records).map((r) => r.id), ['n1', 'n2']);
});

test('orphans are records with no link, no shared tag and no shared topic', () => {
  const records = [
    rec('a', { title: 'A', text: 'go to [[B]]' }),
    rec('b', { title: 'B' }),
    rec('c', { title: 'C', tags: ['pricing'] }),
    rec('d', { title: 'D', topics: ['Pricing'] }),
    rec('e', { title: 'E', tags: ['lonely'] }),
  ];
  const orphans = orphanRecords(records).map((r) => r.id);
  // a↔b by link; c and d share the pricing vocabulary once both are normalized.
  assert.deepEqual(orphans, ['e']);
});

test('duplicate titles cluster exact and near matches without merging real siblings', () => {
  const records = [
    rec('1', { title: 'Design Review' }),
    rec('2', { title: 'design  review' }),
    rec('3', { title: 'Unrelated thing' }),
  ];
  const groups = duplicateTitles(records);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].ids.sort(), ['1', '2']);

  // One character apart and genuinely different — reported, never merged, which is why this
  // pass produces candidates for a reviewer instead of applying anything.
  const siblings = duplicateTitles([rec('4', { title: 'Q3 Planning' }), rec('5', { title: 'Q4 Planning' })]);
  assert.equal(siblings.length, 1);

  // Short titles are excluded from near-matching — 2 edits rewrites most of "Atlas".
  assert.deepEqual(duplicateTitles([rec('6', { title: 'Atlas' }), rec('7', { title: 'Notes' })]), []);
});

test('a numbered series is not a pile of duplicates', () => {
  // Recurring meetings and default chat titles sit one or two edits apart. Reporting them
  // as one giant duplicate group is how a maintenance report becomes noise nobody reads.
  const series = ['Atlas sync 1', 'Atlas sync 2', 'Atlas sync 3', 'Atlas Sync'];
  assert.deepEqual(duplicateTitles(series.map((t, i) => rec(`s${i}`, { title: t }))), []);
  assert.deepEqual(duplicateTitles(['Chat 1', 'Chat 2', 'Chat 3'].map((t, i) => rec(`c${i}`, { title: t }))), []);
  // Two records genuinely sharing a numbered title still group — that is an exact match,
  // not a series.
  assert.equal(duplicateTitles([rec('a', { title: 'Atlas sync 2' }), rec('b', { title: 'atlas  sync 2' })]).length, 1);
});

test('vocabulary drift finds one term filed several ways', () => {
  const records = [
    rec('1', { tags: ['design-review'] }),
    rec('2', { tags: ['designreview'] }),
    rec('3', { topics: ['Design Review'] }),
    rec('4', { tags: ['pricing'] }),
  ];
  const drift = vocabularyDrift(records);
  const cluster = drift.find((g) => g.terms.some((t) => t.term === 'design-review'));
  assert.ok(cluster, 'the two spellings of design-review should cluster');
  assert.ok(cluster.terms.some((t) => t.term === 'designreview'));
  assert.ok(!drift.some((g) => g.terms.some((t) => t.term === 'pricing')));
});

test('mentions come from every structured signal the corpus already carries', () => {
  const records = [rec('m1', {
    type: 'meeting', title: 'Standup', text: 'we discussed [[Atlas]]',
    people: ['Alex Rivera'], tags: ['standup-notes'], topics: ['migration plan'],
  })];
  const kinds = mentionsFrom(records).map((m) => `${m.kind}:${m.name}`);
  assert.deepEqual(kinds.sort(), [
    'person:Alex Rivera', 'tag:standup-notes', 'title:Atlas', 'topic:migration plan',
  ]);
  // Junk never becomes a mention.
  assert.deepEqual(mentionsFrom([rec('x', { topics: ['meeting', ''], tags: ['2026'] })]), []);
});

test('spanning measures how often a question needs more than one record', () => {
  const records = [
    rec('1', { text: 'atlas migration plan timeline' }),
    rec('2', { text: 'atlas migration risks' }),
    rec('3', { text: 'atlas migration budget' }),
    rec('4', { text: 'atlas migration owners' }),
    rec('5', { text: 'unrelated lunch order' }),
  ];
  const wide = spanningQuestions(records, ['what is the atlas migration status']);
  assert.equal(wide.considered, 1);
  assert.equal(wide.spanning, 1);
  assert.equal(wide.medianRecords, 4);

  const narrow = spanningQuestions(records, ['lunch order details']);
  assert.equal(narrow.spanning, 0);
  assert.equal(narrow.fraction, 0);

  // Too few usable terms to be a question about the corpus — skipped, not counted as narrow.
  assert.equal(spanningQuestions(records, ['ok thanks']).considered, 0);
  assert.equal(spanningQuestions(records, []).fraction, 0);
});

test('the survey is one read-only pass over everything, and reports its own thresholds', () => {
  const records = [
    rec('m1', { type: 'meeting', title: 'Atlas kickoff', text: 'plan [[Atlas Charter]]', people: ['Alex Rivera'], topics: ['atlas'] }),
    rec('m2', { type: 'meeting', title: 'Atlas review', text: 'again [[Atlas Charter]]', people: ['alex rivera', 'Jordan Blake'], topics: ['atlas'] }),
    rec('m3', { type: 'meeting', title: 'Atlas retro', text: '', people: ['Alex'], topics: ['atlas'] }),
    rec('m4', { type: 'meeting', title: 'Atlas costs', text: '', people: ['Alex Rivera'], topics: ['atlas'] }),
    rec('m5', { type: 'meeting', title: 'Atlas handover', text: '', people: ['Alex Rivera'], topics: ['atlas'] }),
    rec('n1', { type: 'note', title: 'Lonely note', text: 'nothing here' }),
  ];
  const report = surveyCorpus(records, { questions: ['what happened with atlas'] });

  assert.equal(report.corpus.records, 6);
  assert.deepEqual(report.corpus.byType, { meeting: 5, note: 1 });
  assert.equal(report.subjects.threshold.records, 3);

  const atlasPeople = report.subjects.top.find((s) => s.kind === 'person');
  assert.equal(atlasPeople.name, 'Alex Rivera');
  assert.deepEqual(atlasPeople.aliases, ['alex']); // the bare speaker label folded in
  assert.equal(atlasPeople.records, 5);
  // Jordan Blake spoke once and gets no page — evidence, not first sight.
  assert.ok(!report.subjects.top.some((s) => s.name === 'Jordan Blake'));

  assert.equal(report.wantedPages.total, 1);
  assert.equal(report.wantedPages.top[0].target, 'Atlas Charter');
  assert.ok(report.orphans.sample.some((r) => r.id === 'n1'));
  assert.equal(report.questions.considered, 1);

  // Nothing in the report is a mutation of the input.
  assert.equal(records[0].title, 'Atlas kickoff');
});

test('an empty corpus produces a report rather than an exception', () => {
  const report = surveyCorpus([]);
  assert.equal(report.corpus.records, 0);
  assert.equal(report.subjects.total, 0);
  assert.equal(report.subjects.capped, false);
  assert.equal(report.orphans.fraction, 0);
  assert.match(formatSurvey(report), /0 records/);
  assert.match(formatSurvey(report), /no questions supplied/);
});

test('the sweep shows what each threshold would cost, so the number is chosen not inherited', () => {
  const records = Array.from({ length: 6 }, (_, i) => rec(`r${i}`, { topics: ['atlas', i < 2 ? 'pricing' : 'onboarding'] }));
  const sweep = thresholdSweep(records);
  assert.equal(sweep.length, 4);
  // Tightening a threshold can never admit more subjects.
  for (let i = 1; i < sweep.length; i += 1) assert.ok(sweep[i].qualifying <= sweep[i - 1].qualifying);
});

test('formatSurvey renders the verdict the measurement exists to produce', () => {
  const records = [
    rec('1', { text: 'atlas migration plan' }), rec('2', { text: 'atlas migration risk' }),
    rec('3', { text: 'atlas migration cost' }), rec('4', { text: 'atlas migration owner' }),
  ];
  const thick = formatSurvey(surveyCorpus(records, { questions: ['atlas migration status'] }));
  assert.match(thick, /synthesis has something to compound/);

  const thin = formatSurvey(surveyCorpus(records, { questions: ['completely unrelated wording here'] }));
  assert.match(thin, /THIN/);
  assert.equal(formatSurvey(null), 'no report');
});

test('the distance primitive lives on its own, not inside the feature that grew it', () => {
  // Importing it from voice-intents.js put that module (79 KB) and its structured.js
  // dependency (41 KB) on the MV3 service worker's cold start, for forty lines of
  // arithmetic. A primitive two unrelated features need belongs in its own module.
  const src = readFileSync(new URL('../curate.js', import.meta.url), 'utf8');
  assert.ok(!/from '\.\/voice-intents\.js'/.test(src), 'curate.js must not import voice-intents.js');
  assert.match(src, /from '\.\/distance\.js'/);
});

test('redaction placeholders are excluded from links and counted instead', () => {
  const records = [
    rec('c1', { type: 'chat', text: 'see [[Atlas]], [[PERSON_1]] and [[Q3_2026]]' }),
    rec('c2', { type: 'chat', text: '[[PERSON_1]] and [[LOCATION_2]] again' }),
    rec('n1', { title: 'Atlas', text: 'the real page' }),
  ];
  // A real link survives — matched by TYPE, so [[Q3_2026]] is not mistaken for a placeholder.
  assert.deepEqual(wikilinksIn(records[0].text), ['Atlas', 'Q3_2026']);
  // …and no placeholder becomes a wanted page.
  assert.ok(!wantedPages(records).some((w) => /PERSON|LOCATION/.test(w.target)));
  assert.ok(wantedPages(records).some((w) => w.target === 'Q3_2026'));

  // The loss is REPORTED, not silent: only the user can decide their redaction level is
  // costing them a connected graph.
  const cost = redactionCost(records);
  assert.equal(cost.total, 3);
  assert.equal(cost.records, 2);
  assert.deepEqual(cost.byType, { PERSON: 2, LOCATION: 1 });
  assert.deepEqual(redactionCost([]), { total: 0, records: 0, byType: {} });

  const report = surveyCorpus(records);
  assert.equal(report.redaction.total, 3);
  assert.match(formatSurvey(report), /REDACTED MENTIONS/);
  assert.match(formatSurvey(report), /vault is per-conversation/);
});

test('a self-label survives mentionsFrom so resolution can decide about it', () => {
  // The exception has to live at BOTH layers or it lives at neither: a self-label fails
  // isSubjectCandidate (it is a pronoun), so filtering candidacy here — before resolution
  // knows whether there is a name to fold it into — threw the user out of their own corpus.
  const records = [rec('m1', { type: 'meeting', people: ['You', 'Jordan Blake'] })];
  const names = mentionsFrom(records).filter((m) => m.kind === 'person').map((m) => m.name);
  assert.deepEqual(names, ['You', 'Jordan Blake']);
  // A self-label is a person's exception only — a TOPIC called "you" is filtered normally.
  assert.deepEqual(mentionsFrom([rec('m2', { topics: ['meeting'] })]), []);
});

test('the near-duplicate passes are near-linear, not N x N', () => {
  // This is the design's own "no N×N scan" rule, enforced instead of remembered. The
  // pairwise version ran 1s at 2,000 records, 10s at 6,000 and 40s at 12,000 — on the UI
  // thread, which is an unresponsive tab rather than a slow report. Blocking made it flat.
  const corpus = (n) => Array.from({ length: n }, (_, i) => rec(`c${i}`, {
    type: 'chat', title: `Unique conversation number ${i}`, text: 'body', tags: [`t${i % 300}`],
  }));

  const time = (n) => { const t = Date.now(); duplicateTitles(corpus(n)); return Date.now() - t; };
  const small = Math.max(time(1500), 1);
  const large = Math.max(time(12000), 1);
  // Quadratic would be ~64x for an 8x corpus. Allow generous slack for a loaded CI box and
  // still fail loudly on a return to pairwise.
  assert.ok(large < small * 12,
    `duplicateTitles looks quadratic again: ${small}ms at 1.5k vs ${large}ms at 12k`);
  assert.ok(large < 5000, `12k records took ${large}ms — that is a frozen tab, not a report`);
});

test('blocking still finds the duplicates that matter, in a big corpus', () => {
  // Blocking is only worth it if the findings survive. A typo at the FRONT is caught by the
  // suffix key and one at the BACK by the prefix key — that is why there are two.
  const records = [
    ...Array.from({ length: 6000 }, (_, i) => rec(`c${i}`, { title: `Unique conversation number ${i}` })),
    rec('a1', { title: 'Design Review' }),
    rec('a2', { title: 'design  review' }),
    rec('b1', { title: 'Atlas migration plan' }),
    rec('b2', { title: 'Atals migration plan' }),
    rec('d1', { title: 'Quarterly planning session' }),
    rec('d2', { title: 'Quarterly planning sessoin' }),
  ];
  const groups = duplicateTitles(records);
  const found = (id) => groups.find((g) => g.ids.includes(id));
  assert.ok(found('a1')?.ids.includes('a2'), 'an exact normalized duplicate');
  assert.ok(found('b1')?.ids.includes('b2'), 'a typo at the START, caught by the suffix block');
  assert.ok(found('d1')?.ids.includes('d2'), 'a typo at the END, caught by the prefix block');
});

test('a pathological corpus costs a truncated report, never a hung page', () => {
  // Ten thousand titles that all begin the same way land in one block, and a block is
  // compared pairwise. The budget is what stops that being the old bug wearing a hat.
  const records = Array.from({ length: 9000 }, (_, i) => rec(`c${i}`, { title: `Weekly project status report ${'z'.repeat(i % 9)}${i}` }));
  const t = Date.now();
  const groups = duplicateTitles(records);
  const ms = Date.now() - t;
  assert.ok(ms < 5000, `a same-prefix corpus took ${ms}ms — the comparison budget is not holding`);
  assert.ok(Array.isArray(groups));
});

test('blocking spends the discriminating evidence first, or it finds nothing that matters', () => {
  // The recall bug that blocking introduced: nine thousand titles all beginning the same way
  // land in ONE bucket under the prefix key, and that single non-discriminating block spent
  // the whole comparison budget before the buckets holding the real findings were reached.
  // A small block is a specific one; working through them in size order is what fixes it.
  const noise = Array.from({ length: 9000 }, (_, i) => rec(`n${i}`, { title: `Unrelated conversation ${i}` }));
  const planted = [
    rec('a1', { title: 'Atlas migration plan' }),
    rec('a2', { title: 'Atals migration plan' }),
    rec('b1', { title: 'Quarterly planning session' }),
    rec('b2', { title: 'Quarterly planning sessoin' }),
  ];
  const t = Date.now();
  const groups = duplicateTitles([...noise, ...planted]);
  assert.ok(Date.now() - t < 5000, 'still has to be fast');
  const found = (id) => groups.find((g) => g.ids.includes(id));
  assert.ok(found('a1')?.ids.includes('a2'), 'a real duplicate must survive a corpus full of noise');
  assert.ok(found('b1')?.ids.includes('b2'), 'and so must the second one');
});
