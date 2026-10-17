import test from 'node:test';
import assert from 'node:assert/strict';
import { bakeLightTransfer } from '../src/light-transfer-bake';
import { compressTransfer } from '../src/light-transfer-cache';
import { bakingLayout, surfaceSamples } from '../src/lightmap-layout';
import { bakeSurfaceTransfer } from '../src/surface-lightmap';
import { ROOM_IDS, ROOMS } from '../src/world';
import { DataUtils } from 'three';
import { panelLightSampler } from '../src/panel-light-bake';

const result = bakeLightTransfer();

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

test('startup calculation prepares every directed connection using compact, bounded surface texels', () => {
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
      end = field.runs[run] + field.runs[run + 1]; assert.ok(end <= width * height); samples += field.runs[run + 1];
    }
    assert.equal(samples, field.values.length); assert.ok(field.values.every(value => Number.isFinite(value) && value > 0));
    bytes += field.runs.byteLength + field.values.byteLength;
  }
  assert.ok(bytes < 4 * 1024 * 1024);
});

test('the complete startup job matches independent surface bakes, including concave rooms', () => {
  for (const [receiver, source] of [
    [{ room: 'A', side: 0 }, { room: 'G', side: 0 }],
    [{ room: 'G', side: 3 }, { room: 'A', side: 1 }],
    [{ room: 'E', side: 2 }, { room: 'F', side: 3 }],
  ] as const) {
    const layout = bakingLayout(receiver.room), key = `${receiver.room}${receiver.side}<${source.room}${source.side}`;
    assert.deepEqual([layout.width, layout.height], result.atlases[receiver.room]);
    const expected = compressTransfer(receiver.room, key, bakeSurfaceTransfer(receiver, source, surfaceSamples(layout), layout.width * layout.height));
    assert.deepEqual(result.fields.find(field => field.key === key), expected);
  }
});
