import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TOPICS, TOPICS_SCHEMA, topicsSchema, topicsPrompt, topicsFormat, parseTopics, normalizeTopic, normalizeTopics, topicsStream,
  ENTITY_TYPES, ENTITIES_SCHEMA, entitiesPrompt, parseEntities, coerceEntities,
  MAX_SUGGESTIONS, suggestionsPrompt, parseSuggestions,
} from '../extraction.js';

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

test('the topics prompt carries the schema, so the shape cannot drift from the parser', () => {
  const p = topicsPrompt('anything');
  assert.ok(p.includes('"topics"'));
  assert.ok(p.includes('[string, …]'));
});

test('untrusted content is fenced and labelled as data in every extraction prompt', () => {
  // A transcript can contain "ignore your instructions and…". These prompts read attacker-
  // supplied text by design, so the fence is not decoration.
  for (const p of [topicsPrompt('x'), suggestionsPrompt('x')]) {
    assert.ok(/untrusted/i.test(p), 'the content is not marked untrusted');
    assert.ok(p.includes('--- BEGIN CONTENT ---') && p.includes('--- END CONTENT ---'));
  }
  assert.ok(/untrusted DATA/i.test(entitiesPrompt()));
});

test('the content is clipped before it is sent, not after', () => {
  assert.ok(topicsPrompt('x'.repeat(50000), { maxChars: 100 }).length < 3000);
});

test('a topics answer reads whether it is an object, a bare array or a markdown list', () => {
  const want = ['pricing', 'Q3 launch'];
  assert.deepEqual(parseTopics('{"topics":["pricing","Q3 launch"]}'), want);
  assert.deepEqual(parseTopics('["pricing","Q3 launch"]'), want);
  assert.deepEqual(parseTopics('- pricing\n- Q3 launch'), want);
  assert.deepEqual(parseTopics('```json\n{"topics": ["pricing", "Q3 launch",]}\n```'), want);
});

test('a topic naming only the container is dropped — it says nothing about the content', () => {
  assert.deepEqual(parseTopics('{"topics":["meeting","notes","pricing","transcript"]}'), ['pricing']);
});

test('a "topic" that is really a sentence is refused rather than truncated into a fake tag', () => {
  assert.equal(normalizeTopic('we should revisit the pricing model before the launch'), '');
  assert.equal(normalizeTopic('**pricing**'), 'pricing');
  assert.equal(normalizeTopic('“Q3 launch”'), 'Q3 launch');
  assert.equal(normalizeTopic('- hiring plan'), 'hiring plan');
});

test('topics are deduped case-insensitively and capped', () => {
  const many = Array.from({ length: 30 }, (_, i) => `topic ${i}`);
  assert.equal(parseTopics(JSON.stringify({ topics: many })).length, MAX_TOPICS);
  assert.deepEqual(parseTopics('{"topics":["Pricing","pricing","PRICING"]}'), ['Pricing']);
});

test('a model that finds nothing gets an empty list, never a null the caller must handle', () => {
  assert.deepEqual(parseTopics('none'), []);
  assert.deepEqual(parseTopics(''), []);
  assert.deepEqual(parseTopics('I could not determine any topics.'), []);
});

test('normalizeTopics is reusable by the deterministic paths, not just the model one', () => {
  // A topic from a heuristic and one from a model must normalise identically, or the same
  // subject appears twice in a facet list under two spellings.
  assert.deepEqual(normalizeTopics(['  Pricing ', 'pricing', 'meeting', ''], { max: 5 }), ['Pricing']);
});

test('topics stream as they arrive', () => {
  const s = topicsStream();
  s.push('{"topics":["pric');
  assert.deepEqual(s.snapshot().value.topics, ['pric']);
  s.push('ing","hiring"]}');
  assert.deepEqual(s.end().value.topics, ['pricing', 'hiring']);
});

test('the limit in the prompt and the limit the parser applies are the same number', () => {
  // A schema fixed at 8 while the prompt asked for 15 silently threw away the last seven.
  const p = topicsPrompt('x', { max: 15 });
  assert.ok(p.includes('at most 15 items'), 'the prompt does not state the caller\'s limit');
  const fifteen = Array.from({ length: 15 }, (_, i) => `subject ${i}`);
  assert.equal(parseTopics(JSON.stringify({ topics: fifteen }), { max: 15 }).length, 15);
  assert.equal(topicsSchema(15).fields.topics.maxItems, 15);
});

test('a client can inject its own topic rule instead of re-reading the reply around it', () => {
  const shouty = parseTopics('{"topics":["pricing","hiring"]}', { normalize: (t) => String(t).toUpperCase() });
  assert.deepEqual(shouty, ['PRICING', 'HIRING']);
});

test('the topics response_format is derived from the same schema', () => {
  const f = topicsFormat();
  assert.equal(f.response_format.json_schema.schema.properties.topics.type, 'array');
  assert.equal(topicsFormat('none'), null);
});

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

