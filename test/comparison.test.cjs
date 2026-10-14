const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');

class Uri {
  constructor(scheme, fsPath, query = '') {
    Object.assign(this, { scheme, fsPath, path: fsPath, query });
  }
  static file(file) {
    return new Uri('file', file);
  }
  static parse(value) {
    return new Uri(value.split(':')[0], value);
  }
  with(values) {
    return Object.assign(new Uri(this.scheme, this.fsPath, this.query), values);
  }
}
const executed = [];
const errors = [];
const vscode = {
  Uri,
  TreeItem: class {},
  MarkdownString: class {},
  commands: {
    executeCommand: (...args) => {
      executed.push(args);
    }
  },
  window: {
    showErrorMessage: message => {
      errors.push(message);
    }
  }
};
const compiled = esbuild.buildSync({
  stdin: {
    contents: `export { GitService } from './src/gitService';
      export { CommandCenter } from './src/commands';
      export { Model } from './src/model';
      export { ContextTracker } from './src/contextTracker';
      export { findMainRef } from './src/refPicker';`,
    resolveDir: process.cwd(),
    loader: 'ts'
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
  write: false
}).outputFiles[0].text;
const mod = { exports: {} };
vm.runInNewContext(compiled, {
  module: mod,
  exports: mod.exports,
  process,
  console,
  setTimeout,
  clearTimeout,
  require: name => (name === 'vscode' ? vscode : require(name))
});
const { GitService, CommandCenter, Model, ContextTracker, findMainRef } = mod.exports;

// Synthetic history lives only in this ignored fixture repository; never commit to the fork or user's repositories.
fs.mkdirSync('.test-vscode', { recursive: true });
const root = fs.mkdtempSync(path.resolve('.test-vscode/comparison-regression-'));
const repo = { root, remoteUrl: '' };
function git(args, input) {
  return childProcess
    .execFileSync('git', ['-C', root, ...args], {
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'GitHD Test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'GitHD Test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid'
      }
    })
    .trim();
}
git(['init', '--quiet']);
git(['config', 'diff.renames', 'true']);
function commit(files, parents = []) {
  const entries = Object.entries(files)
    .sort()
    .map(([name, value]) => {
      const blob = git(['hash-object', '-w', '--stdin'], value);
      return `100644 blob ${blob}\t${name}\n`;
    })
    .join('');
  const tree = git(['mktree'], entries);
  return git(['commit-tree', tree, ...parents.flatMap(parent => ['-p', parent])], 'fixture\n');
}
const originalFiles = { 'shared.txt': 'base\n', 'delete.txt': 'remove\n', 'rename-old.txt': 'rename\n' };
const base = commit(originalFiles);
const main = commit({ ...originalFiles, 'shared.txt': 'main only\n', 'main-only.txt': 'main\n' }, [base]);
const head = commit({ 'shared.txt': 'feature\n', 'added.txt': 'add\n', 'rename-new.txt': 'rename\n' }, [base]);
const unrelated = commit({ 'unrelated.txt': 'unrelated\n' });
git(['update-ref', 'refs/heads/main', main]);
git(['update-ref', 'refs/heads/feature', head]);
git(['update-ref', 'refs/tags/lightweight', main]);
git(['tag', '-a', 'annotated', '-m', 'annotated fixture', head]);
git(['symbolic-ref', 'HEAD', 'refs/heads/feature']);
const service = Object.create(GitService.prototype);
service._gitPath = 'git';

function commandCenter() {
  const model = Object.create(Model.prototype);
  model._filesViewContextTracker = new ContextTracker('githd-local.testBack', 'githd-local.testForward');
  model._onDidChangeFilesViewContext = { fire() {} };
  const center = Object.create(CommandCenter.prototype);
  center._model = model;
  center._gitService = service;
  center._getOrUpdateRepo = async () => repo;
  center._loader = { getCurrentBranch: value => service.getCurrentBranch(value) };
  return center;
}

