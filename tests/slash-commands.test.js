import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SLASH_TYPING_RE, enabledSkills, matchSlashRecipe, matchSlashSkill, recipeInvocationText,
  skillInvocationLabel, skillInvocationOf, slashCommandInsert, slashCommandItems,
} from '../slash-commands.js';
import { expandSkillPrompt } from '../skill-vars.js';

const builtins = [
  { command: 'search', icon: '🔎', description: 'Search the web.' },
  { command: 'history', icon: '🕘', description: 'Search prior chats.' },
  { command: 'history meetings', icon: '🎙️', description: 'Search meetings.', feature: 'liveMeetings' },
];
const skills = [
  { id: 's1', command: 'summarize', name: 'Summarize', icon: '📝', description: 'Summarize a page', prompt: 'Summarize:\n\n{{input}}' },
  { id: 's2', command: 'review', name: 'Review', description: 'Review code', prompt: 'Review this carefully.' },
  { id: 's3', command: 'off', name: 'Off', enabled: false, prompt: 'never' },
];

test('built-ins are offered first, and a gated one is shown locked rather than hidden', () => {
  // A Free user should still DISCOVER what Pro unlocks — hiding the command reads as the
  // feature not existing.
  const items = slashCommandItems({ builtins, skills, skillsAllowed: false, features: {} });
  assert.deepEqual(items.map((i) => i.command), ['search', 'history', 'history meetings']);
  assert.equal(items[2].locked, true);
  assert.equal(items[2].type, 'builtin');
  const pro = slashCommandItems({ builtins, skills, skillsAllowed: true, features: { liveMeetings: true } });
  assert.equal(pro.find((i) => i.command === 'history meetings').locked, false);
  assert.deepEqual(pro.filter((i) => i.type === 'skill').map((i) => i.command), ['summarize', 'review'], 'a disabled skill is not a command');
});

test('a client with no built-ins gets just its skills and recipes', () => {
  // The desktop today: no /search, no /monitor — the menu is the user's own skills.
  const items = slashCommandItems({ skills, recipes: [{ name: 'open_bug', description: 'File it' }], skillsAllowed: true });
  assert.deepEqual(items.map((i) => `${i.type}:${i.command}`), ['skill:summarize', 'skill:review', 'recipe:open_bug']);
});

test('the prefix narrows by command, including subcommands with a space', () => {
  const items = slashCommandItems({ builtins, skills, skillsAllowed: true, prefix: 'history m', features: { liveMeetings: true } });
  assert.deepEqual(items.map((i) => i.command), ['history meetings']);
  assert.deepEqual(slashCommandItems({ builtins, skills, skillsAllowed: true, prefix: '/re' }).map((i) => i.command), ['review']);
  assert.equal(slashCommandInsert(items[0]), '/history meetings ');
});

test('the typing pattern opens the menu while the command is being typed, not once args begin', () => {
  assert.ok(SLASH_TYPING_RE.test('/'));
  assert.ok(SLASH_TYPING_RE.test('/sum'));
  assert.ok(SLASH_TYPING_RE.test('/history m'));
  assert.equal(SLASH_TYPING_RE.test('/summarize the thread please'), false);
  assert.equal(SLASH_TYPING_RE.test('summarize'), false);
});

test('a sent /command resolves to its enabled skill and the rest of the line', () => {
  assert.deepEqual(matchSlashSkill('/Summarize  the thread', skills), { skill: skills[0], args: 'the thread' });
  assert.equal(matchSlashSkill('/off now', skills), null, 'a disabled skill does not run');
  assert.equal(matchSlashSkill('/nope', skills), null);
  assert.equal(matchSlashSkill('plain text', skills), null);
  assert.deepEqual(enabledSkills(skills).map((s) => s.id), ['s1', 's2']);
});

test('a recipe command becomes a request to run it, never a prompt expansion', () => {
  const recipes = [{ name: 'open_bug', enabled: true }, { name: 'gone', enabled: false }];
  const m = matchSlashRecipe('/open_bug Crash on start', recipes);
  assert.equal(m.recipe.name, 'open_bug');
  assert.equal(m.args, 'Crash on start');
  assert.equal(matchSlashRecipe('/gone x', recipes), null);
  assert.match(recipeInvocationText(m.recipe, m.args), /Run the saved recipe "open_bug" with this input: Crash on start/);
});

test('the invocation label is the command as typed; the content stays the prompt', () => {
  assert.deepEqual(skillInvocationOf(skills[0], '  the thread '), { command: 'summarize', args: 'the thread', name: 'Summarize', icon: '📝' });
  assert.equal(skillInvocationLabel(skillInvocationOf(skills[0], 'the thread')), '/summarize the thread');
  assert.equal(skillInvocationLabel(skillInvocationOf(skills[1])), '/review');
  assert.equal(skillInvocationOf({ command: '' }, 'x'), null);
  assert.equal(skillInvocationOf(null), null);
  assert.equal(skillInvocationLabel(null), '');
});

test('expandSkillPrompt puts the args in the slot when there is one, after the prompt when not — never both', async () => {
  const inline = await expandSkillPrompt(skills[0].prompt, { args: 'the thread' });
  assert.equal(inline.text, 'Summarize:\n\nthe thread');
  const appended = await expandSkillPrompt(skills[1].prompt, { args: 'the thread' });
  assert.equal(appended.text, 'Review this carefully.\n\nthe thread');
  const bare = await expandSkillPrompt(skills[1].prompt, { args: '  ' });
  assert.equal(bare.text, 'Review this carefully.');
  // Resolvers are still honoured, and what was empty is still reported.
  const dated = await expandSkillPrompt('On {{date}}: {{selection}}', { resolvers: { date: () => '2026-09-12' } });
  assert.equal(dated.text, 'On 2026-09-12: ');
  assert.deepEqual(dated.empty, ['selection']);
});
