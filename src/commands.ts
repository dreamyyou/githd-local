import * as path from 'path';

import * as vs from 'vscode';

import { Model, HistoryViewContext } from './model';
import { HistoryViewProvider } from './historyViewProvider';
import { InfoViewProvider } from './infoViewProvider';
import { GitService, GitRepo, GitRefType, GitCommittedFile } from './gitService';
import { Tracer } from './tracer';
import { ExplorerViewProvider } from './explorerViewProvider';
import { Dataloader } from './dataloader';
import { PanelViewProvider } from './panelViewProvider';
import { findMainRef, selectDiffPair, selectDiffRefs } from './refPicker';
import type { DiffRefs } from './refPicker';

function toGitUri(uri: vs.Uri, ref?: string): vs.Uri {
  return uri.with({
    scheme: 'git',
    path: uri.path,
    query: JSON.stringify({
      path: uri.fsPath,
      ref
    })
  });
}

async function selectBranch(
  gitService: GitService,
  repo: GitRepo,
  allowEnterSha?: boolean
): Promise<vs.QuickPickItem[]> {
  const refs = await gitService.getRefs(repo);
  const items = refs.map(ref => {
    let description: string | undefined;
    if (ref.type === GitRefType.Head) {
      description = ref.commit;
    } else if (ref.type === GitRefType.Tag) {
      description = `Tag at ${ref.commit}`;
    } else if (ref.type === GitRefType.RemoteHead) {
      description = `Remote branch at ${ref.commit}`;
    }
    return { label: ref.name || ref.commit, description };
  });
  if (allowEnterSha) items.unshift(new EnterShaPickItem());
  return items;
}

interface RepoPickItem extends vs.QuickPickItem {
  repo: GitRepo;
}

class EnterShaPickItem implements vs.QuickPickItem {
  label = 'Enter commit SHA';
  description = '';
  openShaTextBox = true;
}

async function selectGitRepo(gitService: GitService): Promise<GitRepo | undefined> {
  const repos: GitRepo[] = gitService.getGitRepos();
  if (repos.length === 0) {
    return;
  }
  if (repos.length === 1) {
    return repos[0];
  }
  const pickItems: RepoPickItem[] = repos.map(repo => {
    return { label: path.basename(repo.root), description: repo.root, repo };
  });
  const item = await vs.window.showQuickPick(pickItems, {
    placeHolder: 'Select the git repo'
  });
  return item?.repo;
}

async function selectAuthor(gitService: GitService, repo: GitRepo): Promise<vs.QuickPickItem[]> {
  let authors = await gitService.getAuthors(repo);
  authors.unshift({ name: 'All', email: '' });
  return authors.map(author => {
    return { label: author.name, description: author.email };
  });
}

interface Command {
  id: string;
  method: Function;
}

const Commands: Command[] = [];

function command(id: string) {
  return function (_target: any, _key: string, descriptor: PropertyDescriptor) {
    if (!(typeof descriptor.value === 'function')) {
      throw new Error('not supported');
    }
    Commands.push({ id, method: descriptor.value });
  };
}

export class CommandCenter {
  constructor(
    context: vs.ExtensionContext,
    private _model: Model,
    private _loader: Dataloader,
    private _gitService: GitService,
    private _historyView: HistoryViewProvider,
    private _explorerView: ExplorerViewProvider
  ) {
    // register an empty document content provider
    vs.workspace.registerTextDocumentContentProvider('githd-local-empty', {
      provideTextDocumentContent: () => ''
    });

    context.subscriptions.push(
      ...Commands.map(({ id, method }) => {
        return vs.commands.registerCommand(id, (...args: any[]) =>
          Promise.resolve(method.apply(this, args)).catch(err => Tracer.error(`command ${id} failed ${err.message}`))
        );
      })
    );
  }

  @command('githd-local.viewHistory')
  async viewHistory(): Promise<void> {
    Tracer.verbose('Command: githd-local.viewHistory');
    const repo = await this._getOrUpdateRepo();
    if (repo) {
      this._viewHistory({ repo, branch: '' });
    }
  }

  @command('githd-local.viewFileHistory')
  async viewFileHistory(specifiedPath = vs.window.activeTextEditor?.document?.uri): Promise<void> {
    Tracer.verbose('Command: githd-local.viewFileHistory');
    if (!specifiedPath) {
      return;
    }
    let repo = await this._gitService.getGitRepo(specifiedPath.fsPath);
    if (!repo) {
      return;
    }
    return this._viewHistory({ specifiedPath, repo, branch: '' });
  }

