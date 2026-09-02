import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REACH, reachRank, reachSatisfies } from '../reach.js';
import { REACH as viaRouter } from '../router.js';

test('the ladder is ordered least-to-most, and the router still exports it', () => {
  assert.deepEqual([...REACH], ['device', 'trusted', 'any']);
  // Every existing caller reaches for REACH through the router; that import must keep working.
  assert.equal(viaRouter, REACH);
});

test('an unknown tier ranks lowest, so a typo can never widen reach', () => {
  assert.equal(reachRank('device'), 0);
  assert.equal(reachRank('any'), 2);
  assert.equal(reachRank('supervisor'), 0);
  assert.equal(reachRank(undefined), 0);
  assert.equal(reachSatisfies('typo', 'trusted'), false);
  assert.equal(reachSatisfies('any', 'trusted'), true);
  assert.equal(reachSatisfies('device', 'device'), true);
});

test('the package entry point actually parses and exports one REACH', async () => {
  // index.js re-exports ~40 modules and nothing imported it: a duplicate export (REACH from
  // both reach.js and router.js) is a hard ESM parse error, and it was caught two repos
  // downstream by the extension's parse test rather than here.
  const pkg = await import('../index.js');
  assert.equal(pkg.REACH, REACH);
  assert.equal(typeof pkg.reachSatisfies, 'function');
});
