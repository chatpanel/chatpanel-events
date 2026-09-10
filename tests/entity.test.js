import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_THRESHOLD, aliasMap, earnsBrief, isRedactionToken, isSubjectCandidate,
  normalizeSubject, rankSubjects, resolveSubjects, stripQualifiers, subjectKey,
  subjectTokens, suggestMerges,
} from '../entity.js';

test('canonical form folds filing noise but keeps the name readable', () => {
  assert.equal(normalizeSubject('  Alex   Rivera '), 'alex rivera');
  assert.equal(normalizeSubject('ALEX-RIVERA'), 'alex rivera');
  assert.equal(normalizeSubject('@alex.rivera'), 'alex rivera');
  assert.equal(normalizeSubject(''), '');
  assert.equal(normalizeSubject(null), '');
  // Unicode survives — stripping to [a-z0-9] would erase a name outright, the bug tags.js
  // already had to fix once.
  assert.equal(normalizeSubject('Ολυμπία'), 'ολυμπία');
  assert.equal(normalizeSubject('東京 タワー'), '東京 タワー');
});

test('normalizeSubject is idempotent', () => {
  for (const s of ['Alex Rivera', '#Design Review!', 'Ολυμπία', 'a'.repeat(120)]) {
    assert.equal(normalizeSubject(normalizeSubject(s)), normalizeSubject(s));
  }
});

test('subjectKey namespaces by kind and refuses unknown kinds', () => {
  assert.equal(subjectKey('person', 'Alex Rivera'), 'person:alex rivera');
  assert.equal(subjectKey('tag', 'Design Review'), 'tag:design review');
  assert.equal(subjectKey('nonsense', 'Alex'), '');
  assert.equal(subjectKey('person', '  '), '');
  // Two kinds never collide even on the same word.
  assert.notEqual(subjectKey('topic', 'atlas'), subjectKey('title', 'atlas'));
});

test('subjectTokens returns a list, never a string, for an empty name', () => {
  assert.deepEqual(subjectTokens(''), []);
  assert.deepEqual(subjectTokens('Alex  Rivera!'), ['alex', 'rivera']);
});

test('a candidate has to be more than a common word or a number', () => {
  assert.ok(isSubjectCandidate('Atlas'));
  assert.ok(isSubjectCandidate('design review'));
  assert.ok(!isSubjectCandidate('meeting'));
  assert.ok(!isSubjectCandidate('notes'));
  assert.ok(!isSubjectCandidate('2026'));
  assert.ok(!isSubjectCandidate('a'));
  assert.ok(!isSubjectCandidate(''));
  assert.ok(!isSubjectCandidate('x'.repeat(200)));
  // A stop word inside a phrase is fine — only a bare one is rejected.
  assert.ok(isSubjectCandidate('meeting cadence'));
  // Initials are not an identity to accumulate against.
  assert.ok(!isSubjectCandidate('j r', { kind: 'person' }));
});

test('an alias resolves only when exactly one full name claims it', () => {
  const one = aliasMap(['Alex Rivera', 'Jordan Blake']);
  assert.equal(one.get('alex'), 'alex rivera');
  assert.equal(one.get('rivera'), 'alex rivera');
  assert.equal(one.get('blake'), 'jordan blake');

  // A second Alex retracts the claim — for both, and silently guessing here is the whole
  // reason this rule exists.
  const two = aliasMap(['Alex Rivera', 'Alex Chen']);
  assert.equal(two.get('alex'), undefined);
  assert.equal(two.get('rivera'), 'alex rivera');
  assert.equal(two.get('chen'), 'alex chen');
});

test('only the first and last token can be an alias, and only a real one', () => {
  const m = aliasMap(['Alex Jordan Rivera', 'Sam Okonkwo']);
  assert.equal(m.get('alex'), 'alex jordan rivera');
  assert.equal(m.get('rivera'), 'alex jordan rivera');
  // A middle name is not how anyone refers to a person, so it does not resolve.
  assert.equal(m.get('jordan'), undefined);
  // A single-token name claims nothing and is claimed by nothing.
  assert.deepEqual([...aliasMap(['Atlas']).keys()], []);
  assert.deepEqual([...aliasMap([]).keys()], []);
  assert.deepEqual([...aliasMap(null).keys()], []);
});