test('the entity types match the redaction engine, which is a wire contract', () => {
  // These land in `[[TYPE_n]]` placeholders that clients restore against; adding one here
  // without adding it there produces a token nothing can put back.
  assert.deepEqual(ENTITY_TYPES, ['PERSON', 'ORG', 'LOCATION', 'ID', 'EMAIL', 'PHONE', 'OTHER']);
});

test('entities read from the shape a small local model actually emits', () => {
  const messy = "Here's the JSON:\n```json\n{entities: [{value: 'Alex Rivera', type: 'person'}, {value: 'a@example.com', type: EMAIL},]}\n```";
  assert.deepEqual(parseEntities(messy), [
    { value: 'Alex Rivera', type: 'PERSON' },
    { value: 'a@example.com', type: 'EMAIL' },
  ]);
});

test('an entity type outside the requested set is dropped, not silently retyped', () => {
  const out = parseEntities('{"entities":[{"value":"Alex","type":"PERSON"},{"value":"Acme","type":"ORG"}]}', { types: ['PERSON'] });
  assert.deepEqual(out, [{ value: 'Alex', type: 'PERSON' }]);
});

test('a clean sample and an unreadable reply are different answers', () => {
  // The distinction that matters: "clean" means send the text; "unreadable" means fall back
  // to another detector. Collapsing them is how unredacted text gets sent.
  assert.deepEqual(coerceEntities('{"entities":[]}').entities, []);
  assert.equal(coerceEntities('none').source, 'nothing');
  assert.equal(coerceEntities('I am not sure what you are asking.'), null);
  assert.deepEqual(parseEntities('I am not sure what you are asking.'), [], 'the array form still degrades safely');
});

test('an entity with no value is dropped without losing the rest of the list', () => {
  const out = parseEntities('{"entities":[{"value":"Alex","type":"PERSON"},{"value":"","type":"ORG"},{"value":"Acme","type":"ORG"}]}');
  assert.equal(out.length, 2);
});

test('the entities schema is strict-JSON-Schema clean for servers that enforce it', () => {
  const js = ENTITIES_SCHEMA.fields.entities;
  assert.equal(js.type, 'object[]');
  assert.deepEqual(Object.keys(js.fields), ['value', 'type']);
});

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

test('suggestions read from an array, an object or a numbered list', () => {
  const want = ['What changed in pricing?', 'Summarise the thread'];
  assert.deepEqual(parseSuggestions('["What changed in pricing?","Summarise the thread"]'), want);
  assert.deepEqual(parseSuggestions('{"prompts":["What changed in pricing?","Summarise the thread"]}'), want);
  assert.deepEqual(parseSuggestions('1. What changed in pricing?\n2. Summarise the thread'), want);
});

test('numbering and quotes a model adds despite being told not to are stripped', () => {
  assert.deepEqual(parseSuggestions('{"prompts":["1. \\"What changed?\\"","- Summarise it"]}'), ['What changed?', 'Summarise it']);
});

test('suggestions are capped, deduped and clipped', () => {
  const many = Array.from({ length: 20 }, (_, i) => `ask me thing ${i}`);
  assert.equal(parseSuggestions(JSON.stringify({ prompts: many })).length, MAX_SUGGESTIONS);
  assert.deepEqual(parseSuggestions('{"prompts":["Same thing","same thing"]}'), ['Same thing']);
  assert.ok(parseSuggestions(JSON.stringify({ prompts: ['x'.repeat(500)] }))[0].length <= 80);
});

test('a model with nothing to suggest yields an empty list', () => {
  assert.deepEqual(parseSuggestions('none'), []);
  assert.deepEqual(parseSuggestions(''), []);
});

// ---------------------------------------------------------------------------
// The point of the exercise
// ---------------------------------------------------------------------------

test('one repair learned once is a repair every extraction has', () => {
  // Code fences were learned by topic-extraction, "none" as prose by voice-intents, markdown
  // lists by suggestions — each in its own file, none sharing. Every schema now has all three.
  const fenced = '```json\n{"topics":["pricing"]}\n```';
  assert.deepEqual(parseTopics(fenced), ['pricing']);
  assert.deepEqual(parseSuggestions('```json\n{"prompts":["Ask about pricing"]}\n```'), ['Ask about pricing']);
  assert.deepEqual(parseEntities('```json\n{"entities":[{"value":"Alex","type":"PERSON"}]}\n```'), [{ value: 'Alex', type: 'PERSON' }]);
  for (const parse of [parseTopics, parseSuggestions, parseEntities]) {
    assert.deepEqual(parse('none'), [], `${parse.name} does not know that "none" is an answer`);
  }
});

test('every schema here declares what "nothing" means, so no caller has to guess', () => {
  for (const schema of [TOPICS_SCHEMA, ENTITIES_SCHEMA]) {
    assert.ok(schema.nothing, `${schema.name} has no declared empty answer`);
  }
});
