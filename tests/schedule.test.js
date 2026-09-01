import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextFireAt, occurrencesBetween, validateSchedule, dueJobs, nextWakeAt, occurrenceKey,
  defineJob, defineTrigger, createTriggerRegistry, jobsForEvent, BUILTIN_TRIGGERS,
  timerTrigger, phraseTrigger, topicTrigger, questionTrigger, personJoinedTrigger,
  clipText, matchSummary,
  meetingStartedTrigger, voiceCommandTrigger, ScheduleError, MISSED_POLICIES, saidIn,
  utteranceLooksComplete, coalesceMatches, matchTexts,
  TEXT_DELTA, TRIGGER_SOURCES, eventSource, sourceAllowed,
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

test('a matched question carries the question, not just the asker', () => {
  // The row in the thread, the toast and the run log are all this string. "question from
  // Jordan Blake" describes an event nobody can identify afterwards — least of all the person
  // reading the answer that landed underneath it.
  const [hit] = jobsForEvent([evJob(questionTrigger.id, {})],
    delta([{ t: 1, speaker: 'Jordan Blake', text: 'how are we handling the rollback' }]),
    { registry, ctx: { isSelf } });
  assert.match(hit.match.why, /question from Jordan Blake/);
  assert.match(hit.match.why, /how are we handling the rollback/);
});

test('a very long question is clipped at a word, never mid-word', () => {
  const long = `why does the ${'very '.repeat(40)}long pipeline stall`;
  const [hit] = jobsForEvent([evJob(questionTrigger.id, {})],
    delta([{ t: 1, speaker: 'Jordan Blake', text: long }]), { registry, ctx: { isSelf } });
  assert.ok(hit.match.why.length < 160, 'a reason is a line, not a transcript');
  assert.match(hit.match.why, /…”$/);
  // The visible cut is a PREFIX of what was said that ends where a word ends — the failure
  // this exists to stop is "…with the informati".
  const body = hit.match.why.match(/“(.*)…”$/)[1];
  assert.ok(long.startsWith(body), 'the clip is a prefix of what was actually said');
  assert.equal(long[body.length], ' ', 'and it stops on a word boundary');
});

test('clipText shortens where a reader would, and leaves short text alone', () => {
  assert.equal(clipText('already short', 40), 'already short');
  assert.equal(clipText('answer the question the best way possible with the information', 40),
    'answer the question the best way…');
  // No boundary to back up to: an unbroken token is cut rather than erased.
  assert.equal(clipText('a'.repeat(30), 10), `${'a'.repeat(10)}…`);
  assert.equal(clipText('   spaced   out   text  ', 40), 'spaced out text');
});

