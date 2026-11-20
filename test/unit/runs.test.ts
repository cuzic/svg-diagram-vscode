import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Runs, Semaphore} from '../../src/runs.ts';

test('a save during a run over many files: the old run keeps the others and is not cancelled', () => {
  const runs = new Runs<string>();
  const all = runs.start(['a', 'b', 'c']);
  const save = runs.start(['b']);
  assert.equal(all.signal.aborted, false);
  assert.deepEqual(['a', 'b', 'c'].map(k => all.owns(k)), [true, false, true]);
  assert.equal(save.owns('b'), true);
});

test('a run is cancelled once every one of its files has a newer run', () => {
  const runs = new Runs<string>();
  const first = runs.start(['a']);
  const second = runs.start(['a']);
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, false);

  const pair = runs.start(['x', 'y']);
  runs.start(['x']);
  assert.equal(pair.signal.aborted, false);
  runs.start(['y']);
  assert.equal(pair.signal.aborted, true);
});

test('finish forgets only what the run still owned', () => {
  const runs = new Runs<string>();
  const old = runs.start(['a', 'b']);
  const newer = runs.start(['b']);
  runs.finish(old);
  assert.equal(newer.owns('b'), true);
  runs.finish(newer);
  assert.equal(newer.owns('b'), false);
});

test('abortAll cancels what is running', () => {
  const runs = new Runs<string>();
  const a = runs.start(['a']);
  const b = runs.start(['b']);
  runs.abortAll();
  assert.equal(a.signal.aborted && b.signal.aborted, true);
});

test('Semaphore: at most `limit` at once, in order; an aborted waiter leaves the queue', async () => {
  const sem = new Semaphore(2);
  const order: string[] = [];
  const r1 = await sem.acquire();
  const r2 = await sem.acquire();
  const gone = new AbortController();
  const p3 = sem.acquire(gone.signal).then(r => { order.push(r ? 'w1 got it' : 'w1 gave up'); return r; });
  const p4 = sem.acquire().then(r => { order.push('w2 got it'); return r; });
  await Promise.resolve();
  assert.deepEqual(order, []);
  gone.abort();
  r1?.();
  const [rel3, rel4] = await Promise.all([p3, p4]);
  assert.equal(rel3, undefined);
  assert.deepEqual(order, ['w1 gave up', 'w2 got it']);
  r2?.(); rel4?.(); rel4?.(); // a second release does nothing
  const again = [await sem.acquire(), await sem.acquire()];
  assert.equal(again.every(Boolean), true);
});
