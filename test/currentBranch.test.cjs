const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');

const compiled = esbuild.buildSync({
  stdin: {
    contents: "export { Dataloader } from './src/dataloader'; export { GitService } from './src/gitService';",
    resolveDir: process.cwd(),
    loader: 'ts'
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
  write: false
}).outputFiles[0].text;
const moduleUnderTest = { exports: {} };
vm.runInNewContext(compiled, {
  module: moduleUnderTest,
  exports: moduleUnderTest.exports,
  process,
  console,
  setTimeout,
  clearTimeout,
  require: name => (name === 'vscode' ? { MarkdownString: class {} } : require(name))
});
const { Dataloader, GitService } = moduleUnderTest.exports;

function cachedLoader(repo, service) {
  const loader = new Dataloader({ subscriptions: [] }, { onDidChangeCurrentGitRepo() {}, ...service });
  loader._repo = repo;
  loader._cache.branch = 'old-branch';
  return loader;
}

test('current branch is fresh even when no file watcher event invalidates the cache', async () => {
  const repo = { root: '/fixture', remoteUrl: '' };
  let currentBranch = 'first';
  let queries = 0;
  const loader = cachedLoader(repo, {
    async getCurrentBranch(requestedRepo) {
      assert.equal(requestedRepo, repo);
      queries++;
      return currentBranch;
    }
  });
  assert.equal(await loader.getCurrentBranch(repo), 'first');
  currentBranch = 'second';
  assert.equal(await loader.getCurrentBranch(repo), 'second');
  assert.equal(queries, 2);
});

test('an empty initial cache must not hide the real branch', async () => {
  const repo = { root: '/fixture', remoteUrl: '' };
  const loader = cachedLoader(repo, {
    async getCurrentBranch() {
      return 'main';
    }
  });
  loader._cache.branch = '';
  assert.equal(await loader.getCurrentBranch(repo), 'main');
  assert.equal(await loader.getCurrentBranch(), '');
});

test('real Git HEAD changes are detected in normal repositories and linked worktrees', async () => {
  fs.mkdirSync('.test-vscode', { recursive: true });
  const fixture = fs.mkdtempSync(path.resolve('.test-vscode/branch-regression-'));
  const clone = path.join(fixture, 'repo');
  const worktree = path.join(fixture, 'linked');
  function git(repo, ...args) {
    return childProcess
      .execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      .trim();
  }
  // Reuse existing commits; all ref and HEAD changes stay inside this test clone.
  git(process.cwd(), 'clone', '--shared', '--no-checkout', '--quiet', process.cwd(), clone);
  git(clone, 'update-ref', 'refs/heads/test-before', 'HEAD');
  git(clone, 'update-ref', 'refs/heads/test-after', 'HEAD');
  git(clone, 'worktree', 'add', '--detach', '--quiet', worktree, 'HEAD');
  assert.ok(fs.statSync(path.join(worktree, '.git')).isFile());
  const gitService = Object.create(GitService.prototype);
  gitService._gitPath = 'git';
  for (const root of [clone, worktree]) {
    const repo = { root, remoteUrl: '' };
    const loader = cachedLoader(repo, { getCurrentBranch: gitService.getCurrentBranch.bind(gitService) });
    git(root, 'symbolic-ref', 'HEAD', 'refs/heads/test-before');
    assert.equal(await loader.getCurrentBranch(repo), 'test-before');
    git(root, 'symbolic-ref', 'HEAD', 'refs/heads/test-after');
    assert.equal(await loader.getCurrentBranch(repo), 'test-after');
  }
});
