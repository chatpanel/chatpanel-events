import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defineSchema, describeSchema, toJsonSchema, responseFormat, RESPONSE_MODES,
  unfence, findJson, rewriteJson, repairJson, coerce, parseStructured, isNothing,
  createStructuredStream, StructuredError, FIELD_TYPES,
} from '../structured.js';

// The schema the voice refinement actually uses — kept here so the tests exercise a real
// shape rather than a convenient one.
const REFINEMENT = defineSchema({
  name: 'refinement',
  purpose: 'What the speaker actually wants done.',
  fields: {
    request: { type: 'string', required: true, max: 200, describe: 'one sentence, their words' },
    name: { type: 'string', max: 48, describe: 'a label of at most 6 words' },
    kind: { type: 'enum', values: ['question', 'monitor', 'note', 'skill', 'none'], default: 'question' },
    skill: { type: 'string', max: 80 },
  },
  nothing: { request: '', name: '', kind: 'none', skill: '' },
});

const TOPICS = defineSchema({
  name: 'topics',
  fields: { topics: { type: 'string[]', maxItems: 6, itemMax: 40 } },
  fallback: 'lines',
});

const ENTITIES = defineSchema({
  name: 'entities',
  fields: {
    entities: {
      type: 'object[]',
      maxItems: 50,
      fields: {
        value: { type: 'string', required: true, max: 200 },
        type: { type: 'enum', values: ['PERSON', 'ORG', 'LOCATION', 'ID', 'EMAIL', 'PHONE', 'OTHER'], default: 'OTHER' },
      },
    },
  },
});

// ---------------------------------------------------------------------------
// Defining
// ---------------------------------------------------------------------------

test('a schema without a name or fields is refused at definition time, not at call time', () => {
  assert.throws(() => defineSchema({ fields: { a: 'string' } }), StructuredError);
  assert.throws(() => defineSchema({ name: 'x' }), StructuredError);
  assert.throws(() => defineSchema({ name: 'x', fields: { a: { type: 'blob' } } }), /unknown type/);
  assert.throws(() => defineSchema({ name: 'x', fields: { a: { type: 'enum', values: [] } } }), /enum with no values/);
});

test('a default that is not one of the enum values is a definition error', () => {
  // Caught here or never: at runtime it silently becomes the answer for every unparseable reply.
  assert.throws(
    () => defineSchema({ name: 'x', fields: { k: { type: 'enum', values: ['a', 'b'], default: 'c' } } }),
    /is not one of its values/,
  );
});

test('field order is declaration order — the prompt asks in it, so the model answers in it', () => {
  assert.deepEqual(REFINEMENT.order, ['request', 'name', 'kind', 'skill']);
});

test('every declared type is one a field can actually be given', () => {
  for (const t of FIELD_TYPES) {
    const spec = t === 'enum' ? { type: t, values: ['a'] } : t === 'object[]' ? { type: t, fields: { a: 'string' } } : { type: t };
    assert.doesNotThrow(() => defineSchema({ name: 't', fields: { f: spec } }));
  }
});

// ---------------------------------------------------------------------------
// The prompt renders from the schema
// ---------------------------------------------------------------------------

test('the prompt names every field, so it cannot drift from the parser', () => {
  const p = describeSchema(REFINEMENT);
  for (const k of REFINEMENT.order) assert.ok(p.includes(`"${k}"`), `prompt omits ${k}`);
  assert.ok(p.includes('"question"|"monitor"|"note"|"skill"|"none"'), 'enum values are not spelled out');
  assert.ok(/ONLY a JSON object/.test(p));
});

test('the prompt carries each field guidance and its limits', () => {
  const p = describeSchema(REFINEMENT);
  assert.ok(p.includes('one sentence, their words'));
  assert.ok(/request .*required/.test(p));
  assert.ok(/name .*at most 48 characters/.test(p));
  assert.ok(/kind .*defaults to "question"/.test(p));
});

test('a list schema shows a list, and an object list shows its item shape', () => {
  assert.ok(describeSchema(TOPICS).includes('[string, …]'));
  const p = describeSchema(ENTITIES);
  assert.ok(p.includes('"value"') && p.includes('"type"'), 'the item shape is not described');
});

