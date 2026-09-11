// Who does which job: cheap for the work that runs constantly, strong for the work that does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyModel, supportsSubagents, appoint, routeTeam, SWARM_ROLES, roleById,
} from '../cowriter-router.js';

const c = (id, model, over = {}) => ({ id, name: id, kind: 'api', model, ...over });

test('a model is classified by what its NAME says it is, provider-agnostically', () => {
  for (const m of ['claude-haiku-4-5', 'gpt-4o-mini', 'gemini-flash', 'qwen2.5:7b']) {
    assert.equal(classifyModel(m), 'cheap', m);
  }
  for (const m of ['claude-opus-5', 'llama-405b', 'gpt-5']) assert.equal(classifyModel(m), 'strong', m);
  assert.equal(classifyModel('claude-sonnet-5'), 'balanced');
});

test('an unknown model is mid, never "cheapest" — a guess must not become the constant worker', () => {
  assert.equal(classifyModel('some-new-model-nobody-has-heard-of'), 'balanced');
  assert.equal(classifyModel(''), 'balanced');
});

test('the Editor gets the cheap model and the Writer the strong one — that is the whole point', () => {
  const cands = [c('a', 'claude-haiku-4-5'), c('b', 'claude-sonnet-5'), c('c', 'claude-opus-5')];
  const team = routeTeam(SWARM_ROLES, cands);
  assert.equal(team.editor.id, 'a');
  assert.equal(team.researcher.id, 'b');
  assert.equal(team.writer.id, 'c');
});

test('an explicit override wins over the preference — it is the user saying so', () => {
  const cands = [c('a', 'claude-haiku-4-5'), c('c', 'claude-opus-5')];
  assert.equal(appoint(SWARM_ROLES[0], cands, { overrides: { editor: 'c' } }).id, 'c');
  // An override naming something that is gone falls back rather than appointing nobody.
  assert.equal(appoint(SWARM_ROLES[0], cands, { overrides: { editor: 'ghost' } }).id, 'a');
});

test('an unusable candidate is never appointed, and no usable one means no appointment', () => {
  const cands = [c('a', 'claude-haiku-4-5', { usable: false }), c('b', 'claude-sonnet-5')];
  assert.equal(appoint(SWARM_ROLES[0], cands).id, 'b');
  assert.equal(appoint(SWARM_ROLES[0], [c('x', '', {})]), null, 'a candidate with no model is not one');
  assert.equal(appoint(SWARM_ROLES[0], []), null);
  assert.equal(appoint(SWARM_ROLES[0], null), null);
});

test('a CLI that runs its own subagents is appointed in subagent mode, an HTTP model is not', () => {
  const cli = { id: 'claude', name: 'Claude Code', kind: 'bridge', bridgeAgent: 'claude', model: 'claude' };
  assert.equal(supportsSubagents(cli), true);
  assert.equal(supportsSubagents(c('a', 'gpt-4o')), false);
  assert.equal(appoint(SWARM_ROLES[2], [cli]).mode, 'subagent');
  assert.equal(appoint(SWARM_ROLES[2], [c('a', 'gpt-4o')]).mode, 'api');
  // An explicit `subagents` flag is believed over the inference.
  assert.equal(appoint(SWARM_ROLES[2], [{ ...cli, subagents: false }]).mode, 'api');
});

test('every role states a preference, and a dropped role resolves to nothing', () => {
  for (const r of SWARM_ROLES) {
    assert.ok(['cheap', 'balanced', 'strong'].includes(r.prefer), r.id);
    assert.ok(r.name && r.desc && r.icon);
  }
  assert.equal(roleById('editor').name, 'Editor');
  assert.equal(roleById('nope'), null);
});

test('ties break by name, so the same roster always appoints the same team', () => {
  const cands = [c('zeta', 'claude-sonnet-5'), c('alpha', 'claude-sonnet-5')];
  assert.equal(appoint(SWARM_ROLES[1], cands).id, 'alpha');
  assert.equal(appoint(SWARM_ROLES[1], [...cands].reverse()).id, 'alpha');
});
