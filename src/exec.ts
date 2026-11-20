import {execFile} from 'node:child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** Set when the process failed to start, exited non-zero, timed out or was aborted. */
  error?: Error;
}

/** Runs the CLI without a shell. Never rejects: the caller decides what a non-zero exit means. */
export function exec(bin: string, args: string[], opts: {cwd: string; signal?: AbortSignal; timeoutMs?: number}): Promise<ExecResult> {
  return new Promise(resolve => {
    execFile(bin, args, {cwd: opts.cwd, signal: opts.signal, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8'}, (error, stdout, stderr) =>
      resolve({stdout, stderr, ...(error ? {error} : {})}));
  });
}