  @command('githd-local.viewFolderHistory')
  async viewFolderHistory(specifiedPath: vs.Uri): Promise<void> {
    Tracer.verbose('Command: githd-local.viewFolderHistory');
    return this.viewFileHistory(specifiedPath);
  }

  @command('githd-local.viewLineHistory')
  async viewLineHistory(file = vs.window.activeTextEditor?.document?.uri): Promise<void> {
    Tracer.verbose('Command: githd-local.viewLineHistory');
    if (!file) {
      return;
    }

    let repo = await this._gitService.getGitRepo(file.fsPath);
    if (!repo) {
      return;
    }
    let line = vs.window.activeTextEditor?.selection?.active?.line;
    if (!line) {
      return;
    }
    line++;
    return this._viewHistory({ specifiedPath: file, line, repo, branch: '' });
  }

  @command('githd-local.viewAllHistory')
  async viewAllHistory(): Promise<void> {
    Tracer.verbose('Command: githd-local.viewAllHistory');
    if (this._model.historyViewContext) {
      return this._viewHistory(this._model.historyViewContext, true);
    }

    const selected = await this._getOrUpdateRepo();
    if (!selected) {
      return;
    }
    this._model.setHistoryViewContext({ repo: selected, branch: '' });
  }

  @command('githd-local.viewBranchHistory')
  async viewBranchHistory(context?: HistoryViewContext): Promise<void> {
    Tracer.verbose('Command: githd-local.viewBranchHistory');
    let placeHolder: string = `Select a ref to see it's history`;
    let repo: GitRepo;
    if (context) {
      repo = context.repo;
      const specifiedPath = this._model.historyViewContext?.specifiedPath;
      if (specifiedPath) {
        placeHolder += ` of ${path.basename(specifiedPath.fsPath)}`;
      }
    } else {
      const selected = await this._getOrUpdateRepo();
      if (!selected) {
        return;
      }
      repo = selected;
    }
    placeHolder += ` (${repo.root})`;

    vs.window.showQuickPick(selectBranch(this._gitService, repo), { placeHolder }).then(item => {
      if (item) {
        if (context) {
          context.branch = item.label;
          this._viewHistory(context);
        } else {
          this._viewHistory({ branch: item.label, repo });
        }
      }
    });
  }

  @command('githd-local.viewAuthorHistory')
  viewAuthorHistory(): void {
    Tracer.verbose('Command: githd-local.viewAuthorHistory');
    const context = this._model.historyViewContext as HistoryViewContext;
    let placeHolder: string = `Select a author to see his/her commits`;
    vs.window
      .showQuickPick(selectAuthor(this._gitService, context.repo), {
        placeHolder
      })
      .then(item => {
        if (item) {
          const email = item.description;
          let context = this._model.historyViewContext;
          if (context) {
            context.author = email;
            this._viewHistory(context);
          }
        }
      });
  }

  @command('githd-local.viewStashes')
  async viewStashes(): Promise<void> {
    Tracer.verbose('Command: githd-local.viewStashes');
    const repo = await this._getOrUpdateRepo();
    if (repo) {
      this._viewHistory({ repo, isStash: true, branch: '' });
    }
  }

  @command('githd-local.diffBranch')
  async diffBranch(): Promise<void> {
    Tracer.verbose('Command: githd-local.diffBranch');
    const repo = await this._getOrUpdateRepo();
    if (!repo) {
      return;
    }
    return this._diffSelections(repo);
  }

  @command('githd-local.diffThreeDot')
  async diffThreeDot(): Promise<void> {
    const repo = await this._getOrUpdateRepo();
    if (!repo) {
      return;
    }
    const selection = await selectDiffPair(await this._gitService.getRefs(repo), 'three-dot');
    if (selection) {
      await this._showComparison(repo, selection);
    }
  }

  @command('githd-local.diffMain')
  async diffMain(): Promise<void> {
    const repo = await this._getOrUpdateRepo();
    if (!repo) {
      return;
    }
    const mainRef = findMainRef(await this._gitService.getRefs(repo));
    if (!mainRef) {
      await vs.window.showErrorMessage(
        'GitHD Local: Neither main nor origin/main exists. Use Three-dot Diff to select a target.'
      );
      return;
    }
    const branch = await this._loader.getCurrentBranch(repo);
    const rightRef = branch && branch !== 'HEAD' ? `refs/heads/${branch}` : 'HEAD';
    await this._showComparison(repo, { leftRef: mainRef, rightRef, mode: 'three-dot' });
  }

