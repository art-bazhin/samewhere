import test from 'node:test';
import assert from 'node:assert/strict';
import { LoadingProgress, fetchLoadingBuffer } from '../src/loading-progress';

test('progress uses a fixed total and waits for every task without moving backwards', () => {
  const values: number[] = [], loading = new LoadingProgress(value => values.push(value));
  const files = loading.task(2), graphics = loading.task();
  files(.5); assert.deepEqual(values, []); loading.seal();
  assert.equal(values.at(-1), 1 / 3);
  files(.25); assert.equal(values.at(-1), 1 / 3);
  files(); assert.equal(values.at(-1), 2 / 3);
  graphics(); assert.equal(values.at(-1), 1);
  assert.throws(() => loading.task(), /registered/);
});

test('downloads report byte progress and finish only at the end of the response', async () => {
  const original = globalThis.fetch, updates: number[] = [];
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { 'Content-Length': '4' } });
  try {
    const pending = fetchLoadingBuffer('test', new AbortController().signal, (value = 1) => updates.push(value));
    stream.enqueue(new Uint8Array([1, 2]));
    await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(updates, [.5]);
    stream.enqueue(new Uint8Array([3, 4])); stream.close();
    assert.deepEqual(new Uint8Array(await pending), new Uint8Array([1, 2, 3, 4]));
    assert.equal(updates.at(-1), 1); assert.ok(updates.slice(0, -1).every(value => value < 1));
  } finally { globalThis.fetch = original; }
});

test('compressed or unknown response sizes never invent fractional progress', async () => {
  const original = globalThis.fetch;
  try {
    for (const headers of [new Headers({ 'Content-Encoding': 'br', 'Content-Length': '1' }), new Headers()]) {
      const updates: number[] = [];
      globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3, 4]), { headers });
      await fetchLoadingBuffer('test', new AbortController().signal, (value = 1) => updates.push(value));
      assert.deepEqual(updates, [1]);
    }
  } finally { globalThis.fetch = original; }
});
