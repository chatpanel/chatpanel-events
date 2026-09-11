// Delegation inside a note: the token says WHO, the rest of the line says WHAT.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAgentMention, agentMentionAt, parseSkillMention, mergeSkillPrompt,
  findSkillByName, findTargetByName, mentionAnswerPrefix,
} from '../note-mentions.js';

test('the instruction may sit before OR after the token — both are one request', () => {
  assert.deepEqual(parseAgentMention('@[Claude Code] update the plan'), { name: 'Claude Code', task: 'update the plan' });
  assert.deepEqual(parseAgentMention('Update the plan @[Claude Code]'), { name: 'Claude Code', task: 'Update the plan' });
  assert.deepEqual(parseAgentMention('please @[Codex] fix this'), { name: 'Codex', task: 'please fix this' });
});

test('a mention with no task is someone still typing, and a bare line is not a mention', () => {
  assert.deepEqual(parseAgentMention('@[Codex]'), { name: 'Codex', task: '' });
  assert.deepEqual(parseAgentMention('just a line'), { name: '', task: '' });
  assert.deepEqual(parseAgentMention('email alex@example.com'), { name: '', task: '' });
});

test('agentMentionAt returns the WHOLE line, because the Q&A replaces it', () => {
  const text = 'intro\n@[Codex] draft the rollback\ntail';
  const m = agentMentionAt(text, 12);
  assert.equal(m.name, 'Codex');
  assert.equal(m.task, 'draft the rollback');
  assert.equal(text.slice(m.start, m.end), '@[Codex] draft the rollback');
  assert.equal(agentMentionAt(text, 2), null, 'the caret is on a line with no mention');
  assert.equal(agentMentionAt('@[Codex]', 8), null, 'no task, nothing to run');
});

test('a #skill token is addressing, not content — it leaves the instruction', () => {
  assert.deepEqual(parseSkillMention('#[Weekly review] cover last week'), { name: 'Weekly review', text: 'cover last week' });
  assert.deepEqual(parseSkillMention('no skill here'), { name: '', text: 'no skill here' });
  // The token's own gap does not survive as a double space.
  assert.equal(parseSkillMention('do #[Thing] it').text, 'do it');
});

test('a skill prompt takes the task at its placeholder, or underneath when it has none', () => {
  assert.equal(mergeSkillPrompt('Summarize {{input}} for an exec', 'the Q3 notes'), 'Summarize the Q3 notes for an exec');
  assert.equal(mergeSkillPrompt('Summarize {{ input }} twice: {{input}}', 'x'), 'Summarize x twice: x');
  assert.equal(mergeSkillPrompt('Be concise', 'rewrite this'), 'Be concise\n\nrewrite this');
  assert.equal(mergeSkillPrompt('Be concise', ''), 'Be concise');
  assert.equal(mergeSkillPrompt('', 'just the task'), 'just the task');
});

test('a skill resolves by exact name first, then by contains', () => {
  const skills = [{ name: 'Weekly review' }, { title: 'Review' }, { name: 'Weekly review notes' }];
  assert.equal(findSkillByName(skills, 'Review').title, 'Review');
  assert.equal(findSkillByName(skills, 'weekly').name, 'Weekly review');
  assert.equal(findSkillByName(skills, 'nope'), null);
  assert.equal(findSkillByName(null, 'x'), null);
});

test('a target resolves by name, then by the id underneath it — whatever shape the client holds', () => {
  const targets = [
    { name: 'Claude Code', bridgeAgent: 'claude' },
    { name: 'My GPT', model: 'gpt-4o' },
    { id: 'codex' },
  ];
  assert.equal(findTargetByName(targets, 'Claude Code').bridgeAgent, 'claude');
  assert.equal(findTargetByName(targets, 'claude').bridgeAgent, 'claude', 'the bridge id resolves too');
  assert.equal(findTargetByName(targets, 'codex').id, 'codex', 'a bare gateway model id is a target');
  assert.equal(findTargetByName(targets, 'gpt-4o').name, 'My GPT');
  assert.equal(findTargetByName(targets, 'My').name, 'My GPT', 'contains, once exact has failed');
  assert.equal(findTargetByName(targets, 'nothing'), null);
});

test('an exact name beats a contains match on a different entry', () => {
  const targets = [{ name: 'Claude Code Extra' }, { name: 'Claude' }];
  assert.equal(findTargetByName(targets, 'Claude').name, 'Claude');
});

test('the answer is written as a transcript — the question quoted, the agent named', () => {
  assert.equal(mentionAnswerPrefix('Codex', 'draft it'), '> draft it\n\n**Codex:**\n\n');
  assert.equal(mentionAnswerPrefix('Codex', 'line one\nline two'), '> line one\n> line two\n\n**Codex:**\n\n');
});
