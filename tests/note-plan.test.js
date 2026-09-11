// A plan note is written entirely by agents, and its ledger has to say so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePlanTasks, planTitleFor, planParts, planBody, planAttribution,
  planSectionSystem, PLAN_DECOMPOSE_SYSTEM, PLAN_AUTHORS,
} from '../note-plan.js';
import { HUMAN } from '../attribution.js';

const tasks = (over = {}) => [
  { title: 'Survey the options', role: 'research', prompt: 'find options', done: true, working: false, output: '- a\n- b', ...over },
  { title: 'Draft the runbook', role: 'write', prompt: 'write it', done: false, working: true, output: '' },
];

test('the ledger sums to the body — the invariant the whole module exists for', () => {
  const body = planBody('Migrate Atlas', tasks());
  const runs = planAttribution('Migrate Atlas', tasks(), 5);
  assert.equal(runs.reduce((n, r) => n + r.len, 0), body.length);
});

test('a plan note is never attributed to the human who asked for it', () => {
  const runs = planAttribution('Migrate Atlas', tasks(), 5);
  const authors = new Set(runs.map((r) => r.author));
  assert.equal(authors.has(HUMAN), false);
  assert.ok(authors.has(PLAN_AUTHORS.planner));
  assert.ok(authors.has(PLAN_AUTHORS.research), 'the section a researcher wrote says Researcher');
});

test('the section a member has not written yet stays the Planner\'s scaffold', () => {
  const runs = planAttribution('G', [{ title: 'T', role: 'write', done: false, working: false, output: '' }], 1);
  assert.deepEqual([...new Set(runs.map((r) => r.author))], [PLAN_AUTHORS.planner]);
});

test('the checklist is the progress report — it fills in as the work lands', () => {
  const body = planBody('Migrate Atlas', tasks());
  assert.match(body, /\*\*Plan\*\* — 1\/2 sub-tasks done/);
  assert.match(body, /- \[x\] 1\. Survey the options/);
  assert.match(body, /- \[ \] 2\. Draft the runbook — _working…_/);
});

test('a heading with nothing under it says who is working, rather than reading as empty', () => {
  const body = planBody('G', tasks());
  assert.match(body, /## 2\. Draft the runbook\n\n_⏳ Writer working…_/);
  const idle = planBody('G', [{ title: 'T', role: 'write', done: false, working: false, output: '' }]);
  assert.match(idle, /_pending_/);
});

test('adjacent parts by one author merge into one run', () => {
  const runs = planAttribution('G', [{ title: 'T', role: 'write', done: false, working: false, output: '' }], 1);
  assert.equal(runs.length, 1, 'three Planner parts in a row are one run');
});

test('a fenced or chatty JSON answer still yields a plan', () => {
  const raw = 'Sure!\n```json\n{"tasks":[{"title":"A","role":"research","prompt":"p"}]}\n```';
  const out = parsePlanTasks(raw, 'the goal');
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'research');
  assert.deepEqual([out[0].done, out[0].working, out[0].output], [false, false, '']);
});

test('an unreadable answer becomes ONE task carrying the goal, not an error', () => {
  const out = parsePlanTasks('the model refused', 'Migrate Atlas');
  assert.equal(out.length, 1);
  assert.equal(out[0].prompt, 'Migrate Atlas');
  assert.equal(out[0].role, 'write');
  assert.deepEqual(parsePlanTasks('nonsense', '   '), [], 'with no goal either, there is nothing to plan');
});

test('an invented role is coerced, and the list is capped', () => {
  const many = JSON.stringify({ tasks: Array.from({ length: 20 }, (_, i) => ({ title: `T${i}`, role: 'interpretive-dance' })) });
  const out = parsePlanTasks(many, 'g');
  assert.equal(out.length, 6);
  assert.ok(out.every((t) => t.role === 'write'));
});

test('the prompts say what the answer must NOT contain, because it lands in the note', () => {
  assert.match(PLAN_DECOMPOSE_SYSTEM, /Return ONLY compact JSON/);
  assert.match(planSectionSystem('G', { title: 'T', prompt: 'p' }), /Output ONLY the section's markdown content/);
  assert.match(planSectionSystem('G', { title: 'T', prompt: 'p' }), /no heading, no preamble/);
});

test('a title is one line of plain text, whatever the goal looked like', () => {
  assert.equal(planTitleFor('# **Migrate**  the\n`Atlas` cluster'), 'Migrate the Atlas cluster');
  assert.equal(planTitleFor('x'.repeat(100)).length, 60);
});
