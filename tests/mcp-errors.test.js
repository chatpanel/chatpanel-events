import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainMcpError, packageFromArgs } from '../mcp-errors.js';

// The real failure, verbatim in shape: a published package whose executable has no
// `#!/usr/bin/env node`, so the SHELL ran JavaScript. Twelve lines of noise that say
// nothing about what is wrong, whose fault it is, or what to do — and whose natural
// reading is "ChatPanel is broken", the one interpretation that is definitely false.
const SHEBANG = `local MCP "npx" exited with code 2: /Users/x/.npm/_npx/abc/node_modules/.bin/weather: line 1: import: command not found
/Users/x/.npm/_npx/abc/node_modules/.bin/weather: line 4: const: command not found
/Users/x/.npm/_npx/abc/node_modules/.bin/weather: line 7: syntax error near unexpected token \`('`;

test('a missing shebang is named, and blamed correctly', () => {
  const e = explainMcpError(SHEBANG, { packageName: '@heyg/mcp-weather-server@1.0.2' });
  assert.equal(e.id, 'missing-shebang');
  assert.match(e.summary, /@heyg\/mcp-weather-server/);
  assert.match(e.detail, /#!\/usr\/bin\/env node/);
  // Saying whose bug it is matters as much as what it is: a user who thinks their config
  // is wrong will keep changing their config.
  assert.equal(e.blame, 'package');
  assert.match(e.fix, /author|version|different server/i);
  // The raw output survives — an explanation that hides the evidence cannot be checked.
  assert.ok(e.raw.includes('command not found'));
});

test('a missing bridge is not confused with a broken package', () => {
  const e = explainMcpError("Can't reach the ChatPanel Bridge for local MCP (fetch failed).");
  assert.equal(e.id, 'no-bridge');
  assert.equal(e.blame, 'setup');
});

test('a package that does not exist says so', () => {
  const e = explainMcpError('npm ERR! code E404\nnpm ERR! 404 Not Found - GET https://registry/x');
  assert.equal(e.id, 'not-found');
  assert.equal(e.blame, 'config');
});

test('an unrecognised failure returns null rather than a guess', () => {
  // A confident wrong explanation costs more than showing the output as it came.
  assert.equal(explainMcpError('server closed the connection unexpectedly'), null);
  assert.equal(explainMcpError(''), null);
  assert.equal(explainMcpError(null), null);
});

test('the package name is read from the command, skipping flags', () => {
  assert.equal(packageFromArgs(['-y', '@scope/pkg@1.0.0', '--registry', 'https://r']), '@scope/pkg@1.0.0');
  assert.equal(packageFromArgs(['-y']), '');
});

test('an explanation still works without a package name', () => {
  const e = explainMcpError(SHEBANG);
  assert.match(e.summary, /This MCP server/);
});
