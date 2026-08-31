import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WAKE, compileWake, findWakeCommand, parseCommand, parseDuration, parseClock,
  parseWhen, parseNumberWords, normalizeSpeech, editDistance, defineVoiceIntent,
  createVoiceIntentRegistry, defaultVoiceIntents, commandsFromSegments, timerIntent,
  reminderIntent, noteIntent, monitorIntent, scheduleIntent, VoiceIntentError, MAX_COMMANDS_PER_DELTA,
} from '../voice-intents.js';

// A fixed local moment: Monday 2026-06-01, 10:00 local. Every expectation below is built
// with the same local-time constructor, so these pass in any timezone.
const MON_10AM = new Date(2026, 5, 1, 10, 0, 0, 0).getTime();
const local = (days, hour, minute = 0) => new Date(2026, 5, 1 + days, hour, minute, 0, 0).getTime();

// ── wake word ──────────────────────────────────────────────────────────────

test('the wake word is configurable, and a too-short one is refused', () => {
  const w = compileWake('Jarvis');
  assert.ok(findWakeCommand('jarvis set a timer for 5 minutes', w));
  assert.equal(findWakeCommand('chatpanel set a timer', w), null);
  // Three letters is already generous; two would fire on ordinary speech constantly.
  assert.throws(() => compileWake('ok'), VoiceIntentError);
  assert.throws(() => compileWake([]), VoiceIntentError);
});

test('speech-to-text mangling still opens the gate', () => {
  const w = compileWake(DEFAULT_WAKE);
  // The three renderings a real caption track produces for an unknown brand name.
  for (const said of ['chatpanel, set a timer', 'chat panel set a timer', 'Chat Panel: set a timer']) {
    assert.ok(findWakeCommand(said, w), `wake missed in: ${said}`);
  }
  assert.ok(findWakeCommand('chat pannel set a timer', w), 'one edit should still match');
});

test('the wake word does not fire on ordinary speech', () => {
  const w = compileWake(DEFAULT_WAKE);
  for (const said of ['the chat was useful', 'can you open the panel', 'channel partner update']) {
    assert.equal(findWakeCommand(said, w), null, `false wake on: ${said}`);
  }
});

test('the command keeps its original casing and loses the politeness', () => {
  const w = compileWake(DEFAULT_WAKE);
  const f = findWakeCommand('Hey ChatPanel, could you please remind me to email Alex Rivera', w);
  assert.equal(f.command, 'remind me to email Alex Rivera');
  assert.equal(f.wake, 'chatpanel');
});

test('normalising speech preserves offsets so the original text can be sliced', () => {
  const raw = "Chat-Panel, that's it!";
  assert.equal(normalizeSpeech(raw).length, raw.length);
});

test('edit distance stops early instead of scoring the whole string', () => {
  assert.equal(editDistance('chatpanel', 'chatpanel'), 0);
  assert.equal(editDistance('chatpanel', 'chatpannel', 2), 1);
  assert.ok(editDistance('chatpanel', 'entirely different', 2) > 2);
});

// ── numbers and durations ──────────────────────────────────────────────────

test('numbers as people say them', () => {
  assert.equal(parseNumberWords(['twenty', 'five']), 25);
  assert.equal(parseNumberWords(['an']), 1);
  assert.equal(parseNumberWords(['two', 'and', 'a', 'half']), 2.5, '"a" is an article here, not a one');
  assert.equal(parseNumberWords(['half']), 0.5);
  assert.equal(parseNumberWords(['banana']), null);
});

test('durations, including the halves', () => {
  const ms = (t) => parseDuration(t)?.ms;
  assert.equal(ms('set a timer for 10 minutes'), 600_000);
  assert.equal(ms('ten minutes'), 600_000);
  assert.equal(ms('90 seconds'), 90_000);
  assert.equal(ms('90s'), 90_000);
  assert.equal(ms('1 hour 30 minutes'), 90 * 60_000, 'both parts must be summed');
  assert.equal(ms('an hour and a half'), 90 * 60_000, 'the fraction trails its unit');
  assert.equal(ms('two and a half hours'), 150 * 60_000, 'and here it precedes it');
  assert.equal(ms('half an hour'), 30 * 60_000);
  assert.equal(ms('a quarter of an hour'), 15 * 60_000);
  assert.equal(ms('1.5 hours'), 90 * 60_000);
  assert.equal(ms('a timer for the standup'), undefined, 'no duration named');
  assert.equal(ms('minutes'), undefined, 'a unit with no quantity is not a duration');
});

