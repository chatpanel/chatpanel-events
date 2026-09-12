import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  speakerBreakdown, speakerTimeline, speakerStats, densityRibbon, formatTalkTime, SPEAKER_SLOTS,
} from '../meeting-shape.js';

const T0 = Date.UTC(2026, 8, 11, 14, 0, 0);
const at = (sec) => T0 + sec * 1000;

/** A two-speaker meeting with a real clock: Ama holds the floor, Bo answers. */
const timed = {
  segments: [
    { t: at(0), speaker: 'Ama', text: 'Opening the review, here is where we stand today.' },
    { t: at(10), speaker: 'Ama', text: 'The migration is behind by about a week.' },
    { t: at(20), speaker: 'Bo', text: 'Understood.' },
    { t: at(25), speaker: 'Ama', text: 'So we cut scope rather than the date.' },
    { t: at(35), speaker: 'Bo', text: 'Agreed, I will write it up.' },
  ],
};

test('a meeting with timestamps is measured in real time, not in characters', () => {
  const b = speakerBreakdown(timed);
  assert.equal(b.basis, 'clock');
  // Ama: 0→10, 10→20, 25→35 = 30s. Bo: 20→25 = 5s, plus a last line estimated from its text.
  assert.equal(b.speakers[0].speaker, 'Ama');
  assert.equal(b.speakers[0].seconds, 30);
  assert.ok(b.speakers[1].seconds >= 5 && b.speakers[1].seconds < 10);
  assert.ok(b.speakers[0].share > b.speakers[1].share);
  assert.ok(Math.abs(b.speakers.reduce((n, s) => n + s.share, 0) - 1) < 1e-9);
});

test('"Understood." is short but not free — Bo outweighs his character count', () => {
  // The whole point of the clock basis. By characters Bo holds 22%; by the clock he held
  // the floor for a fifth of a minute of a 36-second meeting. A chart that counted letters
  // would make a terse participant look absent.
  const byText = speakerStats(timed);
  const byClock = speakerBreakdown(timed);
  assert.notEqual(
    byText.find((s) => s.speaker === 'Bo').share.toFixed(3),
    byClock.speakers.find((s) => s.speaker === 'Bo').share.toFixed(3),
  );
});

test('a break is silence, not the last speaker still talking', () => {
  const withGap = {
    segments: [
      { t: at(0), speaker: 'Ama', text: 'Back in ten.' },
      { t: at(600), speaker: 'Ama', text: 'Right, we are back.' },
    ],
  };
  // 600s of gap, capped at the 30s a turn can run for.
  assert.equal(speakerBreakdown(withGap).speakers[0].seconds <= 35, true);
});

test('no usable clock falls back to characters and SAYS so', () => {
  const flat = {
    segments: [
      { at: '2:00:36 PM', speaker: 'Ama', text: 'A display clock cannot become a duration.' },
      { at: '2:01:02 PM', speaker: 'Bo', text: 'Right.' },
    ],
  };
  const b = speakerBreakdown(flat);
  assert.equal(b.basis, 'text');
  assert.equal(b.totalMs, null);
  assert.equal(b.speakers[0].seconds, null);
  assert.equal(b.speakers[0].speaker, 'Ama');
});

test('an ISO timestamp counts; a display clock never gets coerced into today', () => {
  const iso = {
    segments: [
      { t: new Date(at(0)).toISOString(), speaker: 'Ama', text: 'One.' },
      { t: new Date(at(12)).toISOString(), speaker: 'Bo', text: 'Two.' },
    ],
  };
  assert.equal(speakerBreakdown(iso).basis, 'clock');
  assert.equal(speakerBreakdown({ segments: [{ t: '6:28:00 PM', speaker: 'Ama', text: 'x' }] }).basis, 'text');
});

test('past the slot count the tail folds into one bucket rather than taking a new hue', () => {
  const many = {
    segments: Array.from({ length: 9 }, (_, i) => (
      { t: at(i * 10), speaker: `P${i}`, text: 'x'.repeat(50 - i) }
    )),
  };
  const b = speakerBreakdown(many);
  assert.equal(b.shown.length, SPEAKER_SLOTS);
  assert.deepEqual(b.shown.map((s) => s.slot), [0, 1, 2, 3, 4]);
  assert.equal(b.other.speakers.length, 9 - SPEAKER_SLOTS);
  assert.ok(b.speakers.filter((s) => s.slot === -1).every((s) => b.other.speakers.includes(s.speaker)));
  assert.ok(Math.abs(b.shown.reduce((n, s) => n + s.share, 0) + b.other.share - 1) < 1e-9);
});

test('one speaker needs no "other" bucket', () => {
  assert.equal(speakerBreakdown({ segments: [{ t: at(0), speaker: 'Ama', text: 'Alone.' }] }).other, null);
});

test('slots are ranked, so two people in one meeting can never share a colour', () => {
  const b = speakerBreakdown(timed);
  const slots = b.shown.map((s) => s.slot);
  assert.equal(new Set(slots).size, slots.length);
});

