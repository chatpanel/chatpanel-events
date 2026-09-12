import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildToolset } from '../toolset.js';
import { buildGroupDispatchSpec, makeGroupDispatchExecutor, makeDispatchProvider, validateAction, DESCRIBE_ACTION } from '../tool-dispatch.js';
import { findDispatchProvider, FIND_TOOL_NAME } from '../find-tool.js';
import { webSearchToolProvider, searchResultsToText, WEB_SEARCH_TOOL_NAME } from '../web-search-tool.js';
import { FIND_ACTION } from '../tool-discovery.js';

const searchSpec = {
  name: 'history_search',
  description: 'Search past chats. Returns snippets.',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  annotations: { readOnlyHint: true },
};
const noteSpec = {
  name: 'note_read',
  description: 'Read one note by id.',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};

function provider(specs, seen = []) {
  return {
    specs,
    system: 'inner guidance',
    async execute(name, input) { seen.push([name, input]); return `ran ${name}`; },
  };
}

test('buildToolset merges providers, first name wins, and flags remote tools', async () => {
  const a = provider([searchSpec]);
  const b = provider([searchSpec, noteSpec]); // duplicate history_search is dropped
  const mcp = { ...provider([{ name: 'mcp_jira_list', description: 'x', parameters: {} }]), remote: true };
  const ts = buildToolset([a, b, mcp], { mcpSystem: () => 'MCP RULES' });
  assert.deepEqual(ts.specs.map((s) => s.name), ['history_search', 'note_read', 'mcp_jira_list']);
  assert.ok(ts.remoteTools.has('mcp_jira_list'));
  assert.ok(!ts.remoteTools.has('history_search'));
  assert.match(ts.system, /^MCP RULES/);
  assert.equal(ts.systemParts.mcp, Math.round('MCP RULES'.length / 4));
  assert.equal(await ts.execute('note_read', { id: '1' }), 'ran note_read');
  assert.match(await ts.execute('nope', {}), /Unknown tool/);
});

test('buildToolset pays for the MCP block only when an mcp_ tool is present', () => {
  let asked = 0;
  const ts = buildToolset([provider([searchSpec])], { mcpSystem: () => { asked += 1; return 'MCP'; } });
  assert.equal(asked, 0);
  assert.equal(ts.system, 'inner guidance');
  assert.equal(buildToolset([], { mcpSystem: 'x' }), undefined);
});

test('the dispatcher spec lists actions and declares the args envelope', () => {
  const spec = buildGroupDispatchSpec({ name: 'find', description: 'Find things.', specs: [searchSpec, noteSpec] });
  assert.equal(spec.name, 'find');
  assert.match(spec.description, /- history_search\(query\): Search past chats\./);
  assert.deepEqual(spec.parameters.properties.action.enum, [DESCRIBE_ACTION, 'history_search', 'note_read']);
  assert.equal(spec.parameters.properties.args.type, 'object');
  assert.ok(!spec.parameters.properties.query, 'find is only offered when the menu is a subset');
  const capped = buildGroupDispatchSpec({ name: 'find', description: 'd', specs: [searchSpec], hidden: 3 });
  assert.ok(capped.parameters.properties.action.enum.includes(FIND_ACTION));
  assert.match(capped.description, /3 more actions not listed/);
});

test('the executor routes on the real name, validates, describes, and finds', async () => {
  const seen = [];
  const run = makeGroupDispatchExecutor({
    name: 'find', specs: [searchSpec], all: [searchSpec, noteSpec],
    runAction: (n, a) => { seen.push([n, a]); return `ran ${n}`; },
  });
  assert.equal(await run('find', { action: 'history_search', args: { query: 'q' } }), 'ran history_search');
  assert.deepEqual(seen.at(-1), ['history_search', { query: 'q' }]);
  // top-level args are tolerated too
  assert.equal(await run('find', { action: 'history_search', query: 'top' }), 'ran history_search');
  assert.deepEqual(seen.at(-1), ['history_search', { query: 'top' }]);
  // missing required → structured error, nothing ran
  const before = seen.length;
  const bad = JSON.parse(await run('find', { action: 'history_search', args: {} }));
  assert.match(bad.error, /Missing required argument/);
  assert.equal(seen.length, before);
  // describe returns the full schema
  const desc = JSON.parse(await run('find', { action: DESCRIBE_ACTION, args: { tool: 'note_read' } }));
  assert.equal(desc.name, 'note_read');
  assert.deepEqual(desc.parameters.required, ['id']);
  // an unlisted-but-reachable action still runs, and find can locate it
  assert.equal(await run('find', { action: 'note_read', args: { id: 'n1' } }), 'ran note_read');
  const found = JSON.parse(await run('find', { action: FIND_ACTION, args: { query: 'read note' } }));
  assert.ok(JSON.stringify(found).includes('note_read'));
  // unknown action names the menu
  const unknown = JSON.parse(await run('find', { action: 'zzz', args: {} }));
  assert.deepEqual(unknown.actions, ['history_search']);
  assert.match(unknown.hint, /1 more/);
  // direct calls bypass the dispatcher
  assert.equal(await run('note_read', { id: 'x' }), 'ran note_read');
  assert.equal(validateAction(noteSpec, { id: 'x' }), null);
});

