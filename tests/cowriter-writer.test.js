import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lineAt, writerAffordance, instructionOnLine, goalDraftAllowed, createSpendMeter, writerTail,
  draftSeparator, groundingBlock, writerRequest, clipCompletion, normalizeWriterPrefs, normalizeIntent,
  WRITER_PREFS, GEARS,
} from '../cowriter-writer.js';

test('the caret line is found without its newline, at either end of the document', () => {
  const doc = 'one\ntwo\nthree';
  assert.deepEqual(lineAt(doc, 0), { text: 'one', start: 0, end: 3 });
  assert.deepEqual(lineAt(doc, 5), { text: 'two', start: 4, end: 7 });
  assert.deepEqual(lineAt(doc, doc.length), { text: 'three', start: 8, end: 13 });
});

test('a heading with no body, a blank line under one, an empty item and a TODO each afford a draft', () => {
  const heading = '## Introduction';
  assert.deepEqual(writerAffordance(heading, heading.length), { kind: 'section', at: heading.length, label: 'this section' });
  const under = '## Introduction\n';
  assert.equal(writerAffordance(under, under.length).kind, 'section');
  const filled = '## Introduction\nNVIDIA was founded in 1993.';
  assert.equal(writerAffordance(filled, 5), null, 'a section that has a body affords nothing');
  assert.equal(writerAffordance('- ', 2).kind, 'item');
  assert.equal(writerAffordance('Risks TODO:', 11).kind, 'todo');
  assert.equal(writerAffordance('plain prose here', 5), null);
});

test('an imperative line is an instruction; a mention, a command and prose are not', () => {
  const doc = 'Intro.\nsummarize the above in 3 sentences';
  const io = instructionOnLine(doc, doc.length);
  assert.equal(io.text, 'summarize the above in 3 sentences');
  assert.equal(io.start, 7);
  assert.equal(instructionOnLine('@[Codex] summarize this', 5), null);
  assert.equal(instructionOnLine('/summarize', 5), null);
  assert.equal(instructionOnLine('The summary was late.', 5), null);
  assert.equal(instructionOnLine('list', 2), null, 'too short to be a task');
});

test('the goal drafts once per burst of the user\'s own writing, at a line end, with context', () => {
  const doc = 'A paragraph long enough to be real context for a continuation.';
  assert.equal(goalDraftAllowed({ text: doc, caret: doc.length }), true, 'armed, at the end');
  assert.equal(goalDraftAllowed({ text: doc, caret: 10 }), false, 'mid-line is not a stopping point');
  assert.equal(goalDraftAllowed({ text: doc, caret: doc.length, lastLen: doc.length - 5 }), false, 'nothing new since the last draft');
  assert.equal(goalDraftAllowed({ text: doc, caret: doc.length, lastLen: doc.length - 30 }), true, 'enough new writing');
  assert.equal(goalDraftAllowed({ text: 'short', caret: 5 }), false, 'no context to continue');
});

test('the spend meter is a rolling minute, and reports what it spent', () => {
  let t = 0;
  const meter = createSpendMeter({ capPerMin: 2, now: () => t });
  assert.equal(meter.ok(), true);
  meter.spend(); meter.spend();
  assert.equal(meter.ok(), false);
  assert.equal(meter.used(), 2);
  t = 61_000;
  assert.equal(meter.ok(), true, 'the window cleared');
  assert.equal(meter.used(), 0);
});

test('the Writer is asked for a continuation, or for an instruction over the note above it', () => {
  const cont = writerRequest({ before: 'NVIDIA established in 1993.', title: 'GPUs', intent: 'a history of NVIDIA' });
  assert.match(cont.system, /^The note's goal \(guide your writing toward it\): a history of NVIDIA\./);
  assert.match(cont.system, /Output ONLY the continuation\.$/);
  assert.equal(cont.user, '# GPUs\n\nNVIDIA established in 1993.');
  assert.equal(cont.maxTokens, 220);
  const instr = writerRequest({ before: 'Intro.\nsummarize the above', contextBefore: 'Intro.\n', instruction: 'summarize the above', cards: [{ title: 'Atlas', snippet: 'the migration' }] });
  assert.match(instr.system, /executing an instruction/);
  assert.match(instr.system, /- Atlas — the migration/);
  assert.match(instr.user, /NOTE SO FAR:\nIntro\.\n\n\nINSTRUCTION/);
  assert.equal(instr.maxTokens, 600);
  assert.equal(groundingBlock([]), '');
});

test('a long note is continued from its tail; an instruction result lands on its own line', () => {
  const long = 'x'.repeat(2000);
  assert.equal(writerTail(long).length, 1601);
  assert.equal(draftSeparator('line'), '\n\n');
  assert.equal(draftSeparator('line\n'), '\n');
  assert.equal(draftSeparator('line\n\n'), '');
});

test('a completion is clipped to one sentence on one line', () => {
  assert.equal(clipCompletion('  and expanded into AI. Then more.\nnext line'), 'and expanded into AI.');
  assert.equal(clipCompletion('no terminal punctuation here'), 'no terminal punctuation here');
  assert.equal(clipCompletion(''), '');
});

test('the switches default to off, unknown keys are dropped, and the goal is one capped line', () => {
  const p = normalizeWriterPrefs({ gear: 'focus', goalDrive: true, bogus: true, autocomplete: 'yes' });
  assert.deepEqual(p, { gear: 'focus', revealFixes: false, actOnInstructions: false, goalDrive: true, autocomplete: false });
  assert.equal(normalizeWriterPrefs(null).gear, 'ambient');
  assert.ok(WRITER_PREFS.filter((x) => x.spends).length === 3, 'every switch that spends says so');
  assert.equal(GEARS.length, 2);
  assert.equal(normalizeIntent('  a   goal\nwith lines  '), 'a goal with lines');
  assert.equal(normalizeIntent('x'.repeat(300)).length, 200);
});
