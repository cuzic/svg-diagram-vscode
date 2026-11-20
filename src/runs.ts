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

/** At most `limit` holders at a time; waiters go in order. A waiter whose signal aborts leaves the queue. */
export class Semaphore {
  private held = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  /** Resolves to a release function, or to undefined when the signal aborted first (nothing is held then). */
  async acquire(signal?: AbortSignal): Promise<(() => void) | undefined> {
    if (signal?.aborted) return undefined;
    if (this.held >= this.limit) {
      const ok = await new Promise<boolean>(resolve => {
        const wake = () => { signal?.removeEventListener('abort', onAbort); resolve(true); };
        const onAbort = () => { const i = this.waiting.indexOf(wake); if (i >= 0) this.waiting.splice(i, 1); resolve(false); };
        this.waiting.push(wake);
        signal?.addEventListener('abort', onAbort, {once: true});
      });
      if (!ok) return undefined;
    } else {
      this.held++;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next(); // the slot passes straight to the next waiter
      else this.held--;
    };
  }
}
