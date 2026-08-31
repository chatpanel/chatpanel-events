import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlowchart, renderFlowchartSvg } from '../flowchart.js';

const SRC = `flowchart TB
    ROOT["Startup anti-patterns"]
    ROOT --> IDEA["Patterns that seem helpful<br/>but create more harm than good"]
    IDEA --> RISK["Risks accumulate"]
    RISK --> FOCUS["Clouded focus"]
    ROOT --> S["Strategy & focus"]
    S --> S1["Lack of focus"]
    classDef root fill:#172554,color:#ffffff,stroke:#172554;
    class ROOT root;`;

test('parses nodes, edges, direction, labels and classes', () => {
  const g = parseFlowchart(SRC);
  assert.equal(g.dir, 'TB');
  assert.equal(g.nodes.size, 6);
  assert.equal(g.edges.length, 5);
  assert.equal(g.nodes.get('IDEA').label, 'Patterns that seem helpful<br/>but create more harm than good');
  assert.equal(g.nodes.get('S').label, 'Strategy & focus', 'unquoted, entities left to the renderer');
  assert.equal(g.nodeClass.get('ROOT'), 'root');
  assert.equal(g.classDefs.get('root').fill, '#172554');
});

test('renders a self-contained SVG honouring classDef colours', () => {
  const svg = renderFlowchartSvg(SRC);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<\/svg>$/);
  assert.ok(svg.includes('#172554'), 'the declared class fill is used');
  assert.match(svg, /marker-end="url\(#a\)"/, 'edges carry an arrowhead');
});

test('every label is XML-escaped — a label can never inject markup', () => {
  const svg = renderFlowchartSvg('flowchart LR\n A["<script>x</script> & co"] --> B["ok"]');
  assert.ok(!/<script>/.test(svg), 'no live script element');
  assert.ok(svg.includes('&lt;script&gt;'), 'escaped instead');
  assert.ok(svg.includes('&amp;'), 'ampersands escaped');
});

test('<br/> and long labels wrap onto multiple lines', () => {
  const svg = renderFlowchartSvg('flowchart TB\n A["one<br/>two"] --> B["b"]');
  const texts = svg.match(/<text[^>]*>[^<]*<\/text>/g) || [];
  assert.ok(texts.some((t) => t.includes('>one<')) && texts.some((t) => t.includes('>two<')), 'br splits lines');
});

test('LR lays out horizontally (wider than tall) and TB vertically', () => {
  const lr = renderFlowchartSvg('flowchart LR\n A["aaa"] --> B["bbb"] --> C["ccc"]');
  const tb = renderFlowchartSvg('flowchart TB\n A["aaa"] --> B["bbb"] --> C["ccc"]');
  const dims = (s) => ({ w: +s.match(/width="(\d+)"/)[1], h: +s.match(/height="(\d+)"/)[1] });
  assert.ok(dims(lr).w > dims(lr).h, 'LR is wider than tall');
  assert.ok(dims(tb).h > dims(tb).w, 'TB is taller than wide');
});

test('non-flowchart diagrams return null so the caller keeps the code block', () => {
  assert.equal(renderFlowchartSvg('sequenceDiagram\n A->>B: hi'), null);
  assert.equal(renderFlowchartSvg('just prose'), null);
  assert.equal(parseFlowchart(''), null);
});

test('a cyclic graph still lays out instead of hanging', () => {
  const svg = renderFlowchartSvg('flowchart TB\n A["a"] --> B["b"]\n B --> C["c"]\n C --> A');
  assert.ok(svg && svg.includes('</svg>'));
});

test('chained edges become separate connections, and arrows inside labels are not connectors', () => {
  const g = parseFlowchart('flowchart TB\n A["a"] --> B["b"] -->|yes| C["c"]');
  assert.equal(g.edges.length, 2, 'A->B and B->C');
  assert.deepEqual(g.edges.map((e) => `${e.from}->${e.to}`), ['A->B', 'B->C']);
  assert.equal(g.edges[1].label, 'yes');
  // An arrow inside a quoted label must not split the line.
  const g2 = parseFlowchart('flowchart LR\n A["build --> ship"] --> B["done"]');
  assert.equal(g2.edges.length, 1);
  assert.equal(g2.nodes.get('A').label, 'build --> ship');
});
