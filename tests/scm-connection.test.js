// An SCM connection holds a secret's NAME, never the secret; a remote maps to one; a job
// gets a branch and a worktree; one process gets the token through its environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConnection, normalizeConnection, parseRemote, connectionFor, branchFor, worktreeDirFor, credentialEnv, describeConnection, connectionFromForm, hostOf, ScmError } from '../scm-connection.js';
import { PREF_SECTIONS, pickSections, applySections } from '../client-prefs.js';

test('a connection never stores a token; the record is the hub, the host, a secret ref and a reach', () => {
  assert.match(validateConnection({ id: 'gh', kind: 'github', token: 'ghp_x' }).errors[0], /never stores a secret/);
  assert.match(validateConnection({ id: 'gh', kind: 'github', password: 'x' }).errors[0], /never stores a secret/);
  assert.throws(() => normalizeConnection({ id: 'gh', kind: 'github', pat: 'x' }), (e) => e instanceof ScmError);
  assert.match(validateConnection({ id: 'ghe', kind: 'github-enterprise' }).errors[0], /baseUrl/);
  assert.match(validateConnection({ id: 'x', kind: 'svn' }).errors[0], /kind/);
  const c = normalizeConnection({ id: 'gh', kind: 'github', reach: ['ChatPanel/*'] });
  assert.equal(c.secretRef, 'chatpanel:scm:gh'); assert.equal(hostOf(c), 'github.com'); assert.deepEqual(c.reach, ['chatpanel/*']);
  assert.equal(c.label, 'github · github.com');
  const e = normalizeConnection({ id: 'corp', kind: 'github-enterprise', baseUrl: 'https://git.corp.example/', label: 'Corp' });
  assert.equal(e.baseUrl, 'https://git.corp.example'); assert.equal(hostOf(e), 'git.corp.example');
  assert.equal(describeConnection(e), 'GitHub Enterprise · git.corp.example');
  assert.equal(describeConnection({ ...c, enabled: false }), 'GitHub · github.com · chatpanel/* (off)');
  const f = connectionFromForm({ kind: 'gitlab', label: 'Work GitLab', reach: 'team/*, team/app' });
  assert.equal(f.ok, true); assert.equal(f.connection.id, 'work-gitlab'); assert.deepEqual(f.connection.reach, ['team/*', 'team/app']);
  // It travels with the prefs document — the record, which has no secret to leak.
  assert.ok(PREF_SECTIONS.some((s) => s.id === 'connections'));
  assert.ok(PREF_SECTIONS.some((s) => s.id === 'agents' && s.path[0] !== 'agents'), 'the pool is not settings.agents (the harness list)');
  const settings = applySections({}, { connections: [c], agents: [{ id: 'a' }] });
  assert.deepEqual(pickSections(settings).connections, [c]);
  assert.equal(settings.agents, undefined); assert.deepEqual(settings.agentPool, [{ id: 'a' }]);
});

test('a remote reads in every spelling, with any credential dropped', () => {
  assert.deepEqual(parseRemote('git@github.com:chatpanel/chatpanel-events.git'), { host: 'github.com', owner: 'chatpanel', name: 'chatpanel-events', protocol: 'ssh' });
  assert.deepEqual(parseRemote('ssh://git@gitlab.com/team/app.git'), { host: 'gitlab.com', owner: 'team', name: 'app', protocol: 'ssh' });
  assert.deepEqual(parseRemote('https://user:secret@github.com/o/n.git'), { host: 'github.com', owner: 'o', name: 'n', protocol: 'https' });
  assert.deepEqual(parseRemote('https://dev.azure.com/org/proj/_git/repo'), { host: 'dev.azure.com', owner: 'org/proj', name: 'repo', protocol: 'https' });
  assert.deepEqual(parseRemote('https://gitlab.com/a/b/c'), { host: 'gitlab.com', owner: 'a/b', name: 'c', protocol: 'https' });
  assert.equal(parseRemote('https://github.com/'), null);
  assert.equal(parseRemote(''), null);
});

test('the connection for a remote: same host, the most specific reach wins, disabled ones never', () => {
  const any = normalizeConnection({ id: 'any', kind: 'github' });
  const org = normalizeConnection({ id: 'org', kind: 'github', reach: ['acme/*'] });
  const one = normalizeConnection({ id: 'one', kind: 'github', reach: ['acme/app'] });
  const off = normalizeConnection({ id: 'off', kind: 'github', reach: ['acme/app'], enabled: false });
  const gl = normalizeConnection({ id: 'gl', kind: 'gitlab' });
  assert.equal(connectionFor('git@github.com:acme/app.git', [gl, any, org, off, one]).id, 'one');
  assert.equal(connectionFor('git@github.com:acme/other.git', [any, org, one]).id, 'org');
  assert.equal(connectionFor('git@github.com:someone/x.git', [org, one, any]).id, 'any');
  assert.equal(connectionFor('git@github.com:someone/x.git', [org, one]), null, 'a reach is a boundary');
  assert.equal(connectionFor('https://gitlab.com/t/a', [any, gl]).id, 'gl');
  assert.equal(connectionFor('nonsense', [any]), null);
});

test('a job’s names: the branch is always under cp/, the worktree dir mirrors it', () => {
  assert.equal(branchFor('Naming Phase 2', 'events: relabel'), 'cp/naming-phase-2/events-relabel');
  assert.equal(worktreeDirFor('Naming Phase 2', 'events: relabel'), 'naming-phase-2/events-relabel');
  assert.equal(branchFor('../main', '..'), 'cp/main/x', 'nothing escapes the prefix');
});

test('the credential lives in ONE process’s environment, scoped to the host — never a file, never the command line', () => {
  const env = credentialEnv({ kind: 'github' }, 'ghp_secret');
  assert.equal(env.GIT_CONFIG_KEY_0, 'credential.https://github.com.helper');
  assert.match(env.GIT_CONFIG_VALUE_0, /CHATPANEL_SCM_TOKEN/);
  assert.equal(env.GIT_CONFIG_VALUE_0.includes('ghp_secret'), false, 'the helper reads the env; the value is not in it');
  assert.equal(env.CHATPANEL_SCM_TOKEN, 'ghp_secret'); assert.equal(env.CHATPANEL_SCM_USER, 'x-access-token');
  assert.equal(env.GH_TOKEN, 'ghp_secret'); assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GH_HOST, undefined);
  const ghe = credentialEnv({ kind: 'github-enterprise', baseUrl: 'https://git.corp.example' }, 't');
  assert.equal(ghe.GIT_CONFIG_KEY_0, 'credential.https://git.corp.example.helper'); assert.equal(ghe.GH_HOST, 'git.corp.example');
  const gl = credentialEnv({ kind: 'gitlab', username: 'me' }, 't');
  assert.equal(gl.CHATPANEL_SCM_USER, 'me'); assert.equal(gl.GITLAB_TOKEN, 't');
  assert.deepEqual(credentialEnv({ kind: 'github' }, ''), {}, 'no token, no env');
});
