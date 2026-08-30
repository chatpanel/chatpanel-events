import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SKILL_VARS, SKILL_VAR_NAMES, lintSkillPrompt, parseSkillVars,
  skillVarGuidance, skillVarPattern, substituteSkillVars, suggestSkillVar, SkillVarError,
} from '../skill-vars.js';

test('an invented placeholder is reported, not silently shipped', async () => {
  // The bug this module exists for: prompt-assist was told to preserve any
  // {{placeholders}} without being told which exist, so it wrote {{content}}. The
  // panel had no idea, and the model received the literal characters.
  const prompt = 'Rewrite this.\n\nContent:\n{{content}}';
  const lint = lintSkillPrompt(prompt);
  assert.deepEqual(lint.known, []);
  assert.equal(lint.unknown.length, 1);
  assert.equal(lint.unknown[0].name, 'content');
  assert.equal(lint.unknown[0].suggestion, 'input', 'a content-shaped slot should point at {{input}}');
  assert.equal(lint.hasInput, false);
});

test('an unknown placeholder is left in the text, never rewritten', async () => {
  // Substituting something we did not recognise would be a silent edit of the user's
  // own prompt. Report it; let the caller say so.
  const out = await substituteSkillVars('a {{content}} b', { args: 'X' });
  assert.equal(out.text, 'a {{content}} b');
  assert.deepEqual(out.unknown.map((u) => u.name), ['content']);
});

test('{{input}} takes the args, with or without a label', async () => {
  const out = await substituteSkillVars('Fix: {{input}} / {{input:the draft}}', { args: 'hello' });
  assert.equal(out.text, 'Fix: hello / hello');
  assert.deepEqual(out.filled, ['input']);
});

test('a resolver runs only when its variable appears', async () => {
  // {{selection}} costs a tab read. A prompt that does not use it must not pay.
  let selectionCalls = 0;
  let titleCalls = 0;
  const resolvers = {
    selection: () => { selectionCalls += 1; return 'picked text'; },
    title: () => { titleCalls += 1; return 'Page'; },
  };
  await substituteSkillVars('Summarize {{selection}}', { resolvers });
  assert.equal(selectionCalls, 1);
  assert.equal(titleCalls, 0, 'an absent variable must not be resolved');
});

test('a throwing or missing resolver is an empty slot, not a failed turn', async () => {
  const out = await substituteSkillVars('{{selection}} on {{url}}', {
    resolvers: { selection: () => { throw new Error('tab closed'); } },
  });
  assert.equal(out.text, ' on ');
  assert.deepEqual(out.empty.sort(), ['selection', 'url'], 'both should be reported as unfilled');
  assert.deepEqual(out.filled, []);
});

test('an empty slot is distinguishable from a filled one', async () => {
  // The panel tells the user "nothing is selected" off exactly this.
  const out = await substituteSkillVars('{{selection}}|{{input}}', {
    args: 'typed',
    resolvers: { selection: () => '   ' },
  });
  assert.deepEqual(out.filled, ['input']);
  assert.deepEqual(out.empty, ['selection']);
});

test('a replacement containing $& is inserted literally', async () => {
  // String.replace treats $-patterns in the REPLACEMENT specially. Page titles and
  // pasted text contain $ all the time; a function replacement is the only safe form.
  const out = await substituteSkillVars('T: {{title}} / {{input}}', {
    args: 'cost is $5 $& $1',
    resolvers: { title: () => 'A $& B' },
  });
  assert.equal(out.text, 'T: A $& B / cost is $5 $& $1');
});

test('parse keeps source order and flags each token', () => {
  const toks = parseSkillVars('{{url}} then {{nope}} then {{input:label}}');
  assert.deepEqual(toks.map((t) => [t.name, t.known]), [['url', true], ['nope', false], ['input', true]]);
  assert.equal(toks[2].label, 'label');
  assert.ok(toks[0].index < toks[1].index && toks[1].index < toks[2].index);
});

test('matching is case- and space-insensitive', async () => {
  const out = await substituteSkillVars('{{ INPUT }} {{Url}}', {
    args: 'x',
    resolvers: { url: () => 'https://e.example' },
  });
  assert.equal(out.text, 'x https://e.example');
});

test('a prompt with no placeholders is returned untouched and costs nothing', async () => {
  const resolvers = { selection: () => assert.fail('must not resolve') };
  const out = await substituteSkillVars('plain prompt', { resolvers });
  assert.equal(out.text, 'plain prompt');
  assert.deepEqual(out.filled, []);
});

test('hasInput is what decides append-vs-interpolate', () => {
  assert.equal(lintSkillPrompt('Fix {{input}}').hasInput, true);
  assert.equal(lintSkillPrompt('Fix the page {{url}}').hasInput, false);
});

test('suggestions are offered only when they are actually close', () => {
  assert.equal(suggestSkillVar('inptu'), 'input');
  assert.equal(suggestSkillVar('titel'), 'title');
  assert.equal(suggestSkillVar('body'), 'input', 'content-shaped names point at the input slot');
  assert.equal(suggestSkillVar('kubernetes'), '', 'a bad suggestion is worse than none');
  assert.equal(suggestSkillVar('input'), '', 'a known name needs no suggestion');
});

test('the assist guidance is generated from the declared set', () => {
  // If it were a hand-written string, adding a variable here would leave the model
  // still inventing — which is how {{content}} happened.
  const text = skillVarGuidance();
  for (const name of SKILL_VAR_NAMES) assert.match(text, new RegExp(`\\{\\{${name}\\}\\}`));
  assert.match(text, /never invent another/i);
});

test('the declared set is frozen and self-consistent', () => {
  assert.throws(() => { SKILL_VARS.push({ name: 'x' }); });
  assert.throws(() => skillVarPattern('content'), SkillVarError);
  for (const v of SKILL_VARS) {
    assert.ok(v.summary, `${v.name} needs a summary — it is user-facing in the editor and the assist prompt`);
    assert.ok(['args', 'resolver'].includes(v.source));
  }
  assert.equal(new Set(SKILL_VAR_NAMES).size, SKILL_VAR_NAMES.length, 'names must be unique');
});
