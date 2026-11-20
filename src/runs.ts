// Which run's result counts, per file, when runs over overlapping sets of files overlap in time. No `vscode` import.
//
// A save starts a run for one file while a run over many (open tabs, "check the workspace") may still be going.
// The newer run owns that file; the older one still owns the rest. So a run is cancelled only when every one of
// its files has a newer run, and its results are applied only to the files it still owns.

export interface Run<K> {
  readonly id: number;
  readonly keys: readonly K[];
  readonly signal: AbortSignal;
  /** This run is still the latest for the key: its result for that key may be shown. */
  owns(key: K): boolean;
}

export class Runs<K> {
  private seq = 0;
  private readonly latest = new Map<K, number>();
  private readonly active = new Map<number, {keys: readonly K[]; abort: AbortController}>();

  start(keys: readonly K[]): Run<K> {
    const id = ++this.seq;
    const abort = new AbortController();
    for (const k of keys) this.latest.set(k, id);
    this.active.set(id, {keys, abort});
    for (const [other, run] of this.active) {
      if (other !== id && run.keys.every(k => this.latest.get(k) !== other)) {
        run.abort.abort();
        this.active.delete(other);
      }
    }
    return {id, keys, signal: abort.signal, owns: k => this.latest.get(k) === id};
  }

  /** The run is over (finished or failed): forget it, and the keys it still owned. */
  finish(run: Run<K>): void {
    this.active.delete(run.id);
    for (const k of run.keys) if (this.latest.get(k) === run.id) this.latest.delete(k);
  }

  /** Cancels everything (dispose). */
  abortAll(): void {
    for (const run of this.active.values()) run.abort.abort();
    this.active.clear();
    this.latest.clear();
  }
}