test('three-dot diff uses merge base and excludes target-only changes', async () => {
  const result = await service.resolveComparison(repo, 'main', 'feature', 'three-dot');
  assert.equal(result.leftRef, base);
  assert.equal(result.rightRef, head);
  const [, files] = await service.getCommittedFiles(repo, result.rightRef, result.leftRef);
  assert.deepEqual(Array.from(files, file => file.gitRelativePath).sort(), [
    'added.txt',
    'delete.txt',
    'rename-new.txt',
    'shared.txt'
  ]);
  assert.equal(
    git(['diff', '--name-status', `${result.leftRef}..${result.rightRef}`]),
    git(['diff', '--name-status', 'main...feature'])
  );
  assert.equal(files.find(file => file.gitRelativePath === 'rename-new.txt').status, 'R');
  const twoDot = await service.resolveComparison(repo, 'main', 'feature', 'two-dot');
  assert.equal(twoDot.leftRef, main);
  assert.match(git(['diff', '--name-status', `${twoDot.leftRef}..${twoDot.rightRef}`]), /main-only.txt/);
});

test('reversing base and head displays target-side changes instead', async () => {
  const result = await service.resolveComparison(repo, 'feature', 'main', 'three-dot');
  assert.equal(result.leftRef, base);
  assert.equal(result.rightRef, main);
});

for (const mode of ['two-dot', 'three-dot']) {
  test(`${mode} accepts lightweight tags, annotated tags and abbreviated commit IDs`, async () => {
    const tags = await service.resolveComparison(repo, 'lightweight', 'annotated', mode);
    const hashes = await service.resolveComparison(repo, main.slice(0, 10), head.slice(0, 10), mode);
    assert.equal(tags.leftRef, mode === 'three-dot' ? base : main);
    assert.equal(tags.rightRef, head);
    assert.equal(hashes.leftRef, tags.leftRef);
    assert.equal(hashes.rightRef, tags.rightRef);
  });
}

test('file list and opened editor use the same merge-base snapshot, including renames/additions/deletions', async () => {
  const center = commandCenter();
  const specifiedPath = Uri.file(path.join(root, 'shared.txt'));
  await center._showComparison(repo, { leftRef: 'main', rightRef: 'feature', mode: 'three-dot' }, specifiedPath);
  const context = center._model.filesViewContext;
  assert.equal(context.specifiedPath, specifiedPath);
  assert.equal(context.leftRef, base);
  assert.equal(context.rightRef, head);
  assert.match(context.comparisonLabel, /main \.\.\. feature/);
  const [, files] = await service.getCommittedFiles(repo, context.rightRef, context.leftRef);
  for (const file of files) {
    center.openCommittedFile(file);
    const [command, left, right, title] = executed.at(-1);
    assert.equal(command, 'vscode.diff');
    assert.match(title, /main \.\.\. feature/);
    if (file.status === 'A') assert.equal(left.scheme, 'githd-local-empty');
    else {
      assert.equal(JSON.parse(left.query).ref, base);
      assert.equal(JSON.parse(left.query).path, path.join(root, file.gitRelativeOldPath));
    }
    if (file.status === 'D') assert.equal(right.scheme, 'githd-local-empty');
    else assert.equal(JSON.parse(right.query).ref, head);
  }
  const modified = files.find(file => file.gitRelativePath === 'shared.txt');
  center.openCommittedFile(modified);
  const [, left, right] = executed.at(-1);
  assert.equal(git(['show', `${JSON.parse(left.query).ref}:shared.txt`]), 'base');
  assert.equal(git(['show', `${JSON.parse(right.query).ref}:shared.txt`]), 'feature');
});

test('back and forward retain comparison mode label and resolved commits', async () => {
  const center = commandCenter();
  await center._showComparison(repo, { leftRef: 'main', rightRef: 'feature', mode: 'three-dot' });
  await center._showComparison(repo, { leftRef: 'main', rightRef: 'feature', mode: 'two-dot' });
  center._model.goBackFilesViewContext();
  assert.equal(center._model.filesViewContext.leftRef, base);
  assert.match(center._model.filesViewContext.comparisonLabel, /\.\.\./);
  center._model.goForwardFilesViewContext();
  assert.equal(center._model.filesViewContext.leftRef, main);
  assert.doesNotMatch(center._model.filesViewContext.comparisonLabel, /\.\.\./);
});