  @command('githd-local.diffFile')
  // explorer/context will pass two args while editor/context will one
  async diffFile(specifiedPath: vs.Uri, _: any, ref?: string): Promise<void> {
    Tracer.verbose('Command: githd-local.diffFile');
    return this._diffPath(specifiedPath, ref);
  }

  @command('githd-local.diffFolder')
  // explorer/context will pass two args while editor/context will one
  async diffFolder(specifiedPath: vs.Uri, _: any, ref?: string): Promise<void> {
    Tracer.verbose('Command: githd-local.diffFolder');
    return this._diffPath(specifiedPath, ref);
  }

  @command('githd-local.inputRef')
  async inputRef(): Promise<void> {
    Tracer.verbose('Command: githd-local.inputRef');
    const repo = await this._getOrUpdateRepo();
    if (!repo) {
      return;
    }
    vs.window
      .showInputBox({
        placeHolder: `Input a ref(sha1) to see it's committed files`
      })
      .then(ref => this._model.setFilesViewContext({ rightRef: ref?.trim(), repo }));
  }

  @command('githd-local.openCommit')
  openCommit(repo: GitRepo, ref: string, specifiedPath: vs.Uri): void {
    Tracer.verbose('Command: githd-local.openCommit');
    this._model.setFilesViewContext({ rightRef: ref, repo, specifiedPath });
  }

  @command('githd-local.goBackHistoryView')
  goBackHistoryView(): void {
    Tracer.verbose('Command: githd-local.goBackHistoryView');
    this._model.goBackHistoryViewContext();
  }

  @command('githd-local.goForwardHistoryView')
  goForwardHistoryView(): void {
    Tracer.verbose('Command: githd-local.goForwardHistoryView');
    this._model.goForwardHistoryViewContext();
  }

  @command('githd-local.goBackFilesView')
  goBackFilesViewContext(): void {
    this._model.goBackFilesViewContext();
  }

  @command('githd-local.goForwardFilesView')
  goForwardFilesViewContext(): void {
    this._model.goForwardFilesViewContext();
  }

  @command('githd-local.refreshFilesView')
  async refreshFilesView(): Promise<void> {
    Tracer.verbose('Command: githd-local.refreshFilesView');
    await this._explorerView.refresh();
  }

  @command('githd-local.goBackNoMore')
  dummyForGoBackIcon(): void {}

  @command('githd-local.goForwardNoMore')
  dummyForGoForwardIcon(): void {}

  @command('githd-local.previousCommit')
  async previousCommit(): Promise<void> {
    Tracer.verbose('Command: githd-local.previousCommit');
    this._explorerView.showPreviousCommit();
  }

  @command('githd-local.nextCommit')
  async nextCommit(): Promise<void> {
    Tracer.verbose('Command: githd-local.nextCommit');
    this._explorerView.showNextCommit();
  }

  @command('githd-local.previousCommitNoMore')
  dummyForPreviousCommitIcon(): void {}

  @command('githd-local.nextCommitNoMore')
  dummyForNextCommitIcon(): void {}

  @command('githd-local.openCommittedFile')
  openCommittedFile(file: GitCommittedFile): void {
    Tracer.verbose('Command: githd-local.openCommittedFile');
    let rightRef = this._model.filesViewContext?.rightRef;
    let leftRef: string = rightRef + '~';
    let title = rightRef;
    if (this._model.filesViewContext?.leftRef) {
      leftRef = this._model.filesViewContext.leftRef;
      title = this._model.filesViewContext.comparisonLabel || `${leftRef} .. ${rightRef}`;
    }
    title += ' | ' + path.basename(file.gitRelativePath);
    let left = file.status == 'A' ? vs.Uri.parse('githd-local-empty:') : toGitUri(file.oldFileUri, leftRef);
    let right = file.status == 'D' ? vs.Uri.parse('githd-local-empty:') : toGitUri(file.fileUri, rightRef);
    vs.commands.executeCommand<void>('vscode.diff', left, right, title, { preview: true });
  }

