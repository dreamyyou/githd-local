const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

async function waitFor(check, description) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

exports.run = async function run() {
  await require('./host.cjs').run();
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '../.test-vscode/three-dot-fixture.json'), 'utf8'));
  assert.equal(vscode.workspace.workspaceFolders[0].uri.fsPath, fixture.root);
  const git = vscode.extensions.getExtension('vscode.git');
  const gitExtension = await git.activate();
  const api = gitExtension.getAPI(1);
  await waitFor(() => api.repositories.some(repo => repo.rootUri.fsPath === fixture.root), 'Git repository discovery');
  const compareCommand = process.env.GITHD_TEST_PICKER_SHORTCUT ? 'githd-local.diffBranch' : 'githd-local.diffMain';
  if (process.env.GITHD_TEST_PICKER_SHORTCUT) {
    // Accept the first item in the real Compare picker in this isolated test window.
    const pending = vscode.commands.executeCommand(compareCommand);
    const accept = setInterval(
      () => vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem'),
      100
    );
    let timeout;
    try {
      await Promise.race([
        pending,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Compare picker shortcut did not finish')), 10000);
        })
      ]);
    } finally {
      clearInterval(accept);
      clearTimeout(timeout);
    }
  } else {
    await vscode.commands.executeCommand(compareCommand);
  }
  const fileUri = vscode.Uri.file(path.join(fixture.root, 'shared.txt'));
  await vscode.commands.executeCommand('githd-local.openCommittedFile', {
    fileUri,
    oldFileUri: fileUri,
    gitRelativePath: 'shared.txt',
    gitRelativeOldPath: 'shared.txt',
    status: 'M'
  });
  const tab = await waitFor(
    () =>
      vscode.window.tabGroups.all
        .flatMap(group => group.tabs)
        .find(tab => {
          if (!(tab.input instanceof vscode.TabInputTextDiff)) return false;
          return (
            JSON.parse(tab.input.original.query).ref === fixture.base &&
            JSON.parse(tab.input.modified.query).ref === fixture.head
          );
        }),
    'three-dot diff editor with merge-base and head commits'
  );
  const before = await vscode.workspace.openTextDocument(tab.input.original);
  const after = await vscode.workspace.openTextDocument(tab.input.modified);
  assert.equal(before.getText(), 'base\n');
  assert.equal(after.getText(), 'feature\n');
  assert.match(tab.label, /main \.\.\. feature/);
  const result = {
    version: vscode.extensions.getExtension('wikichen.githd-local').packageJSON.version,
    command: compareCommand,
    originalRef: fixture.base,
    modifiedRef: fixture.head,
    before: before.getText(),
    after: after.getText(),
    title: tab.label
  };
  fs.writeFileSync(path.join(__dirname, '../.test-vscode/three-dot-host-result.json'), JSON.stringify(result, null, 2));
  console.log('Real three-dot editor test passed', JSON.stringify(result));
};