test('main shortcut chooses local main, then origin/main, never a same-named tag', () => {
  const local = { type: 0, name: 'main' };
  const remote = { type: 1, name: 'origin/main' };
  const tag = { type: 2, name: 'main' };
  assert.equal(findMainRef([remote, local]), 'refs/heads/main');
  assert.equal(findMainRef([remote, tag]), 'refs/remotes/origin/main');
  assert.equal(findMainRef([tag]), undefined);
});

test('main shortcut compares real current HEAD and supports detached HEAD', async () => {
  const center = commandCenter();
  await center.diffMain();
  assert.equal(center._model.filesViewContext.leftRef, base);
  assert.equal(center._model.filesViewContext.rightRef, head);
  git(['update-ref', '--no-deref', 'HEAD', head]);
  try {
    await center.diffMain();
    assert.equal(center._model.filesViewContext.leftRef, base);
    assert.equal(center._model.filesViewContext.rightRef, head);
  } finally {
    git(['symbolic-ref', 'HEAD', 'refs/heads/feature']);
  }
});

test('invalid refs, options, tree objects and unrelated histories fail visibly without replacing the current result', async () => {
  const center = commandCenter();
  await center._showComparison(repo, { leftRef: 'main', rightRef: 'feature', mode: 'two-dot' });
  for (const [leftRef, rightRef] of [
    ['missing-ref', 'feature'],
    ['--help', 'feature'],
    ['main^{tree}', 'feature'],
    [unrelated, 'feature']
  ]) {
    const errorCount = errors.length;
    await center._showComparison(repo, { leftRef, rightRef, mode: 'three-dot' });
    assert.equal(errors.length, errorCount + 1);
    assert.match(errors.at(-1), /Cannot compare refs/);
    assert.equal(center._model.filesViewContext.leftRef, main);
  }
});

test('multiple merge bases are reported instead of silently selecting a different base for the editor', async () => {
  const first = commit(originalFiles, [main, head]);
  const second = commit(originalFiles, [head, main]);
  await assert.rejects(service.resolveComparison(repo, first, second, 'three-dot'), /unique common ancestor/);
});

test('main shortcut falls back to origin/main and reports a missing target without opening a result', async () => {
  git(['update-ref', 'refs/remotes/origin/main', main]);
  const center = commandCenter();
  center._gitService = Object.create(service);
  center._gitService.getRefs = async () => [{ type: 1, name: 'origin/main' }];
  await center.diffMain();
  assert.equal(center._model.filesViewContext.leftRef, base);
  assert.equal(center._model.filesViewContext.rightRef, head);
  assert.match(center._model.filesViewContext.comparisonLabel, /origin\/main/);
  center._gitService.getRefs = async () => [];
  const previous = center._model.filesViewContext;
  const errorCount = errors.length;
  await center.diffMain();
  assert.equal(errors.length, errorCount + 1);
  assert.match(errors.at(-1), /Neither main nor origin\/main/);
  assert.equal(center._model.filesViewContext.comparisonLabel, previous.comparisonLabel);
});

test('resolved comparison remains consistent if branch tips move before a file is opened', async () => {
  const result = await service.resolveComparison(repo, 'main', 'feature', 'three-dot');
  git(['update-ref', 'refs/heads/feature', main]);
  try {
    const [, files] = await service.getCommittedFiles(repo, result.rightRef, result.leftRef);
    assert.ok(files.some(file => file.gitRelativePath === 'added.txt'));
    assert.ok(!files.some(file => file.gitRelativePath === 'main-only.txt'));
    assert.equal(git(['show', `${result.rightRef}:shared.txt`]), 'feature');
  } finally {
    git(['update-ref', 'refs/heads/feature', head]);
  }
});

test('identical comparison snapshots in different worktrees preserve the newly selected repository', async () => {
  const center = commandCenter();
  const comparison = await service.resolveComparison(repo, 'main', 'feature', 'three-dot');
  center._model.setFilesViewContext({ repo, ...comparison });
  const otherRepo = { root: root + '-other-worktree', remoteUrl: '' };
  center._model.setFilesViewContext({ repo: otherRepo, ...comparison });
  assert.equal(center._model.filesViewContext.repo, otherRepo);
});

fs.writeFileSync('.test-vscode/three-dot-fixture.json', JSON.stringify({ root, base, main, head }));