  @command('githd-local.openCommitInfo')
  openCommitInfo(): void {
    Tracer.verbose('Command: githd-local.openCommitInfo');
    vs.workspace.openTextDocument(InfoViewProvider.defaultUri).then(doc => {
      vs.languages.setTextDocumentLanguage(doc, 'githd-local');
      vs.window
        .showTextDocument(doc, { preview: true, preserveFocus: true })
        .then(() => vs.commands.executeCommand('cursorTop'));
    });
  }

  @command('githd-local.openLineDiff')
  openLineDiff(content: string): void {
    Tracer.verbose('Command: githd-local.openLineDiff');
    vs.workspace
      .openTextDocument({ content, language: 'diff' })
      .then(doc =>
        vs.window
          .showTextDocument(doc, { preview: true, preserveFocus: true })
          .then(() => vs.commands.executeCommand('cursorTop'))
      );
  }

  @command('githd-local.diffUncommittedFile')
  async diffUncommittedFile(file = vs.window.activeTextEditor?.document?.uri): Promise<void> {
    if (!file) {
      return;
    }
    Tracer.verbose('Command: githd-local.diffUncommittedFile');

    const repo = await this._gitService.getGitRepo(file.fsPath);
    if (!repo) {
      return;
    }
    vs.window
      .showQuickPick(selectBranch(this._gitService, repo), {
        placeHolder: `Select a ref to see the diff with local copy of ${path.basename(file.path)}`
      })
      .then(async item => {
        if (item) {
          return await vs.commands.executeCommand<void>(
            'vscode.diff',
            toGitUri(file, item.label),
            file,
            `${item.label} .. Uncommitted (${path.basename(file.path)})`,
            { preview: true }
          );
        }
      });
  }

  @command('githd-local.setExpressMode')
  async setExpressMode(): Promise<void> {
    Tracer.verbose('Command: githd-local.setExpressMode');
    this._historyView.express = !this._historyView.express;
  }

  @command('githd-local.setRepository')
  async setRepository(): Promise<void> {
    Tracer.verbose('Command: githd-local.setRepository');

    const repo: GitRepo | undefined = await selectGitRepo(this._gitService);
    if (repo) {
      this._gitService.updateCurrentGitRepo(repo);
    }
  }

  @command('githd-local.clearFilesView')
  clearFilesView(): void {
    Tracer.verbose('Command: githd-local.clearFilesView');
    this._model.clearFilesViewContexts();
  }

  @command('githd-local.showStats')
  showStats(): void {
    Tracer.verbose('Command: githd-local.showStats');
    vs.commands.executeCommand(`${PanelViewProvider.viewType}.focus`);
  }

  private async _viewHistory(context: HistoryViewContext, all: boolean = false): Promise<void> {
    this._historyView.loadAll = all;
    await this._model.setHistoryViewContext(context);
  }

  private async _diffPath(specifiedPath: vs.Uri, ref?: string): Promise<void> {
    if (specifiedPath) {
      const repo = await this._gitService.getGitRepo(specifiedPath.fsPath);
      if (repo) {
        return this._diffSelections(repo, specifiedPath, ref);
      }
    }
  }

  private async _diffSelections(repo: GitRepo, specifiedPath?: vs.Uri, ref?: string): Promise<void> {
    const refs = await this._gitService.getRefs(repo);
    const branch = await this._loader.getCurrentBranch(repo);
    const currentBranchRef = branch && branch !== 'HEAD' ? `refs/heads/${branch}` : 'HEAD';
    const currentRef = ref || currentBranchRef;
    const selection = await selectDiffRefs(refs, currentRef, currentBranchRef);
    if (!selection) {
      return;
    }
    await this._showComparison(repo, selection, specifiedPath);
  }

  private async _showComparison(repo: GitRepo, selection: DiffRefs, specifiedPath?: vs.Uri): Promise<void> {
    try {
      const resolved = await this._gitService.resolveComparison(
        repo,
        selection.leftRef,
        selection.rightRef,
        selection.mode
      );
      this._model.setFilesViewContext({ repo, ...resolved, specifiedPath });
    } catch (err) {
      await vs.window.showErrorMessage(`GitHD Local: Cannot compare refs. ${String(err)}`);
    }
  }

  private async _getOrUpdateRepo(): Promise<GitRepo | undefined> {
    if (!this._gitService.currentGitRepo) {
      const repo: GitRepo | undefined = await selectGitRepo(this._gitService);
      if (!repo) {
        return;
      }
      this._gitService.updateCurrentGitRepo(repo);
    }
    return this._gitService.currentGitRepo;
  }
}
