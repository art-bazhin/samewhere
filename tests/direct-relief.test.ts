import test from 'node:test';
import assert from 'node:assert/strict';
import { addDirectLightGradient, directReliefDistanceGain } from '../src/directional-lightmap';
import { panelLightSampler } from '../src/panel-light-bake';

test('direct relief compensates distant sources, preserves near response and has a finite cap', () => {
  assert.equal(directReliefDistanceGain(2 ** 2), 1);
  assert.ok(Math.abs(directReliefDistanceGain(3 ** 2) - 1.35) < 1e-12);
  assert.ok(Math.abs(directReliefDistanceGain(10 ** 2) - 15) < 1e-12);
  assert.equal(directReliefDistanceGain(100 ** 2), 25);
  const normal = { x: 0, y: 0, z: 1 };
  for (const angle of [5, 30, 60, 90]) {
    const radians = angle * Math.PI / 180;
    const gradient = (distance: number) => {
      const result = new Float64Array(3);
      addDirectLightGradient(result, distance * Math.cos(radians), 0, distance * Math.sin(radians), normal, 1 / distance ** 3, distance ** 2);
      return result;
    };
    const near = gradient(3), far = gradient(10);
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(near[c] - far[c]) < 1e-12, `${angle} degrees: distant normal response fades`);
  }
});

test('compensated panel gradients retain physical irradiance and reject light behind a face', () => {
  const physical = panelLightSampler('A', undefined, 'draft'), relief = panelLightSampler('A', undefined, 'draft', true);
  const raw = new Float64Array(4), adjusted = new Float64Array(4);
  const point = { x: 4.998, y: .6, z: 0 }, normal = { x: -1, y: 0, z: 0 };
  assert.equal(relief(point, normal, adjusted), physical(point, normal, raw));
  assert.equal(adjusted[3], raw[3]);
  assert.ok(adjusted.some((value, i) => i < 3 && Math.abs(value - raw[i]) > .001));
  // A deliberately downward-facing receiver cannot see ceiling panels.
  assert.equal(relief(point, { x: 0, y: -1, z: 0 }, adjusted), 0);
  assert.deepEqual([...adjusted], [0, 0, 0, 0]);
});
