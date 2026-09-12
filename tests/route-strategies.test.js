// The routing DECISIONS, now shared: what a model is guessed to be, and how one is chosen.
// These claims held in the extension's own suite; they are restated here so a client that
// inherits the modules inherits the promises.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reachOf, capabilitiesOf, qualityOf, costOf, applyOverride, reachChoicesFor, inferCandidate,
} from '../model-candidates.js';
import { ROUTE_STRATEGIES, ROUTE_MIDDLEWARE, needForTurn, explicitModelStrategy, complexityStrategy } from '../route-strategies.js';
import { createModelRouter } from '../router.js';

test('reach: a bridge agent is trusted, a loopback endpoint is on-device, a public host is any', () => {
  assert.equal(reachOf({ kind: 'bridge' }), 'trusted');
  assert.equal(reachOf({ baseUrl: 'http://127.0.0.1:11434/v1' }), 'device');
  assert.equal(reachOf({ baseUrl: 'https://api.openai.com/v1' }), 'any');
  assert.equal(reachOf({ baseUrl: 'not a url' }), 'any', 'an unparseable destination is treated as the furthest reach');
});

test('quality is read from a parameter count as a number, and a CLI harness is not an unknown model', () => {
  assert.equal(qualityOf({ model: 'qwen3-8b' }), 0.3);
  assert.equal(qualityOf({ model: 'gemma-4-26b-it' }), 0.6);
  assert.equal(qualityOf({ model: 'llama-405b' }), 0.85);
  assert.equal(qualityOf({ name: 'Claude Code', kind: 'bridge' }), 0.8);
  assert.equal(qualityOf({ model: 'something-nobody-knows' }), 0.5);
});

test('inferCandidate: a router model from a client\'s own record, health injected, override outward-only', () => {
  const agent = inferCandidate({ id: 'claude', name: 'Claude Code' }, 'bridge');
  assert.equal(agent.reach, 'trusted');
  assert.equal(agent.classUsed, 'A');
  assert.ok(agent.capabilities.includes('coding'));
  const local = inferCandidate({ id: 'll', name: 'Ollama', model: 'qwen3-8b', baseUrl: 'http://localhost:11434' }, 'api');
  assert.equal(local.reach, 'device');
  assert.equal(local.costPer1k, 0, 'on-device costs nothing');
  assert.equal(inferCandidate({ id: 'nothing', name: 'no model' }, 'api'), null, 'an endpoint with no model is not a candidate');
  const down = inferCandidate({ id: 'x', model: 'gpt-4o', baseUrl: 'https://api.openai.com' }, 'api', { health: { available: false, rateLimited: true } });
  assert.equal(down.available, false);
  assert.equal(down.rateLimited, true);
  const moved = applyOverride({ reach: 'device', costPer1k: 0 }, { reach: 'any', costPer1k: 3 });
  assert.equal(moved.reach, 'any', 'outward is allowed');
  const refused = applyOverride({ reach: 'any', costPer1k: 3 }, { reach: 'device' });
  assert.equal(refused.reach, 'any', 'inward is refused — that is what privacy depends on');
  assert.deepEqual(reachChoicesFor('trusted'), ['trusted', 'any']);
});

test('the strategies and middleware are declared once, in order', () => {
  assert.deepEqual(ROUTE_STRATEGIES.map((s) => s.id), ['named-by-user', 'failover-to-similar', 'escalate-on-complexity']);
  assert.deepEqual(ROUTE_MIDDLEWARE.map((m) => m.id), ['redaction']);
});

test('"use claude" is an instruction; "hi" escalates to nothing; the need carries an injected guard', async () => {
  const models = [
    inferCandidate({ id: 'claude', name: 'Claude Code' }, 'bridge'),
    inferCandidate({ id: 'small', name: 'Ollama', model: 'qwen3-8b', baseUrl: 'http://localhost:11434' }, 'api'),
  ];
  const named = await explicitModelStrategy.decide(models, { requestText: 'use claude for this' });
  assert.equal(named[0].id, 'claude');
  assert.equal(await complexityStrategy.decide(models, { signals: { smalltalk: true } }), null);

  const need = needForTurn({ request: { text: 'hi' } });
  assert.equal(need.reach, 'any');
  const capped = needForTurn({ request: { text: 'summarise this page' }, guard: { reach: 'device', why: 'internal page' } });
  assert.equal(capped.reach, 'device', 'the guard caps reach');
  assert.ok(capped.requirementReasons.includes('internal page'));

  const router = createModelRouter({ models, strategies: ROUTE_STRATEGIES, middleware: ROUTE_MIDDLEWARE });
  const d = router.route(capped);
  assert.equal(d.model?.id, 'small', 'a device-only need cannot reach the agent, however capable');
});
