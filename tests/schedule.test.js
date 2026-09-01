import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextFireAt, occurrencesBetween, validateSchedule, dueJobs, nextWakeAt, occurrenceKey,
  defineJob, defineTrigger, createTriggerRegistry, jobsForEvent, BUILTIN_TRIGGERS,
  timerTrigger, phraseTrigger, topicTrigger, questionTrigger, personJoinedTrigger,
  meetingStartedTrigger, voiceCommandTrigger, ScheduleError, MISSED_POLICIES, saidIn,
  utteranceLooksComplete,
} from '../schedule.js';

// Monday 2026-06-01, 10:00 local. Expectations are built with the same local constructor,
// so these pass in any timezone.
const MON_10AM = new Date(2026, 5, 1, 10, 0, 0, 0).getTime();
const local = (days, hour, minute = 0) => new Date(2026, 5, 1 + days, hour, minute, 0, 0).getTime();

// ── schedules ──────────────────────────────────────────────────────────────

test('a daily schedule fires at the next wall-clock time, today or tomorrow', () => {
  assert.equal(nextFireAt({ kind: 'daily', hour: 14 }, MON_10AM), local(0, 14));
  assert.equal(nextFireAt({ kind: 'daily', hour: 8 }, MON_10AM), local(1, 8), 'already past today');
  assert.equal(nextFireAt({ kind: 'daily', hour: 10 }, MON_10AM), local(1, 10), 'exactly now is not "after now"');
});

test('weekday-only skips the weekend', () => {
  const friday = new Date(2026, 5, 5, 10, 0, 0, 0).getTime();
  const at = nextFireAt({ kind: 'daily', hour: 8, weekdaysOnly: true }, friday);
  assert.equal(new Date(at).getDay(), 1, 'Friday 10am → Monday, not Saturday');
});

test('a weekly schedule finds its weekday', () => {
  assert.equal(nextFireAt({ kind: 'weekly', weekday: 3, hour: 9 }, MON_10AM), local(2, 9));
  // Today, still ahead → today. Today, already past → next week.
  assert.equal(nextFireAt({ kind: 'weekly', weekday: 1, hour: 14 }, MON_10AM), local(0, 14));
  assert.equal(nextFireAt({ kind: 'weekly', weekday: 1, hour: 9 }, MON_10AM), local(7, 9));
});

test('an interval keeps its phase across restarts instead of drifting later', () => {
  const anchor = MON_10AM;
  const s = { kind: 'interval', everyMs: 30 * 60_000, anchor };
  assert.equal(nextFireAt(s, anchor), anchor + 30 * 60_000);
  // Woken 5 minutes late: the next firing is still on the original half-hour grid.
  assert.equal(nextFireAt(s, anchor + 35 * 60_000), anchor + 60 * 60_000);
});

test('a one-shot is spent once it has passed', () => {
  assert.equal(nextFireAt({ kind: 'once', at: MON_10AM + 1000 }, MON_10AM), MON_10AM + 1000);
  assert.equal(nextFireAt({ kind: 'once', at: MON_10AM - 1000 }, MON_10AM), null);
});

test('feeding a fire time back in advances rather than repeating it', () => {
  // The loop that runs a job and asks "what next?" would otherwise never terminate.
  const s = { kind: 'daily', hour: 8 };
  const first = nextFireAt(s, MON_10AM);
  assert.equal(nextFireAt(s, first), local(2, 8));
});

test('a schedule finer than every platform allows is refused, not faked', () => {
  assert.throws(() => validateSchedule({ kind: 'interval', everyMs: 5000 }), ScheduleError);
  assert.throws(() => validateSchedule({ kind: 'daily', hour: 25 }), ScheduleError);
  assert.throws(() => validateSchedule({ kind: 'weekly', hour: 9 }), ScheduleError);
  assert.throws(() => validateSchedule({ kind: 'sometimes' }), ScheduleError);
});

test('catch-up is bounded — a fortnight asleep is not a queue of work', () => {
  const s = { kind: 'daily', hour: 8 };
  const twoWeeks = occurrencesBetween(s, MON_10AM - 40 * 86_400_000, MON_10AM, 20);
  assert.equal(twoWeeks.length, 20);
});

// ── jobs and missed windows ────────────────────────────────────────────────

const brief = (over = {}) => defineJob({
  id: 'job1',
  name: 'Daily brief',
  trigger: timerTrigger.id,
  schedule: { kind: 'daily', hour: 8 },
  action: { kind: 'skill', skillId: 'skill:daily-brief' },
  createdAt: MON_10AM - 86_400_000,
  ...over,
});

