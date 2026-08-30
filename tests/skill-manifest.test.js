import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SKILL_MANIFEST_VERSION, SkillManifestError,
  declaredAccess, isSafeSkillPath, needsBridge, normalizeSkill, originLabel, originOf,
  sameSkillOrigin, skillFiles, skillIsStale, trustOf, upcastSkill, upcastSkills, validateSkill,
} from '../skill-manifest.js';

// A skill exactly as the extension has stored one since before F6 existed.
const v1 = Object.freeze({
  id: 'summarize',
  name: 'Summarize',
  command: 'summarize',
  icon: '📝',
  description: 'Summarize a page',
  context: 'page',
  prompt: 'Summarize the attached page(s).',
  builtin: true,
  mcpMode: 'none',
});

test('a v1 skill upcasts without a single field changing', () => {
  // The Tesla rule at record level. Every F6 field is absence-means-the-old-default, so
  // the upcaster has nothing to fill in and must not invent anything.
  const out = upcastSkill(v1);
  assert.equal(out.v, SKILL_MANIFEST_VERSION);
  for (const [k, val] of Object.entries(v1)) assert.deepEqual(out[k], val, `field '${k}' changed`);
  assert.deepEqual(Object.keys(out).sort(), [...Object.keys(v1), 'v'].sort(), 'no field invented');
  assert.equal(v1.v, undefined, 'upcast must not mutate its input');
});

test('a record already at the current version is left alone', () => {
  const at2 = { ...v1, v: 2 };
  assert.deepEqual(upcastSkill(at2), at2);
});

test('a record from the future is refused, not guessed at', () => {
  assert.throws(() => upcastSkill({ ...v1, v: 99 }), SkillManifestError);
});

test('upcastSkills tolerates a missing list', () => {
  assert.deepEqual(upcastSkills(undefined), []);
  assert.equal(upcastSkills([v1])[0].v, SKILL_MANIFEST_VERSION);
});

// --- trust is derived, never declared --------------------------------------------

test('a skill cannot assert its own trust', () => {
  // Otherwise every check downstream is a formality: an importer writes trust:'built-in'
  // and the review screen believes it.
  const hostile = normalizeSkill({
    id: 'x', name: 'X', trust: 'built-in', builtin: true,
    origin: { source: 'skills-sh', id: 'someone/evil', hash: 'sha256-abc' },
  });
  assert.equal(hostile.trust, undefined, 'a stored trust field must not survive');
  assert.equal(hostile.builtin, false, 'an origin means it is not ours, whatever it claims');
  assert.equal(trustOf(hostile), 'community');
});

test('trust reads provenance', () => {
  assert.equal(trustOf({ builtin: true }), 'built-in');
  assert.equal(trustOf({ id: 'mine' }), 'user');
  assert.equal(trustOf({ origin: { source: 'github', id: 'openai/skills/k8s' } }), 'community');
  // A famous publisher is still community — only what we ship went through our review.
  assert.equal(trustOf({ origin: { source: 'github', id: 'anthropics/skills/pdf' } }), 'community');
});

test('a half-origin is treated as no origin, and dropped', () => {
  // "source but no id" cannot be re-fetched or compared; keeping it would look answered.
  assert.equal(originOf({ origin: { source: 'github' } }), null);
  const out = normalizeSkill({ id: 'x', name: 'X', origin: { source: 'github' } });
  assert.equal('origin' in out, false);
});

// --- package files are a filesystem boundary --------------------------------------

test('directory traversal is rejected everywhere it could appear', () => {
  for (const bad of [
    '../secrets', 'a/../../b', '/etc/passwd', 'C:/Windows/system32', 'a\\..\\b',
    'a//b', './x', 'x/.', ' lead.md', 'trail.md ', 'nul\u0000.md', 'bell\u0007.md', '',
  ]) {
    assert.equal(isSafeSkillPath(bad), false, `should reject ${JSON.stringify(bad)}`);
  }
  for (const ok of ['api.md', 'deep/nested/file.md', 'a-b_c.1.md', 'render.py']) {
    assert.equal(isSafeSkillPath(ok), true, `should accept ${JSON.stringify(ok)}`);
  }
});

