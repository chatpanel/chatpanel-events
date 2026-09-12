import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolTraits, bareToolName, canRunConcurrently, isCacheable, needsConfirmation, traitsIndex } from '../tool-traits.js';

test('annotations win, and a read-only tool is never destructive', () => {
  const t = toolTraits({ name: 'mcp_github__delete_repo', annotations: { readOnlyHint: true } });
  assert.equal(t.source, 'annotations');
  assert.equal(t.readOnly, true);
  assert.equal(t.destructive, false, 'the name says delete; the server says read-only; the server knows');
  assert.equal(t.idempotent, true);
  assert.equal(canRunConcurrently(t), true);
  assert.equal(isCacheable(t), true);
  assert.equal(needsConfirmation(t), false);
});

test('an absent destructiveHint falls back to the name, not to the spec\'s "assume destructive"', () => {
  // Per the MCP spec the default is true — which would put every create_issue behind a
  // confirmation. Explicit wins; absent reads the name.
  const create = toolTraits({ name: 'create_issue', annotations: { readOnlyHint: false } });
  assert.equal(create.destructive, false);
  assert.equal(create.readOnly, false);
  const del = toolTraits({ name: 'delete_issue', annotations: { readOnlyHint: false } });
  assert.equal(del.destructive, true);
  const explicit = toolTraits({ name: 'create_issue', annotations: { readOnlyHint: false, destructiveHint: true } });
  assert.equal(explicit.destructive, true);
  assert.equal(needsConfirmation(explicit), true);
});

test('names are read when there are no annotations, conservatively', () => {
  for (const n of ['get_issue', 'mcp_jira__search_issues', 'list-zones', 'history_search', 'web_search', 'read_page', 'screenshot', 'smart_search']) {
    assert.equal(toolTraits({ name: n }).readOnly, true, `${n} is a read`);
  }
  for (const n of ['create_issue', 'click_at', 'type_text', 'update_issue', 'post_message', 'frobnicate']) {
    const t = toolTraits({ name: n });
    assert.equal(t.readOnly, false, `${n} is not a read`);
    assert.equal(t.destructive, false, `${n} is not destructive`);
  }
  for (const n of ['delete_file', 'mcp_cf__purge_cache', 'issue_remove_label', 'reset_password', 'revoke_token']) {
    const t = toolTraits({ name: n });
    assert.equal(t.destructive, true, `${n} is destructive`);
    assert.equal(t.readOnly, false);
  }
  assert.equal(toolTraits({ name: 'get_and_delete' }).readOnly, false, 'a destructive token anywhere cancels the read verb');
  assert.equal(toolTraits({ name: 'search_and_replace' }).readOnly, false, 'a write token anywhere cancels the read verb');
  assert.equal(toolTraits({ name: 'issue_get' }).readOnly, true, 'the read verb need not come first');
  assert.equal(toolTraits({ name: 'scroll_down' }).readOnly, false, 'moving the page is not reading it');
  assert.equal(toolTraits('list_things').source, 'heuristic');
});

test('an annotations object with no boolean hints is not an annotations object', () => {
  assert.equal(toolTraits({ name: 'get_x', annotations: { title: 'Get X' } }).source, 'heuristic');
});

test('the server prefix is stripped before the verb is read', () => {
  assert.equal(bareToolName('mcp_my__server__get_thing'), 'get_thing');
  assert.equal(bareToolName('mcp-x'), 'x');
  assert.equal(bareToolName('plain'), 'plain');
});

test('traitsIndex covers every named spec', () => {
  const idx = traitsIndex([{ name: 'get_a' }, { name: 'delete_b', annotations: { readOnlyHint: false, destructiveHint: true } }, { nope: 1 }]);
  assert.equal(idx.size, 2);
  assert.equal(idx.get('get_a').readOnly, true);
  assert.equal(idx.get('delete_b').destructive, true);
});

test('the destructive gate asks on the real action, remembers "always", refuses with nobody to ask', async () => {
  const { withDestructiveGate } = await import('../tool-traits.js');
  const ran = [];
  const toolset = {
    specs: [{ name: 'mcp', description: 'd', parameters: {} }, { name: 'page', description: 'p', parameters: {} }, { name: 'delete_note', description: 'x', parameters: {} }],
    remoteTools: new Set(['mcp']),
    traits: new Map([['mcp_gh__delete_repo', { readOnly: false, destructive: true }], ['mcp_gh__get_repo', { readOnly: true, destructive: false }]]),
    async execute(name, input) { ran.push(`${name}:${input?.action || ''}`); return 'ok'; },
  };
  const asked = [];
  let answer = 'deny';
  const gated = withDestructiveGate(toolset, { confirm: async (q) => { asked.push(q); return answer; }, only: (n) => toolset.remoteTools.has(n) });
  // A read through the dispatcher is never asked about.
  assert.equal(await gated.execute('mcp', { action: 'mcp_gh__get_repo', args: {} }), 'ok');
  assert.equal(asked.length, 0);
  // A destructive action is asked about on ITS name, with the dispatcher named as the route.
  const denied = JSON.parse(await gated.execute('mcp', { action: 'mcp_gh__delete_repo', args: { repo: 'r' } }));
  assert.equal(denied.declined, true);
  assert.match(denied.error, /DECLINED "mcp_gh__delete_repo"/);
  assert.equal(asked[0].name, 'mcp_gh__delete_repo');
  assert.equal(asked[0].via, 'mcp');
  assert.deepEqual(ran, ['mcp:mcp_gh__get_repo'], 'a declined call never reaches the tool');
  // "always" runs it now and stops asking for that tool.
  answer = 'always';
  assert.equal(await gated.execute('mcp', { action: 'mcp_gh__delete_repo', args: {} }), 'ok');
  assert.equal(await gated.execute('mcp', { action: 'mcp_gh__delete_repo', args: {} }), 'ok');
  assert.equal(asked.length, 2, 'asked once more, then remembered');
  // A tool outside `only` is untouched even though its name is destructive.
  assert.equal(await gated.execute('delete_note', {}), 'ok');
  assert.equal(asked.length, 2);
  // No confirm handle: refused, with a message that says why and what to do.
  const blind = withDestructiveGate(toolset, { only: (n) => toolset.remoteTools.has(n) });
  const refused = JSON.parse(await blind.execute('mcp', { action: 'mcp_gh__delete_repo', args: {} }));
  assert.equal(refused.needsConfirmation, true);
  assert.match(refused.error, /cannot ask/);
  // A top-level spec is classified by its own annotations.
  const flat = withDestructiveGate({ specs: [{ name: 'mcp_x__wipe', annotations: { readOnlyHint: false, destructiveHint: true } }], async execute() { return 'ok'; } }, { confirm: async () => 'deny' });
  assert.match(await flat.execute('mcp_x__wipe', {}), /DECLINED/);
});
