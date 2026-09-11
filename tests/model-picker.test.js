import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupModels, filterSections, defaultModelId, modelSummary,
} from '../model-picker.js';

const agent = (id, available = true) => ({
  id, provider: 'bridge', providerType: 'agent', viaBridge: true, available,
  reason: available ? '' : `${id} is a local CLI agent that is not installed`,
});
const model = (id, provider, available = true) => ({
  id, provider, providerType: 'openai', viaBridge: false, available,
});

const keys = (sections) => sections.map((s) => s.key);
const ids = (section) => section.items.map((m) => m.id);

test('agents lead, then providers alphabetically — a CLI is not a model', () => {
  const sections = groupModels([
    model('gpt-4o', 'openai'),
    agent('codex'),
    model('qwen2.5:7b', 'ollama'),
    model('claude-sonnet-5', 'anthropic'),
    agent('claude-code'),
  ]);
  assert.deepEqual(keys(sections), [
    'agents', 'provider:anthropic', 'provider:ollama', 'provider:openai',
  ]);
  assert.deepEqual(ids(sections[0]), ['claude-code', 'codex']);
  assert.equal(sections[1].label, 'Anthropic');
});

test('an unavailable model is kept and sorted last, never dropped', () => {
  // Dropping it answers "where did Claude Code go?" with nothing, and not being installed is
  // the most common reason a first message fails.
  const sections = groupModels([agent('claude-code', false), agent('codex', true)]);
  assert.deepEqual(ids(sections[0]), ['codex', 'claude-code']);
  assert.equal(sections[0].items[1].available, false);
  assert.match(sections[0].items[1].reason, /not installed/);
});

test('a provider is never read out of a model name', () => {
  // A GPT-named model served from someone's own Ollama is local, and that was the point.
  const sections = groupModels([model('gpt-oss:20b', 'ollama')]);
  assert.deepEqual(keys(sections), ['provider:ollama']);
});

test('an empty section is never emitted', () => {
  assert.deepEqual(groupModels([]), []);
  assert.deepEqual(keys(groupModels([model('gpt-4o', 'openai')])), ['provider:openai']);
});

test('the selected model is marked in place, whichever section it landed in', () => {
  const sections = groupModels([agent('codex'), model('gpt-4o', 'openai')], { selectedId: 'gpt-4o' });
  assert.equal(sections[0].items[0].selected, false);
  assert.equal(sections[1].items[0].selected, true);
});

test('searching a provider name keeps all of its models', () => {
  // Local model ids rarely contain the provider name, so matching ids alone would show none.
  const sections = groupModels([model('qwen2.5:7b', 'ollama'), model('gpt-4o', 'openai')]);
  const hit = filterSections(sections, 'ollama');
  assert.deepEqual(keys(hit), ['provider:ollama']);
  assert.deepEqual(ids(hit[0]), ['qwen2.5:7b']);
});

test('searching drops sections that match nothing, leaving no floating heading', () => {
  const sections = groupModels([agent('codex'), model('gpt-4o', 'openai')]);
  assert.deepEqual(keys(filterSections(sections, 'gpt')), ['provider:openai']);
  assert.deepEqual(filterSections(sections, 'nothing-matches-this'), []);
  assert.equal(filterSections(sections, '  '), sections);
});

test('the default is a reachable agent, and never something known to be unavailable', () => {
  assert.equal(defaultModelId([model('gpt-4o', 'openai'), agent('codex')]), 'codex');
  // An uninstalled CLI must not be the default just for being an agent.
  assert.equal(defaultModelId([agent('claude-code', false), model('gpt-4o', 'openai')]), 'gpt-4o');
  assert.equal(defaultModelId([]), '');
});

test('an id that names nothing is "not known yet" before the list loads, broken after', () => {
  // A red dot on a picker nobody has populated is the "0 redactions" mistake in miniature.
  assert.equal(modelSummary([], 'codex').available, null);
  assert.equal(modelSummary([model('gpt-4o', 'openai')], 'codex').available, false);
  assert.equal(modelSummary([agent('codex')], 'codex').available, true);
});

test('a provider heading is spelled the way the company spells it', () => {
  // "Openai" in the most-read text in the picker reads as carelessness about everything else.
  const sections = groupModels([
    model('gpt-4o', 'openai'), model('r1', 'deepseek'), model('grok', 'xai'),
    model('local', 'ollama'), model('x', 'my-own-host'),
  ]);
  assert.deepEqual(sections.map((s) => s.label), [
    'DeepSeek', 'My-own-host', 'Ollama', 'OpenAI', 'xAI',
  ]);
});

test('the summary says which provider, so the button can be read without opening it', () => {
  const s = modelSummary([model('claude-sonnet-5', 'anthropic')], 'claude-sonnet-5');
  assert.equal(s.provider, 'Anthropic');
  assert.equal(s.agent, false);
  assert.equal(modelSummary([agent('codex')], 'codex').agent, true);
});
