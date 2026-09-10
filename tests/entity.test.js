import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_THRESHOLD, aliasMap, earnsBrief, isSubjectCandidate, normalizeSubject,
  rankSubjects, resolveSubjects, subjectKey, subjectTokens,
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