// ---------------------------------------------------------------------------
// The same schema as JSON Schema
// ---------------------------------------------------------------------------

test('strict JSON Schema lists every property as required, as the servers demand', () => {
  const js = toJsonSchema(REFINEMENT);
  assert.deepEqual(js.required, REFINEMENT.order);
  assert.equal(js.additionalProperties, false);
  assert.deepEqual(js.properties.kind.enum, ['question', 'monitor', 'note', 'skill', 'none']);
  assert.equal(js.properties.request.description, 'one sentence, their words');
});

test('non-strict JSON Schema requires only what the schema requires', () => {
  assert.deepEqual(toJsonSchema(REFINEMENT, { strict: false }).required, ['request']);
});

test('an object list becomes a nested array schema, not a bare array', () => {
  const js = toJsonSchema(ENTITIES);
  assert.equal(js.properties.entities.type, 'array');
  assert.equal(js.properties.entities.items.properties.type.enum.length, 7);
});

test('the response_format ladder degrades from grammar to JSON mode to nothing', () => {
  assert.deepEqual(RESPONSE_MODES, ['schema', 'object', 'none']);
  assert.equal(responseFormat(REFINEMENT).response_format.type, 'json_schema');
  assert.equal(responseFormat(REFINEMENT).response_format.json_schema.strict, true);
  assert.equal(responseFormat(REFINEMENT, { mode: 'object' }).response_format.type, 'json_object');
  // An agent CLI has no such body at all — the caller must send nothing, not an empty object.
  assert.equal(responseFormat(REFINEMENT, { mode: 'none' }), null);
});

test('the json_schema name is sanitised — a schema name is not a wire identifier', () => {
  const s = defineSchema({ name: 'meeting insights/v2', fields: { a: 'string' } });
  assert.match(responseFormat(s).response_format.json_schema.name, /^[a-zA-Z0-9_-]+$/);
});

// ---------------------------------------------------------------------------
// Finding the JSON — what indexOf/lastIndexOf got wrong
// ---------------------------------------------------------------------------

test('a brace inside a string no longer ends the object early', () => {
  // slice(indexOf('{'), lastIndexOf('}')+1) survives this one; the next test is the one it fails.
  const src = '{"note":"use {braces} carefully","kind":"note"}';
  assert.equal(findJson(src).text, src);
});

test('prose after the object no longer swallows it', () => {
  const src = 'Here you go: {"kind":"note"} — let me know if you want a different } shape.';
  const got = findJson(src);
  assert.equal(got.text, '{"kind":"note"}');
  assert.equal(got.complete, true);
});

test('a truncated object is reported as truncated, not as absent', () => {
  const got = findJson('{"request":"how is the wea');
  assert.equal(got.complete, false);
  assert.equal(got.text, '{"request":"how is the wea');
});

test('an answer with no JSON at all yields nothing', () => {
  assert.equal(findJson('I am not sure what you mean.'), null);
});

