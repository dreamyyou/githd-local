import * as vs from 'vscode';
import { GitRefType } from './gitService';
import type { GitRef, DiffMode } from './gitService';

export interface DiffRefs {
  leftRef: string;
  rightRef: string;
  mode: DiffMode;
}

interface RefPickItem extends vs.QuickPickItem {
  ref?: string;
  action?: 'main' | 'pair' | 'three-dot' | 'input';
}

function toPickItem(ref: GitRef): RefPickItem {
  let kind = 'Local branch';
  let prefix = 'refs/heads/';
  if (ref.type === GitRefType.RemoteHead) {
    kind = 'Remote branch';
    prefix = 'refs/remotes/';
  } else if (ref.type === GitRefType.Tag) {
    kind = 'Tag';
    prefix = 'refs/tags/';
  }
  return {
    label: ref.name || ref.commit,
    description: `${kind} at ${ref.commit}`,
    ref: ref.name ? prefix + ref.name : ref.commit
  };
}

function validateRef(value: string): string | undefined {
  if (!value.trim() || /\s|\.\./.test(value.trim()) || value.trim().startsWith('-')) {
    return 'Enter one branch, tag or commit SHA';
  }
  return undefined;
}

function parseRefs(value: string, currentRef: string): DiffRefs | undefined {
  const parts = value.trim().split(/(\.{2,})/);
  if (parts.length === 1 && !validateRef(parts[0])) {
    return { leftRef: parts[0].trim(), rightRef: currentRef, mode: 'two-dot' };
  }
  if (
    parts.length === 3 &&
    (parts[1] === '..' || parts[1] === '...') &&
    !validateRef(parts[0]) &&
    !validateRef(parts[2])
  ) {
    return {
      leftRef: parts[0].trim(),
      rightRef: parts[2].trim(),
      mode: parts[1] === '...' ? 'three-dot' : 'two-dot'
    };
  }
  return undefined;
}

function validateRefs(value: string): string | undefined {
  return parseRefs(value, 'HEAD') ? undefined : 'Enter a ref, base .. head, or base ... head';
}

async function selectRef(items: RefPickItem[], title: string, placeHolder: string): Promise<string | undefined> {
  const item = await vs.window.showQuickPick<RefPickItem>(
    [{ label: 'Enter branch, tag or commit SHA…', action: 'input' }, ...items],
    { title, placeHolder }
  );
  if (item?.action !== 'input') {
    return item?.ref;
  }
  const value = await vs.window.showInputBox({ title, prompt: placeHolder, validateInput: validateRef });
  return value !== undefined && !validateRef(value) ? value.trim() : undefined;
}

export async function selectDiffPair(refs: GitRef[], mode: DiffMode): Promise<DiffRefs | undefined> {
  const items = refs.map(toPickItem);
  const name = mode === 'three-dot' ? 'Three-dot diff (PR)' : 'Two-dot diff';
  const leftRef = await selectRef(
    items,
    `GitHD Local: ${name} (1/2)`,
    'Select target / base ref (branch to merge into), tag, or enter a commit'
  );
  if (!leftRef) {
    return undefined;
  }
  const rightRef = await selectRef(
    items,
    `GitHD Local: ${name} (2/2)`,
    `Select comparison / head ref (changes to review) against ${leftRef.replace(/^refs\/(heads|remotes|tags)\//, '')}`
  );
  return rightRef ? { leftRef, rightRef, mode } : undefined;
}

export function findMainRef(refs: GitRef[]): string | undefined {
  if (refs.some(ref => ref.type === GitRefType.Head && ref.name === 'main')) {
    return 'refs/heads/main';
  }
  if (refs.some(ref => ref.type === GitRefType.RemoteHead && ref.name === 'origin/main')) {
    return 'refs/remotes/origin/main';
  }
  return undefined;
}

export async function selectDiffRefs(
  refs: GitRef[],
  currentRef: string,
  currentBranchRef: string = currentRef
): Promise<DiffRefs | undefined> {
  const items = refs.map(toPickItem);
  const currentLabel = currentRef.replace(/^refs\/(heads|remotes|tags)\//, '');
  const selection = await vs.window.showQuickPick<RefPickItem>(
    [
      {
        label: 'Compare current branch with main (three-dot / PR)',
        description: currentBranchRef.replace(/^refs\/(heads|remotes)\//, ''),
        action: 'main'
      },
      { label: 'Compare two refs…', description: 'Two-dot diff', action: 'pair' },
      { label: 'Compare two refs (three-dot / PR)…', action: 'three-dot' },
      { label: 'Enter branch, tag or commit SHA…', action: 'input' },
      ...items
    ],
    { title: 'GitHD Local: Compare', placeHolder: `Select a ref to compare with ${currentLabel}` }
  );
  if (!selection) {
    return undefined;
  }
  if (selection.action === 'main') {
    const mainRef = findMainRef(refs);
    if (!mainRef) {
      await vs.window.showErrorMessage(
        'GitHD Local: Neither main nor origin/main exists. Use Three-dot Diff to select a target.'
      );
      return undefined;
    }
    return { leftRef: mainRef, rightRef: currentBranchRef, mode: 'three-dot' };
  }
  if (selection.action === 'input') {
    const value = await vs.window.showInputBox({
      title: 'GitHD Local: Enter refs',
      prompt: `Enter a ref to compare with ${currentLabel}, base .. head, or base ... head (PR)`,
      validateInput: validateRefs
    });
    return value !== undefined ? parseRefs(value, currentRef) : undefined;
  }
  if (selection.action === 'pair' || selection.action === 'three-dot') {
    return selectDiffPair(refs, selection.action === 'three-dot' ? 'three-dot' : 'two-dot');
  }
  return { leftRef: selection.ref!, rightRef: currentRef, mode: 'two-dot' };
}
