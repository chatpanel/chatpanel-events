import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBudget, validateBudget, usageOf, BudgetError } from '../budget.js';
import { validateTeam, normalizeTeam, normalizeGrants, grantAllows, TeamError } from '../team.js';
import { fixedPlan, parsePlan, waves, breakCycles, plannerPrompt } from '../team-plan.js';
import { parseFindings, boardText, createBoard, toBriefClaims } from '../team-board.js';
import { runTeam, dryRunTeam } from '../team-run.js';
import { teamToolProvider, TEAM_TOOL_NAME, describeTeamForApproval } from '../team-tool.js';

// ── budget ────────────────────────────────────────────────────────────────────────────
test('a budget must cap something, and refuses what it cannot afford', () => {
  assert.equal(validateBudget({}).ok, false);
  assert.equal(validateBudget({ tokens: -1 }).ok, false);
  assert.equal(validateBudget({ tokens: 1000, pages: 3 }).ok, false, 'an unknown dimension is refused, not ignored');
  assert.throws(() => createBudget({}), (e) => e instanceof BudgetError && e.code === 'INVALID');
  let t = 0;
  const b = createBudget({ tokens: 1000, calls: 3, ms: 5000 }, { now: () => t });
  assert.equal(b.canAfford({ tokens: 900 }), true);
  b.charge({ prompt_tokens: 400, completion_tokens: 200 }); // an OpenAI usage shape
  assert.deepEqual(b.remaining().tokens, 400);
  assert.equal(b.canAfford({ tokens: 500 }), false, 'the next call would cross the cap');
  assert.equal(b.canAfford({ tokens: 100 }), true);
  b.charge({ input_tokens: 100, output_tokens: 100 }); // Anthropic's
  b.charge({ total_tokens: 100 });
  assert.equal(b.exhausted(), 'calls', 'three calls made; calls is the dimension that ran out');
  t = 6000;
  const s = b.snapshot();
  assert.equal(s.spent.ms, 6000);
  assert.equal(s.remaining.ms, 0);
  assert.deepEqual(usageOf({ cost: 0.02 }).usd, 0.02);
});

// ── team ──────────────────────────────────────────────────────────────────────────────
const research = {
  name: 'research', description: 'Find and write',
  roles: [
    { id: 'researcher', prompt: 'Find facts with refs.', prefer: 'balanced', grants: ['data', 'web'] },
    { id: 'writer', prompt: 'Write the answer.', prefer: 'strong', grants: ['none'], dependsOn: ['researcher'] },
  ],
  merge: 'judge', judge: 'writer', budget: { tokens: 20000, ms: 60000 },
};

test('a team without a budget is not a team; a page grant is refused; trust is derived', () => {
  assert.equal(validateTeam({ ...research, budget: undefined }).ok, false);
  assert.ok(validateTeam({ ...research, budget: {} }).errors.some((e) => /budget:/.test(e)));
  const paged = validateTeam({ ...research, roles: [{ id: 'r', prompt: 'x', grants: ['page'] }] });
  assert.equal(paged.ok, false);
  assert.match(paged.errors.join(' '), /a tab is one person's/);
  assert.equal(validateTeam({ ...research, judge: 'nobody' }).ok, false);
  assert.equal(validateTeam({ ...research, roles: [{ id: 'r', prompt: 'x', grants: ['nope'] }] }).ok, false, 'an unknown grant is refused, not ignored');
  const n = normalizeTeam({ ...research, builtin: true, roles: research.roles.map((r) => ({ ...r, grants: ['data', 'data'] })) });
  assert.equal(n.builtin, undefined, 'a stored builtin flag does not survive');
  assert.deepEqual(n.roles[0].grants, ['data']);
  assert.deepEqual(normalizeGrants(['none', 'web']), ['none'], 'none wins');
  assert.equal(grantAllows(['data', 'mcp:jira'], 'mcp', 'jira'), true);
  assert.equal(grantAllows(['data', 'mcp:jira'], 'mcp', 'github'), false);
  assert.equal(grantAllows(['mcp'], 'mcp', 'anything'), true);
  assert.equal(grantAllows(['data', 'web', 'mcp'], 'page'), false, 'page is never grantable');
  assert.throws(() => normalizeTeam({ name: 'x' }), (e) => e instanceof TeamError);
});

// ── plan ──────────────────────────────────────────────────────────────────────────────
test('a fixed plan is one task per role with the roles\' dependencies; a planner\'s answer is read generously', () => {
  const t = normalizeTeam(research);
  const fixed = fixedPlan(t, 'compare X and Y');
  assert.deepEqual(fixed.map((x) => [x.id, x.role, x.dependsOn]), [['t_researcher', 'researcher', []], ['t_writer', 'writer', ['t_researcher']]]);
  assert.match(fixed[0].prompt, /Find facts with refs\.\n\nRequest: compare X and Y/);
  assert.deepEqual(waves(fixed).map((w) => w.map((x) => x.id)), [['t_researcher'], ['t_writer']]);
  const planned = parsePlan('Sure! ```json\n{"tasks":[{"id":"a","role":"researcher","title":"X","prompt":"look up X"},{"id":"b","role":"researcher","title":"Y","prompt":"look up Y"},{"id":"c","role":"writer","title":"write","prompt":"compare","dependsOn":["a","b","zzz"]},{"id":"d","role":"ghost","title":"no","prompt":"nope"}]}\n```', t);
  assert.deepEqual(planned.map((x) => x.id), ['a', 'b', 'c'], 'an unknown role is dropped');
  assert.deepEqual(planned[2].dependsOn, ['a', 'b'], 'a dependency on nothing is dropped');
  assert.deepEqual(waves(planned).map((w) => w.length), [2, 1]);
  assert.deepEqual(parsePlan('none', t), [], 'nothing readable → the caller falls back');
  const cyc = breakCycles([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }]);
  assert.ok(cyc.every((x) => x.dependsOn.length <= 1) && waves(cyc).length >= 1, 'a cycle is broken, never waited on forever');
  assert.match(plannerPrompt(t, 'q'), /researcher: researcher — Find facts/);
});