test('matchSummary names what fired, and a burst names all of them', () => {
  const one = matchSummary([q(1, 'did the staging pull work', 'Alex Rivera')], { noun: 'questions' });
  assert.equal(one, 'question', 'a single match keeps the reason its own trigger wrote');

  const three = matchSummary([
    q(1, 'did the staging pull work', 'Alex Rivera'),
    q(2, 'which credential was used', 'Alex Rivera'),
    q(3, 'is the bucket shared', 'Alex Rivera'),
  ], { noun: 'questions' });
  assert.match(three, /^3 questions: /);
  for (const t of ['staging pull', 'credential', 'bucket']) assert.ok(three.includes(t), `${t} should be named`);

  // Beyond what fits, the count of the rest is kept rather than silently dropped.
  const many = matchSummary(Array.from({ length: 6 }, (_, i) => q(i + 1, `question number ${i}`)), { noun: 'questions' });
  assert.match(many, /\+3 more$/);
  assert.equal(matchSummary([], { noun: 'questions' }), '');
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

// ---------------------------------------------------------------------------
// coalesceMatches — a burst of questions is a batch, not one answer and 13 drops
// ---------------------------------------------------------------------------
const q = (t, text, speaker = 'You') => ({ segment: { t, text, speaker }, why: 'question' });

test('coalesceMatches: a caption that grew is one ask, and the finished text wins', () => {
  const got = coalesceMatches([q(1, 'why is the sky'), q(1, 'why is the sky blue'), q(2, 'what is cooldown')]);
  assert.equal(got.length, 2);
  assert.equal(got[0].segment.text, 'why is the sky blue');
});

test('coalesceMatches: without timestamps, prefix growth still collapses', () => {
  const grown = [{ segment: { text: 'what is happening', speaker: 'You' } },
    { segment: { text: 'what is happening here', speaker: 'You' } }];
  assert.equal(coalesceMatches(grown).length, 1);
});

test('coalesceMatches: a timestamp is identity, so prefix matching cannot over-merge', () => {
  // "question number 1" IS a prefix of "question number 10". Twelve distinct asks must stay
  // distinct — an OR between the two rules silently merged them.
  const many = Array.from({ length: 12 }, (_, i) => q(i + 10, `question number ${i}`));
  assert.equal(coalesceMatches(many, { max: 20 }).length, 12);
});

test('coalesceMatches: the same words from two speakers are two asks', () => {
  assert.equal(coalesceMatches([q(3, 'is that right', 'Alex'), q(4, 'is that right', 'Jordan')]).length, 2);
});

test('coalesceMatches: over the cap the OLDEST go — the meeting has moved past them', () => {
  const many = Array.from({ length: 12 }, (_, i) => q(i + 10, `q${i}`));
  const kept = coalesceMatches(many, { max: 8 });
  assert.equal(kept.length, 8);
  assert.equal(kept[0].segment.text, 'q4');
  assert.equal(kept[7].segment.text, 'q11');
});

test('matchTexts: the lines a batch is asking about, deduped, in order', () => {
  assert.deepEqual(matchTexts([q(1, 'why is the sky'), q(1, 'why is the sky blue'), q(2, 'and cooldown?')]),
    ['why is the sky blue', 'and cooldown?']);
  assert.deepEqual(matchTexts([]), []);
});

// ---------------------------------------------------------------------------
// Sources — the same trigger, wherever the text is written
// ---------------------------------------------------------------------------
const textReg = createTriggerRegistry(BUILTIN_TRIGGERS);
const said = [{ t: 1, speaker: 'You', text: 'why is the sky blue?' }];
const asks = (params, event) => jobsForEvent(
  [{ id: 'j', name: 'n', enabled: true, trigger: questionTrigger.id, params, action: { kind: 'prompt', text: 'x' } }],
  event, { registry: textReg },
).length;
const inMeeting = { type: 'meeting.transcript.delta', meetingId: 'm', segments: said };
const inNote = { type: TEXT_DELTA, source: 'note', sourceId: 'n1', segments: said };
const inChat = { type: TEXT_DELTA, source: 'chat', sourceId: 'c1', segments: said };

test('a job stored before sources existed still fires on meetings, and ONLY meetings', () => {
  // The compatibility guarantee. Every such job was created against a form that said "in a
  // call"; widening it silently would run models over notes its author never pointed it at.
  assert.equal(asks({}, inMeeting), 1);
  assert.equal(asks({}, inNote), 0);
  assert.equal(asks({}, inChat), 0);
});

test('a job scoped to a surface fires there and nowhere else', () => {
  assert.equal(asks({ sources: ['note'] }, inNote), 1);
  assert.equal(asks({ sources: ['note'] }, inMeeting), 0);
  assert.equal(asks({ sources: ['chat'] }, inChat), 1);
  assert.equal(asks({ sources: ['meeting', 'note', 'chat'] }, inChat), 1);
});

test('an unknown or missing source matches nothing — never everything', () => {
  assert.equal(asks({ sources: ['note'] }, { type: TEXT_DELTA, segments: said }), 0);
  assert.equal(asks({ sources: ['nope'] }, inNote), 0, 'a junk scope falls back to meeting-only');
  assert.equal(eventSource({ type: TEXT_DELTA, source: 'wat' }), '');
  assert.equal(eventSource(inMeeting), 'meeting', 'a meeting delta says so by its type alone');
});

test('phrase and topic triggers are gated the same way', () => {
  const one = (trigger, params, event) => jobsForEvent(
    [{ id: 'j', name: 'n', enabled: true, trigger, params, action: { kind: 'prompt', text: 'x' } }],
    event, { registry: textReg },
  ).length;
  const typed = { type: TEXT_DELTA, source: 'note', segments: [{ t: 1, speaker: 'You', text: 'this is an action item for pricing' }] };
  assert.equal(one(phraseTrigger.id, { any: ['action item'] }, typed), 0, 'meeting-only by default');
  assert.equal(one(phraseTrigger.id, { any: ['action item'], sources: ['note'] }, typed), 1);
  assert.equal(one(topicTrigger.id, { terms: ['pricing'], sources: ['note'] }, typed), 1);
});
