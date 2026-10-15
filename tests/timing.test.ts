import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameTiming } from '../src/timing';

test('regular presentation at 60 Hz has low CPU time independently of frame intervals', () => {
  const timing = new FrameTiming();
  for (let i = 0; i <= 120; i++) timing.record(i * 1000 / 60, 2);
  const stats = timing.summary();
  assert.ok(Math.abs(stats.fps - 60) < 0.001);
  assert.equal(stats.cpuP95Ms, 2); assert.equal(stats.slowFrames, 0);
});
test('a rare hitch is retained in the maximum even when the mean and p95 look normal', () => {
  const timing = new FrameTiming(); let now = 0;
  timing.record(now, 1);
  for (let i = 0; i < 120; i++) { now += i === 60 ? 80 : 1000 / 60; timing.record(now, 1); }
  const stats = timing.summary();
  assert.equal(stats.maxMs, 80); assert.equal(stats.slowFrames, 1);
  assert.ok(stats.p95Ms < 17); assert.ok(stats.meanMs < 18);
});
test('old stalls expire from the bounded rolling window', () => {
  const timing = new FrameTiming(10); let now = 0;
  timing.record(now, 1); timing.record(now += 100, 50);
  assert.equal(timing.summary().maxMs, 100);
  for (let i = 0; i < 10; i++) timing.record(now += 16, 1);
  assert.equal(timing.summary().maxMs, 16); assert.equal(timing.summary().cpuP95Ms, 1);
});
test('tab visibility reset excludes time spent in the background', () => {
  const timing = new FrameTiming(); timing.record(0, 1); timing.record(16, 1);
  timing.reset(); timing.record(100000, 1); timing.record(100016, 1);
  assert.equal(timing.summary().maxMs, 16); assert.equal(timing.summary().slowFrames, 0);
});
