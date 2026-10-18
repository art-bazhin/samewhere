import test from 'node:test';
import assert from 'node:assert/strict';
import { DataUtils, Vector3 } from 'three';
import { insideOutline } from '../src/geometry';
import { LIGHT_RAY_OFFSET, SURFACE_SAMPLE_OFFSET } from '../src/light-path';
import { bakingLayout, surfaceSamples } from '../src/lightmap-layout';
import { bakePanelLight, createBounceSampler, panelLightSampler } from '../src/panel-light-bake';
import { ROOM_IDS, roomOutline, roomWalls } from '../src/world';

test('wall receivers and biased rays stay inside every room footprint', () => {
  for (const room of ROOM_IDS) {
    const samples = surfaceSamples(bakingLayout(room)), walls = roomWalls(room), outline = roomOutline(room);
    let checked = 0;
    for (const texel of samples.texels) {
      const i = texel * 3;
      const point = { x: samples.positions[i], z: samples.positions[i + 2] };
      const normal = { x: samples.normals[i], z: samples.normals[i + 2] };
      if (!walls.some(wall => normal.x * wall.normal.x + normal.z * wall.normal.z < -.999 &&
        Math.abs((point.x - wall.a.x) * wall.normal.x + (point.z - wall.a.z) * wall.normal.z) < .01)) continue;
      assert.ok(insideOutline(point, outline), `${room}: receiver ${JSON.stringify(point)}`);
      const origin = { x: point.x + normal.x * LIGHT_RAY_OFFSET, z: point.z + normal.z * LIGHT_RAY_OFFSET };
      assert.ok(insideOutline(origin, outline), `${room}: ray origin ${JSON.stringify(origin)}`);
      checked++;
    }
    assert.ok(checked > 0, `${room}: wall probes must be checked`);
  }
});

test('triangle corner padding preserves direct and reflected light after interpolation', () => {
  const layout = bakingLayout('D'), map = bakePanelLight('D', surfaceSamples(layout), layout.width * layout.height);
  const direct = panelLightSampler('D'), bounce = createBounceSampler('D'), rgb = new Float32Array(3);
  for (const wall of roomWalls('D')) {
    const normal = new Vector3(-wall.normal.x, 0, -wall.normal.z), u = new Vector3(normal.z, 0, -normal.x);
    const chart = layout.charts.find(chart => chart.triangles.some(t => t.normals[0].dot(normal) > .999 &&
      Math.abs((t.positions[0].x - wall.center.x) * wall.normal.x + (t.positions[0].z - wall.center.z) * wall.normal.z) < .0001))!;
    for (const corner of [wall.a, wall.b]) for (const height of [.5, 1.5, 2.5]) {
      const point = new Vector3(corner.x + (wall.center.x - corner.x) * .01 / (wall.width / 2), height,
        corner.z + (wall.center.z - corner.z) * .01 / (wall.width / 2));
      const x = chart.x + 1 + (point.dot(u) - chart.min.x) / chart.step.x;
      const y = chart.y + 1 + (point.y - chart.min.y) / chart.step.y;
      const ix = Math.floor(x), iy = Math.floor(y), tx = x - ix, ty = y - iy;
      const read = (channel: number) => {
        const at = (dx: number, dy: number) => DataUtils.fromHalfFloat(map[((iy + dy) * layout.width + ix + dx) * 4 + channel]);
        return at(0, 0) * (1 - tx) * (1 - ty) + at(1, 0) * tx * (1 - ty) + at(0, 1) * (1 - tx) * ty + at(1, 1) * tx * ty;
      };
      point.addScaledVector(normal, SURFACE_SAMPLE_OFFSET); bounce(point, normal, rgb);
      assert.ok(read(0) > direct(point, normal) * .9, 'Corner padding must preserve direct light');
      assert.ok(read(1) > rgb[0] * .9, 'Corner padding must preserve reflected light');
    }
  }
});
