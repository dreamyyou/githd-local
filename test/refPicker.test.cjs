const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const esbuild = require('esbuild');

const compiled = esbuild.buildSync({
  entryPoints: ['src/refPicker.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
  write: false
}).outputFiles[0].text;
const refs = [
  { name: 'main', commit: '1111111', type: 0 },
  { name: 'feature', commit: '2222222', type: 0 },
  { name: 'origin/main', commit: '1111111', type: 1 },
  { name: 'v1', commit: '3333333', type: 2 }
];

async function pick(choices, input, data = refs, pairMode, currentRef = 'main', currentBranchRef = currentRef) {
  const calls = [];
  const errors = [];
  let inputCalls = 0;
  const inputs = Array.isArray(input) ? [...input] : [input];
  const window = {
    async showQuickPick(items, options) {
      calls.push({ count: items.length, options, firstAction: items[0].action });
      const choice = choices.shift();
      if (choice === undefined) return undefined;
      return items.find(item => item.action === choice || item.ref === choice || item.label === choice);
    },
    showErrorMessage(message) {
      errors.push(message);
    },
    async showInputBox(options) {
      inputCalls++;
      const value = inputs.shift();
      if (value !== undefined && options.validateInput(value)) return undefined;
      return value;
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    process,
    module,
    exports: module.exports,
    require: name => (name === 'vscode' ? { window, MarkdownString: class {} } : require(name))
  });
  const result = pairMode
    ? await module.exports.selectDiffPair(data, pairMode)
    : await module.exports.selectDiffRefs(data, currentRef, currentBranchRef);
  return { result: result && JSON.parse(JSON.stringify(result)), calls, errors, inputCalls };
}

test('single branch keeps selected ref on the left and current ref on the right', async () => {
  const { result, calls } = await pick(['feature']);
  assert.deepEqual(result, { leftRef: 'refs/heads/feature', rightRef: 'main', mode: 'two-dot' });
  assert.equal(calls.length, 1);
});
test('two-step comparison preserves direction and supports remote refs and tags', async () => {
  const { result, calls } = await pick(['pair', 'origin/main', 'v1']);
  assert.deepEqual(result, { leftRef: 'refs/remotes/origin/main', rightRef: 'refs/tags/v1', mode: 'two-dot' });
  assert.deepEqual(
    calls.map(call => call.count),
    [8, 5, 5]
  );
});
test('different refs pointing to the same commit remain selectable', async () => {
  assert.deepEqual((await pick(['pair', 'main', 'origin/main'])).result, {
    leftRef: 'refs/heads/main',
    rightRef: 'refs/remotes/origin/main',
    mode: 'two-dot'
  });
});
for (const choices of [[], ['pair'], ['pair', 'main'], ['input']]) {
  test(`cancel is harmless at ${JSON.stringify(choices)}`, async () => {
    assert.equal((await pick([...choices])).result, undefined);
  });
}
for (const [input, expected] of [
  [' feature ', { leftRef: 'feature', rightRef: 'main', mode: 'two-dot' }],
  [' main .. origin/main ', { leftRef: 'main', rightRef: 'origin/main', mode: 'two-dot' }],
  ['abc1234 .. def5678', { leftRef: 'abc1234', rightRef: 'def5678', mode: 'two-dot' }],
  ['', undefined],
  ['main..', undefined],
  ['..main', undefined],
  ['main...feature', { leftRef: 'main', rightRef: 'feature', mode: 'three-dot' }],
  ['main....feature', undefined],
  ['a..b..c', undefined],
  ['--help', undefined],
  ['a... ', undefined]
]) {
  test(`manual input ${JSON.stringify(input)}`, async () => {
    assert.deepEqual((await pick(['input'], input)).result, expected);
  });
}
test('ten thousand refs produce linear-size menus', async () => {
  const data = Array.from({ length: 10000 }, (_, index) => ({ name: `branch-${index}`, commit: `${index}`, type: 0 }));
  const { result, calls } = await pick(['pair', 'branch-0', 'branch-9999'], undefined, data);
  assert.deepEqual(result, { leftRef: 'refs/heads/branch-0', rightRef: 'refs/heads/branch-9999', mode: 'two-dot' });
  assert.deepEqual(
    calls.map(call => call.count),
    [10004, 10001, 10001]
  );
});
test('manifest and runtime use the isolated namespace', () => {
  const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.equal(`${manifest.publisher}.${manifest.name}`, 'wikichen.githd-local');
  for (const color of manifest.contributes.colors) {
    assert.match(color.id, /^githdLocal\.[A-Za-z0-9.]+$/);
  }
  for (const command of manifest.contributes.commands) assert.ok(command.command.startsWith('githd-local.'));
  for (const key of Object.keys(manifest.contributes.configuration.properties))
    assert.ok(key.startsWith('githd-local.'));
  for (const file of fs.readdirSync('src').filter(file => file.endsWith('.ts'))) {
    const source = fs.readFileSync(`src/${file}`, 'utf8');
    assert.doesNotMatch(source, /['"`]githd(?:[.'"`]|-(?!local))/);
    assert.doesNotMatch(source, /['"]canGoForwardFilesView['"]/);
  }
});

for (const mode of ['two-dot', 'three-dot']) {
  test(`${mode}: each side accepts a manually entered commit`, async () => {
    const { result } = await pick(['input', 'input'], ['abc1234', 'def5678'], refs, mode);
    assert.deepEqual(result, { leftRef: 'abc1234', rightRef: 'def5678', mode });
  });
  test(`${mode}: tag and entered commit can be mixed`, async () => {
    const { result } = await pick(['v1', 'input'], 'abc1234', refs, mode);
    assert.deepEqual(result, { leftRef: 'refs/tags/v1', rightRef: 'abc1234', mode });
  });
  for (const choices of [[], ['input'], ['main'], ['main', 'input']]) {
    test(`${mode}: cancellation at ${JSON.stringify(choices)}`, async () => {
      assert.equal((await pick([...choices], undefined, refs, mode)).result, undefined);
    });
  }
}
test('existing picker exposes three-dot comparison without enumerating combinations', async () => {
  const { result, calls } = await pick(['three-dot', 'main', 'feature']);
  assert.deepEqual(result, { leftRef: 'refs/heads/main', rightRef: 'refs/heads/feature', mode: 'three-dot' });
  assert.deepEqual(
    calls.map(call => call.count),
    [8, 5, 5]
  );
});
test('same-named branch and tag use unambiguous full ref names', async () => {
  const sameNames = [
    { name: 'v1', commit: '111', type: 0 },
    { name: 'v1', commit: '222', type: 2 }
  ];
  const { result } = await pick(['refs/heads/v1', 'refs/tags/v1'], undefined, sameNames, 'three-dot');
  assert.deepEqual(result, { leftRef: 'refs/heads/v1', rightRef: 'refs/tags/v1', mode: 'three-dot' });
});

test('first picker entry compares current branch to main with one click and no input', async () => {
  const { result, calls, inputCalls } = await pick(['main'], undefined, refs, undefined, 'refs/heads/feature');
  assert.deepEqual(result, { leftRef: 'refs/heads/main', rightRef: 'refs/heads/feature', mode: 'three-dot' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].firstAction, 'main');
  assert.equal(inputCalls, 0);
});
test('picker shortcut falls back to origin/main without another picker', async () => {
  const data = refs.filter(ref => ref.type !== 0 || ref.name !== 'main');
  const { result, calls, inputCalls } = await pick(['main'], undefined, data, undefined, 'refs/heads/feature');
  assert.deepEqual(result, { leftRef: 'refs/remotes/origin/main', rightRef: 'refs/heads/feature', mode: 'three-dot' });
  assert.equal(calls.length, 1);
  assert.equal(inputCalls, 0);
});
test('picker shortcut reports missing main without prompting for refs', async () => {
  const { result, calls, errors, inputCalls } = await pick(['main'], undefined, [], undefined, 'HEAD');
  assert.equal(result, undefined);
  assert.equal(calls.length, 1);
  assert.equal(inputCalls, 0);
  assert.match(errors[0], /Neither main nor origin\/main/);
});
test('shortcut uses current branch even when the picker was opened from a historical commit', async () => {
  const { result } = await pick(['main'], undefined, refs, undefined, 'abc1234', 'refs/heads/feature');
  assert.deepEqual(result, { leftRef: 'refs/heads/main', rightRef: 'refs/heads/feature', mode: 'three-dot' });
});