test('a job is due for the occurrences it missed, and the policy decides how many run', () => {
  const threeDaysLater = local(3, 12);
  const lastRun = { job1: MON_10AM };

  const once = dueJobs([brief({ onMissed: 'runOnce' })], { now: threeDaysLater, lastRun });
  assert.equal(once.length, 1);
  assert.equal(once[0].at, local(3, 8), 'the most recent missed slot, not the oldest');
  assert.equal(once[0].missedCount, 3);

  const all = dueJobs([brief({ onMissed: 'runAll' })], { now: threeDaysLater, lastRun });
  assert.deepEqual(all.map((d) => d.at), [local(1, 8), local(2, 8), local(3, 8)]);

  const skip = dueJobs([brief({ onMissed: 'skip' })], { now: threeDaysLater, lastRun });
  assert.equal(skip[0].skipped, true, 'reported so the watermark advances — but nothing runs');
});

test('dedup is on the scheduled time, not the time we woke up', () => {
  // Alarms are approximate and devices sleep. Keying on the fire time makes "approximately
  // 9am" mean "twice".
  const at = local(1, 8);
  assert.equal(occurrenceKey('job1', at), occurrenceKey('job1', at));
  const late = dueJobs([brief()], { now: at + 4 * 60_000, lastRun: { job1: MON_10AM } });
  assert.equal(late[0].key, occurrenceKey('job1', at));
  assert.equal(late[0].late, true, 'and it says it was late, so a UI can be honest about it');
});

test('a disabled job is not due, and neither is one Plugins refuses', () => {
  assert.deepEqual(dueJobs([brief({ enabled: false })], { now: local(2, 9), lastRun: { job1: MON_10AM } }), []);
  assert.deepEqual(dueJobs([brief()], { now: local(2, 9), lastRun: { job1: MON_10AM }, admit: () => false }), []);
});

test('one alarm is enough — the client arms the soonest', () => {
  const jobs = [
    brief(),
    brief({ id: 'job2', schedule: { kind: 'daily', hour: 12 } }),
  ];
  assert.equal(nextWakeAt(jobs, { now: MON_10AM }), local(0, 12), 'noon today beats 8am tomorrow');
});

test('a job must declare what it does before it can exist', () => {
  assert.throws(() => defineJob({ id: 'x', name: 'n', trigger: 't', action: { kind: 'nope' } }), ScheduleError);
  assert.throws(() => defineJob({ id: 'x', name: 'n', trigger: 't', action: { kind: 'skill' } }), ScheduleError,
    'a skill job with no skill is a job that cannot run');
  assert.throws(() => defineJob({ id: 'x', name: 'n', trigger: timerTrigger.id, action: { kind: 'notify' } }), ScheduleError,
    'a timer job with no schedule is not a schedule');
  assert.throws(() => brief({ onMissed: 'whenever' }), ScheduleError);
  assert.deepEqual([...MISSED_POLICIES], ['skip', 'runOnce', 'runAll']);
});

// ── event triggers ─────────────────────────────────────────────────────────

const registry = createTriggerRegistry(BUILTIN_TRIGGERS);
const isSelf = (s) => s === 'Alex Rivera';
const evJob = (trigger, params) => defineJob({
  id: `j-${trigger}`, name: trigger, trigger, params, action: { kind: 'skill', skillId: 'skill:x' },
});
const delta = (segs) => ({ type: 'meeting.transcript.delta', meetingId: 'm1', segments: segs });

test('a phrase said by anyone can start a job the user already created', () => {
  const jobs = [evJob(phraseTrigger.id, { any: ['action item', 'follow up'] })];
  const hit = jobsForEvent(jobs, delta([{ t: 1, speaker: 'Jordan Blake', text: 'that is an ACTION ITEM for us' }]), { registry, ctx: { isSelf } });
  assert.equal(hit.length, 1);
  assert.match(hit[0].match.why, /action item/);

  assert.deepEqual(jobsForEvent(jobs, delta([{ t: 1, speaker: 'x', text: 'nothing relevant' }]), { registry }), []);
  assert.deepEqual(jobsForEvent([evJob(phraseTrigger.id, { any: [] })], delta([{ t: 1, speaker: 'x', text: 'anything' }]), { registry }), [],
    'a phrase trigger with no phrase must not fire on every word');
});