test('punctuation at the end of an utterance does not eat the unit', () => {
  // Captions punctuate; "minutes." used to tokenise into an unknown unit and the whole
  // command silently failed to parse.
  assert.equal(parseDuration('set a timer for ten minutes.')?.ms, 600_000);
});

// ── clock times ────────────────────────────────────────────────────────────

const hm = (c) => (c ? { hour: c.hour, minute: c.minute } : c);

test('a number is only a clock time when something says so', () => {
  assert.deepEqual(hm(parseClock('at 9am')), { hour: 9, minute: 0 });
  assert.deepEqual(hm(parseClock('at 9:30 pm')), { hour: 21, minute: 30 });
  assert.deepEqual(hm(parseClock('21:15')), { hour: 21, minute: 15 });
  assert.deepEqual(hm(parseClock('at nine am')), { hour: 9, minute: 0 });
  assert.deepEqual(hm(parseClock("at 9 o'clock")), { hour: 9, minute: 0 });
  assert.deepEqual(hm(parseClock('at 12am')), { hour: 0, minute: 0 });
  assert.equal(parseClock('at 9am').meridiem, true, 'an explicit am/pm must be reported');
  assert.equal(parseClock('at 8').meridiem, false, 'so a bare hour can be read with the daypart');
  // The one that matters: a duration is not a time of day.
  assert.equal(parseClock('set a timer for 10 minutes'), null);
  assert.equal(parseClock('give me 5 more'), null);
});

// ── when ───────────────────────────────────────────────────────────────────

test('relative, clock, day and weekday times all resolve against the injected now', () => {
  const when = (t) => parseWhen(t, { now: MON_10AM });
  assert.equal(when('in 20 minutes').at, MON_10AM + 20 * 60_000);
  assert.equal(when('at 3pm').at, local(0, 15));
  assert.equal(when('at 9am').at, local(1, 9), 'a time already past today means tomorrow');
  assert.equal(when('tomorrow at 3').at, local(1, 3));
  assert.equal(when('tonight at 8').at, local(0, 20));
  assert.equal(when('on wednesday at 9am').at, local(2, 9));
  assert.equal(when('next monday at 9am').at, local(7, 9), '"next monday" is never today');
  assert.equal(when('at 11am').at, local(0, 11), 'still ahead today, so today');
  assert.equal(when('sometime soon'), null);
});

test('recurrence is a wall-clock rule, not an interval', () => {
  // "every day at 8am" has to survive a daylight-saving change; 86_400_000 ms does not.
  const daily = parseWhen('every day at 8am', { now: MON_10AM });
  assert.deepEqual(daily.recurrence, { kind: 'daily', hour: 8, minute: 0, weekdaysOnly: false });
  assert.equal(daily.at, local(1, 8));

  const morning = parseWhen('every morning', { now: MON_10AM });
  assert.equal(morning.recurrence.hour, 9);

  const weekly = parseWhen('every wednesday at 9am', { now: MON_10AM });
  assert.deepEqual(weekly.recurrence, { kind: 'weekly', weekday: 3, hour: 9, minute: 0 });
  assert.equal(weekly.at, local(2, 9));

  const weekdays = parseWhen('every weekday at 8am', { now: MON_10AM });
  assert.equal(weekdays.recurrence.weekdaysOnly, true);
});

test('a daily job at a weekday-only hour skips the weekend', () => {
  const friday = new Date(2026, 5, 5, 10, 0, 0, 0).getTime(); // Fri
  const at = parseWhen('every weekday at 8am', { now: friday }).at;
  assert.equal(new Date(at).getDay(), 1, 'the next weekday run after Friday 10am is Monday');
});

// ── intents ────────────────────────────────────────────────────────────────

test('a timer command carries its duration and what it is for', () => {
  const r = defaultVoiceIntents().parse('set a timer for 10 minutes for the demo', { now: MON_10AM });
  assert.equal(r.intent, 'voice:timer');
  assert.equal(r.args.ms, 600_000);
  assert.equal(r.args.at, MON_10AM + 600_000);
  assert.equal(r.args.label, 'demo');
});

test('a reminder keeps what to do and drops when to do it from the text', () => {
  const r = defaultVoiceIntents().parse('remember to take the kids to school at 9am on Wednesday', { now: MON_10AM });
  assert.equal(r.intent, 'voice:reminder');
  assert.equal(r.args.text, 'take the kids to school');
  assert.equal(r.args.at, local(2, 9));
  assert.equal(r.args.recurrence, null);
});

