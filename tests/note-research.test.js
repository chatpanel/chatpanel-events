// A research pane is a ranking problem: empty is better than irrelevant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  salientTerms, topicTerms, researchRelevance, webQuery, researchSnippet,
  rankResearchCards, mergeResearchLanes,
} from '../note-research.js';

const card = (title, snippet = '') => ({ kind: 'note', title, snippet, key: title });

test('the query is the note\'s content, not the way it was phrased', () => {
  const t = salientTerms('Can you please check the replication lag today');
  assert.ok(t.has('replication'));
  assert.ok(t.has('lag') === false, 'three letters is not a topic');
  for (const noise of ['please', 'check', 'today', 'you']) assert.equal(t.has(noise), false);
});

test('agent and note-meta words are not what a note is about', () => {
  const t = salientTerms('ask claude to research this question and summarize the answer');
  assert.equal(t.size, 0, `nothing here is a topic, got ${[...t]}`);
});

test('topic terms rank by how often the note returns to them, not by what came first', () => {
  const text = 'Meeting notes about the rollout. Snapshot matters. snapshot again, and snapshot once more. rollout.';
  assert.deepEqual(topicTerms(text, 2), ['snapshot', 'rollout']);
});

test('a lone SHORT word in common is NOT related — that is how March\'s note surfaces', () => {
  const salient = salientTerms('replication lag during the atlas rollout');
  // "atlas" is five letters: common enough to appear anywhere, so one of it proves nothing.
  assert.equal(researchRelevance(card('Weekly sync', 'we discussed atlas'), salient), 0);
  assert.ok(researchRelevance(card('Atlas rollout plan', 'atlas rollout'), salient) > 0, 'two words is evidence');
});

test('one SPECIFIC word is enough, because a long word is evidence on its own', () => {
  const salient = salientTerms('replication lag during the atlas rollout');
  assert.ok(researchRelevance(card('Notes', 'replication was fine'), salient) > 0);
});

test('a web result the user asked for is not re-gated on its snippet', () => {
  const salient = salientTerms('replication lag during the atlas rollout');
  const c = card('A paraphrasing headline', 'nothing in common at all');
  assert.equal(researchRelevance(c, salient, { web: true }), 0, 'no overlap still scores zero');
  const partial = card('Atlas guide', 'about atlas');
  assert.equal(researchRelevance(partial, salient), 0, 'one short word is not enough in the workspace');
  assert.ok(researchRelevance(partial, salient, { web: true }) > 0, 'but it is on the lane the user asked for');
});

test('no query means no claims about relevance', () => {
  assert.equal(researchRelevance(card('anything'), salientTerms('a the it')), 0);
});

test('ranking drops the irrelevant, orders the rest, and honours dismissals', () => {
  const cards = [
    card('Weekly sync', 'we discussed things'),
    card('Atlas rollout plan', 'replication lag and snapshots'),
    card('Replication notes', 'replication'),
  ];
  const out = rankResearchCards(cards, 'replication lag during the atlas rollout');
  assert.deepEqual(out.map((c) => c.title), ['Atlas rollout plan', 'Replication notes']);
  const fewer = rankResearchCards(cards, 'replication lag during the atlas rollout', { dismissed: new Set(['Replication notes']) });
  assert.deepEqual(fewer.map((c) => c.title), ['Atlas rollout plan']);
});

test('the web lane keeps the engine\'s own order, minus dismissals', () => {
  const cards = [card('First'), card('Second')];
  assert.deepEqual(rankResearchCards(cards, 'anything', { web: true }).map((c) => c.title), ['First', 'Second']);
});

test('what the user pressed comes first, and nothing appears twice', () => {
  const web = [{ kind: 'web', title: 'W1', key: 'u1' }, { kind: 'web', title: 'dupe', key: 'k1' }];
  const local = [{ kind: 'note', title: 'N1', key: 'k1' }, { kind: 'note', title: 'N2', key: 'k2' }];
  const merged = mergeResearchLanes(web, local);
  assert.deepEqual(merged.map((c) => c.title), ['W1', 'dupe', 'N2']);
  assert.equal(mergeResearchLanes(web, local, 2).length, 2);
});

test('the web query is the title plus what the note is about, bounded', () => {
  assert.equal(webQuery('Atlas migration', ['replication', 'snapshot']), 'Atlas migration replication snapshot');
  assert.ok(webQuery('x'.repeat(200), []).length <= 120);
  assert.equal(webQuery('', []), '');
});

test('a snippet is enough to recognise a source, not to read instead of it', () => {
  assert.equal(researchSnippet('  lots   of\n\nwhitespace  '), 'lots of whitespace');
  assert.equal(researchSnippet('x'.repeat(500)).length, 160);
});
