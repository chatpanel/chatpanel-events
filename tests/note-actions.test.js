// AI writing in a note: the prompt and the frame must agree, and the triggers must fire only
// where a person meant them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTE_ACTIONS, NOTE_ACTION_ORDER, NOTE_COMMANDS, frameNoteAction, noteActionLabel,
  commandLineAt, triggerQueryAt, filterNoteActions, noteActionItems,
} from '../note-actions.js';

const NOTE = '# Plan\n\nFirst point.\nSecond point.';

test('every action writes INTO the note, so every prompt forbids a preamble', () => {
  for (const k of NOTE_ACTION_ORDER) {
    assert.match(NOTE_ACTIONS[k].system, /Output ONLY/, `${k} could land "Sure! Here is" in the document`);
    assert.ok(NOTE_ACTIONS[k].maxTokens > 0);
  }
  for (const c of NOTE_COMMANDS) assert.match(c.system, /Output ONLY/, `@${c.cmd}`);
});

test('continue appends after a blank line and never repeats the note', () => {
  const f = frameNoteAction('continue', NOTE, 5, 5);
  assert.equal(f.target, NOTE);
  assert.equal(f.head, `${NOTE}\n\n`);
  assert.equal(f.tail, '');
  // A note already ending in whitespace gets no second gap.
  assert.equal(frameNoteAction('continue', 'x\n').head, 'x\n');
});

test('summarize lands a Summary section at the END, even when a selection was summarized', () => {
  const f = frameNoteAction('summarize', NOTE, 8, 20);
  assert.equal(f.target, 'First point.');
  assert.equal(f.head, `${NOTE}\n\n## Summary\n\n`);
  assert.equal(f.tail, '');
  assert.equal(frameNoteAction('summarize', `${NOTE}\n\n\n`).head, `${NOTE}\n\n## Summary\n\n`);
});

test('tasks REPLACES the selection and refuses to run without one', () => {
  const f = frameNoteAction('tasks', NOTE, 8, 20);
  assert.deepEqual(f, { target: 'First point.', head: '# Plan\n\n', tail: '\nSecond point.' });
  assert.deepEqual(frameNoteAction('tasks', NOTE, 4, 4), { error: 'select' });
  assert.deepEqual(frameNoteAction('tasks', NOTE, 6, 8), { error: 'select' }, 'a whitespace-only selection is no selection');
});

test('improve rewrites the selection in place, or the whole note when nothing is selected', () => {
  const sel = frameNoteAction('improve', NOTE, 8, 20);
  assert.deepEqual(sel, { target: 'First point.', head: '# Plan\n\n', tail: '\nSecond point.' });
  const all = frameNoteAction('improve', NOTE);
  assert.deepEqual(all, { target: NOTE, head: '', tail: '' });
});

test('an empty note has nothing to work with, and an unknown action says so', () => {
  assert.deepEqual(frameNoteAction('continue', '   '), { error: 'empty' });
  assert.deepEqual(frameNoteAction('improve', ''), { error: 'empty' });
  assert.deepEqual(frameNoteAction('rewrite', NOTE), { error: 'unknown' });
  assert.equal(noteActionLabel('tasks'), 'Turn into tasks');
  assert.equal(noteActionLabel('nope'), 'nope');
});

test('a selection outside the body is clamped rather than slicing garbage', () => {
  const f = frameNoteAction('improve', 'abc', 10, 99);
  assert.deepEqual(f, { target: 'abc', head: '', tail: '' });
});

test('an @command is found anywhere on the caret line, case-insensitively, with its span', () => {
  const text = 'intro\nplease @Table the G7 by population\nafter';
  const c = commandLineAt(text, 20);
  assert.equal(c.spec.cmd, 'table');
  assert.equal(c.instruction, 'the G7 by population');
  // The span starts at the `@`, so "please " survives the replacement.
  assert.equal(text.slice(c.start, c.end), '@Table the G7 by population');
  assert.equal(text.slice(0, c.start), 'intro\nplease ');
});

test('a command with no instruction is still being typed, and an unknown command is text', () => {
  assert.equal(commandLineAt('@table', 6), null);
  assert.equal(commandLineAt('@table   ', 9), null);
  assert.equal(commandLineAt('@dance now', 10), null);
  assert.equal(commandLineAt('email me @tablet now', 20), null, '\\b keeps @tablet from reading as @table');
});

test('the / palette opens at a line start or after a space — never inside a path or an email', () => {
  assert.deepEqual(triggerQueryAt('/su', 3, '/'), { word: 'su', start: 1, end: 3 });
  assert.deepEqual(triggerQueryAt('note /', 6, '/'), { word: '', start: 6, end: 6 });
  assert.equal(triggerQueryAt('a/b', 3, '/'), null);
  assert.equal(triggerQueryAt('alex@example', 12, '@'), null);
  assert.deepEqual(triggerQueryAt('x\n@ta', 5, '@'), { word: 'ta', start: 3, end: 5 });
  assert.equal(triggerQueryAt('# heading', 9, '#'), null, 'a heading is not a trigger');
  assert.equal(triggerQueryAt('/su', 3, '/', { hasSelection: true }), null);
  assert.equal(triggerQueryAt('/su\nmore', 8, '/'), null, 'only the caret line counts');
});

test('palette items carry no runner, and filter by key prefix or label substring', () => {
  const items = noteActionItems();
  assert.deepEqual(items.map((i) => i.key), ['continue', 'summarize', 'tasks', 'improve']);
  assert.ok(items.every((i) => i.label && i.hint && !('run' in i)));
  assert.deepEqual(filterNoteActions(items, 'su').map((i) => i.key), ['summarize']);
  assert.deepEqual(filterNoteActions(items, 'WRIT').map((i) => i.key), ['continue', 'improve']);
  assert.equal(filterNoteActions(items, '').length, 4);
  assert.deepEqual(noteActionItems(['tasks', 'nope']).map((i) => i.key), ['tasks']);
});
