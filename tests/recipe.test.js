import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRecipe, expandRecipe, recipeParams, mapInput, dryRunRecipe, runPlan, runRecipe, RecipeError } from '../recipe.js';

const openBug = {
  name: 'open_bug', mode: 'call', tool: 'mcp_github__create_issue',
  arguments: { title: { $param: 'title' }, body: { $param: 'body', default: '' }, labels: ['bug'] },
};
const triage = {
  name: 'triage_pair', mode: 'parallel',
  calls: [
    { tool: 'mcp_github__get_issue', arguments: { number: { $param: 'first' } } },
    { tool: 'mcp_github__get_issue', arguments: { number: { $param: 'second' } } },
  ],
};
const label = {
  name: 'label_bugs', mode: 'batch', tool: 'mcp_github__update_issue',
  items: [{ arguments: { number: { $param: 'a' }, labels: ['bug'] } }, { arguments: { number: { $param: 'b' }, labels: ['bug'] } }],
};
const searchRead = {
  name: 'search_then_read', mode: 'pipeline',
  steps: [
    { tool: 'mcp_github__search_issues', arguments: { query: { $param: 'query' } } },
    { tool: 'mcp_github__get_issue', arguments: {}, inputMapping: { number: '$json.items.0.number' }, onMappingMissing: 'fail' },
    { tool: 'note_write', arguments: { title: 'Triage' }, inputMapping: { body: '$text' } },
  ],
};
const specs = [
  { name: 'mcp_github__create_issue', parameters: { type: 'object', required: ['title'] } },
  { name: 'mcp_github__get_issue', parameters: { type: 'object', required: ['number'] }, annotations: { readOnlyHint: true } },
  { name: 'mcp_github__search_issues', parameters: { type: 'object', required: ['query'] } },
  { name: 'mcp_github__update_issue', parameters: { type: 'object', required: ['number'] } },
  { name: 'mcp_github__delete_issue', parameters: { type: 'object', required: ['number'] } },
  { name: 'note_write', parameters: { type: 'object', required: ['title', 'body'] } },
];

test('validation names what an author got wrong', () => {
  assert.equal(validateRecipe(openBug).ok, true);
  const bad = validateRecipe({ name: 'x y', mode: 'pipeline', steps: [{ tool: 'a', inputMapping: { k: '$json.x' } }, { inputMapping: { k: 'json.x' } }] });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /^name:/.test(e)));
  assert.ok(bad.errors.some((e) => /steps\[0\]\.inputMapping: the first step/.test(e)));
  assert.ok(bad.errors.some((e) => /steps\[1\]\.tool: required/.test(e)));
  assert.ok(bad.errors.some((e) => /steps\[1\]\.inputMapping: values must be/.test(e)));
  assert.equal(validateRecipe(null).ok, false);
});

test('parameters are discovered, substituted, defaulted, and reported when missing', () => {
  assert.deepEqual(recipeParams(openBug), [{ name: 'title', required: true, default: undefined }, { name: 'body', required: false, default: '' }]);
  const ok = expandRecipe(openBug, { title: 'Crash on start' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.plan.calls, [{ tool: 'mcp_github__create_issue', arguments: { title: 'Crash on start', body: '', labels: ['bug'] } }]);
  const missing = expandRecipe(openBug, {});
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ['title']);
  assert.equal(missing.plan.calls[0].arguments.title, undefined, 'a missing parameter is absent, never the placeholder object');
  assert.equal(expandRecipe(label, { a: 1, b: 2 }).plan.calls.length, 2);
  assert.equal(expandRecipe({ mode: 'nope' }, {}).plan, null);
});

test('inputMapping reads text, json and paths; misses are named', () => {
  const prev = JSON.stringify({ items: [{ number: 42, title: 't' }], total: 1 });
  const m = mapInput(prev, { number: '$json.items.0.number', all: '$json', raw: '$text', gone: '$json.items.9.number', weird: '$nope' }, { keep: true });
  assert.equal(m.arguments.number, 42);
  assert.equal(m.arguments.all.total, 1);
  assert.equal(m.arguments.raw, prev);
  assert.equal(m.arguments.keep, true);
  assert.deepEqual(m.skipped.map((s) => s.arg), ['gone', 'weird']);
  assert.match(m.skipped[0].reason, /not found/);
  const notJson = mapInput('plain text', { n: '$json.x' });
  assert.equal(notJson.skipped[0].reason, 'previous result is not JSON');
  const obj = mapInput({ text: '{"a":1}' }, { a: '$json.a' });
  assert.equal(obj.arguments.a, 1, 'a { text } result is read through its text');
});

