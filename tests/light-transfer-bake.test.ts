import test from 'node:test';
import assert from 'node:assert/strict';
import { bakeLightTransfer, bakeLightingRooms } from '../src/light-transfer-bake';
import { compressTransfer } from '../src/light-transfer-cache';
import { bakingLayout, surfaceSamples } from '../src/lightmap-layout';
import { bakeSurfaceTransfer } from '../src/surface-lightmap';
import { portalPosition, ROOM_HEIGHT, ROOM_IDS, ROOMS, roomWalls, wallNormal } from '../src/world';
import { DataUtils, Vector3 } from 'three';
import { panelLightSampler } from '../src/panel-light-bake';
import { encodeLighting, decodeLighting } from '../src/lighting-data';

const result = bakeLightTransfer();

test('independent bake batches reproduce the same room maps and connections', () => {
  const partial = bakeLightingRooms(['E']);
  assert.deepEqual(Object.keys(partial.panels), ['E']);
  assert.deepEqual(partial.panels.E, result.panels.E);
  assert.deepEqual(partial.atlases.E, result.atlases.E);
  assert.deepEqual(partial.fields, result.fields.filter(field => field.room === 'E'));
});

test('lighting binary preserves every sample and rejects stale or incomplete data', () => {
  const binary = encodeLighting(result, 'test-revision'), buffer = binary.buffer as ArrayBuffer;
  const decoded = decodeLighting(buffer, 'test-revision');
  assert.deepEqual(decoded, { ...result, fields: [...result.fields].sort((a, b) => a.key.localeCompare(b.key)) });
  assert.equal(decoded.panels.A.buffer, buffer);
  assert.equal(decoded.fields[0].values.buffer, buffer);
  assert.throws(() => decodeLighting(buffer, 'other-revision'), /revision mismatch/);
  assert.throws(() => decodeLighting(buffer.slice(0, 8), 'test-revision'), /Invalid lighting file/);
  assert.throws(() => decodeLighting(buffer.slice(0, 16), 'test-revision'), /Invalid lighting header/);
  assert.throws(() => decodeLighting(buffer.slice(0, -4), 'test-revision'), /Invalid lighting section/);
});

test('panel light and reflected light remain finite, bounded and occluded by pedestals', () => {
  let bytes = 0, reflected = 0;
  for (const room of ROOM_IDS) {
    const [width, height] = result.atlases[room], map = result.panels[room];
    assert.equal(map.length, width * height * 4); bytes += map.byteLength;
    for (let i = 0; i < map.length; i += 4) {
      const rgba = Array.from(map.subarray(i, i + 4), value => DataUtils.fromHalfFloat(value));
      assert.ok(rgba.every(value => Number.isFinite(value) && value >= 0 && value < 100));
      assert.ok(rgba[1] >= rgba[2] && rgba[2] >= rgba[3], 'Warm materials cannot create a blue bounce');
      if (rgba[1] > .001) reflected++;
    }
    const lamp = ROOMS[room].pedestals[0], sample = panelLightSampler(room);
    assert.ok(sample({ x: lamp.x, y: 1.21, z: lamp.z }, { x: 0, y: 1, z: 0 }) > 0);
    assert.equal(sample({ x: lamp.x, y: .01, z: lamp.z }, { x: 0, y: 1, z: 0 }), 0, 'Pedestal blocks the floor directly beneath it');
    assert.equal(sample({ x: lamp.x, y: 1.21, z: lamp.z }, { x: 0, y: -1, z: 0 }), 0);
  }
  assert.ok(bytes <= 3 * 1024 * 1024); assert.ok(reflected > 1000);
});

test('build calculation prepares every directed connection using compact, bounded surface texels', () => {
  const sockets = ROOM_IDS.flatMap(room => Array.from({ length: ROOMS[room].sides }, (_, side) => `${room}${side}`));
  const expected = sockets.flatMap(receiver => sockets.filter(source => receiver !== source).map(source => `${receiver}<${source}`)).sort();
  assert.deepEqual(result.fields.map(field => field.key).sort(), expected);
  assert.equal(result.fields.length, 812); assert.ok(result.elapsedMs > 0);
  let bytes = 0;
  for (const field of result.fields) {
    const [width, height] = result.atlases[field.room];
    assert.ok(width > 0 && height > 0); assert.ok(field.key.startsWith(field.room));
    let end = 0, samples = 0;
    for (let run = 0; run < field.runs.length; run += 2) {
      assert.ok(field.runs[run] >= end); assert.ok(field.runs[run + 1] > 0);
      end = field.runs[run] + field.runs[run + 1]; assert.ok(end <= width * height * 4); samples += field.runs[run + 1];
    }
    assert.equal(samples, field.values.length); assert.ok(field.values.every(value => Number.isFinite(value) && value > 0));
    bytes += field.runs.byteLength + field.values.byteLength;
  }
  assert.ok(bytes < 8 * 1024 * 1024);
});

