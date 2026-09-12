import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderContent, toMultimodalMessages, deferAttachedSources, withSourceTool } from '../context-attachments.js';

const page = { id: 'a1', kind: 'url', title: 'Runbook', url: 'https://example.com/runbook', text: 'Cut over Friday. Rollback in 20 minutes.' };
const img = { id: 'i1', kind: 'image', title: 'shot.png', dataUrl: 'data:image/png;base64,AAAA' };

test('text attachments fold into the message as <context> blocks; images do not', () => {
  const text = renderContent({ role: 'user', content: 'what does it say?', attachments: [page, img] });
  assert.match(text, /^what does it say\?\n\n<context source="https:\/\/example\.com\/runbook">\n# \[url\] Runbook\nCut over Friday/);
  assert.doesNotMatch(text, /base64/);
});

test('images become image blocks in the provider\'s shape, on user turns only', () => {
  const msgs = [{ role: 'user', content: 'look', attachments: [img] }, { role: 'assistant', content: 'ok', attachments: [img] }];
  const oa = toMultimodalMessages(msgs, 'openai');
  assert.deepEqual(oa[0].content, [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: img.dataUrl } }]);
  assert.equal(oa[1].content, 'ok');
  const an = toMultimodalMessages(msgs, 'anthropic');
  assert.equal(an[0].content[0].type, 'image');
  assert.equal(an[0].content[0].source.media_type, 'image/png');
});

test('big sources are deferred behind the source tool only when the turn has tools', () => {
  const big = { ...page, text: 'word '.repeat(2000) };
  const msgs = [{ role: 'user', content: 'summarise', attachments: [big] }];
  assert.equal(deferAttachedSources(msgs, null), null, 'no tools → nothing deferred, nothing lost');
  const tools = { specs: [{ name: 'find' }], system: 'S', execute: async () => 'x' };
  const d = deferAttachedSources(msgs, tools);
  assert.ok(d, 'deferred');
  assert.match(d.messages[0].attachments[0].text, /not included — read with `source`/);
  const withTool = withSourceTool(tools, d.store);
  assert.ok(withTool.specs.some((s) => s.name === 'source'));
  assert.match(withTool.system, /Runbook/);
  const small = deferAttachedSources([{ role: 'user', content: 'x', attachments: [page] }], tools);
  assert.equal(small, null, 'a small source travels inline');
});
