// Tasks of type "svg-diagram". `typecheck` prints tsc's own lines (file(line,col): error TS...), so the built-in $tsc matcher reads them.
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type {ResolvedCli} from './cli.ts';
import {hasPackage} from './setup.ts';

export const TASK_TYPE = 'svg-diagram';

interface SvgDiagramTaskDefinition extends vscode.TaskDefinition {
  command: 'typecheck';
  args?: string[];
}

export class SvgDiagramTaskProvider implements vscode.TaskProvider {
  private readonly peekCli: (scope: vscode.Uri) => ResolvedCli | undefined;
  constructor(peekCli: (scope: vscode.Uri) => ResolvedCli | undefined) {
    this.peekCli = peekCli;
  }

  /**
   * Only for folders that use svg-diagram (in their node_modules, or with a .svg-diagram.json): a CLI on PATH alone
   * must not put a build task into every project. Never warns (the task list is opened in unrelated projects too).
   */
  provideTasks(): vscode.Task[] {
    return (vscode.workspace.workspaceFolders ?? []).filter(usesSvgDiagram).flatMap(folder => {
      const t = this.make(folder, {type: TASK_TYPE, command: 'typecheck'});
      return t ? [t] : [];
    });
  }

  resolveTask(task: vscode.Task): vscode.Task | undefined {
    const def = task.definition as SvgDiagramTaskDefinition;
    const folder = typeof task.scope === 'object' ? task.scope : vscode.workspace.workspaceFolders?.[0];
    return def.command === 'typecheck' && folder ? this.make(folder, def) : undefined;
  }

  make(folder: vscode.WorkspaceFolder, def: SvgDiagramTaskDefinition): vscode.Task | undefined {
    const cli = this.peekCli(folder.uri);
    if (!cli) return undefined;
    const exec = new vscode.ProcessExecution(cli.bin, [def.command, ...(def.args ?? [])], {cwd: folder.uri.fsPath});
    const task = new vscode.Task(def, folder, '型検査（typecheck）', TASK_TYPE, exec, '$tsc');
    task.group = vscode.TaskGroup.Build;
    task.presentationOptions = {reveal: vscode.TaskRevealKind.Silent, clear: true};
    return task;
  }
}

function usesSvgDiagram(folder: vscode.WorkspaceFolder): boolean {
  return folder.uri.scheme === 'file' && (hasPackage(folder.uri.fsPath, 'svg-diagram') || fs.existsSync(path.join(folder.uri.fsPath, '.svg-diagram.json')));
}