test('a phrase matches WHOLE WORDS — the bug where every utterance fired', () => {
  // Reported from a live meeting: an "Interview" job with a phrase trigger ran on every
  // line. `includes` is why — a short phrase is inside most sentences, and from the user's
  // chair that is indistinguishable from a trigger that ignores its phrase entirely.
  const jobs = [evJob(phraseTrigger.id, { any: ['int'] })];
  assert.deepEqual(jobsForEvent(jobs, delta([{ t: 1, speaker: 'x', text: 'lets start the interview now' }]), { registry }), [],
    '"int" must not fire on "interview"');
  assert.equal(jobsForEvent([evJob(phraseTrigger.id, { any: ['interview'] })],
    delta([{ t: 1, speaker: 'x', text: 'lets start the interview now' }]), { registry }).length, 1);

  // Real speech around the phrase still matches: punctuation, casing and neighbours.
  for (const line of ['That is an ACTION ITEM.', 'action item: ship it', 'so, action item — mine']) {
    assert.equal(jobsForEvent([evJob(phraseTrigger.id, { any: ['action item'] })], delta([{ t: 1, speaker: 'x', text: line }]), { registry }).length, 1, line);
  }
  assert.deepEqual(jobsForEvent([evJob(phraseTrigger.id, { any: ['action item'] })],
    delta([{ t: 1, speaker: 'x', text: 'no actionable items here' }]), { registry }), []);

  // A phrase too short to be a phrase is refused rather than matching everything.
  assert.deepEqual(jobsForEvent([evJob(phraseTrigger.id, { any: ['a', 'in'] })], delta([{ t: 1, speaker: 'x', text: 'anything at all' }]), { registry }), []);
  assert.equal(saidIn('the standup is at nine', 'standup'), true);
  assert.equal(saidIn('the standup is at nine', 'stand'), false);
  assert.equal(saidIn('shipping v2.0 today', 'v2.0'), true, 'a phrase with regex characters is matched literally');
});

test('a speaker filter is honoured, so "when someone else says X" is expressible', () => {
  const jobs = [evJob(phraseTrigger.id, { any: ['pricing'], speaker: 'others' })];
  assert.equal(jobsForEvent(jobs, delta([{ t: 1, speaker: 'Jordan Blake', text: 'about pricing' }]), { registry, ctx: { isSelf } }).length, 1);
  assert.equal(jobsForEvent(jobs, delta([{ t: 1, speaker: 'Alex Rivera', text: 'about pricing' }]), { registry, ctx: { isSelf } }).length, 0);
});

test('"talks about something" is looser than a literal phrase', () => {
  const jobs = [evJob(topicTrigger.id, { terms: ['migration', 'deadline'], minHits: 2 })];
  const said = delta([
    { t: 1, speaker: 'Jordan Blake', text: 'the migration is the thing' },
    { t: 2, speaker: 'Jordan Blake', text: 'and the deadline moved again' },
  ]);
  assert.equal(jobsForEvent(jobs, said, { registry }).length, 1, 'terms may be spread across the window');
  assert.equal(jobsForEvent(jobs, delta([{ t: 1, speaker: 'x', text: 'the migration is fine' }]), { registry }).length, 0,
    'minHits means both, not either');
});

test('a question is detected with or without the punctuation', () => {
  const jobs = [evJob(questionTrigger.id, {})];
  assert.equal(jobsForEvent(jobs, delta([{ t: 1, speaker: 'Jordan Blake', text: 'how are we handling the rollback' }]), { registry, ctx: { isSelf } }).length, 1,
    'speech-to-text drops question marks constantly');
  assert.equal(jobsForEvent(jobs, delta([{ t: 1, speaker: 'Jordan Blake', text: 'we ship on friday' }]), { registry, ctx: { isSelf } }).length, 0);
  assert.equal(jobsForEvent(jobs, delta([{ t: 1, speaker: 'Jordan Blake', text: 'what?' }]), { registry, ctx: { isSelf } }).length, 0,
    'a two-word "what?" is not worth waking a model for');
  // WHOSE questions, by default, is a product decision that has been changed more than once
  // (see the comment on the trigger). What must hold either way is that the OTHER answers are
  // reachable — the job form has a speaker dropdown — because a default nobody can find is a
  // trap regardless of which one it is. This asserts the current default and both alternatives.
  assert.equal(jobsForEvent(jobs, delta([{ t: 1, speaker: 'Alex Rivera', text: 'how are we handling the rollback' }]), { registry, ctx: { isSelf } }).length, 1,
    'your own question counts by default');
  const only = (speaker) => [evJob(questionTrigger.id, { speaker })];
  assert.equal(jobsForEvent(only('others'), delta([{ t: 1, speaker: 'Alex Rivera', text: 'how are we handling the rollback' }]), { registry, ctx: { isSelf } }).length, 0,
    '"only what other people ask" must be expressible');
  assert.equal(jobsForEvent(only('me'), delta([{ t: 1, speaker: 'Jordan Blake', text: 'how are we handling the rollback' }]), { registry, ctx: { isSelf } }).length, 0,
    'and so must "only what I ask"');
});