test('the timeline buckets wall time, so a quiet stretch is visibly quiet', () => {
  const sparse = {
    segments: [
      { t: at(0), speaker: 'Ama', text: 'Kicking off.' },
      { t: at(5), speaker: 'Ama', text: 'One more thing.' },
      { t: at(600), speaker: 'Bo', text: 'Sorry, back.' },
    ],
  };
  const tl = speakerTimeline(sparse, { buckets: 10 });
  assert.equal(tl.basis, 'clock');
  assert.equal(tl.buckets.length, 10);
  assert.equal(tl.buckets[0].speaker, 'Ama');
  assert.equal(tl.buckets[5].weight, 0, 'the middle of the meeting was empty and reads as empty');
  assert.equal(tl.buckets.at(-1).speaker, 'Bo');
});

test('a turn that spans buckets is billed to every bucket it covers', () => {
  const monologue = { segments: [{ t: at(0), speaker: 'Ama', text: 'x' }, { t: at(30), speaker: 'Bo', text: 'y' }] };
  const tl = speakerTimeline(monologue, { buckets: 6 });
  const amaBuckets = tl.buckets.filter((b) => b.speaker === 'Ama').length;
  assert.ok(amaBuckets > 1, 'a 30-second turn counted once would leave the band mostly blank');
});

test('each bucket carries the full split, not only its winner', () => {
  const tl = speakerTimeline(timed, { buckets: 4 });
  const mixed = tl.buckets.find((b) => b.by.length > 1);
  assert.ok(mixed, 'a four-bucket split of this meeting has a bucket holding both speakers');
  assert.ok(mixed.by.every((x) => x.share >= 0 && x.share <= 1));
  assert.ok(mixed.by[0].weight >= mixed.by[1].weight, 'the split is ordered, loudest first');
});

test('a clockless meeting still gets a timeline — bucketed by position', () => {
  const flat = { segments: Array.from({ length: 20 }, (_, i) => ({ speaker: i < 10 ? 'Ama' : 'Bo', text: 'word' })) };
  const tl = speakerTimeline(flat, { buckets: 4 });
  assert.equal(tl.basis, 'text');
  assert.equal(tl.from, null);
  assert.deepEqual(tl.buckets.map((b) => b.speaker), ['Ama', 'Ama', 'Bo', 'Bo']);
});

test('an empty meeting draws nothing rather than throwing', () => {
  for (const empty of [null, undefined, {}, { segments: [] }]) {
    assert.deepEqual(speakerTimeline(empty).buckets, []);
    assert.deepEqual(speakerBreakdown(empty).speakers, []);
    assert.deepEqual(densityRibbon(empty), []);
  }
});

test('captions sharing one millisecond do not become a zero-length meeting', () => {
  const same = { segments: [{ t: at(0), speaker: 'Ama', text: 'a' }, { t: at(0), speaker: 'Bo', text: 'b' }] };
  assert.equal(speakerBreakdown(same).basis, 'text');
  assert.equal(speakerTimeline(same, { buckets: 4 }).buckets.length, 4);
});

test('an unnamed speaker is labelled, not dropped — the line still happened', () => {
  const b = speakerBreakdown({ segments: [{ t: at(0), speaker: '', text: 'Anonymous caption.' }, { t: at(9), speaker: 'Ama', text: 'Hi.' }] });
  assert.ok(b.speakers.some((s) => s.speaker === 'Speaker'));
});

test('the ranking is stable when two speakers tie', () => {
  // Ten seconds each, twice each — and the trailing line belongs to a third speaker so
  // neither of the tied two is the one whose duration has to be estimated.
  const tie = {
    segments: [
      { t: at(0), speaker: 'Bo', text: 'x' }, { t: at(10), speaker: 'Ama', text: 'x' },
      { t: at(20), speaker: 'Bo', text: 'x' }, { t: at(30), speaker: 'Ama', text: 'x' },
      { t: at(40), speaker: 'Cy', text: 'x' },
    ],
  };
  const ranked = speakerBreakdown(tie).speakers;
  assert.equal(ranked[0].seconds, ranked[1].seconds, 'the fixture is only a tie if the seconds match');
  assert.deepEqual(ranked.slice(0, 2).map((s) => s.speaker), ['Ama', 'Bo']);
});

test('durations are written the way a person reads them', () => {
  assert.equal(formatTalkTime(0), '');
  assert.equal(formatTalkTime(48_000), '48s');
  assert.equal(formatTalkTime(41 * 60_000), '41 min');
  assert.equal(formatTalkTime(72 * 60_000), '1h 12m');
  assert.equal(formatTalkTime(NaN), '');
});

test('the position ribbon still behaves, because the desktop pane is built on it', () => {
  const flat = { segments: Array.from({ length: 12 }, (_, i) => ({ speaker: i < 6 ? 'Ama' : 'Bo', text: 'word' })) };
  const r = densityRibbon(flat, 4);
  assert.equal(r.length, 4);
  assert.deepEqual(r.map((b) => b.speaker), ['Ama', 'Ama', 'Bo', 'Bo']);
  assert.ok(r.every((b) => b.weight > 0 && b.weight <= 1));
});
