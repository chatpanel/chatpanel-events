import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const index = readFileSync(path.join(root, 'index.js'), 'utf8');
const modules = readdirSync(root).filter((f) => f.endsWith('.js'));

test('everything index.js re-exports actually ships', () => {
  // The published package was one command away from being broken: `files` listed 14 of 26
  // modules, so `import '@chatpanel/events'` would have thrown ERR_MODULE_NOT_FOUND on
  // ./router.js — and an npm version, once burned, cannot be reused. A `files` list edited by
  // hand drifts the moment a module is added; this is the check that notices.
  const needed = [...index.matchAll(/from '\.\/([\w.-]+\.js)'/g)].map((m) => m[1]);
  assert.ok(needed.length > 10, 'the re-export scan found almost nothing — has index.js changed shape?');
  for (const f of needed) {
    assert.ok(pkg.files.includes(f), `index.js re-exports ${f} and package.json "files" omits it`);
  }
});

test('every module is importable by subpath', () => {
  // `exports` is a closed door: a module absent from the map cannot be imported directly even
  // when it is inside the tarball, and the failure looks like the file is missing.
  for (const f of modules) {
    if (f === 'index.js') continue;
    assert.equal(pkg.exports[`./${f}`], `./${f}`, `${f} is not reachable as @chatpanel/events/${f}`);
  }
  assert.equal(pkg.exports['.'], './index.js');
});

test('the license and readme travel with the code', () => {
  for (const f of ['LICENSE', 'README.md']) assert.ok(pkg.files.includes(f), `${f} is not published`);
});