test('dry run names unknown tools, missing required fields and destructive calls — and executes nothing', () => {
  const d = dryRunRecipe(searchRead, { query: 'is:open' }, { specs });
  assert.equal(d.ok, true, JSON.stringify(d.warnings));
  assert.deepEqual(d.calls[1].mappedLater, ['number']);
  assert.deepEqual(d.calls[1].missingRequired, [], 'a field the pipeline maps later is not missing');
  assert.equal(d.calls[1].traits.readOnly, true, 'traits come from the spec\'s annotations');
  const bad = dryRunRecipe({ name: 'nuke', mode: 'parallel', calls: [{ tool: 'mcp_github__delete_issue', arguments: {} }, { tool: 'nonexistent', arguments: {} }] }, {}, { specs });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.warnings.map((w) => w.code).sort(), ['destructive', 'missing_required', 'unknown_tool']);
  assert.deepEqual(bad.destructive, [0]);
  const noSpecs = dryRunRecipe(openBug, { title: 'x' });
  assert.equal(noSpecs.calls[0].known, null, 'without specs, existence is unknown rather than asserted');
  assert.equal(dryRunRecipe(openBug, {}).ok, false, 'a missing parameter blocks');
});

test('a call recipe runs through the host executor with the recipe named in meta', async () => {
  const seen = [];
  const r = await runRecipe(openBug, { title: 'T' }, { execute: async (tool, args, meta) => { seen.push({ tool, args, meta }); return 'ok'; } });
  assert.equal(r.status, 'completed');
  assert.deepEqual(seen[0].args, { title: 'T', body: '', labels: ['bug'] });
  assert.equal(seen[0].meta.recipe, 'open_bug');
  await assert.rejects(runRecipe(openBug, {}, { execute: async () => 'x' }), (e) => e instanceof RecipeError && e.code === 'MISSING_PARAMS');
});

test('parallel and batch keep every sibling result and name the failures', async () => {
  const r = await runRecipe(triage, { first: 1, second: 2 }, {
    execute: async (tool, args) => (args.number === 2 ? { error: 'not found' } : { number: args.number }),
  });
  assert.equal(r.status, 'partial');
  assert.deepEqual(r.failedIndexes, [1]);
  assert.deepEqual(r.results[0], { number: 1 });
  const b = await runRecipe(label, { a: 1, b: 2 }, { execute: async () => 'done' });
  assert.equal(b.status, 'completed');
  assert.equal(b.results.length, 2);
});

test('a pipeline maps step to step, stops at a failure, and keeps what came before', async () => {
  const log = [];
  const execute = async (tool, args) => {
    log.push([tool, args]);
    if (tool === 'mcp_github__search_issues') return JSON.stringify({ items: [{ number: 7 }] });
    if (tool === 'mcp_github__get_issue') return JSON.stringify({ number: args.number, title: 'Seven' });
    return 'written';
  };
  const ok = await runRecipe(searchRead, { query: 'q' }, { execute });
  assert.equal(ok.status, 'completed');
  assert.equal(ok.finalResult, 'written');
  assert.deepEqual(ok.steps[1].mappedArguments, { number: 7 });
  assert.match(log[2][1].body, /Seven/, 'step 3 received step 2\'s text');
  assert.equal(log[2][1].title, 'Triage', 'base arguments survive mapping');

  // The search finds nothing: step 2's mapping cannot resolve and it is marked `fail`, so
  // nothing after the search runs — and the search result is still returned.
  const empty = await runRecipe(searchRead, { query: 'q' }, { execute: async () => JSON.stringify({ items: [] }) });
  assert.equal(empty.status, 'failed');
  assert.equal(empty.failedStep, 1);
  assert.equal(empty.reason, 'mapping_missing');
  assert.equal(empty.steps.length, 2);
  assert.equal(empty.steps[0].status, 'ok');
  assert.equal(empty.steps[1].status, 'skipped');
  assert.equal(empty.steps[1].skippedMappings[0].arg, 'number');

  // A tool error mid-pipeline stops it with the error in place.
  const broken = await runRecipe(searchRead, { query: 'q' }, {
    execute: async (tool) => (tool === 'mcp_github__get_issue' ? 'error: 500' : JSON.stringify({ items: [{ number: 1 }] })),
  });
  assert.equal(broken.status, 'failed');
  assert.equal(broken.failedStep, 1);
  assert.equal(broken.reason, 'tool_error');
});

test('a pipeline with onMappingMissing "continue" still runs the step', async () => {
  const plan = expandRecipe({ name: 'p', mode: 'pipeline', steps: [{ tool: 'a', arguments: {} }, { tool: 'b', arguments: { x: 1 }, inputMapping: { y: '$json.nope' } }] }, {}).plan;
  const r = await runPlan(plan, { execute: async (tool, args) => JSON.stringify({ tool, args }) });
  assert.equal(r.status, 'completed');
  assert.deepEqual(r.steps[1].skippedMappings.map((s) => s.arg), ['y']);
  assert.deepEqual(JSON.parse(r.steps[1].result).args, { x: 1 });
});
