import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, defaultLinkPolicy } from '../markdown-render.js';

test('the basics render', () => {
  assert.match(renderMarkdown('# Title'), /<h1>Title<\/h1>/);
  assert.match(renderMarkdown('**b**'), /<strong>b<\/strong>/);
  assert.match(renderMarkdown('- a\n- b'), /<ul>[\s\S]*<li>a<\/li>[\s\S]*<li>b<\/li>/);
  assert.match(renderMarkdown('`code`'), /<code>code<\/code>/);
});

test('everything is escaped before any markup is emitted', () => {
  // The property the whole file rests on: model output cannot inject.
  const html = renderMarkdown('<script>alert(1)</script>');
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('an image tag smuggled through an alt text cannot escape the attribute', () => {
  const html = renderMarkdown('![" onerror="alert(1)](https://x/y.png)');
  // The right assertion is about BREAKING OUT, not about the substring: `onerror=&quot;`
  // is inert text sitting inside alt="". Asserting on /onerror=/ fails a correct renderer.
  assert.match(html, /alt="&quot; onerror=&quot;alert\(1\)"/);
  assert.doesNotMatch(html, /onerror="/, 'no RAW quote may close the attribute');
});

test('dangerous link schemes are dropped', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,<b>', 'file:///etc/passwd', 'vbscript:x']) {
    const html = renderMarkdown(`[x](${bad})`);
    assert.doesNotMatch(html, /href="(?!")/, bad);
  }
});

test('http, https and mailto survive', () => {
  assert.match(renderMarkdown('[a](https://a.com)'), /href="https:\/\/a\.com"/);
  assert.match(renderMarkdown('[a](mailto:x@y.com)'), /href="mailto:x@y\.com"/);
});

test('an injected policy decides, and the default is the strict one', () => {
  // The extension admits chrome-extension:// for its own pages; a desktop app must not.
  // A client that forgets to pass a policy gets the safe behaviour, not an open door.
  const permissive = (url) => (url.startsWith('app://') ? url : defaultLinkPolicy(url));
  assert.match(renderMarkdown('[a](app://record/1)', { link: permissive }), /href="app:\/\/record\/1"/);
  assert.doesNotMatch(renderMarkdown('[a](app://record/1)'), /app:\/\//);
});

test('a policy that throws drops the link rather than the document', () => {
  const html = renderMarkdown('[a](https://a.com)', { link: () => { throw new Error('boom'); } });
  assert.doesNotMatch(html, /https:\/\/a\.com/);
  assert.match(html, /a/);
});

test('the policy is restored after a render, even one that throws', () => {
  try { renderMarkdown('[a](app://x)', { link: () => { throw new Error('x'); } }); } catch { /* ignore */ }
  // A leaked permissive policy would silently widen every later render in the process.
  assert.doesNotMatch(renderMarkdown('[a](app://x)'), /app:\/\//);
});