// ── board ─────────────────────────────────────────────────────────────────────────────
test('findings are read from JSON when present and from prose when not; the board text is sized', () => {
  const f = parseFindings('Here is what I found.\n```json\n{"findings":[{"kind":"claim","text":"X launched in 2024","refs":["note:n1","https://x.example"],"confidence":0.9},{"text":"open question: pricing","kind":"question"}]}\n```', { role: 'researcher', taskId: 't1' });
  assert.equal(f.length, 2);
  assert.equal(f[0].id, 't1:1');
  assert.equal(f[0].confidence, 0.9);
  assert.equal(f[1].kind, 'question');
  const prose = parseFindings('Just a paragraph of prose with no JSON.', { role: 'writer', taskId: 't2' });
  assert.equal(prose.length, 1);
  assert.equal(prose[0].kind, 'draft');
  const b = createBoard({ now: () => 7 });
  const heard = [];
  b.onFinding((x) => heard.push(x.id));
  b.add(f); b.add(prose);
  assert.equal(b.size, 3);
  assert.deepEqual(heard, ['t1:1', 't1:2', 't2:1']);
  assert.match(boardText(b.all(), { taskIds: ['t1'] }), /\[claim · researcher · 90%\] X launched in 2024 \(refs: note:n1, https:\/\/x.example\)/);
  assert.doesNotMatch(boardText(b.all(), { taskIds: ['t1'] }), /paragraph of prose/);
  const many = Array.from({ length: 200 }, (_, i) => ({ kind: 'claim', text: `finding ${i} ${'x'.repeat(100)}`, role: 'r', taskId: 't' }));
  const cut = boardText(many, { max: 3000 });
  assert.match(cut, /earlier ones omitted/);
  assert.ok(cut.length <= 3200);
  assert.match(cut, /finding 199/, 'the newest survive');
  assert.deepEqual(toBriefClaims(f)[0].refs, [{ kind: 'note', id: 'n1' }, { kind: 'url', id: 'https://x.example' }]);
});

// ── run ───────────────────────────────────────────────────────────────────────────────
const scripted = (answers, { usage = { total_tokens: 100 } } = {}) => {
  const calls = [];
  const callModel = async (req) => {
    calls.push(req);
    const a = answers[req.taskId] ?? answers[req.role] ?? '';
    if (typeof a === 'function') return a(req);
    return { ok: true, text: a, usage };
  };
  return { calls, callModel };
};

