import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineRule, createRuleEngine, SUPPRESSED, RuleError } from '../rules.js';

const ev = (type, id = 'e1', payload = {}) => ({ type, id, payload });
const mk = (over = {}) => {
  const emitted = [];
  let t = 0;
  const engine = createRuleEngine({ emit: (type, p) => emitted.push({ type, ...p }), now: () => t, ...over });
  return { engine, emitted, tick: (ms) => { t += ms; }, at: () => t };
};

test('a rule fires on its event and records that it did', async () => {
  const { engine, emitted } = mk();
  const ran = [];
  engine.add(defineRule({ id: 'save-notes', on: 'turn.ended', then: async (e) => { ran.push(e.id); return 'saved'; } }));

  const out = await engine.dispatch(ev('turn.ended'));
  assert.deepEqual(ran, ['e1']);
  assert.equal(out[0].fired, true);
  assert.equal(out[0].result, 'saved');
  // Recorded, because an automation you cannot see is one you cannot trust.
  assert.equal(emitted[0].type, 'automation.fired');
  assert.equal(emitted[0].classUsed, 'R');
});

test('an event a rule does not listen for costs nothing', async () => {
  // Matching on TYPE before running any predicate is what keeps a busy log cheap.
  const { engine } = mk();
  let asked = 0;
  engine.add(defineRule({ id: 'r', on: 'turn.ended', when: () => { asked++; return true; }, then: async () => {} }));
  await engine.dispatch(ev('capability.invoked'));
  assert.equal(asked, 0, 'a condition ran for an event its rule cannot match');
});

test('every reason a rule did NOT fire is distinct and recorded', async () => {
  // "It did nothing" has many causes worth telling apart — a user debugging automation
  // needs to know which.
  const { engine, emitted } = mk({ admit: (r) => r.id !== 'off' });
  engine.add(defineRule({ id: 'off', on: 'x', then: async () => {} }));
  engine.add(defineRule({ id: 'nope', on: 'x', when: () => false, then: async () => {} }));
  engine.add(defineRule({ id: 'boom', on: 'x', when: () => { throw new Error('bad'); }, then: async () => {} }));

  const out = await engine.dispatch(ev('x'));
  assert.deepEqual(out.map((o) => o.reason), [SUPPRESSED.DISABLED, SUPPRESSED.CONDITION, SUPPRESSED.ERROR]);
  assert.deepEqual(emitted.map((e) => e.reason), [SUPPRESSED.DISABLED, SUPPRESSED.CONDITION, SUPPRESSED.ERROR]);
});

test('a condition that throws does not fire the rule', async () => {
  // Firing on an unanswered question is how automation does something nobody asked for.
  const { engine } = mk();
  let fired = false;
  engine.add(defineRule({ id: 'r', on: 'x', when: () => { throw new Error('?'); }, then: async () => { fired = true; } }));
  await engine.dispatch(ev('x'));
  assert.equal(fired, false);
});

test('the same event redelivered does not fire the rule twice', async () => {
  // A log can redeliver; a rule that acts twice on one cause has done something the user
  // did not ask for, and for a non-pure action that is not recoverable.
  const { engine } = mk();
  let count = 0;
  engine.add(defineRule({ id: 'r', on: 'x', then: async () => { count++; } }));
  await engine.dispatch(ev('x', 'same'));
  const second = await engine.dispatch(ev('x', 'same'));
  assert.equal(count, 1);
  assert.equal(second[0].reason, SUPPRESSED.DUPLICATE);
  // A DIFFERENT event is a different cause and does fire.
  await engine.dispatch(ev('x', 'other'));
  assert.equal(count, 2);
});

test('a rate limit holds, then releases', async () => {
  const { engine, tick } = mk();
  let count = 0;
  engine.add(defineRule({ id: 'r', on: 'x', everyMs: 1000, then: async () => { count++; } }));
  await engine.dispatch(ev('x', 'a'));
  await engine.dispatch(ev('x', 'b'));
  assert.equal(count, 1, 'the rate limit did not hold');
  tick(1500);
  await engine.dispatch(ev('x', 'c'));
  assert.equal(count, 2, 'the rate limit never released');
});

test('a rule needing approval does not act without it', async () => {
  let asked = 0;
  const { engine } = mk({ approve: async () => { asked++; return false; } });
  let fired = false;
  engine.add(defineRule({ id: 'send', on: 'x', requiresApproval: true, then: async () => { fired = true; } }));
  const out = await engine.dispatch(ev('x'));
  assert.equal(asked, 1);
  assert.equal(fired, false);
  assert.equal(out[0].reason, SUPPRESSED.NO_PERMISSION);
});

test('with no approver at all, an approval-requiring rule stays silent', async () => {
  // Fail closed: a missing approver means nobody can consent, not that consent is implied.
  const { engine } = mk();
  let fired = false;
  engine.add(defineRule({ id: 'send', on: 'x', requiresApproval: true, then: async () => { fired = true; } }));
  assert.equal((await engine.dispatch(ev('x')))[0].reason, SUPPRESSED.NO_PERMISSION);
  assert.equal(fired, false);
});

test('a rule that throws does not take down the emitter or the other rules', async () => {
  // Automation is a passenger, not a driver.
  const { engine, emitted } = mk();
  engine.add(defineRule({ id: 'bad', on: 'x', then: async () => { throw new Error('kaboom'); } }));
  engine.add(defineRule({ id: 'good', on: 'x', then: async () => 'ok' }));
  const out = await engine.dispatch(ev('x'));
  assert.equal(out[0].fired, false);
  assert.equal(out[0].error, 'kaboom');
  assert.equal(out[1].fired, true, 'one failing rule stopped the others');
  assert.ok(emitted.some((e) => e.type === 'automation.suppressed' && e.reason === SUPPRESSED.ERROR));
});

test('the class a rule uses is declared, not guessed', async () => {
  // "Did this cost anything" cannot be inferred from the outside, and a rule quietly using
  // a cloud model while reported as free is the worst version of that.
  const { engine, emitted } = mk();
  engine.add(defineRule({ id: 'smart', on: 'x', classUsed: 'M', then: async () => {} }));
  await engine.dispatch(ev('x'));
  assert.equal(emitted[0].classUsed, 'M');
});

test('a declaration that cannot work is rejected at declare time', () => {
  assert.throws(() => defineRule({ id: 'x', then: async () => {} }), (e) => e instanceof RuleError);
  assert.throws(() => defineRule({ on: 'x', then: async () => {} }), (e) => e.code === 'BAD_RULE');
  assert.throws(() => defineRule({ id: 'x', on: 'y' }), (e) => e.code === 'BAD_RULE');
  assert.throws(() => defineRule({ id: 'x', on: 'y', when: 'nope', then: async () => {} }), (e) => e.code === 'BAD_RULE');
});

test('registration is revertible', () => {
  const { engine } = mk();
  const remove = engine.add(defineRule({ id: 'r', on: 'x', then: async () => {} }));
  assert.equal(engine.list().length, 1);
  remove();
  assert.equal(engine.list().length, 0);
});
