import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recipeToolProvider, recipeToolSpec, describeRecipeForApproval, RECIPE_TOOL_NAME } from '../recipe-tool.js';
import { buildToolset } from '../toolset.js';
import { mcpDispatchProvider, MCP_TOOL_NAME } from '../mcp-dispatch.js';
import { withDestructiveGate } from '../tool-traits.js';

const ran = [];
const server = {
  remote: true,
  specs: [
    { name: 'mcp_gh__search_issues', description: 'Search issues.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, annotations: { readOnlyHint: true } },
    { name: 'mcp_gh__get_issue', description: 'Get one issue.', parameters: { type: 'object', properties: { number: { type: 'integer' } }, required: ['number'] }, annotations: { readOnlyHint: true } },
    { name: 'mcp_gh__create_issue', description: 'Create an issue.', parameters: { type: 'object', properties: { title: { type: 'string' }, labels: { type: 'array' } }, required: ['title'] } },
    { name: 'mcp_gh__delete_issue', description: 'Delete an issue.', parameters: { type: 'object', properties: { number: { type: 'integer' } }, required: ['number'] } },
  ],
  execute: async (n, a) => { ran.push([n, a]); return n === 'mcp_gh__search_issues' ? JSON.stringify({ items: [{ number: 7 }] }) : JSON.stringify({ ok: true, tool: n, args: a }); },
};
const openBug = { name: 'open_bug', description: 'File a bug', mode: 'call', tool: 'mcp_gh__create_issue', arguments: { title: { $param: 'title' }, labels: ['bug'] }, enabled: true };
const searchRead = { name: 'search_read', mode: 'pipeline', steps: [{ tool: 'mcp_gh__search_issues', arguments: { query: { $param: 'q' } } }, { tool: 'mcp_gh__get_issue', arguments: {}, inputMapping: { number: '$json.items.0.number' }, onMappingMissing: 'fail' }], enabled: true };

// Exactly as a client arms it: dispatcher → toolset → gate → bind.
function arm({ recipes = [], confirmSave = null, saveRecipe = null, confirmDestructive = null } = {}) {
  const mcp = mcpDispatchProvider(buildToolset([server]));
  const provider = recipeToolProvider({ recipes, confirmSave, saveRecipe });
  let toolset = buildToolset([mcp, provider]);
  toolset = withDestructiveGate(toolset, { confirm: confirmDestructive, only: (n) => toolset.remoteTools.has(n) });
  provider.bind(toolset);
  return toolset;
}

test('the spec is the catalogue, terse, and lists only enabled recipes', () => {
  const spec = recipeToolSpec([openBug, { ...searchRead, enabled: false }]);
  assert.match(spec.description, /open_bug\(title\) — File a bug/);
  assert.doesNotMatch(spec.description, /search_read/);
  assert.ok(JSON.stringify(spec).length < 2200);
});

test('save: dry run on the card, stored only on Allow, refused with nobody to ask', async () => {
  const seen = []; const saved = [];
  const tools = arm({ confirmSave: async (detail, r) => { seen.push(detail); return r.name === 'open_bug' ? 'allow' : 'deny'; }, saveRecipe: async (r) => saved.push(r) });
  const ok = JSON.parse(await tools.execute(RECIPE_TOOL_NAME, { action: 'save', recipe: openBug }));
  assert.equal(ok.saved, 'open_bug');
  assert.deepEqual(ok.params, ['title']);
  assert.equal(saved[0].enabled, true);
  assert.match(seen[0], /open_bug — File a bug\nMode: call\nParameters: title\nmcp_gh__create_issue \{"labels":\["bug"\]\}/);
  assert.equal(ran.length, 0, 'saving runs nothing');
  const no = JSON.parse(await tools.execute(RECIPE_TOOL_NAME, { action: 'save', recipe: { ...searchRead, name: 'other' } }));
  assert.equal(no.declined, true);
  const ghost = JSON.parse(await tools.execute(RECIPE_TOOL_NAME, { action: 'save', recipe: { name: 'ghost', mode: 'call', tool: 'mcp_nope__x', arguments: {} } }));
  assert.match(ghost.error, /not available/);
  assert.equal(seen.length, 2, 'no card for an impossible recipe');
  const blind = arm({ recipes: [openBug] });
  assert.match(JSON.parse(await blind.execute(RECIPE_TOOL_NAME, { action: 'save', recipe: { ...openBug, name: 'again' } })).error, /cannot ask/);
});

test('run goes through the dispatcher, so the destructive gate fires on the real action', async () => {
  ran.length = 0;
  const asked = [];
  const tools = arm({ recipes: [openBug, searchRead, { name: 'nuke', mode: 'call', tool: 'mcp_gh__delete_issue', arguments: { number: { $param: 'n' } }, enabled: true }], confirmDestructive: async (q) => { asked.push(q.name); return 'deny'; } });
  const r = JSON.parse(await tools.execute(RECIPE_TOOL_NAME, { action: 'run', name: 'open_bug', params: { title: 'Crash' } }));
  assert.equal(r.status, 'completed');
  assert.deepEqual(ran[0], ['mcp_gh__create_issue', { title: 'Crash', labels: ['bug'] }]);
  assert.match(JSON.parse(await tools.execute(RECIPE_TOOL_NAME, { action: 'run', name: 'open_bug', params: {} })).error, /Missing parameter\(s\): title/);
  const p = JSON.parse(await tools.execute(RECIPE_TOOL_NAME, { action: 'run', name: 'search_read', params: { q: 'login' } }));
  assert.deepEqual(p.steps[1].mappedArguments, { number: 7 });
  const nuked = JSON.parse(await tools.execute(RECIPE_TOOL_NAME, { action: 'run', name: 'nuke', params: { n: 1 } }));
  assert.equal(nuked.status, 'failed');
  assert.deepEqual(asked, ['mcp_gh__delete_issue']);
  const dry = JSON.parse(await tools.execute(RECIPE_TOOL_NAME, { action: 'dry_run', name: 'nuke', params: { n: 2 } }));
  assert.equal(dry.calls[0].destructive, true);
  assert.equal(dry.calls[0].known, true);
});

test('the MCP dispatcher: one resident tool, remote, find over the full set when narrowed', async () => {
  const full = buildToolset([server]);
  const menu = { ...full, specs: full.specs.slice(0, 2) };
  const disp = mcpDispatchProvider(menu, { all: full.specs });
  assert.equal(disp.specs.length, 1);
  assert.equal(disp.specs[0].name, MCP_TOOL_NAME);
  assert.equal(disp.remote, true);
  assert.match(disp.specs[0].description, /2 more actions not listed/);
  assert.equal(disp.traits.get('mcp_gh__delete_issue').destructive, true);
  const outer = buildToolset([disp]);
  const found = JSON.parse(await outer.execute(MCP_TOOL_NAME, { action: 'find', args: { query: 'delete issue' } }));
  assert.equal(found.matches[0].name, 'mcp_gh__delete_issue');
  assert.equal(found.matches[0].listed, false);
  assert.equal(JSON.parse(await outer.execute(MCP_TOOL_NAME, { action: 'mcp_gh__delete_issue', args: { number: 1 } })).tool, 'mcp_gh__delete_issue', 'a hidden action runs');
  assert.equal(outer.hiddenVia.get('mcp_gh__get_issue'), MCP_TOOL_NAME);
});

test('the approval text reads as steps and warnings', () => {
  const text = describeRecipeForApproval(searchRead, { calls: [{ tool: 'a', arguments: { query: 'x' } }, { tool: 'b', arguments: {}, mappedLater: ['number'] }], warnings: [{ message: 'careful' }] });
  assert.match(text, /1\. a \{"query":"x"\}\n2\. b \(\+ number from the previous step\)\n⚠ careful/);
});