test('resolveSubjects folds surface forms into one identity and picks the common spelling', () => {
  const subjects = resolveSubjects([
    { kind: 'person', name: 'Alex Rivera', recordId: 'm1' },
    { kind: 'person', name: 'alex rivera', recordId: 'm2' },
    { kind: 'person', name: 'Alex Rivera', recordId: 'm3' },
    { kind: 'person', name: 'Alex', recordId: 'm4' },
  ]);
  assert.equal(subjects.size, 1);
  const s = subjects.get('person:alex rivera');
  assert.equal(s.name, 'Alex Rivera'); // most common surface form wins, not first-seen
  assert.equal(s.mentions, 4);
  assert.equal(s.records.size, 4);
  assert.deepEqual(s.aliases, ['alex']);
});

test('the display name is a form of the subject, never one of its aliases', () => {
  // "Alex" and "Alex Rivera" tie on count here. A page for person:alex rivera titled "Alex"
  // is a page whose title is not the subject's name.
  const subjects = resolveSubjects([
    { kind: 'person', name: 'Alex Rivera', recordId: 'm1' },
    { kind: 'person', name: 'Alex', recordId: 'm2' },
  ]);
  assert.equal(subjects.get('person:alex rivera').name, 'Alex Rivera');
});

test('aliasing is per kind — a topic is never merged by the person rule', () => {
  const subjects = resolveSubjects([
    { kind: 'topic', name: 'design review', recordId: 'n1' },
    { kind: 'topic', name: 'design', recordId: 'n2' },
  ]);
  assert.equal(subjects.size, 2);
  assert.ok(subjects.has('topic:design review'));
  assert.ok(subjects.has('topic:design'));
});

test('unknown kinds and junk names are dropped rather than becoming subjects', () => {
  const subjects = resolveSubjects([
    { kind: 'sideways', name: 'Alex Rivera', recordId: 'x' },
    { kind: 'topic', name: 'meeting', recordId: 'x' },
    { kind: 'topic', name: '', recordId: 'x' },
    null,
  ]);
  assert.equal(subjects.size, 0);
});

test('a subject earns a page on evidence, not on first sight', () => {
  const thin = { records: new Set(['a', 'b']), mentions: 9 };
  const wide = { records: new Set(['a', 'b', 'c']), mentions: 5 };
  assert.ok(!earnsBrief(thin));
  assert.ok(earnsBrief(wide));
  assert.ok(earnsBrief(thin, { records: 2, mentions: 2 }));
  assert.ok(!earnsBrief(null));
  // An array of record ids works as well as a Set — callers rehydrating from JSON.
  assert.ok(earnsBrief({ records: ['a', 'b', 'c'], mentions: 5 }, DEFAULT_THRESHOLD));
});

test('ranking is stable, evidence-ordered, and honours the count ceiling', () => {
  const subjects = resolveSubjects([
    ...['a', 'b', 'c', 'd'].map((r) => ({ kind: 'topic', name: 'atlas', recordId: r })),
    ...['a', 'b', 'c'].map((r) => ({ kind: 'topic', name: 'pricing', recordId: r })),
    ...['a', 'b', 'c'].map((r) => ({ kind: 'topic', name: 'onboarding', recordId: r })),
    { kind: 'topic', name: 'atlas', recordId: 'a' },
    { kind: 'topic', name: 'atlas', recordId: 'b' },
    { kind: 'topic', name: 'onboarding', recordId: 'a' },
    { kind: 'topic', name: 'onboarding', recordId: 'b' },
    { kind: 'topic', name: 'pricing', recordId: 'd' },
    { kind: 'topic', name: 'pricing', recordId: 'e' },
    { kind: 'topic', name: 'thin', recordId: 'a' },
  ]);
  const ranked = rankSubjects(subjects);
  assert.deepEqual(ranked.map((s) => s.name), ['pricing', 'atlas', 'onboarding']);
  assert.ok(!ranked.some((s) => s.name === 'thin'));
  assert.equal(ranked[0].recordCount, 5);
  assert.equal(rankSubjects(subjects, { limit: 1 }).length, 1);
  assert.equal(rankSubjects(subjects, { limit: 0 }).length, 0);
  // Same input, same order, every run — the report has to be diffable.
  assert.deepEqual(rankSubjects(subjects).map((s) => s.key), ranked.map((s) => s.key));
});