test('joining, starting, and a spoken command', () => {
  const joined = jobsForEvent([evJob(personJoinedTrigger.id, { names: ['Alex'] })],
    { type: 'meeting.person-joined', people: ['Alex Rivera', 'Jordan Blake'] }, { registry });
  assert.deepEqual(joined[0].match.people, ['Alex Rivera']);

  const started = jobsForEvent([evJob(meetingStartedTrigger.id, { platform: 'meet' })],
    { type: 'meeting.started', platform: 'zoom', title: 'Standup' }, { registry });
  assert.deepEqual(started, [], 'a platform filter that does not match must not fire');

  // Authority is settled where the command is parsed; a trigger may narrow it, never widen it.
  const refused = jobsForEvent([evJob(voiceCommandTrigger.id, {})],
    { type: 'voice.command', command: { allowed: false, intent: 'voice:timer', command: 'set a timer' } }, { registry });
  assert.deepEqual(refused, [], "someone else's command cannot reach a job either");
});

test('a trigger whose matcher throws does not fire and does not take the bus down', () => {
  const boom = defineTrigger({ id: 'boom', kind: 'meeting', watches: ['meeting.transcript.delta'], matches: () => { throw new Error('nope'); } });
  const reg = createTriggerRegistry([boom]);
  assert.deepEqual(jobsForEvent([evJob('boom', {})], delta([{ t: 1, speaker: 'x', text: 'y' }]), { registry: reg }), []);
});

test('an event trigger only sees the event types it watches', () => {
  const jobs = [evJob(phraseTrigger.id, { any: ['x'] })];
  assert.deepEqual(jobsForEvent(jobs, { type: 'meeting.started' }, { registry }), []);
});

// ---------------------------------------------------------------------------
// utteranceLooksComplete — is this caption a finished thought, or half of one?
// ---------------------------------------------------------------------------
test('utteranceLooksComplete: a line ending on a connective is not finished', () => {
  // The reported case: the trigger matched, the job ran, and the REASON had not been said.
  assert.equal(utteranceLooksComplete('the product is just amazing because'), false);
  assert.equal(utteranceLooksComplete('I think we need to'), false);
  assert.equal(utteranceLooksComplete('can you look at the'), false);
  assert.equal(utteranceLooksComplete('the renewal is'), false);
});

test('utteranceLooksComplete: punctuation ends it, inside quotes too', () => {
  assert.equal(utteranceLooksComplete('They said the product is amazing.'), true);
  assert.equal(utteranceLooksComplete('it was great!'), true);
  assert.equal(utteranceLooksComplete('“ship it.”'), true);
  assert.equal(utteranceLooksComplete('is that right?'), true);
});

test('utteranceLooksComplete: trailing comma, colon or dash means more is coming', () => {
  assert.equal(utteranceLooksComplete('pricing is fine —'), false);
  assert.equal(utteranceLooksComplete('three things:'), false);
  assert.equal(utteranceLooksComplete('well, and'), false);
});

test('utteranceLooksComplete: unpunctuated speech is complete unless it dangles', () => {
  // Speech-to-text often emits no punctuation at all. Requiring a full stop would make every
  // job wait every time, which is the opposite of the complaint.
  assert.equal(utteranceLooksComplete('we should ship it'), true);
  assert.equal(utteranceLooksComplete('we shipped it yesterday'), true);
  assert.equal(utteranceLooksComplete('action item for Alex'), true);
  assert.equal(utteranceLooksComplete('take both'), true);
});

test('utteranceLooksComplete: nothing at all is not a finished thought', () => {
  assert.equal(utteranceLooksComplete(''), false);
  assert.equal(utteranceLooksComplete('   '), false);
  assert.equal(utteranceLooksComplete(null), false);
});