test('a run plans, fans out in waves with barriers, reads the board, merges through the judge — and every task went through the host', async () => {
  const events = [];
  const { calls, callModel } = scripted({
    t_researcher: '```json\n{"findings":[{"kind":"claim","text":"A costs 10","refs":["note:1"]},{"kind":"claim","text":"B costs 12","refs":["note:2"]}]}\n```',
    t_writer: 'A is cheaper than B.',
    merge: 'Final: A is cheaper (10 vs 12).',
  });
  const toolsSeen = [];
  let t = 0;
  const res = await runTeam({
    team: research, request: 'which is cheaper, A or B?', callModel,
    toolsFor: (role) => { toolsSeen.push([role.id, role.grants]); return role.grants.includes('none') ? undefined : { specs: [{ name: 'find' }], execute: async () => 'x' }; },
    appoint: (role) => ({ model: role.prefer === 'strong' ? 'big' : 'mid', mode: 'model' }),
    now: () => (t += 10), newId: () => 'run_1', emit: (type, p) => events.push([type, p]),
  });
  assert.equal(res.runId, 'run_1');
  assert.equal(res.status, 'completed');
  assert.equal(res.proposal.kind, 'answer');
  assert.match(res.proposal.text, /Final: A is cheaper/);
  assert.equal(res.proposal.by, 'writer');
  assert.deepEqual(calls.map((c) => [c.taskId, c.model]), [['t_researcher', 'mid'], ['t_writer', 'big'], ['merge', 'big']]);
  assert.match(calls[1].prompt, /Findings so far:\n- \[claim · researcher\] A costs 10 \(refs: note:1\)/, 'the writer read the board, not the researcher\'s transcript');
  assert.match(calls[0].prompt, /end your answer with your findings/);
  assert.equal(calls[0].tools?.specs?.[0]?.name, 'find', 'the researcher got the host\'s narrowed toolset');
  assert.equal(calls[1].tools, undefined, 'the writer, granted none, got no tools');
  assert.deepEqual(toolsSeen.map((x) => x[0]), ['researcher', 'writer']);
  assert.equal(res.board.length, 3);
  assert.equal(res.usage.spent.tokens, 300);
  assert.deepEqual(events.map((e) => e[0]), ['run.started', 'plan.ready', 'task.started', 'task.finding', 'task.finding', 'task.done', 'task.started', 'task.finding', 'task.done', 'run.merging', 'run.done']);
  assert.equal(events.at(-1)[1].status, 'completed');
});