test('a redaction placeholder is never a subject — it is the absence of one', () => {
  // @chatpanel/pii writes [[PERSON_1]], which is character-for-character the wikilink
  // grammar, so a redacted transcript read as a document full of links to pages nobody
  // wrote — and every one earned a page. The person we deliberately did not learn about was
  // being filed as a thing we know.
  for (const t of ['PERSON_1', '[[PERSON_1]]', '[EMAIL_2]', 'LOCATION_10', 'ORG_3', ' PHONE_1 ']) {
    assert.ok(isRedactionToken(t), `${t} should be recognised as a placeholder`);
    assert.ok(!isSubjectCandidate(t, { kind: 'person' }), `${t} must not be a subject`);
  }
  // Matched by TYPE, not by shape: these are things people write and want filed.
  for (const t of ['Q3_2026', 'PHASE_2', 'ATLAS', 'Alex Rivera', 'person_1', 'PERSON_']) {
    assert.ok(!isRedactionToken(t), `${t} is not a placeholder`);
  }
  assert.ok(isSubjectCandidate('Q3_2026'));
});

test('placeholders never merge across conversations, because the vault does not', () => {
  // The vault is scoped to a conversation and is never persisted, so Monday's PERSON_1 and
  // Friday's are different people. A global subject would attribute one person's decisions
  // to another — the failure aliasMap refuses when it is merely possible, and here it is
  // guaranteed.
  const subjects = resolveSubjects([
    { kind: 'person', name: 'PERSON_1', recordId: 'chat:mon' },
    { kind: 'person', name: 'PERSON_1', recordId: 'chat:fri' },
    { kind: 'person', name: 'PERSON_1', recordId: 'chat:sat' },
  ]);
  assert.equal(subjects.size, 0);
});

test('a person keeps their identity through whatever the directory hung off it', () => {
  assert.equal(stripQualifiers('Alex Rivera (ACME)'), 'Alex Rivera');
  assert.equal(stripQualifiers('Alex Rivera - Host'), 'Alex Rivera');
  assert.equal(stripQualifiers('Alex Rivera (he/him)'), 'Alex Rivera');
  assert.equal(stripQualifiers('Alex Rivera | ACME'), 'Alex Rivera');
  assert.equal(stripQualifiers('  Alex   Rivera  '), 'Alex Rivera');
  assert.equal(stripQualifiers(''), '');

  const subjects = resolveSubjects([
    { kind: 'person', name: 'Alex Rivera (ACME)', recordId: 'm1' },
    { kind: 'person', name: 'Alex Rivera', recordId: 'm2' },
    { kind: 'person', name: 'Alex Rivera - Guest', recordId: 'm3' },
  ]);
  assert.equal(subjects.size, 1);
  assert.equal(subjects.get('person:alex rivera').records.size, 3);
});

test('a qualifier is decoration on a PERSON and meaning on a topic', () => {
  // "Alex Rivera (ACME)" is not a different person. "Migration (Phase 2)" IS a different
  // topic, so the same stripping must not run there.
  const subjects = resolveSubjects([
    { kind: 'topic', name: 'Migration (Phase 2)', recordId: 'n1' },
    { kind: 'topic', name: 'Migration', recordId: 'n2' },
  ]);
  assert.equal(subjects.size, 2);
});

test('the platform\'s "You" is the user, but only when we know who that is', () => {
  const mentions = [
    { kind: 'person', name: 'You', recordId: 'm1' },
    { kind: 'person', name: 'Alex Rivera', recordId: 'm2' },
    { kind: 'person', name: 'me', recordId: 'm3' },
  ];
  const known = resolveSubjects(mentions, { self: 'Alex Rivera' });
  assert.equal(known.size, 1);
  assert.equal(known.get('person:alex rivera').records.size, 3);

  // With no self name, "You" is a pronoun. Every meeting has one and they are not one person.
  const unknown = resolveSubjects(mentions);
  assert.equal(unknown.size, 1);
  assert.equal(unknown.get('person:alex rivera').records.size, 1);
  assert.ok(!isSubjectCandidate('You', { kind: 'person' }));
  // …but a topic legitimately called "me" is untouched by the person rule.
  assert.ok(isSubjectCandidate('you', { kind: 'topic' }));
});

test('a user merge is an INPUT to derivation, so it survives every rebuild', () => {
  const mentions = [
    { kind: 'person', name: 'Alex Rivera', recordId: 'm1' },
    { kind: 'person', name: 'A. Rivera', recordId: 'm2' },
  ];
  assert.equal(resolveSubjects(mentions).size, 2);
  const merged = resolveSubjects(mentions, { merges: { 'A. Rivera': 'Alex Rivera' } });
  assert.equal(merged.size, 1);
  assert.equal(merged.get('person:alex rivera').records.size, 2);

  // A chain resolves to its end, and a cycle stops instead of hanging a rebuild.
  const chain = resolveSubjects(
    [{ kind: 'person', name: 'AR', recordId: 'm1' }],
    { merges: { AR: 'A. Rivera', 'A. Rivera': 'Alex Rivera' } },
  );
  assert.ok(chain.has('person:alex rivera'));
  const cycle = resolveSubjects(
    [{ kind: 'person', name: 'Alpha One', recordId: 'm1' }],
    { merges: { 'Alpha One': 'Beta Two', 'Beta Two': 'Alpha One' } },
  );
  assert.equal(cycle.size, 1);
});

