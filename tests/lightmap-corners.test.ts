import test from 'node:test';
import assert from 'node:assert/strict';
import { DataUtils, Vector3, type Scene } from 'three';
import { insideOutline, outlineWalls } from '../src/geometry';
import { LIGHT_RAY_OFFSET, SURFACE_SAMPLE_OFFSET } from '../src/light-path';
import { bakingLayout, prepareSurfaceLayout, surfaceSamples } from '../src/lightmap-layout';
import { bakePanelLight, createBounceSampler, panelLightSampler } from '../src/panel-light-bake';
import { PEDESTAL_HEIGHT, pedestalOutline, ROOM_IDS, ROOMS, roomOutline, roomWalls, WALL_THICKNESS } from '../src/world';

test('jambs keep separate narrow lightmaps instead of merging opposing doorway charts', () => {
  for (const room of ROOM_IDS) {
    const baked = bakingLayout(room);
    let scene = baked.charts.find(chart => chart.triangles.length)!.triangles[0].mesh.parent!;
    while (scene.parent) scene = scene.parent;
    const direct = prepareSurfaceLayout(scene as Scene, room, true);
    const charts = direct.charts.filter(chart => chart.reveal !== undefined && !chart.revealLocal);
    assert.equal(charts.length, ROOMS[room].sides * 2);
    assert.equal(direct.charts.filter(chart => chart.revealLocal).length, charts.length);
    for (const chart of charts) {
      assert.equal(chart.step.x, .025); assert.equal(chart.step.y, .025);
      assert.ok(chart.max.x - chart.min.x <= WALL_THICKNESS / 2 + .02501);
      assert.ok(chart.width <= 10, 'A narrow jamb must not allocate the gap to a coplanar doorway');
    }
  }
});

test('pedestal side receivers and biased rays stay outside their solid footprints', () => {
  for (const room of ROOM_IDS) {
    const samples = surfaceSamples(bakingLayout(room));
    const shapes = ROOMS[room].pedestals.map(p => {
      const outline = pedestalOutline(p.controls).map(v => ({ x: p.x + v.x, z: p.z + v.z }));
      return { outline, walls: outlineWalls(outline, []), checked: 0 };
    });
    for (const texel of samples.texels) {
      const i = texel * 3, point = { x: samples.positions[i], z: samples.positions[i + 2] };
      const normal = { x: samples.normals[i], z: samples.normals[i + 2] };
      if (samples.positions[i + 1] <= 0 || samples.positions[i + 1] >= PEDESTAL_HEIGHT || Math.abs(samples.normals[i + 1]) > .01) continue;
      const shape = shapes.find(shape => shape.walls.some(wall => {
        const x = point.x - wall.a.x, z = point.z - wall.a.z;
        const along = (x * (wall.b.x - wall.a.x) + z * (wall.b.z - wall.a.z)) / wall.width;
        return normal.x * wall.normal.x + normal.z * wall.normal.z > .999 && along >= -.00001 && along <= wall.width + .00001 &&
          Math.abs(x * wall.normal.x + z * wall.normal.z - SURFACE_SAMPLE_OFFSET) < .00001;
      }));
      if (!shape) continue;
      assert.ok(!insideOutline(point, shape.outline), `${room}: receiver inside pedestal ${JSON.stringify(point)}`);
      const origin = { x: point.x + normal.x * LIGHT_RAY_OFFSET, z: point.z + normal.z * LIGHT_RAY_OFFSET };
      assert.ok(!insideOutline(origin, shape.outline), `${room}: ray origin inside pedestal ${JSON.stringify(origin)}`);
      shape.checked++;
    }
    for (const shape of shapes) assert.ok(shape.checked > 0, `${room}: every pedestal must be checked`);
  }
});

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

test('pedestal lightmaps retain the reflected-light rise just above the floor', () => {
  const layout = bakingLayout('A'), samples = surfaceSamples(layout), pedestal = ROOMS.A.pedestals[0];
  const [a, b] = pedestalOutline(pedestal.controls), length = Math.hypot(b.x - a.x, b.z - a.z);
  const normal = new Vector3((b.z - a.z) / length, 0, -(b.x - a.x) / length), u = new Vector3(normal.z, 0, -normal.x);
  const center = new Vector3(pedestal.x + (a.x + b.x) / 2, 0, pedestal.z + (a.z + b.z) / 2);
  const chart = layout.charts.find(chart => chart.triangles.some(t => t.mesh.name === 'pedestal-body' &&
    t.normals[0].dot(normal) > .999 && Math.abs(t.positions[0].clone().sub(center).dot(normal)) < .00001))!;
  const probes = [.025, .075, .125, .175, .225].map(height => {
    const point = center.clone().setY(height);
    const x = chart.x + 1 + (point.dot(u) - chart.min.x) / chart.step.x;
    const y = chart.y + 1 + (height - chart.min.y) / chart.step.y;
    return { point, x, y, ix: Math.floor(x), iy: Math.floor(y) };
  });
  const texels = new Set(probes.flatMap(({ ix, iy }) => [0, 1].flatMap(dy => [0, 1].map(dx => (iy + dy) * layout.width + ix + dx))));
  const map = bakePanelLight('A', { ...samples, texels: new Uint32Array(texels) }, layout.width * layout.height, 'draft');
  const bounce = createBounceSampler('A', undefined, true, 'draft'), rgb = new Float32Array(3);
  for (const { point, x, y, ix, iy } of probes) {
    const tx = x - ix, ty = y - iy;
    const at = (dx: number, dy: number) => DataUtils.fromHalfFloat(map[((iy + dy) * layout.width + ix + dx) * 4 + 1]);
    const baked = at(0, 0) * (1 - tx) * (1 - ty) + at(1, 0) * tx * (1 - ty) + at(0, 1) * (1 - tx) * ty + at(1, 1) * tx * ty;
    bounce(point.clone().addScaledVector(normal, SURFACE_SAMPLE_OFFSET), normal, rgb);
    assert.ok(Math.abs(baked - rgb[0]) < rgb[0] * .1, `At ${point.y} m: baked ${baked}, reference ${rgb[0]}`);
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
