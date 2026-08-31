// Widgets are written by a model on a user's whim, so every test here asks the same thing:
// can this widget reach something the user did not give it?
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidget, validateWidgetMessage, effectiveGrants } from '../widget.js';

const w = (over = {}) => ({ id: 'pomodoro', name: 'Pomodoro Timer', html: '<div>25:00</div>', ...over });

test('a manifest is checked before the user is asked to keep it', () => {
  assert.ok(validateWidget(w()));
  assert.throws(() => validateWidget({ ...w(), id: 'Has Spaces' }), /lowercase/);
  assert.throws(() => validateWidget({ ...w(), html: undefined }), /html required/);
  assert.throws(() => validateWidget({ ...w(), html: 'x'.repeat(600 * 1024) }), /exceeds/);
  assert.throws(() => validateWidget({ ...w(), surface: 'desktop' }), /surface/);
});

test('a widget reads and writes only its OWN state, keyed by the host', () => {
  // The id comes from the HOST, which knows which frame spoke. A widget naming someone
  // else's id therefore changes nothing — this is what stops one widget reading another.
  const got = validateWidgetMessage({ op: 'state.get', callId: 'c1', widgetId: 'someone-else' }, { widgetId: 'pomodoro' });
  assert.equal(got.widgetId, 'pomodoro', "the message cannot choose whose state it reads");

  const set = validateWidgetMessage({ op: 'state.set', callId: 'c2', state: { left: 900 } }, { widgetId: 'pomodoro' });
  assert.deepEqual(set.state, { left: 900 });
  assert.throws(() => validateWidgetMessage({ op: 'state.set', callId: 'c', state: { big: 'x'.repeat(300 * 1024) } }, { widgetId: 'p' }), /exceeds/);
  assert.throws(() => validateWidgetMessage({ op: 'nope', callId: 'c' }, { widgetId: 'p' }), /unknown widget op/);
  assert.throws(() => validateWidgetMessage({ op: 'state.get' }, { widgetId: 'p' }), /callId/);
});

test('a capability call needs a GRANT, not a request', () => {
  const msg = { op: 'invoke', callId: 'c3', capability: 'history_search', args: { q: 'x' } };
  // Asked for but not approved → refused.
  assert.throws(() => validateWidgetMessage(msg, { widgetId: 'p', grants: [] }), /no grant/);
  // Approved → allowed.
  const ok = validateWidgetMessage(msg, { widgetId: 'p', grants: ['history_search'] });
  assert.equal(ok.capability, 'history_search');
});

test('a widget cannot widen its own permissions by rewriting itself', () => {
  // The user approved one capability. A later version of the widget asks for two.
  const approved = ['clock'];
  assert.deepEqual(effectiveGrants(w({ requests: ['clock', 'history_search'] }), approved), ['clock'],
    'the un-approved request stays un-granted');
  // And a widget that asks for nothing holds nothing, whatever was approved before.
  assert.deepEqual(effectiveGrants(w(), approved), []);
});