test('a recurring reminder is recognised as recurring', () => {
  const r = defaultVoiceIntents().parse('remind me every weekday morning to check the release queue', { now: MON_10AM });
  assert.equal(r.args.recurrence.kind, 'daily');
  assert.equal(r.args.recurrence.weekdaysOnly, true);
  assert.match(r.args.text, /check the release queue/);
});

test('a reminder with no time is still a reminder', () => {
  const r = defaultVoiceIntents().parse('remind me to thank the team', { now: MON_10AM });
  assert.equal(r.args.at, null, 'the host decides what an undated reminder means');
  assert.equal(r.args.text, 'thank the team');
});

test('"remind me" with nothing to remember is not a command', () => {
  const r = defaultVoiceIntents().parse('remind me', { now: MON_10AM });
  assert.equal(r.intent, null);
  assert.equal(r.needsModel, true);
});

test('scheduling a skill by voice — the daily brief', () => {
  const r = defaultVoiceIntents().parse('every weekday at 8am run my daily brief', { now: MON_10AM });
  assert.equal(r.intent, 'voice:schedule');
  assert.equal(r.args.target, 'daily brief', 'the host resolves this against the skills the user has');
  assert.deepEqual(r.args.recurrence, { kind: 'daily', hour: 8, minute: 0, weekdaysOnly: true });
  assert.equal(r.classUsed, 'C', 'it will start a model turn every morning — say so');

  const once = defaultVoiceIntents().parse('tomorrow at 9 run the release checklist', { now: MON_10AM });
  assert.equal(once.args.recurrence, null);
  assert.equal(once.args.at, local(1, 9));
  assert.equal(once.args.target, 'release checklist');

  // No time is not a schedule — "run the checklist" is a chat message, not a job.
  const bare = defaultVoiceIntents().parse('run the release checklist', { now: MON_10AM });
  assert.equal(bare.intent, null);
  assert.equal(bare.needsModel, true);
});

test('notes and monitors', () => {
  const reg = defaultVoiceIntents();
  assert.deepEqual(reg.parse('note that we agreed to ship on Friday').args, { text: 'we agreed to ship on Friday' });
  assert.equal(reg.parse('keep an eye on the pricing question').intent, 'voice:monitor');
  assert.equal(reg.parse('watch for whether we agree a date').args.prompt, 'we agree a date');
});

test('an unrecognised command asks for a model instead of guessing', () => {
  // The distinction that matters: "I do not understand" is not "nothing was said to me".
  const r = defaultVoiceIntents().parse('put the thing on the other thing');
  assert.equal(r.intent, null);
  assert.equal(r.needsModel, true);
  assert.equal(r.command, 'put the thing on the other thing');
});

test('a class that costs money is declared, not inferred', () => {
  assert.equal(timerIntent.classUsed, 'R');
  assert.equal(reminderIntent.classUsed, 'R');
  assert.equal(noteIntent.classUsed, 'R');
  assert.equal(monitorIntent.classUsed, 'C', 'starting a monitor starts model turns');
});

test('a client can add an intent without touching the parser', () => {
  const reg = defaultVoiceIntents();
  reg.add(defineVoiceIntent({
    id: 'voice:mute',
    label: 'Mute me',
    match: (c) => (/^mute\b/i.test(c) ? {} : null),
  }));
  assert.equal(reg.parse('mute me').intent, 'voice:mute');
  assert.throws(() => defineVoiceIntent({ id: 'x' }), VoiceIntentError);
  assert.throws(() => defineVoiceIntent({ match: () => null }), VoiceIntentError);
});

test('an intent whose matcher throws is simply not a match', () => {
  const reg = createVoiceIntentRegistry([
    defineVoiceIntent({ id: 'boom', match: () => { throw new Error('nope'); } }),
    timerIntent,
  ]);
  assert.equal(reg.parse('set a timer for 5 minutes', { now: MON_10AM }).intent, 'voice:timer');
});

// ── transcript scanning ────────────────────────────────────────────────────

const segs = [
  { t: 100, speaker: 'Alex Rivera', text: 'so the migration lands next week' },
  { t: 200, speaker: 'Alex Rivera', text: 'ChatPanel, set a timer for 10 minutes' },
  { t: 300, speaker: 'Jordan Blake', text: 'chatpanel remind me to cancel the contract tomorrow at 9am' },
];

