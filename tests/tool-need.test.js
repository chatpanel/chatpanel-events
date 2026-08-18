import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolNeedFor } from '../tool-need.js';

const ask = (text, over = {}) => toolNeedFor({ request: { text }, ...over });

test('a greeting arms nothing', () => {
  // The turn this was written for: "hi" reached the model carrying two dispatchers and
  // ~1,200 tokens of rulebook, and — because a turn that carries tools REQUIRES a model
  // that can call them — was answered by a CLI agent that spent two seconds spawning a
  // process to wave back.
  for (const t of ['hi', 'hello', 'hey there', 'thanks!', 'thanks so much', 'good morning', 'sounds great', 'hi 👋', 'bye']) {
    assert.equal(ask(t).tools, false, `"${t}" armed tools`);
  }
});

test("anything referring to work stays armed, even wrapped in pleasantries", () => {
  // "ok got it" carries 'it' — a reference — and the router's smalltalk signal already
  // refuses to call that trivial. The two gates agreeing is the point: neither can quietly
  // widen the toolless class on its own.
  assert.equal(ask('ok got it').tools, true);
  assert.equal(ask('thanks, now do it').tools, true);
});

test('a question is never a pleasantry, even a trivial one', () => {
  // "what can you help with" needs no tools and will get them anyway. That is the trade
  // this rule makes on purpose: the cost of arming a turn that did not need it is tokens,
  // and the cost of the reverse is a wrong answer about the user's own data.
  assert.equal(ask('what can you help with').tools, true);
});

test('anything that could need fetching arms tools — the default is open', () => {
  // A FALSE NEGATIVE IS THE WORST FAILURE HERE. Withhold the history tools from a question
  // about the user's own data and the model answers "I cannot access your meetings", which
  // is both wrong and the exact thing the tool system prompt exists to prevent.
  for (const t of [
    'what did we decide in the standup',
    'find my notes on the migration',
    'summarize this page',
    'do it',
    'search the web for the release date',
    'open the settings tab and click save',
    'whats my longest streak',
    'check jira for open tickets',
  ]) {
    assert.equal(ask(t).tools, true, `"${t}" was treated as small talk`);
  }
});

test('an attachment is never small talk, however short the message', () => {
  assert.equal(ask('hi', { attachments: [{ kind: 'text', text: 'a report' }] }).tools, true);
});

test('asking for tools is never second-guessed', () => {
  // MCP mode 'on', the /history hint, a running skill — the user or a skill said so, and a
  // heuristic must not overrule a stated intent.
  assert.equal(ask('hi', { explicit: true }).tools, true);
});

test('every answer explains itself', () => {
  assert.ok(ask('hi').why);
  assert.ok(ask('find my notes').why);
});

test('signals can be passed in rather than recomputed', () => {
  // The router already computed these for model choice on the same turn; asking twice is
  // two implementations of one question waiting to disagree.
  const req = { text: 'hi' };
  assert.equal(toolNeedFor({ request: req, signals: { smalltalk: true } }).tools, false);
  // BOTH tests must agree. The vocabulary says pleasantry, the router says otherwise — the
  // stricter answer wins, and the stricter answer is always "arm them".
  assert.equal(toolNeedFor({ request: req, signals: { smalltalk: false } }).tools, true);
});

test('a long message built only from pleasantries is not understood, so it is armed', () => {
  // Not-understood must never read as not-needed.
  assert.equal(toolNeedFor({ request: { text: 'ok ok ok ok ok ok ok ok' } }).tools, true);
  assert.equal(toolNeedFor({ request: { text: '' } }).tools, true);
});
