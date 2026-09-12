import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compressToolSpec, compressToolSpecs, compressionStats, trimDescription } from '../tool-schema.js';

const real = {
  name: 'mcp_github__create_issue',
  description: 'Create a new issue in a GitHub repository. This tool creates an issue with the given title and body, and optionally assigns labels, assignees and a milestone. It returns the created issue including its number and URL. Use search_issues first if you are not sure whether a similar issue already exists, to avoid duplicates. Requires write access to the repository.',
  parameters: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    title: 'CreateIssueInput',
    properties: {
      owner: { type: 'string', description: 'The owner of the repository', examples: ['octocat'] },
      repo: { type: 'string', description: 'The name of the repository' },
      title: { type: 'string', description: 'The title of the issue' },
      body: { type: 'string', description: 'Markdown body. Supports GitHub-flavoured markdown, task lists and @mentions; keep it under 65536 characters.' },
      issue_number: { type: 'integer', description: 'The number of the issue', minimum: 1 },
      ref: { type: 'string', description: 'Git ref (branch, tag or SHA) to associate' },
      state: { type: 'string', enum: ['open', 'closed'], default: 'open', description: 'State of the issue' },
      labels: { type: 'array', items: { type: 'string', description: 'A label name' }, description: 'Labels to add to the issue' },
      cursor: { type: 'string', description: 'Opaque pagination token from a previous page' },
      nested: { type: 'object', properties: { deep: { type: 'string', title: 'Deep', description: 'Overrides the parent author for this comment only' } } },
    },
    required: ['owner', 'repo', 'title'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false },
};

test('balanced keeps structure, cuts prose that repeats the name, keeps prose that informs', () => {
  const c = compressToolSpec(real);
  const p = c.parameters;
  assert.equal(c.name, real.name);
  assert.deepEqual(c.annotations, real.annotations, 'non-schema fields are untouched');
  assert.deepEqual(p.required, ['owner', 'repo', 'title']);
  assert.equal(p.additionalProperties, false);
  assert.equal(p.$schema, undefined);
  assert.equal(p.title, undefined);
  assert.equal(p.properties.owner.examples, undefined);
  // Structural facts survive.
  assert.deepEqual(p.properties.state.enum, ['open', 'closed']);
  assert.equal(p.properties.state.default, 'open');
  assert.equal(p.properties.issue_number.minimum, 1);
  assert.equal(p.properties.labels.items.type, 'string');
  // "The number of the issue" says nothing the name does not — gone.
  assert.equal(p.properties.issue_number.description, undefined);
  assert.equal(p.properties.title.description, undefined);
  assert.equal(p.properties.repo.description, undefined);
  // Informative descriptions stay, trimmed.
  assert.match(p.properties.body.description, /Markdown body/);
  assert.ok(p.properties.body.description.length <= 100);
  assert.match(p.properties.nested.properties.deep.description, /Overrides the parent/);
  assert.match(p.properties.labels.description, /add to the issue/);
  // Ambiguous names keep theirs whatever they say.
  assert.match(p.properties.ref.description, /Git ref/);
  assert.match(p.properties.cursor.description, /pagination token/);
  assert.match(p.properties.state.description, /State/);
  // The tool description is a sentence or two, cut at a sentence boundary.
  assert.ok(c.description.length <= 200, c.description);
  assert.match(c.description, /\.$/);
  assert.match(c.description, /^Create a new issue/);
});

test('aggressive keeps only the ambiguous parameter descriptions', () => {
  const p = compressToolSpec(real, { mode: 'aggressive' }).parameters;
  assert.equal(p.properties.labels.description, undefined);
  assert.equal(p.properties.nested.properties.deep.description, undefined);
  assert.match(p.properties.body.description, /Markdown/, '`body` is ambiguous on every server');
  assert.match(p.properties.ref.description, /Git ref/);
  assert.match(p.properties.cursor.description, /pagination/);
});

test('off returns the spec as sent; an unknown mode is treated as off', () => {
  assert.equal(compressToolSpec(real, { mode: 'off' }), real);
  assert.equal(compressToolSpec(real, { mode: 'weird' }), real);
});

test('the MCP shape (inputSchema) is compressed too, and the input is never mutated', () => {
  const mcp = { name: 't', description: real.description, inputSchema: real.parameters };
  const snapshot = JSON.stringify(mcp);
  const c = compressToolSpec(mcp);
  assert.equal(c.inputSchema.$schema, undefined);
  assert.equal(JSON.stringify(mcp), snapshot);
});

test('the stats say what was saved', () => {
  const s = compressionStats([real, { name: 'tiny', description: 'x', parameters: { type: 'object', properties: {} } }]);
  assert.equal(s.tools, 2);
  assert.ok(s.saved > 0 && s.after < s.before);
  assert.ok(s.savedPercent >= 20, `expected a real saving on a real schema, got ${s.savedPercent}%`);
  assert.equal(s.perTool[1].before, s.perTool[1].after, 'a spec with nothing to cut costs nothing');
  assert.equal(compressToolSpecs([real]).length, 1);
});

test('trimDescription prefers a sentence boundary and never splits a word', () => {
  assert.equal(trimDescription('One sentence. Two sentence. Three sentence is long.', 30), 'One sentence. Two sentence.');
  assert.equal(trimDescription('No boundaries here at all in this text', 20), 'No boundaries here…');
  assert.equal(trimDescription('  spaced   out  ', 100), 'spaced out');
  assert.equal(trimDescription('short', 0), 'short');
});
