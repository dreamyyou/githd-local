const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

exports.run = async function run() {
  const original = vscode.extensions.getExtension('huizhou.githd');
  const local = vscode.extensions.getExtension('wikichen.githd-local');
  assert.ok(original, 'Original extension must be installed in the isolated environment');
  assert.ok(local, 'Local extension must be available');
  await original.activate();
  await local.activate();
  const commands = await vscode.commands.getCommands(true);
  for (const extension of [original, local]) {
    for (const contribution of extension.packageJSON.contributes.commands) {
      assert.ok(commands.includes(contribution.command), `Missing command: ${contribution.command}`);
    }
  }
  const originalCommands = new Set(original.packageJSON.contributes.commands.map(item => item.command));
  assert.ok(local.packageJSON.contributes.commands.every(item => !originalCommands.has(item.command)));
  const originalDoc = await vscode.workspace.openTextDocument(vscode.Uri.parse('githd-empty:smoke'));
  const localDoc = await vscode.workspace.openTextDocument(vscode.Uri.parse('githd-local-empty:smoke'));
  assert.equal(originalDoc.getText(), '');
  assert.equal(localDoc.getText(), '');
  assert.notEqual(originalDoc.uri.scheme, localDoc.uri.scheme);
  const result = {
    original: { id: original.id, active: original.isActive, version: original.packageJSON.version },
    local: { id: local.id, active: local.isActive, version: local.packageJSON.version },
    originalCommands: originalCommands.size,
    localCommands: local.packageJSON.contributes.commands.length,
    isolatedContentProviders: true
  };
  fs.writeFileSync(path.join(__dirname, '../.test-vscode/smoke-result.json'), JSON.stringify(result, null, 2));
  console.log('GitHD coexistence smoke test passed', JSON.stringify(result));
};