test('merges are proposed, never applied — and the noisy signals are left out', () => {
  const subjects = resolveSubjects([
    ...['m1', 'm2', 'm3'].map((r) => ({ kind: 'person', name: 'Alex Rivera', recordId: r })),
    { kind: 'person', name: 'A. Rivera', recordId: 'm4' },
    { kind: 'person', name: 'Sam Rivera', recordId: 'm5' },
    ...['n1', 'n2'].map((r) => ({ kind: 'topic', name: 'atlas migration', recordId: r })),
    { kind: 'topic', name: 'atals migration', recordId: 'n3' },
    { kind: 'topic', name: 'atlas', recordId: 'n4' },
    { kind: 'topic', name: 'cloud migration', recordId: 'n5' },
    { kind: 'topic', name: 'q3 planning', recordId: 'n6' },
    { kind: 'topic', name: 'q4 planning', recordId: 'n7' },
  ]);
  const merges = suggestMerges(subjects);
  const pair = (drop) => merges.find((m) => m.dropName === drop);

  // An abbreviated first name with the same surname, and a transposed typo.
  assert.equal(pair('A. Rivera').keepName, 'Alex Rivera');
  assert.equal(pair('A. Rivera').reason, 'initials');
  assert.equal(pair('atals migration').reason, 'spelling');
  // The better-evidenced side survives — it is the name the user thinks in.
  assert.equal(pair('atlas').keepName, 'atlas migration');

  // A digit is a SERIES, not a typo. This is the merge that must never be proposed.
  assert.ok(!pair('q4 planning'), 'q3/q4 differ only in a digit — that is a series');
  // A shared surname is not a signal: two people with one last name are usually two people.
  assert.ok(!pair('Sam Rivera'), 'a shared surname alone must not be proposed');
  // Two topics ending in the same word are two topics.
  assert.ok(!pair('cloud migration'));
  // Nothing is applied: the subjects themselves are unchanged.
  assert.ok(subjects.has('person:a rivera'));

  assert.deepEqual(suggestMerges(new Map()), []);
  assert.deepEqual(suggestMerges(null), []);
  assert.equal(suggestMerges(subjects, { limit: 1 }).length, 1);
});

test('merge suggestions stay fast and keep their findings in a big corpus', () => {
  // Pairwise did not finish 12,000 subjects in two minutes: 6.8s at 2,000, 32s at 6,000,
  // 141s at 12,000 — on the UI thread, so a hung page rather than a slow one.
  const noise = Array.from({ length: 9000 }, (_, i) => ({ kind: 'person', name: `Unrelated Person ${i}`, recordId: `r${i}` }));
  const mentions = [
    ...noise,
    ...['a', 'b', 'c'].map((r) => ({ kind: 'person', name: 'Alex Rivera', recordId: r })),
    { kind: 'person', name: 'A. Rivera', recordId: 'd' },
    ...['e', 'f'].map((r) => ({ kind: 'topic', name: 'atlas migration', recordId: r })),
    { kind: 'topic', name: 'atlas', recordId: 'g' },
    { kind: 'topic', name: 'atals migration', recordId: 'h' },
  ];
  const subjects = resolveSubjects(mentions);
  const t = Date.now();
  const merges = suggestMerges(subjects);
  const ms = Date.now() - t;
  assert.ok(ms < 5000, `suggestMerges took ${ms}ms over ${subjects.size} subjects — that is a frozen tab`);

  // …and the findings must SURVIVE the blocking. They did not at first: one bucket of nine
  // thousand same-prefix names spent the entire budget before the real pairs were compared.
  const pair = (drop) => merges.find((m) => m.dropName === drop);
  assert.ok(pair('A. Rivera'), 'an abbreviated first name, found through the shared surname');
  assert.equal(pair('A. Rivera').keepName, 'Alex Rivera');
  assert.ok(pair('atlas'), 'a contained name');
  assert.ok(pair('atals migration'), 'a transposed typo');
});
