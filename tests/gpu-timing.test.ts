import test from 'node:test';
import assert from 'node:assert/strict';
import { GpuTiming } from '../src/gpu-timing';

function delayedGpu(supported = true) {
  const queries = new Map<WebGLQuery, { ready: boolean; value: number }>();
  let reads = 0, created = 0, active: WebGLQuery | null = null;
  const gl = {
    QUERY_RESULT_AVAILABLE: 1, QUERY_RESULT: 2,
    getExtension: () => supported ? { TIME_ELAPSED_EXT: 3, GPU_DISJOINT_EXT: 4 } : null,
    getParameter: () => false,
    createQuery: () => { const q = {} as WebGLQuery; queries.set(q, { ready: false, value: 2_500_000 }); created++; return q; },
    beginQuery: (_target: number, q: WebGLQuery) => { assert.equal(active, null); active = q; queries.get(q)!.ready = false; },
    endQuery: () => { active = null; },
    getQueryParameter: (q: WebGLQuery, parameter: number) => {
      const query = queries.get(q)!;
      if (parameter === 1) return query.ready;
      assert.ok(query.ready, 'Must never request a result while the GPU is still busy'); reads++; return query.value;
    },
    deleteQuery: (q: WebGLQuery) => { queries.delete(q); },
  };
  return { gl: gl as unknown as WebGL2RenderingContext, queries, get reads() { return reads; }, get created() { return created; } };
}
test('a slow GPU cannot cause blocking result reads or unbounded query allocations', () => {
  const fake = delayedGpu(), timing = new GpuTiming(fake.gl);
  for (let i = 0; i < 200; i++) { timing.begin(); timing.end(); }
  assert.equal(fake.reads, 0); assert.equal(fake.created, 8); assert.equal(timing.summary().pending, 8);
  for (const value of fake.queries.values()) value.ready = true;
  timing.begin(); timing.end();
  assert.equal(timing.summary().p95Ms, 2.5); assert.equal(fake.created, 8);
  timing.dispose(); assert.equal(fake.queries.size, 0);
});
test('browsers without GPU timers render without issuing any query commands', () => {
  const fake = delayedGpu(false), timing = new GpuTiming(fake.gl);
  for (let i = 0; i < 100; i++) { timing.begin(); timing.end(); }
  assert.deepEqual(timing.summary(), { supported: false, p95Ms: null, maxMs: null, pending: 0 });
  assert.equal(fake.created, 0); timing.dispose();
});
