// THE PALETTE, AS DATA — so every client paints the same product.
//
// These values are not new. They are the extension's shipped dashboard stylesheet
// (`meetings.css`, which `notes.css` and `briefs.css` both build on), lifted out of CSS and
// into a form a non-CSS client can read. A SwiftUI or Compose client cannot import a
// stylesheet, and a desktop app that re-types the hexes will drift the first time one is
// tuned — which is the same failure mode as the record model, in a smaller coat.
//
// WHAT BELONGS HERE AND WHAT DOES NOT. Tokens are shared; layout is not. A color named
// `--risk` means the same thing in every surface, so it is a contract. The width of a rail,
// the height of a row and the shape of a shadow are rendering decisions each platform makes
// for itself, and pretending otherwise is how a Mac app ends up looking like a web page.
//
// TWO THEMES, ONE SET OF NAMES. Every token exists in both themes — a name defined in only
// one is what produces the invisible-text-in-light-mode bug. `TOKEN_NAMES` is the guard:
// a test asserts both themes carry exactly it.

export const THEMES = Object.freeze(['light', 'dark']);

/**
 * Semantic roles, and what each is FOR — the part a hex value cannot carry.
 *
 * `bg` is the window; `card` is a raised surface on it; `elev` is raised again (a popover);
 * `field` is a recessed surface (an input, a well). Getting that ladder wrong is why some
 * dark UIs look flat: the surfaces must step in one direction.
 */
export const TOKEN_ROLES = Object.freeze({
  bg: 'the window ground',
  card: 'a surface raised off the ground',
  elev: 'a surface raised off a card — popovers, overlays',
  field: 'a recessed surface — inputs, wells, meters',
  border: 'hairline separators',
  borderStrong: 'a border that must be seen, not merely felt',
  text: 'primary reading colour',
  muted: 'secondary text that is still content',
  faint: 'labels, captions and metadata',
  accent: 'the product colour — selection, links, the active mode',
  accentWeak: 'accent as a background wash',
  decision: 'something settled',
  risk: 'something that can hurt',
  question: 'something open',
  person: 'a person subject',
  topic: 'a topic subject',
  tag: 'a tag subject',
  title: 'a title subject',
});

export const TOKEN_NAMES = Object.freeze(Object.keys(TOKEN_ROLES));

export const LIGHT = Object.freeze({
  bg: '#f5f6f8',
  card: '#ffffff',
  elev: '#ffffff',
  field: '#f7f8fa',
  border: '#e4e7ec',
  borderStrong: '#d3d8e0',
  text: '#181b20',
  muted: '#646b76',
  faint: '#8a909b',
  accent: '#5b5bf0',
  accentWeak: 'rgba(91,91,240,.10)',
  decision: '#15a34a',
  risk: '#dc2626',
  question: '#b45309',
  person: '#7c4dff',
  topic: '#0b84ff',
  tag: '#17a673',
  title: '#b7791f',
});

export const DARK = Object.freeze({
  bg: '#0e1014',
  card: '#16191f',
  elev: '#1b1f26',
  field: '#1f242c',
  border: '#272c34',
  borderStrong: '#353c46',
  text: '#e9ebee',
  muted: '#9aa1ac',
  faint: '#6b7280',
  accent: '#818cf8',
  accentWeak: 'rgba(129,140,248,.13)',
  decision: '#34d399',
  risk: '#f87171',
  question: '#fbbf24',
  person: '#7c4dff',
  topic: '#0b84ff',
  tag: '#17a673',
  title: '#b7791f',
});

export const PALETTES = Object.freeze({ light: LIGHT, dark: DARK });

/** Shape values that are the same in both themes, so they are stated once. */
export const SHAPE = Object.freeze({
  radius: '13px',
  radiusSm: '9px',
  radiusXs: '5px',
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
});

export function paletteFor(theme) {
  return PALETTES[theme] || DARK;
}

/** camelCase → the `--kebab-case` custom property the stylesheets already use. */
export function cssVarName(token) {
  return `--${String(token).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/**
 * A palette as CSS custom-property declarations.
 *
 * Returns only the declarations — the caller wraps them in whatever selector its theming
 * strategy needs (`:root`, `[data-theme="dark"]`, a media query). Deciding the selector here
 * would force one strategy on every client.
 */
export function toCssVars(theme, { includeShape = false } = {}) {
  const palette = paletteFor(theme);
  const lines = TOKEN_NAMES.map((name) => `  ${cssVarName(name)}: ${palette[name]};`);
  if (includeShape) {
    for (const [k, v] of Object.entries(SHAPE)) lines.push(`  ${cssVarName(k)}: ${v};`);
  }
  return lines.join('\n');
}

/**
 * A complete, theme-aware stylesheet block for a web client.
 *
 * Three selectors, and all three are needed: bare `:root` is the light default, the media
 * query serves the "system" setting that stamps no attribute, and `[data-theme]` lets an
 * explicit choice win in BOTH directions. A client that ships only the media query cannot
 * offer a theme switch that overrides the OS.
 */
export function themeStylesheet() {
  return [
    `:root {\n${toCssVars('light', { includeShape: true })}\n  color-scheme: light;\n}`,
    `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {\n${toCssVars('dark')}\n    color-scheme: dark;\n  }\n}`,
    `:root[data-theme="dark"] {\n${toCssVars('dark')}\n  color-scheme: dark;\n}`,
    `:root[data-theme="light"] {\n${toCssVars('light')}\n  color-scheme: light;\n}`,
  ].join('\n\n');
}

/**
 * Resolve the theme actually in force.
 *
 * `preference` is what the user chose — `'light'`, `'dark'` or `'system'`; `systemDark` is
 * what the OS reports. Kept as a function because three surfaces need the same answer and
 * two of them cannot read a media query.
 */
export function resolveTheme(preference, systemDark = false) {
  if (preference === 'light' || preference === 'dark') return preference;
  return systemDark ? 'dark' : 'light';
}
