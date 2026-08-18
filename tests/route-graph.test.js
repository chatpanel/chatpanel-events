import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineModel, createModelRouter } from '../router.js';
import { routeGraph, projectChain } from '../route-graph.js';

const m = (id, over = {}) => defineModel({
  id, label: id, reach: 'any', classUsed: 'C', capabilities: ['tools'],
  costPer1k: 1, latencyMs: 700, quality: 0.5, ...over,
});
const models = [
  m('tiny', { quality: 0.3, costPer1k: 0, latencyMs: 500 }),
  m('mid', { quality: 0.6, reach: 'device', classUsed: 'L', costPer1k: 0, latencyMs: 1500 }),
  m('big', { quality: 0.9, costPer1k: 5 }),
  m('blind', { quality: 0.9, capabilities: [] }),
];
const decisionFor = (need) => createModelRouter({ models }).route(need);

test('the graph shows the losers, not only the winner', () => {
  // A decision whose alternatives you cannot see is an assertion. `blind` has no tools and
  // was ruled out before ranking — that has to be visible, with the reason.
  const g = routeGraph({ decision: decisionFor({ capabilities: ['tools'] }), models });
  const out = g.nodes.find((n) => n.id === 'blind');
  assert.equal(out.eligible, false);
  assert.match(out.why, /tools/);
  assert.equal(g.eliminated, 1);
  assert.equal(g.nodes.length, models.length, 'a candidate vanished from the picture');
});

test('position in the picture is position in the decision', () => {
  const decision = decisionFor({ capabilities: ['tools'] });
  const g = routeGraph({ decision, models });
  const eligible = g.nodes.filter((n) => n.eligible).map((n) => n.id);
  assert.deepEqual(eligible, decision.eligible.map((x) => x.id), 're-sorted rather than shown as decided');
  assert.equal(g.nodes[0].chosen, true);
  assert.equal(g.chosen, decision.model.id);
});

test('the chain is walked, not read off the ranking', () => {
  // Each replacement is chosen relative to the model that JUST failed, not to the original.
  // Reading the ranking would give a plausible-looking fiction: it is the order for the first
  // choice, not for the fourth.
  const decision = decisionFor({ capabilities: ['tools'] });
  const chain = projectChain(decision, 4);
  assert.equal(chain[0].id, decision.model.id);
  const ids = chain.map((h) => h.id);
  assert.equal(new Set(ids).size, ids.length, 'the chain revisited a model');
  // Nearest-first: from `big` (0.9) the closest by quality is `blind` (0.9) if eligible, else
  // `mid` (0.6) before `tiny` (0.3). Whatever the head is, quality distance never jumps back.
  for (let i = 2; i < chain.length; i++) {
    const q = (id) => models.find((x) => x.id === id).quality;
    const prev = Math.abs(q(chain[i - 1].id) - q(chain[0].id));
    const cur = Math.abs(q(chain[i].id) - q(chain[0].id));
    assert.ok(cur >= prev, `hop ${i} jumped back towards the start`);
  }
});

test('every hop after the first says what it is close to', () => {
  const chain = projectChain(decisionFor({}), 3);
  assert.equal(chain[0].reason, null, 'the chosen model is not a replacement for anything');
  for (const hop of chain.slice(1)) assert.match(hop.reason, /closest to/);
});

test('a pinned order is distinguishable from one we guessed', () => {
  // Showing them identically hides the single most common reason a model won.
  const pinnedModels = [m('a'), m('b', { providerRank: 1, orderPinned: true })];
  const g = routeGraph({ decision: createModelRouter({ models: pinnedModels }).route({}), models: pinnedModels });
  assert.equal(g.nodes.find((n) => n.id === 'b').orderPinned, true);
  assert.equal(g.nodes.find((n) => n.id === 'a').orderPinned, false);
});

test('no decision draws nothing rather than throwing', () => {
  const g = routeGraph({ decision: null, models });
  assert.deepEqual(g.nodes, []);
  assert.deepEqual(g.chain, []);
  assert.equal(g.chosen, null);
  assert.deepEqual(projectChain(null), []);
  // A route that found nothing eligible is a real state, not a crash.
  const none = routeGraph({ decision: decisionFor({ capabilities: ['telepathy'] }), models });
  assert.equal(none.chosen, null);
  assert.equal(none.chain.length, 0);
});