test('validate refuses an unsafe path instead of storing it', () => {
  assert.throws(
    () => validateSkill({
      id: 'x', name: 'X',
      origin: { source: 'url', id: 'https://e.example/SKILL.md' },
      files: { references: ['../../.ssh/id_rsa'] },
    }),
    (e) => e.code === 'PATH',
  );
});

test('normalize drops unsafe paths rather than keeping them for a later gate', () => {
  const out = normalizeSkill({
    id: 'x', name: 'X',
    origin: { source: 'url', id: 'https://e.example/SKILL.md' },
    files: { references: ['ok.md', '../escape.md', 'ok.md'] },
  });
  assert.deepEqual(out.files, { references: ['ok.md'] }, 'deduped and filtered');
});

test('an unknown file kind is refused', () => {
  assert.throws(
    () => validateSkill({ id: 'x', name: 'X', files: { '../': ['a'] } }),
    (e) => e.code === 'FILES',
  );
});

test('scripts require an origin, because an unscannable script is the thing to refuse', () => {
  assert.throws(
    () => validateSkill({ id: 'x', name: 'X', files: { scripts: ['run.py'] } }),
    (e) => e.code === 'ORIGIN',
  );
  assert.doesNotThrow(() => validateSkill({
    id: 'x', name: 'X',
    origin: { source: 'github', id: 'o/r/s', hash: 'sha256-a' },
    files: { scripts: ['run.py'] },
  }));
});

test('needsBridge is what stops the extension pretending a script ran', () => {
  const pkg = { id: 'x', name: 'X', origin: { source: 'github', id: 'o/r/s' }, files: { scripts: ['a.py'] } };
  assert.equal(needsBridge(pkg), true);
  assert.equal(needsBridge({ ...pkg, files: { references: ['a.md'] } }), false);
  assert.equal(needsBridge(v1), false);
  assert.deepEqual(skillFiles(v1), {}, 'a non-package has no files');
});

// --- declared access: one derivation, so three surfaces cannot disagree ------------

test('the dropdowns are access statements, not decoration', () => {
  // A record that declared `reads` independently of context/history could claim less
  // than it takes — so the derivation folds them in rather than trusting the field.
  const a = declaredAccess({
    id: 'x', name: 'X', context: 'page', historyContext: 'all', mcpMode: 'selected',
    mcpServerIds: ['fs'], reads: ['net'],
  });
  assert.deepEqual(a.reads, ['chats', 'meetings', 'net', 'page']);
  assert.equal(a.mcp, 'selected');
  assert.deepEqual(a.mcpServerIds, ['fs']);
});

test('context none means no page read', () => {
  assert.deepEqual(declaredAccess({ context: 'none', historyContext: 'none' }).reads, []);
});

test('an out-of-vocabulary value degrades to the safest option, never to itself', () => {
  const a = declaredAccess({ context: 'everything', historyContext: 'everything', mcpMode: 'all', reads: ['root'] });
  assert.equal(a.page, 'auto');
  assert.equal(a.history, 'none');
  assert.equal(a.mcp, 'none');
  assert.deepEqual(a.reads, ['page'], 'an unknown scope is dropped, not carried');
});

test('selected servers are reported only in selected mode', () => {
  assert.deepEqual(declaredAccess({ mcpMode: 'default', mcpServerIds: ['fs'] }).mcpServerIds, []);
});

// --- validation -------------------------------------------------------------------

test('validation covers what a reviewer approves', () => {
  assert.throws(() => validateSkill(null), SkillManifestError);
  assert.throws(() => validateSkill({ name: 'no id' }), (e) => e.code === 'SHAPE');
  assert.throws(() => validateSkill({ id: 'x' }), (e) => e.code === 'SHAPE');
  assert.throws(() => validateSkill({ id: 'x', name: 'X', command: 'Not A Command' }), (e) => e.code === 'SHAPE');
  assert.throws(() => validateSkill({ id: 'x', name: 'X', reads: ['root'] }), (e) => e.code === 'SHAPE');
  assert.throws(() => validateSkill({ id: 'x', name: 'X', context: 'everything' }), (e) => e.code === 'SHAPE');
  assert.throws(() => validateSkill({ id: 'x', name: 'X', origin: { source: 'github' } }), (e) => e.code === 'ORIGIN');
  assert.doesNotThrow(() => validateSkill(v1), 'every shipped v1 skill must still validate');
  assert.doesNotThrow(() => validateSkill({ id: 'x', name: 'X', command: '' }), 'no command is allowed');
});

