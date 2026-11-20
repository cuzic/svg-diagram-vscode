import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Runs} from '../../src/runs.ts';

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
