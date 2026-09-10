import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIGHT, DARK, PALETTES, TOKEN_NAMES, THEMES, paletteFor, cssVarName,
  toCssVars, themeStylesheet, resolveTheme,
} from '../theme.js';

test('both themes define exactly the same token names', () => {
  // The bug this prevents: a token defined only in dark renders as nothing in light.
  for (const theme of THEMES) {
    assert.deepEqual(Object.keys(PALETTES[theme]).sort(), [...TOKEN_NAMES].sort(), theme);
  }
});

test('no token is empty in either theme', () => {
  for (const theme of THEMES) {
    for (const [name, value] of Object.entries(PALETTES[theme])) {
      assert.ok(value && String(value).trim(), `${theme}.${name}`);
    }
  }
});

test('light and dark are genuinely different grounds, not a copied palette', () => {
  assert.notEqual(LIGHT.bg, DARK.bg);
  assert.notEqual(LIGHT.text, DARK.text);
});

test('the surface ladder steps in one direction within each theme', () => {
  // bg -> card -> elev must not be flat, or a dark UI reads as a single sheet.
  assert.notEqual(DARK.bg, DARK.card);
  assert.notEqual(DARK.card, DARK.elev);
  assert.notEqual(LIGHT.bg, LIGHT.card);
});

test('camelCase tokens become the kebab-case custom properties the stylesheets use', () => {
  assert.equal(cssVarName('borderStrong'), '--border-strong');
  assert.equal(cssVarName('bg'), '--bg');
  assert.equal(cssVarName('accentWeak'), '--accent-weak');
});

test('an unknown theme falls back to dark rather than to undefined', () => {
  assert.equal(paletteFor('chartreuse'), DARK);
});

test('toCssVars emits one declaration per token', () => {
  const css = toCssVars('dark');
  assert.equal(css.split('\n').length, TOKEN_NAMES.length);
  assert.match(css, /--accent: #818cf8;/);
});

test('the stylesheet carries all three selectors a real theme switch needs', () => {
  const sheet = themeStylesheet();
  assert.match(sheet, /^:root \{/m, 'the light default');
  assert.match(sheet, /prefers-color-scheme: dark/, 'the system setting, which stamps nothing');
  assert.match(sheet, /:root\[data-theme="dark"\]/, 'an explicit choice must win over the OS');
  assert.match(sheet, /:root\[data-theme="light"\]/, 'in both directions');
});

test('resolveTheme honours an explicit choice and otherwise follows the OS', () => {
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
});