// --- normalize is total, because it runs where throwing costs an edit --------------

test('normalize keeps the extension behaviour it replaces', () => {
  assert.equal(normalizeSkill({ id: 'a', name: 'A' }).enabled, true, 'absence means enabled');
  assert.equal(normalizeSkill({ id: 'a', name: 'A', enabled: false }).enabled, false);
  assert.equal(normalizeSkill({ id: 'a', name: 'A', mcpMode: 'bogus' }).mcpMode, 'none');
  assert.deepEqual(
    normalizeSkill({ id: 'a', name: 'A', mcpMode: 'selected', mcpServerIds: [' fs ', 'fs', ''] }).mcpServerIds,
    ['fs'],
  );
  assert.deepEqual(
    normalizeSkill({ id: 'a', name: 'A', mcpMode: 'none', mcpServerIds: ['fs'] }).mcpServerIds,
    [], 'ids are cleared when the mode does not use them',
  );
});

test('normalize passes a non-object through, as the writer path expects', () => {
  assert.equal(normalizeSkill(null), null);
  assert.equal(normalizeSkill('x'), 'x');
});

test('normalize stamps the current version — writers write current', () => {
  assert.equal(normalizeSkill(v1).v, SKILL_MANIFEST_VERSION);
});

test('F3.5 fields are deduped and scope-checked, and absent stays absent', () => {
  const out = normalizeSkill({
    id: 'a', name: 'A', sources: ['linear', 'linear'], surfaces: ['rail'], reads: ['net', 'root', 'net'],
  });
  assert.deepEqual(out.sources, ['linear']);
  assert.deepEqual(out.surfaces, ['rail']);
  assert.deepEqual(out.reads, ['net']);
  assert.equal('sources' in normalizeSkill({ id: 'a', name: 'A' }), false, 'absence is not filled in');
});

// --- provenance helpers -----------------------------------------------------------

test('same-origin identifies the same upstream skill for updates', () => {
  const a = { origin: { source: 'skills-sh', id: 'o/r/s', hash: 'sha256-1' } };
  const b = { origin: { source: 'skills-sh', id: 'o/r/s', hash: 'sha256-2' } };
  assert.equal(sameSkillOrigin(a, b), true);
  assert.equal(sameSkillOrigin(a, { origin: { source: 'github', id: 'o/r/s' } }), false);
  assert.equal(sameSkillOrigin(a, v1), false, 'a hand-written skill matches nothing upstream');
});

test('staleness is unanswerable rather than optimistic when nothing was hashed', () => {
  // "null" must not be read as "up to date" — that would silently stop update checks.
  assert.equal(skillIsStale(v1, 'sha256-1'), null);
  assert.equal(skillIsStale({ origin: { source: 's', id: 'i' } }, 'sha256-1'), null);
  assert.equal(skillIsStale({ origin: { source: 's', id: 'i', hash: 'sha256-1' } }, 'sha256-1'), false);
  assert.equal(skillIsStale({ origin: { source: 's', id: 'i', hash: 'sha256-1' } }, 'sha256-2'), true);
});

test('every skill can say where it came from', () => {
  assert.equal(originLabel(v1), 'Built-in');
  assert.equal(originLabel({ id: 'mine', name: 'Mine' }), 'Written here');
  assert.equal(originLabel({ origin: { source: 'browse-sh', id: 'airbnb.com/search' } }), 'browse-sh · airbnb.com/search');
  const long = originLabel({ origin: { source: 'skills-sh', id: 'a'.repeat(80) } });
  assert.ok(long.length < 60 && long.includes('…'), 'a long id is elided, not dropped');
});
