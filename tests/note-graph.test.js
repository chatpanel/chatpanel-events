// A note graph drawn from wikilinks alone is dust; topics are the connective tissue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNoteGraph, egoGraph, trimGraph, graphStats, MAX_GRAPH_NODES,
} from '../note-graph.js';

const idx = [
  { id: 'note:a', title: 'Atlas rollback', topics: ['migration'], links: ['Drain plan'] },
  { id: 'note:b', title: 'Drain plan', topics: ['migration'], tags: ['ops'] },
  { id: 'note:c', title: 'Hiring', topics: ['people'], tags: ['ops'] },
];

test('an explicit wikilink is an edge, and a link to a page that does not exist is not', () => {
  const g = buildNoteGraph([...idx, { id: 'note:d', title: 'Stray', links: ['Nowhere'] }]);
  const link = g.links.find((l) => l.kind === 'link');
  assert.deepEqual([link.s, link.t].sort(), ['note:a', 'note:b']);
  assert.equal(g.links.filter((l) => l.kind === 'link').length, 1, 'the dangling link drew nothing');
  assert.ok(g.nodes.some((n) => n.id === 'note:d'), 'but the note itself is still a node');
});

test('a topic on two notes becomes a hub; a topic on one connects nothing and is dropped', () => {
  const g = buildNoteGraph(idx);
  assert.ok(g.nodes.some((n) => n.id === 'topic:migration' && n.type === 'topic'));
  assert.equal(g.nodes.some((n) => n.id === 'topic:people'), false, 'one note is not a cluster');
  // Tags count the same as extracted topics — `ops` is on b and c.
  assert.ok(g.nodes.some((n) => n.id === 'topic:ops'));
});

test('topics can be switched off, leaving the deliberate links only', () => {
  const g = buildNoteGraph(idx, { topics: false });
  assert.equal(g.nodes.filter((n) => n.type === 'topic').length, 0);
  assert.ok(g.links.every((l) => l.kind === 'link'));
});

test('an edge is never drawn twice, whichever way round it was found', () => {
  const g = buildNoteGraph([
    { id: 'x', title: 'X', links: ['Y'] },
    { id: 'y', title: 'Y', links: ['X'] },
  ]);
  assert.equal(g.links.length, 1);
});

test('a note never links to itself, however it is written', () => {
  const g = buildNoteGraph([{ id: 'x', title: 'X', links: ['X'], topics: ['t'] }]);
  assert.equal(g.links.length, 0);
});

test('the ego graph reaches siblings THROUGH a shared topic — which is why hubs exist', () => {
  const g = buildNoteGraph(idx);
  const one = egoGraph(g, 'note:c', 1);
  assert.deepEqual(one.nodes.map((n) => n.id).sort(), ['note:c', 'topic:ops']);
  const two = egoGraph(g, 'note:c', 2);
  assert.ok(two.nodes.some((n) => n.id === 'note:b'), 'b shares the ops tag with c');
  assert.equal(two.nodes.find((n) => n.id === 'note:c').focus, true);
  assert.ok(two.links.every((l) => two.nodes.some((n) => n.id === l.s) && two.nodes.some((n) => n.id === l.t)));
});

test('an ego graph of something absent is empty, not a crash', () => {
  assert.deepEqual(egoGraph(buildNoteGraph(idx), 'note:nope'), { nodes: [], links: [] });
  assert.deepEqual(egoGraph(null, 'x'), { nodes: [], links: [] });
});

test('trimming keeps the most connected, and never drops the node in focus', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ id: `n${i}`, title: `N${i}`, topics: ['shared'] }));
  many.push({ id: 'lonely', title: 'Lonely' });
  const g = buildNoteGraph(many);
  const t = trimGraph(g, 10, 'lonely');
  assert.equal(t.nodes.length, 10);
  assert.ok(t.nodes.some((n) => n.id === 'lonely'), 'the focus survives its own zero degree');
  assert.ok(t.links.every((l) => t.nodes.some((n) => n.id === l.s) && t.nodes.some((n) => n.id === l.t)));
  assert.equal(trimGraph(g, 1000).nodes.length, g.nodes.length, 'under the cap, nothing is touched');
});

test('the stats tell an empty graph apart from an unconnected one', () => {
  assert.deepEqual(graphStats(buildNoteGraph([])), { notes: 0, topics: 0, links: 0 });
  const lonely = graphStats(buildNoteGraph([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]));
  assert.deepEqual(lonely, { notes: 2, topics: 0, links: 0 });
  assert.ok(MAX_GRAPH_NODES > 0);
});
