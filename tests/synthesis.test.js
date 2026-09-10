import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SYNTHESIS_SCHEMA, synthesisPrompt, claimsFromSynthesis, MAX_EXCERPTS } from '../synthesis.js';
import { propose, accept, reject, diffProposal, converge } from '../promotion.js';
import { coerce } from '../structured.js';

const known = new Set(['meeting:m1', 'meeting:m2', 'note:n1']);

test('the prompt shows the ids the model may cite, and nothing it may not', () => {
  const p = synthesisPrompt({
    subject: { name: 'Atlas', kind: 'topic', aliases: ['atlas migration'] },
    existing: ['Appears in 12 records — 12 meetings.'],
    excerpts: [{ id: 'meeting:m1', title: 'Kickoff', date: '2026-08-01', text: 'we decided to move cutover to Q4' }],
  });
  assert.match(p, /Subject: Atlas \(topic\) — also written as atlas migration/);
  assert.match(p, /\[meeting:m1\] Kickoff \(2026-08-01\)/);
  assert.match(p, /Cite ONLY these ids/);
  assert.match(p, /do not repeat these/);
  // describeSchema renders the shape and the field notes, not the schema's name.
  assert.match(p, /Return ONLY a JSON object/, 'the schema block is in the prompt — the shape cannot drift from its description');
  assert.match(p, /"claims": \[\{"text": string, "refs": \[string/, 'and it is THIS schema');
});

test('the prompt is bounded — a subject with two hundred records gets a couple of dozen', () => {
  const excerpts = Array.from({ length: 200 }, (_, i) => ({ id: `meeting:m${i}`, text: 'x'.repeat(5000) }));
  const p = synthesisPrompt({ subject: { name: 'A' }, excerpts });
  assert.equal((p.match(/^\[meeting:m\d+\]/gm) || []).length, MAX_EXCERPTS);
  assert.ok(p.length < MAX_EXCERPTS * 1400, 'each excerpt is capped too');
});

test('a claim citing nothing, or a record it was not shown, is refused — not downgraded', () => {
  const { claims, refused } = claimsFromSynthesis({
    claims: [
      { text: 'Cutover moved to Q4.', refs: ['meeting:m1'], when: '2026-08-01' },
      { text: 'Jordan owns rollback.', refs: [] },
      { text: 'Budget was approved.', refs: ['meeting:m1', 'meeting:m99'] },
      { text: '', refs: ['note:n1'] },
    ],
    summary: 'Atlas is moving.',
  }, { knownIds: known, now: 5, hashOf: (id) => `h-${id}` });
  assert.equal(claims.length, 1);
  assert.equal(claims[0].text, 'Cutover moved to Q4.');
  assert.deepEqual(claims[0].refs, [{ kind: 'meeting', id: 'm1', hash: 'h-meeting:m1' }]);
  assert.equal(claims[0].when, '2026-08-01');
  assert.equal(claims[0].cls, 'C');
  assert.equal(claims[0].state, 'proposed', 'a synthesised claim is born proposed, never promoted');
  assert.ok(claims[0].confidence < 1, 'a model\'s read ranks below any record\'s word');
  assert.deepEqual(refused.map((r) => r.why), ['no citation', 'cites a record it was not shown: meeting:m99', 'empty']);
});

test('"nothing new" is an answer, not a failure', () => {
  const value = coerce('none', SYNTHESIS_SCHEMA).value;
  assert.deepEqual(value, { claims: [], summary: '' });
  const { claims, refused } = claimsFromSynthesis(value, { knownIds: known });
  assert.deepEqual(claims, []); assert.deepEqual(refused, []);
});

test('the schema reads a real model answer, fences and all', () => {
  const text = '```json\n{"claims":[{"text":"Cutover moved to Q4.","refs":["meeting:m1"]}],"summary":"Moving."}\n```';
  const v = coerce(text, SYNTHESIS_SCHEMA).value;
  assert.equal(v.claims[0].refs[0], 'meeting:m1');
});

// ── the gate ─────────────────────────────────────────────────────────────────
const brief = { id: 'brief:x', claims: [{ id: 'c1', kind: 'presence', text: 'Appears in 3 records.', refs: [{ kind: 'meeting', id: 'm1', hash: 'h' }], cls: 'R' }], updatedAt: 1 };
const cClaim = (text) => claimsFromSynthesis({ claims: [{ text, refs: ['meeting:m1'] }] }, { knownIds: known, now: 2 }).claims[0];

test('a proposal never carries promoted, and only accept() produces it', () => {
  const p = propose({ briefId: 'brief:x', claims: [cClaim('Cutover moved to Q4.')], by: 'model', now: 2 });
  assert.equal(p.state, 'proposed');
  assert.ok(p.claims.every((c) => c.state === 'proposed'));
  // Class-R claims and uncited claims cannot even be proposed.
  assert.throws(() => propose({ briefId: 'brief:x', claims: [brief.claims[0]] }), /class-C/);
  assert.throws(() => propose({ briefId: 'brief:x', claims: [{ ...cClaim('x'), refs: [] }] }), /refs/);

  const { brief: next, proposal } = accept(brief, p, { now: 3 });
  assert.equal(proposal.state, 'accepted');
  assert.equal(next.claims.length, 2);
  assert.equal(next.claims[1].state, 'promoted');
  assert.equal(next.claims[1].cls, 'C');
  assert.equal(brief.claims.length, 1, 'the input brief is not mutated — a projection is rebuilt, not edited');
  assert.throws(() => accept(brief, proposal), /is accepted/, 'a settled proposal cannot be accepted twice');
  assert.throws(() => accept({ ...brief, id: 'brief:other' }, p), /does not belong/);
});

test('reject settles a proposal with a reason and leaves the brief alone', () => {
  const p = propose({ briefId: 'brief:x', claims: [cClaim('Wrong thing.')], now: 2 });
  const r = reject(p, { now: 3, why: 'that was the old plan' });
  assert.equal(r.state, 'rejected'); assert.equal(r.why, 'that was the old plan');
  assert.throws(() => reject(r), /not a pending/);
});

test('the reviewer sees what a new claim replaces, as a suggestion', () => {
  const b = { ...brief, claims: [...brief.claims, { ...cClaim('Cutover is planned for Q3 after the load test.'), state: 'promoted' }] };
  const p = propose({ briefId: 'brief:x', claims: [cClaim('Cutover moved to Q4 after the load test.'), cClaim('Sam owns the runbook.')], now: 4 });
  const d = diffProposal(b, p);
  assert.match(d[0].replaces, /planned for Q3/);
  assert.equal(d[1].replaces, null);
});

test('convergence: drafters that agree propose, drafters that disagree go to the human', () => {
  const a = { claims: [cClaim('Cutover moved to Q4 after the load test.'), cClaim('Jordan owns the rollback plan.')] };
  const b = { claims: [cClaim('The cutover moved to Q4 following the load test.'), cClaim('Budget was cut in half.')] };
  const { agreed, disputed } = converge([a, b]);
  assert.equal(agreed.length, 1);
  assert.match(agreed[0].text, /Cutover moved to Q4/);
  assert.equal(agreed[0].agreedBy, 2);
  assert.deepEqual(disputed.map((c) => c.text).sort(), ['Budget was cut in half.', 'Jordan owns the rollback plan.']);
  // One draft alone can never converge with itself.
  assert.equal(converge([a]).agreed.length, 0);
  assert.equal(converge([]).disputed.length, 0);
});