test('makeDispatchProvider keeps the remote flag, traits and reach, and attaches guidance to describe', async () => {
  const inner = buildToolset([provider([searchSpec, noteSpec])]);
  const p = makeDispatchProvider({ name: 'find', description: 'd', resident: 'one line', inner, remote: false });
  assert.equal(p.specs.length, 1);
  assert.equal(p.system, 'one line');
  assert.equal(p.remote, false);
  assert.ok(p.traits instanceof Map);
  assert.equal(p.traits.get('history_search')?.readOnly, true);
  assert.deepEqual(p.reach.map((s) => s.name), ['history_search', 'note_read']);
  const desc = JSON.parse(await p.execute('find', { action: DESCRIBE_ACTION, args: { tool: 'note_read' } }));
  assert.equal(desc.guidance, 'inner guidance');
  const outer = buildToolset([p]);
  assert.equal(outer.hiddenVia.get('note_read'), 'find');
  assert.equal(makeDispatchProvider({ name: 'x', description: 'd', resident: '', inner: null }), null);
});

test('find is the same tool everywhere: name, resident line, and routing', async () => {
  const seen = [];
  const inner = buildToolset([provider([searchSpec], seen)]);
  const find = findDispatchProvider(inner);
  assert.equal(find.specs[0].name, FIND_TOOL_NAME);
  assert.equal(FIND_TOOL_NAME, 'find');
  assert.match(find.system, /You HAVE access to the user's own ChatPanel data/);
  assert.equal(find.remote, false);
  await find.execute('find', { action: 'history_search', args: { query: 'pricing' } });
  assert.deepEqual(seen, [['history_search', { query: 'pricing' }]]);
});

test('web_search provider hands the host search the query and returns citable text with an engine badge', async () => {
  const calls = [];
  const p = webSearchToolProvider({
    search: async (q) => {
      calls.push(q);
      return { query: q, engines: ['duckduckgo'], results: [{ rank: 1, title: 'Oracle (ORCL)', url: 'https://example.com/orcl', text: '150.28' }] };
    },
  });
  assert.equal(p.specs[0].name, WEB_SEARCH_TOOL_NAME);
  assert.equal(p.specs[0].annotations.readOnlyHint, true);
  const out = await p.execute('web_search', { query: 'ORCL stock' });
  assert.deepEqual(calls, ['ORCL stock']);
  assert.equal(out.note, 'ChatPanel · duckduckgo');
  assert.match(out.text, /\[1\] \[Oracle \(ORCL\)\]\(https:\/\/example\.com\/orcl\)/);
  assert.match(out.text, /Result details/);
  assert.equal(await p.execute('web_search', { query: '  ' }), 'No query provided to web_search.');
  assert.match(await p.execute('other', {}), /Unknown tool/);
  const failing = webSearchToolProvider({ search: async () => { throw new Error('blocked'); } });
  assert.equal(await failing.execute('web_search', { query: 'x' }), 'web_search failed: blocked');
  assert.throws(() => webSearchToolProvider({}), /search required/);
});

test('an empty result names the engines tried and tells the model not to give up', () => {
  const text = searchResultsToText({ query: 'q', engines: ['startpage'], results: [] });
  assert.match(text, /No web results for "q" \(searched: startpage\)/);
  assert.match(text, /do NOT conclude/);
});