test('only the device owner can command it', () => {
  // Everyone in a meeting is on the transcript. Without this gate, any participant — or a
  // page writing captions — can put reminders on someone else's machine.
  const out = commandsFromSegments(segs, { isSelf: (s) => s === 'Alex Rivera', now: MON_10AM, meetingId: 'm1' });
  assert.equal(out.length, 2, 'both commands are REPORTED');
  assert.equal(out[0].allowed, true);
  assert.equal(out[1].allowed, false, "someone else's command must not be actionable");
  assert.equal(out[1].speaker, 'Jordan Blake', 'and it must say whose it was, or "why did nothing happen" has no answer');
});

test('with no way to know who is speaking, nothing is allowed', () => {
  // Failing closed on a question of authority is the only safe default.
  const out = commandsFromSegments(segs, { now: MON_10AM });
  assert.equal(out.every((c) => c.allowed === false), true);
});

test('a redelivered segment produces the same key, so it can be deduped', () => {
  const a = commandsFromSegments(segs, { isSelf: () => true, now: MON_10AM, meetingId: 'm1' });
  const b = commandsFromSegments(segs, { isSelf: () => true, now: MON_10AM + 5000, meetingId: 'm1' });
  assert.deepEqual(a.map((c) => c.key), b.map((c) => c.key), 'a flush that resends must not set two timers');
});

test('already-seen transcript is skipped and a burst is capped', () => {
  assert.equal(commandsFromSegments(segs, { isSelf: () => true, sinceTs: 250, now: MON_10AM }).length, 1);
  const many = Array.from({ length: 10 }, (_, i) => ({ t: i + 1, speaker: 'me', text: 'chatpanel note that x' }));
  assert.equal(commandsFromSegments(many, { isSelf: () => true, now: MON_10AM }).length, MAX_COMMANDS_PER_DELTA);
});

test('the common case — a meeting nobody is talking to ChatPanel in — costs nothing', () => {
  const ordinary = Array.from({ length: 200 }, (_, i) => ({ t: i, speaker: 'Alex Rivera', text: 'we should ship the migration on friday and tell the team' }));
  assert.deepEqual(commandsFromSegments(ordinary, { isSelf: () => true, now: MON_10AM }), []);
});

test('ordinary meeting talk does not set timers', () => {
  const wake = compileWake(DEFAULT_WAKE);
  const fire = (text, now = 1e6) => commandsFromSegments([{ t: 1000, text, speaker: 'You' }], { meetingId: 'm', now, wake });

  // Reported from a real call: a meeting ABOUT ChatPanel kept creating timers. parseCommand
  // returns a shape for anything carrying the wake word and a time-ish phrase, intent or not,
  // so plain conversation came back as a command with intent:null and was acted on.
  assert.equal(fire('we should talk about the chat panel roadmap next week').length, 0,
    'a sentence with no request must not fire');
  assert.equal(fire('Okay, so we are meeting today to talk about chat panel.').length, 0);
  // A real request still works.
  assert.equal(fire('hey chatpanel set a timer for 10 seconds')[0]?.intent, 'voice:timer');
});

test('one spoken request keeps ONE key while the caption grows', () => {
  const wake = compileWake(DEFAULT_WAKE);
  // A live caption is rescanned as the sentence extends — deliberately, so a half-heard
  // command gets a second chance. The key must therefore not move, or each rescan looks like
  // a new request. It used to contain `at` (now + the spoken duration), which changed on
  // every scan and produced a new timer per caption update, faster than they could be deleted.
  // Capture BUMPS seg.t every time a live caption grows (the delta filter needs that), so the
  // key must come from `sid`, which is assigned once per utterance. Keying on t is what turned
  // one "set a timer for 30 seconds" into a screenful of timers.
  const keyAt = (now, text) => commandsFromSegments([{ sid: 's:7', t: now, text, speaker: 'You' }],
    { meetingId: 'm', now, wake })[0]?.key;
  const a = keyAt(100000, 'hey chatpanel set a timer for 10 seconds');
  const b = keyAt(103000, 'hey chatpanel set a timer for 10 seconds and then');
  const c = keyAt(109000, 'hey chatpanel set a timer for 10 seconds and then we moved on');
  assert.ok(a, 'the request is recognised');
  assert.equal(a, b, 'the key survives the caption growing');
  assert.equal(b, c, 'and keeps surviving it');
  assert.ok(!/\d{6,}/.test(a), 'no absolute timestamp is baked into the key');
});