test('code fences come off, in every dialect a model writes them', () => {
  assert.equal(unfence('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(unfence('```\n{"a":1}\n```'), '{"a":1}');
  assert.equal(unfence('Sure! Here is the JSON:\n{"a":1}'), '{"a":1}');
  // A fence that is still arriving has no closing marker yet.
  assert.equal(unfence('```json\n{"a":1'), '{"a":1');
});

test('a lead-in is only stripped when a structure follows it', () => {
  assert.equal(unfence('OK'), 'OK', 'a bare "OK" is an answer, not a preamble');
});

// ---------------------------------------------------------------------------
// Repairing almost-JSON
// ---------------------------------------------------------------------------

const repaired = (s, opts) => JSON.parse(repairJson(s, opts));

test('single quotes, unquoted keys and trailing commas all parse', () => {
  assert.deepEqual(repaired("{kind: 'note', name: 'standup', }"), { kind: 'note', name: 'standup' });
});

test('python literals from a model that has read too much python', () => {
  assert.deepEqual(repaired('{"ok": True, "bad": False, "who": None}'), { ok: true, bad: false, who: null });
});

test('comments inside JSON, which a model asked for JSON writes anyway', () => {
  assert.deepEqual(repaired('{\n // the thing they want\n "request": "x" /* sic */ }'), { request: 'x' });
});

test('curly quotes from a model trained on prose', () => {
  assert.deepEqual(repaired('{“kind”: “note”}'), { kind: 'note' });
});

test('a raw newline inside a string is kept rather than breaking the parse', () => {
  assert.deepEqual(repaired('{"request":"line one\nline two"}'), { request: 'line one\nline two' });
});

test('a trailing comma before a closing bracket, at both levels', () => {
  assert.deepEqual(repaired('{"topics":["a","b",],}'), { topics: ['a', 'b'] });
});

test('an unquoted string value is quoted rather than dropped', () => {
  assert.deepEqual(repaired('{"kind": note}'), { kind: 'note' });
});

test('strict mode refuses truncated JSON — that is what `partial` is for', () => {
  assert.equal(repairJson('{"request":"how is the wea'), null);
});

// ---------------------------------------------------------------------------
// Repairing a response that has not finished arriving
// ---------------------------------------------------------------------------

test('an unterminated string value is closed, keeping what has arrived', () => {
  assert.deepEqual(repaired('{"request":"how is the wea', { partial: true }), { request: 'how is the wea' });
});

test('a key with no value yet becomes null — never a guess', () => {
  assert.deepEqual(repaired('{"request":', { partial: true }), { request: null });
});

test('a half-written KEY is dropped: it names nothing yet', () => {
  assert.deepEqual(repaired('{"request":"x","ki', { partial: true }), { request: 'x' });
});

test('open containers are closed in order, however deep', () => {
  assert.deepEqual(
    repaired('{"entities":[{"value":"Alex","type":"PER', { partial: true }),
    { entities: [{ value: 'Alex', type: 'PER' }] },
  );
});

test('every prefix of a real answer parses under partial — the streaming invariant', () => {
  const full = '{"request":"summarise the pricing thread","name":"Pricing thread","kind":"note","skill":""}';
  for (let i = 1; i <= full.length; i++) {
    const out = repairJson(full.slice(0, i), { partial: true });
    if (out == null) continue;                 // before the first '{' there is nothing to read
    assert.doesNotThrow(() => JSON.parse(out), `prefix of length ${i} did not parse: ${out}`);
  }
});

test('a field is settled only when the MODEL closed it, never when we did', () => {
  const mid = rewriteJson('{"request":"summarise the thread","kind":"no', { partial: true });
  assert.ok(mid.settled.has('request'), 'a finished string should be settled');
  assert.ok(!mid.settled.has('kind'), 'a string we closed ourselves must not be settled');
  const done = rewriteJson('{"request":"x","kind":"note"}', { partial: true });
  assert.ok(done.settled.has('request') && done.settled.has('kind'));
});

// ---------------------------------------------------------------------------
// Coercing onto the schema
// ---------------------------------------------------------------------------

test('the happy path, unchanged', () => {
  const v = parseStructured('{"request":"how is the weather","name":"Weather","kind":"question","skill":""}', REFINEMENT);
  assert.deepEqual(v, { request: 'how is the weather', name: 'Weather', kind: 'question', skill: '' });
});

test('"none" as a whole prose answer is an ANSWER, not a parse failure', () => {
  // The bug this closes: read as unparseable, the caller fell back to its deterministic
  // reading and acted on something the model had just said was not a request.
  for (const reply of ['none', 'None.', 'N/A', 'nothing']) {
    const got = coerce(reply, REFINEMENT);
    assert.equal(got.source, 'nothing', `${reply} was not read as a "nothing" answer`);
    assert.deepEqual(got.value, { request: '', name: '', kind: 'none', skill: '' });
  }
});

test('"none" as the value of the required field is the same answer in JSON clothing', () => {
  // Sent verbatim this was a chat message reading "none", which users actually saw.
  const got = coerce('{"request":"none","kind":"question"}', REFINEMENT);
  assert.equal(got.source, 'nothing');
  assert.equal(got.value.kind, 'none');
  assert.equal(isNothing('N/A'), true);
  assert.equal(isNothing('nothing to report here'), false, 'only the whole answer counts');
});

test('a schema that declares no "nothing" gets null for it, rather than an invented empty', () => {
  const bare = defineSchema({ name: 'bare', fields: { request: { type: 'string', required: true } } });
  assert.equal(coerce('none', bare), null);
  assert.equal(coerce('{"request":"none"}', bare), null);
});

test('an unknown enum value falls to the declared default, and a near-miss is mapped', () => {
  assert.equal(parseStructured('{"request":"x","kind":"Monitor."}', REFINEMENT).kind, 'monitor');
  assert.equal(parseStructured('{"request":"x","kind":"a note"}', REFINEMENT).kind, 'note');
  assert.equal(parseStructured('{"request":"x","kind":"webhook"}', REFINEMENT).kind, 'question');
});

test('a key spelled differently is still the key', () => {
  const v = parseStructured('{"Request":"x","Action Items":[],"kind":"note"}', REFINEMENT);
  assert.equal(v.request, 'x', 'casing lost the field entirely');
  const snake = parseStructured('{"request":"x","kind":"note"}', REFINEMENT);
  assert.equal(snake.kind, 'note');
});

test('undeclared keys are dropped — a model that adds a field cannot widen the answer', () => {
  const v = parseStructured('{"request":"x","kind":"note","confidence":0.9,"reasoning":"…"}', REFINEMENT);
  assert.deepEqual(Object.keys(v).sort(), ['kind', 'name', 'request', 'skill']);
});

test('a missing required field rejects the whole answer rather than half-filling it', () => {
  assert.equal(parseStructured('{"kind":"note"}', REFINEMENT), null);
});

test('a string is clipped on a word boundary, not mid-word', () => {
  const long = 'a'.repeat(10) + ' ' + 'b'.repeat(60);
  const v = parseStructured(JSON.stringify({ request: 'x', name: long }), REFINEMENT);
  assert.ok(v.name.length <= 48);
  assert.ok(!/\bb+$/.test(v.name) || v.name.endsWith('a'.repeat(10)), 'clipped mid-word');
});

test('a bare array against a single-list schema is that list', () => {
  // Asked for {"topics":[…]}, models return […] constantly. It is unambiguous, so it is read.
  assert.deepEqual(parseStructured('["pricing","q3 launch"]', TOPICS), { topics: ['pricing', 'q3 launch'] });
});

test('a list is deduped, clipped per item and capped', () => {
  const v = parseStructured('{"topics":["Pricing","pricing","  q3  ","","' + 'x'.repeat(80) + '","a","b","c","d","e"]}', TOPICS);
  assert.equal(v.topics.length, 6);
  assert.equal(v.topics[0], 'Pricing');
  assert.ok(!v.topics.includes('pricing'), 'case-insensitive dedupe failed');
  assert.ok(v.topics.every((t) => t.length <= 40));
});

test('a single value where a list was asked for is a list of one', () => {
  assert.deepEqual(parseStructured('{"topics":"pricing"}', TOPICS), { topics: ['pricing'] });
});

test('a markdown list, when the model ignored "return JSON" entirely', () => {
  const got = coerce('- Pricing\n- Q3 launch\n* Hiring', TOPICS);
  assert.equal(got.source, 'fallback');
  assert.deepEqual(got.value.topics, ['Pricing', 'Q3 launch', 'Hiring']);
});

test('one unbulleted line is prose, not a list of one', () => {
  // Read as an item, "I could not determine any topics." becomes a tag on the note. A list
  // needs either a marker or a second line to be a list.
  assert.equal(coerce('I could not determine any topics.', TOPICS), null);
  assert.deepEqual(coerce('- pricing', TOPICS).value.topics, ['pricing'], 'a marker still makes a list of one');
});

test('a numbered list is the same mistake and reads the same way', () => {
  assert.deepEqual(coerce('1. Pricing\n2) Q3 launch', TOPICS).value.topics, ['Pricing', 'Q3 launch']);
});

test('a list of objects coerces item by item, dropping the ones that are unusable', () => {
  // An item whose own required field is empty is dropped, NOT promoted into a "nothing"
  // answer for the whole list — one unusable entity must not lose the other two.
  const v = parseStructured(
    '{"entities":[{"value":"Alex Rivera","type":"person"},{"value":"","type":"ORG"},{"value":"acme","type":"WIDGET"}]}',
    ENTITIES,
  );
  assert.deepEqual(v.entities, [
    { value: 'Alex Rivera', type: 'PERSON' },
    { value: 'acme', type: 'OTHER' },      // an unknown item enum falls to its default
  ]);
});

test('an answer with nothing usable in it is null, so the caller can fall back', () => {
  assert.equal(coerce('', REFINEMENT), null);
  assert.equal(coerce('I am not sure what you mean.', REFINEMENT), null);
  assert.equal(coerce('{}', REFINEMENT), null);
});

test('a fenced answer with a preamble and a trailing note still reads', () => {
  const messy = 'Sure! Here is the JSON:\n```json\n{\n  request: "check the build",  // their words\n  kind: note,\n}\n```\nLet me know if that helps.';
  assert.deepEqual(parseStructured(messy, REFINEMENT), { request: 'check the build', name: '', kind: 'note', skill: '' });
});

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

test('a structured answer renders as it arrives, one token at a time', () => {
  const full = '{"request":"summarise the pricing thread","name":"Pricing","kind":"note","skill":""}';
  const s = createStructuredStream(REFINEMENT);
  const seen = [];
  for (const ch of full) { const snap = s.push(ch); if (snap.value?.request) seen.push(snap.value.request); }
  const final = s.end();
  assert.equal(final.value.request, 'summarise the pricing thread');
  assert.equal(final.complete, true);
  assert.ok(seen.length > 3, 'the request never appeared progressively');
  assert.ok(seen.some((r) => r.length < 'summarise the pricing thread'.length), 'no intermediate state was visible');
});

test('a field is only reported settled once the model has closed it', () => {
  const s = createStructuredStream(REFINEMENT);
  s.push('{"request":"summarise the pricing thread"');
  assert.ok(s.snapshot().settled.includes('request'));
  s.push(',"kind":"no');
  assert.ok(!s.snapshot().settled.includes('kind'), 'an unfinished enum must not be acted on');
  s.push('te"}');
  assert.ok(s.end().settled.includes('kind'));
  assert.equal(s.snapshot().value.kind, 'note');
});

test('a stream cut off mid-answer still yields what arrived, and says it is incomplete', () => {
  const s = createStructuredStream(REFINEMENT);
  s.push('{"request":"check the build st');
  const final = s.end();
  assert.equal(final.value.request, 'check the build st');
  assert.equal(final.complete, false, 'a truncated answer must not claim to be complete');
});

test('onChange fires on change, not on every token', () => {
  let calls = 0;
  const s = createStructuredStream(REFINEMENT, { onChange: () => { calls++; } });
  for (const ch of '{"request":"abc","kind":"note"}') s.push(ch);
  s.end();
  assert.ok(calls > 0 && calls < 20, `onChange fired ${calls} times`);
});

test('deltas that arrive in arbitrary chunk sizes read the same as one string', () => {
  const full = '{"topics":["pricing","q3 launch","hiring"]}';
  for (const size of [1, 3, 7, 40]) {
    const s = createStructuredStream(TOPICS);
    for (let i = 0; i < full.length; i += size) s.push(full.slice(i, i + size));
    assert.deepEqual(s.end().value.topics, ['pricing', 'q3 launch', 'hiring'], `chunk size ${size}`);
  }
});

test('a stream is reusable — one per call site, reset between calls', () => {
  const s = createStructuredStream(TOPICS);
  s.push('{"topics":["a"]}');
  s.end();
  s.reset();
  assert.equal(s.snapshot().value, null);
  s.push('{"topics":["b"]}');
  assert.deepEqual(s.end().value.topics, ['b']);
});

test('a stream never throws on junk — automation is a passenger, not a driver', () => {
  const s = createStructuredStream(REFINEMENT);
  assert.doesNotThrow(() => { s.push('<<<'); s.push(' {'); s.push('nonsense'); s.end(); });
});