test('independent tasks overlap; a dependent one waits; stop fans out; over budget stops with what it has', async () => {
  const team = normalizeTeam({
    name: 'wide', roles: [
      { id: 'a', prompt: 'A', grants: ['none'] }, { id: 'b', prompt: 'B', grants: ['none'] }, { id: 'c', prompt: 'C', grants: ['none'], dependsOn: ['a', 'b'] },
    ],
    merge: 'concat', budget: { tokens: 100000 },
  });
  let active = 0; let peak = 0; const order = [];
  const callModel = async (req) => {
    active += 1; peak = Math.max(peak, active); order.push(req.taskId);
    await new Promise((r) => setTimeout(r, 15));
    active -= 1;
    return { ok: true, text: `${req.taskId} done`, usage: { total_tokens: 100 } };
  };
  const res = await runTeam({ team, request: 'go', callModel, appoint: () => ({ model: 'm' }) });
  assert.equal(peak, 2, 'a and b ran together');
  assert.equal(order[2], 't_c', 'c waited for both');
  assert.equal(res.status, 'completed');
  assert.match(res.proposal.text, /### a\n- t_a done|### a\nt_a done/);
  // 100 + 100 = 200 spent of 150: the budget is exhausted before c can start.
  const tight = await runTeam({ team: { ...team, budget: { tokens: 150 } }, request: 'go', callModel, appoint: () => ({ model: 'm' }) });
  assert.equal(tight.status, 'over-budget');
  assert.equal(tight.tasks.find((x) => x.id === 't_c').status, 'skipped');
  assert.ok(tight.proposal.text.includes('t_a done'), 'the proposal is what it had');
  // Stop: an aborted signal ends the run as stopped, with nothing merged.
  const ac = new AbortController();
  const stopping = runTeam({ team: { ...team, budget: { tokens: 100000 } }, request: 'go', appoint: () => ({ model: 'm' }), signal: ac.signal, callModel: async (req) => { ac.abort(); return { ok: true, text: 'x', aborted: true }; } });
  const r2 = await stopping;
  assert.equal(r2.status, 'stopped');
});

test('converge merges agreeing claims from independent drafters and sends the rest to the human queue', async () => {
  const team = normalizeTeam({
    name: 'wiki', roles: [{ id: 'd1', prompt: 'draft', grants: ['data'] }, { id: 'd2', prompt: 'draft', grants: ['data'] }],
    merge: 'converge', budget: { calls: 10 },
  });
  const findings = (list) => `\`\`\`json\n${JSON.stringify({ findings: list.map((text) => ({ kind: 'claim', text, refs: ['note:1'] })) })}\n\`\`\``;
  const res = await runTeam({
    team, request: 'Atlas', appoint: () => ({ model: 'm' }),
    callModel: async (req) => ({ ok: true, text: req.role === 'd1' ? findings(['Atlas ships in March 2026 on the platform team', 'Atlas is written in Rust']) : findings(['Atlas ships in March 2026 on the platform team', 'Atlas uses Postgres']) }),
  });
  assert.equal(res.status, 'completed');
  assert.equal(res.proposal.kind, 'claims');
  assert.equal(res.proposal.agreed.length, 1);
  assert.match(res.proposal.agreed[0].text, /March 2026/);
  assert.equal(res.proposal.disputed.length, 2);
});

test('a planner that answers nothing readable falls back to the fixed plan; a role with no model fails its task, not the run', async () => {
  const team = normalizeTeam({ ...research, plan: 'planner' });
  const res = await runTeam({
    team, request: 'q', appoint: (role) => (role.id === 'writer' ? { model: 'big' } : null),
    callModel: async (req) => ({ ok: true, text: req.taskId === 'plan' ? 'I cannot plan this.' : 'writer text', usage: { total_tokens: 10 } }),
  });
  assert.equal(res.plan.by, 'fixed');
  assert.equal(res.tasks.find((x) => x.role === 'researcher').status, 'failed');
  assert.match(res.tasks.find((x) => x.role === 'researcher').error, /no model for role/);
  assert.equal(res.status, 'partial');
  assert.ok(res.proposal, 'the judge still merged what there was');
});

// ── the tool ──────────────────────────────────────────────────────────────────────────
test('the team tool: catalogue in the spec, dry run before the card, save on Allow, run through the host', async () => {
  const saved = []; const cards = [];
  const provider = teamToolProvider({
    teams: [{ ...research, enabled: true }],
    appoint: (role) => ({ model: role.prefer === 'strong' ? 'big' : 'mid' }),
    confirmSave: async (detail, t) => { cards.push(detail); return t.name === 'triage' ? 'allow' : 'deny'; },
    saveTeam: async (t) => saved.push(t),
    run: async ({ team, request }) => ({ runId: 'r1', status: 'completed', proposal: { kind: 'answer', text: `did ${request}` }, tasks: [{ id: 't', role: 'researcher', status: 'ok', ms: 5, findings: [] }], board: [], usage: { spent: { tokens: 1 } } }),
  });
  assert.match(provider.specs[0].description, /Saved teams: research \(researcher, writer\) — Find and write/);
  const dry = JSON.parse(await provider.execute(TEAM_TOOL_NAME, { action: 'dry_run', name: 'research', request: 'q' }));
  assert.equal(dry.ok, true);
  assert.deepEqual(dry.roles.map((r) => r.model), ['mid', 'big']);
  assert.equal(dry.tasks.length, 2);
  const ran = JSON.parse(await provider.execute(TEAM_TOOL_NAME, { action: 'run', name: 'research', request: 'compare' }));
  assert.equal(ran.proposal.text, 'did compare');
  assert.match(JSON.parse(await provider.execute(TEAM_TOOL_NAME, { action: 'run', name: 'research' })).error, /needs a request/);
  const bad = JSON.parse(await provider.execute(TEAM_TOOL_NAME, { action: 'save', team: { name: 'nobudget', roles: [{ id: 'r', prompt: 'x' }] } }));
  assert.ok(bad.problems.some((p) => /budget/.test(p)), 'a team without a budget is refused before any card');
  const ok = JSON.parse(await provider.execute(TEAM_TOOL_NAME, { action: 'save', team: { name: 'triage', roles: [{ id: 'r', prompt: 'read', grants: ['data'] }], budget: { calls: 5 } } }));
  assert.equal(ok.saved, 'triage');
  assert.match(cards[0], /triage\nPlan: fixed · merge: concat\n• r — mid · tools: data\nBudget: calls 5/, 'the card names the model the role would get');
  assert.equal(saved[0].enabled, true);
  const no = JSON.parse(await provider.execute(TEAM_TOOL_NAME, { action: 'save', team: { name: 'other', roles: [{ id: 'r', prompt: 'x', grants: ['none'] }], budget: { ms: 1000 } } }));
  assert.equal(no.declined, true);
  assert.match(describeTeamForApproval(normalizeTeam(research), dryRunTeam(research, '', { appoint: () => null })), /NO MODEL AVAILABLE/);
});