test('every ceiling receives baked floor and wall bounce on its inward-facing surface', () => {
  for (const room of ROOM_IDS) {
    const layout = bakingLayout(room), samples = surfaceSamples(layout), map = result.panels[room];
    const chart = layout.charts.find(chart => chart.triangles.some(t => t.mesh.name === 'ceiling'));
    assert.ok(chart, `${room}: ceiling must have a lightmap chart`);
    assert.equal(chart.step.x, .5); assert.equal(chart.step.y, .5);
    let lit = 0, total = 0;
    for (const texel of samples.texels) {
      const x = texel % layout.width, y = Math.floor(texel / layout.width);
      if (x < chart.x || x >= chart.x + chart.width || y < chart.y || y >= chart.y + chart.height) continue;
      total++;
      assert.ok(samples.normals[texel * 3 + 1] < -.999);
      assert.ok(Math.abs(samples.positions[texel * 3 + 1] - (ROOM_HEIGHT - .002)) < .00001);
      assert.equal(map[texel * 4], 0, 'Downward ceiling panels cannot directly illuminate the ceiling');
      if (DataUtils.fromHalfFloat(map[texel * 4 + 1]) > .01) lit++;
    }
    assert.ok(total > 100); assert.ok(lit > total * .8, `${room}: bounced light reaches ${lit}/${total} ceiling samples`);
  }
});

test('the complete build bake matches independent surface bakes, including concave rooms', () => {
  for (const [receiver, source] of [
    [{ room: 'A', side: 0 }, { room: 'G', side: 0 }],
    [{ room: 'G', side: 3 }, { room: 'A', side: 1 }],
    [{ room: 'E', side: 2 }, { room: 'F', side: 3 }],
  ] as const) {
    const layout = bakingLayout(receiver.room), key = `${receiver.room}${receiver.side}<${source.room}${source.side}`;
    assert.deepEqual([layout.width, layout.height], result.atlases[receiver.room]);
    const expected = compressTransfer(receiver.room, key, bakeSurfaceTransfer(receiver, source, surfaceSamples(layout), layout.width * layout.height), 4);
    assert.deepEqual(result.fields.find(field => field.key === key), expected);
  }
});

test('local panel light continues through each half-threshold without leaking past a jamb', () => {
  for (const room of ROOM_IDS) for (let side = 0; side < ROOMS[room].sides; side++) {
    const p = portalPosition(room, side), n = wallNormal(room, side), sample = panelLightSampler(room);
    const normal = { x: 0, y: 1, z: 0 };
    const inner = sample({ x: p.x - n.x * .151, y: .002, z: p.z - n.z * .151 }, normal);
    const threshold = sample({ x: p.x - n.x * .001, y: .002, z: p.z - n.z * .001 }, normal);
    // Close to the light's range limit, smooth cutoff can remove a negligible
    // contribution over these 15 cm without the wall blocking the threshold.
    assert.ok(threshold + .0001 >= inner * .75, `${room}${side}: the inner wall must not black out its threshold`);
    assert.equal(sample({ x: p.x - n.z * 1.1, y: .002, z: p.z + n.x * 1.1 }, normal), 0);
  }
});

test('pentagonal and hexagonal wall corners retain their padded irradiance', () => {
  for (const room of ['B', 'C'] as const) {
    const layout = bakingLayout(room), map = result.panels[room], sample = panelLightSampler(room);
    for (const wall of roomWalls(room)) {
      const normal = new Vector3(-wall.normal.x, 0, -wall.normal.z);
      const chart = layout.charts.find(chart => chart.triangles.some(t => t.normals[0].dot(normal) > .999 &&
        Math.abs((t.positions[0].x - wall.center.x) * wall.normal.x + (t.positions[0].z - wall.center.z) * wall.normal.z) < .0001))!;
      assert.ok(chart);
      const u = new Vector3(normal.z, 0, -normal.x);
      for (const corner of [wall.a, wall.b]) {
        const point = new Vector3(corner.x + (wall.center.x - corner.x) * .01 / (wall.width / 2), 1,
          corner.z + (wall.center.z - corner.z) * .01 / (wall.width / 2));
        const x = chart.x + 1 + (point.dot(u) - chart.min.x) / chart.step.x;
        const y = chart.y + 1 + (point.y - chart.min.y) / chart.step.y;
        const ix = Math.floor(x), iy = Math.floor(y), tx = x - ix, ty = y - iy;
        const read = (dx: number, dy: number) => DataUtils.fromHalfFloat(map[((iy + dy) * layout.width + ix + dx) * 4]);
        const actual = read(0, 0) * (1 - tx) * (1 - ty) + read(1, 0) * tx * (1 - ty) + read(0, 1) * (1 - tx) * ty + read(1, 1) * tx * ty;
        const expected = sample(point.addScaledVector(normal, .002), normal);
        assert.ok(actual > expected * .9, `${room}: corner irradiance ${actual} vs ${expected}`);
      }
    }
  }
});
