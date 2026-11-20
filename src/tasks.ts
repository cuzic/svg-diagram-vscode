// Tasks of type "svg-diagram". `typecheck` prints tsc's own lines (file(line,col): error TS...), so the built-in $tsc matcher reads them.
import * as vscode from 'vscode';
import type {ResolvedCli} from './cli.ts';

export const TASK_TYPE = 'svg-diagram';

interface SvgDiagramTaskDefinition extends vscode.TaskDefinition {
  command: 'typecheck';
  args?: string[];
}

export class SvgDiagramTaskProvider implements vscode.TaskProvider {
  private readonly getCli: (scope: vscode.Uri) => ResolvedCli | undefined;
  constructor(getCli: (scope: vscode.Uri) => ResolvedCli | undefined) {
    this.getCli = getCli;
  }

  provideTasks(): vscode.Task[] {
    return (vscode.workspace.workspaceFolders ?? []).flatMap(folder => {
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
    const cli = this.getCli(folder.uri);
    if (!cli) return undefined;
    const exec = new vscode.ProcessExecution(cli.bin, [def.command, ...(def.args ?? [])], {cwd: folder.uri.fsPath});
    const task = new vscode.Task(def, folder, '型検査（typecheck）', TASK_TYPE, exec, '$tsc');
    task.group = vscode.TaskGroup.Build;
    task.presentationOptions = {reveal: vscode.TaskRevealKind.Silent, clear: true};
    return task;
  }
}
