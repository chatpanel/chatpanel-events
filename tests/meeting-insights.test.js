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
