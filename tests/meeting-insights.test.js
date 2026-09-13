import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarySections, meetingInsights, insightKindOf, hasInsights } from '../meeting-insights.js';

const SUMMARY = `The team reviewed the cutover.

## Decisions
- Cutover moves to 24 Sep.
* Rollback trigger: health check fails twice.

## Action items
1. Jordan: confirm DNS ownership by Wed.
2) Alex: dry-run the rollback script.

### Open questions
- Who owns the freeze window?

## Attendees
Jordan, Alex, Sam`;

test('sections split on headings and collect bullets in any marker', () => {
  const s = summarySections(SUMMARY);
  assert.deepEqual(s.map((x) => x.heading), ['', 'Decisions', 'Action items', 'Open questions', 'Attendees']);
  assert.equal(s[0].text, 'The team reviewed the cutover.');
  assert.deepEqual(s[1].items, ['Cutover moves to 24 Sep.', 'Rollback trigger: health check fails twice.']);
  assert.deepEqual(s[2].items, ['Jordan: confirm DNS ownership by Wed.', 'Alex: dry-run the rollback script.']);
  assert.equal(s[4].text, 'Jordan, Alex, Sam');
});

test('headings are matched by meaning, not by exact wording', () => {
  assert.equal(insightKindOf('What we agreed'), 'decisions');
  assert.equal(insightKindOf('Next steps'), 'actions');
  assert.equal(insightKindOf('Follow-ups'), 'actions');
  assert.equal(insightKindOf('Risks and open questions'), 'questions');
  assert.equal(insightKindOf('Attendees'), null);
});

test('meetingInsights buckets the three kinds and keeps the rest', () => {
  const i = meetingInsights(SUMMARY);
  assert.equal(i.decisions.length, 2);
  assert.equal(i.actions[0].text, 'Jordan: confirm DNS ownership by Wed.');
  assert.equal(i.actions[0].section, 'Action items');
  assert.equal(i.questions.length, 1);
  assert.deepEqual(i.other.map((s) => s.heading), ['', 'Attendees']);
  assert.equal(hasInsights(SUMMARY), true);
  assert.equal(hasInsights('Just prose, no headings.'), false);
  assert.deepEqual(meetingInsights(''), { decisions: [], actions: [], questions: [], other: [] });
});

// ── The five tiles ────────────────────────────────────────────────────────────────
import { parseMeetingNotes, momentBadge, noteSectionKind, groupActionsByOwner, demd } from '../meeting-insights.js';

test('the five tiles are read out of the notes, marks and all', () => {
  const md = [
    '## TL;DR', 'We **agreed** to move.', '', '## Topics', '- Cutover', '- Rollback',
    '## Key moments', '- [Decision] Cutover moves to 24 Sep', '- **Risk:** the replica lags', '- plain highlight',
    '## Shared links', '- https://example.com/runbook', '- No shared links.',
    '## Action items', '- [ ] Drain the replica _(Jordan Blake)_ — due Friday', '- [x] Confirm the snapshot (Alex Rivera)', '- unowned task',
  ].join('\n');
  const p = parseMeetingNotes(md);
  assert.equal(p.summary, 'We agreed to move.');
  assert.deepEqual(p.topics, ['Cutover', 'Rollback']);
  assert.deepEqual(p.moments, [
    { badge: 'decision', text: 'Cutover moves to 24 Sep' },
    { badge: 'risk', text: 'the replica lags' },
    { badge: 'highlight', text: 'plain highlight' },
  ]);
  assert.deepEqual(p.links, ['https://example.com/runbook'], '"No shared links." is not a link');
  assert.equal(p.actions.length, 3);
  assert.deepEqual({ ...p.actions[0], lineIndex: 0 }, { text: 'Drain the replica', done: false, owner: 'Jordan Blake', due: 'Friday', lineIndex: 0 });
  assert.equal(p.actions[1].done, true);
  assert.equal(p.actions[1].owner, 'Alex Rivera');
  assert.equal(p.actions[2].owner, '');
  assert.equal(p.hasAny, true);
  assert.equal(parseMeetingNotes('').hasAny, false);
});

test('headings are matched by what they mean, badges default to highlight, owners group named-first', () => {
  assert.equal(noteSectionKind('Agenda'), 'topics');
  assert.equal(noteSectionKind('Decisions'), 'moments');
  assert.equal(noteSectionKind('Next steps'), 'actions');
  assert.equal(noteSectionKind('Attendees'), null);
  assert.deepEqual(momentBadge('nothing marked'), { badge: 'highlight', text: 'nothing marked' });
  assert.deepEqual(momentBadge('question: who owns it?'), { badge: 'question', text: 'who owns it?' });
  const groups = groupActionsByOwner([{ text: 'a', owner: '' }, { text: 'b', owner: 'Zed' }, { text: 'c', owner: 'Amy' }]);
  assert.deepEqual(groups.map((g) => g.owner), ['Amy', 'Zed', 'Unassigned']);
  assert.equal(demd('**bold** and `code` and _under_'), 'bold and code and under');
});
