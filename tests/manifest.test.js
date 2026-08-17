import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createManifest, ManifestError } from '../manifest.js';

const seed = (m) => {
  m.register({ id: 'security', kind: 'kernel', label: 'Security' });
  m.register({ id: 'google-sheets', kind: 'adapter', label: 'Google Sheets' });
  m.register({ id: 'mcp', kind: 'tool-group', label: 'MCP servers' });
  return m;
};

test('an unknown id is ENABLED, not disabled', () => {
  // A registry may consult the manifest before anything has registered. Defaulting to off
  // would make a plugin vanish because of a load-order accident — a bug that looks like the
  // feature is broken rather than like a setting.
  assert.equal(createManifest().isEnabled('never-seen'), true);
});

test('the user turning something off is respected', () => {
  const m = seed(createManifest());
  m.setEnabled('mcp', false);
  assert.equal(m.isEnabled('mcp'), false);
  assert.deepEqual(m.disabledIds(), ['mcp']);
});

test('a required plugin refuses rather than reporting success', () => {
  // A mandatory plugin the user can switch off is not mandatory, it is a default.
  const m = seed(createManifest());
  assert.throws(() => m.setEnabled('security', false), (e) => e instanceof ManifestError && e.code === 'REQUIRED');
  assert.equal(m.isEnabled('security'), true);
});

test('a required plugin stays on even if the stored state says otherwise', () => {
  // Storage can be edited, synced or corrupted; the guarantee cannot depend on it being
  // well-formed.
  const m = createManifest({ disabled: ['security', 'mcp'] });
  assert.equal(m.isEnabled('security'), true);
  assert.equal(m.isEnabled('mcp'), false);
});

test('only the OFF ids persist, so later releases enable new plugins by default', () => {
  // Storing the full state would leave a plugin added in a later release in an unknown
  // state and needing a migration. Absence meaning "not disabled" removes that class of
  // problem entirely.
  const m = seed(createManifest({ disabled: ['mcp'] }));
  assert.deepEqual(m.disabledIds(), ['mcp']);
  assert.equal(m.isEnabled('google-sheets'), true, 'a plugin never seen before is off');
});

test('a change is reported once, and only when it is a change', () => {
  const seen = [];
  const m = seed(createManifest({ onChange: (ids) => seen.push(ids) }));
  m.setEnabled('mcp', false);
  m.setEnabled('mcp', false);   // already off
  m.setEnabled('mcp', true);
  assert.deepEqual(seen, [['mcp'], []], 'a no-op write triggered a save');
});

test('filter is the one call a registry makes', () => {
  const m = seed(createManifest({ disabled: ['google-sheets'] }));
  const items = [{ id: 'google-sheets' }, { id: 'excalidraw' }];
  assert.deepEqual(m.filter(items).map((x) => x.id), ['excalidraw']);
});

test('listing says what is installed, what is on, and what cannot be turned off', () => {
  const m = seed(createManifest({ disabled: ['mcp'] }));
  const rows = m.list();
  assert.equal(rows.length, 3);
  assert.equal(rows.find((r) => r.id === 'security').required, true);
  assert.equal(rows.find((r) => r.id === 'mcp').enabled, false);
});

test('registration is idempotent and revertible', () => {
  const m = createManifest();
  m.register({ id: 'x', kind: 'adapter', label: 'X' });
  const remove = m.register({ id: 'x', kind: 'adapter', label: 'X' });
  assert.equal(m.list().length, 1, 'registering twice created two entries');
  remove();
  assert.equal(m.list().length, 0);
});

test('a plugin from outside must declare it', () => {
  // `user` is the source that must never skip a guard, so an unknown value is rejected
  // rather than quietly treated as built-in.
  const m = createManifest();
  assert.throws(() => m.register({ id: 'y', source: 'somewhere' }), (e) => e.code === 'BAD_ENTRY');
  m.register({ id: 'y', source: 'user', kind: 'adapter', label: 'Y' });
  assert.equal(m.list()[0].source, 'user');
});

test('a change made elsewhere is adopted without echoing back', async () => {
  // A manifest is not read once at startup. The user toggles in a settings page and every
  // other context holding one is now wrong — without adopting the change, the toggle
  // appears to do nothing until reload, which reads as the switch being broken.
  const writes = [];
  const m = seed(createManifest({ onChange: (ids) => writes.push(ids) }));
  assert.equal(m.isEnabled('mcp'), true);

  assert.equal(m.sync(['mcp']), true, 'the change was not adopted');
  assert.equal(m.isEnabled('mcp'), false);
  // Echoing it back is how two contexts write over each other forever.
  assert.deepEqual(writes, [], 'adopting a remote change triggered a write');

  // An identical state is not a change, so a storage event cannot cause needless work.
  assert.equal(m.sync(['mcp']), false);

  // Required plugins survive whatever arrives — storage can be edited or synced.
  m.sync(['security', 'mcp']);
  assert.equal(m.isEnabled('security'), true);
});
