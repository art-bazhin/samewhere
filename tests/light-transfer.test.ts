import test from 'node:test';
import assert from 'node:assert/strict';
import { DataUtils } from 'three';
import { combineTransfers, compressTransfer } from '../src/light-transfer-cache';
import { transferAt, transferPathBlocked } from '../src/light-transfer-sampling';
import { bakingLayout, surfaceSamples } from '../src/lightmap-layout';
import { bakeSurfaceTransfer } from '../src/surface-lightmap';
import manifest from '../src/light-transfer-manifest.json';
import { ROOM_IDS } from '../src/world';

test('sparse prepared fields reproduce the original summed lighting bit for bit', () => {
  const layout = bakingLayout('A'), samples = surfaceSamples(layout);
  const sources = ['C', 'G'].map(room => bakeSurfaceTransfer({ room: 'A', side: 0 }, { room: room as 'C' | 'G', side: 0 }, samples, layout.width * layout.height));
  const prepared = sources.map((values, index) => compressTransfer('A', `A0<${index}`, values));
  const scratch = new Float32Array(sources[0].length), actual = new Uint16Array(scratch.length), reference = new Uint16Array(scratch.length);
  for (let i = 0; i < reference.length; i++) reference[i] = DataUtils.toHalfFloat(Math.fround(sources[0][i] + sources[1][i]));
  combineTransfers(prepared, scratch, actual); assert.deepEqual(actual, reference);
  // Removing one contribution reuses the same buffers and leaves no stale light.
  combineTransfers(prepared.slice(0, 1), scratch, actual);
  assert.deepEqual(actual, Uint16Array.from(sources[0], value => DataUtils.toHalfFloat(value)));
  combineTransfers([], scratch, actual); assert.ok(actual.every(value => value === 0));
  assert.ok(prepared.reduce((sum, field) => sum + field.runs.byteLength + field.values.byteLength, 0) < sources[0].byteLength / 4);
});

test('a neighboring ceiling lamp lights the floor through a correctly transformed aperture', () => {
  const a = transferAt({ room: 'A', side: 0 }, { room: 'G', side: 0 }, { x: 0, y: 0, z: -4 });
  assert.ok(a[2] > .1, 'Upward-facing floor receives neighboring light');
  assert.equal(a[3], 0, 'A downward-facing ceiling receives no light from ceiling lamps');
  const b = transferAt({ room: 'G', side: 0 }, { room: 'A', side: 0 }, { x: -3.5, y: 0, z: -6 });
  assert.ok(b[2] > 0, 'The offset H entrance also transports light in the reverse direction');
});

test('door jambs and the header block transport outside the aperture', () => {
  const receiver = { room: 'A', side: 0 } as const, source = { room: 'G', side: 0 } as const;
  for (const p of [{ x: 3, y: 0, z: -4 }, { x: 0, y: 3, z: -4 }]) {
    assert.ok(transferAt(receiver, source, p).every(value => value === 0));
  }
  assert.ok(transferAt(receiver, source, { x: 0, y: 0, z: -4 }).some(value => value > 0));
});

test('concave room walls prevent light from crossing the void between H corridors', () => {
  const result = transferAt({ room: 'G', side: 0 }, { room: 'A', side: 0 }, { x: 3.5, y: 0, z: -5 });
  assert.ok(result.every(value => value === 0));
});

test('pedestals block transported light at their actual height and retain concave cutouts', () => {
  assert.equal(transferPathBlocked('A', { x: -1.8, y: .4, z: 1 }, { x: -1.8, y: .4, z: 3 }, 0), true);
  assert.equal(transferPathBlocked('A', { x: -1.8, y: 1.3, z: 1 }, { x: -1.8, y: 1.3, z: 3 }, 0), false);
  assert.equal(transferPathBlocked('G', { x: -.05, y: .5, z: .3 }, { x: .05, y: .5, z: .3 }, 0), false);
});

test('one scalar per surface texel preserves aperture lighting with bounded 2D storage', () => {
  const layout = bakingLayout('A'), samples = surfaceSamples(layout);
  const result = bakeSurfaceTransfer({ room: 'A', side: 0 }, { room: 'G', side: 0 }, samples, layout.width * layout.height);
  assert.equal(result.length, layout.width * layout.height);
  assert.ok(result.every(value => Number.isFinite(value) && value >= 0)); assert.equal(result[0], 0);
  const floor = Array.from(samples.texels).find(i => Math.abs(samples.positions[i * 3]) < .01 && Math.abs(samples.positions[i * 3 + 2] + 4) < .01 && samples.normals[i * 3 + 1] > .99)!;
  assert.ok(result[floor] > .1);
  const bytes = ROOM_IDS.reduce((sum, room) => sum + manifest.atlases[room][0] * manifest.atlases[room][1] * 2 * 2, 0);
  assert.ok(bytes < 2 * 1024 * 1024, 'Both 2D buffers for all seven rooms fit within 2 MiB');
});

test('surface UVs are deterministic and floor/thresholds share a padded chart', () => {
  const first = bakingLayout('A'), second = bakingLayout('A');
  const signature = (layout: typeof first) => layout.charts.map(chart => ({ x: chart.x, y: chart.y, width: chart.width, height: chart.height, min: chart.min.toArray(), max: chart.max.toArray() }));
  assert.deepEqual(signature(first), signature(second));
  const floor = first.charts.find(chart => chart.triangles.some(triangle => triangle.mesh.name === 'floor'))!;
  assert.ok(floor.triangles.some(triangle => triangle.mesh.name === 'threshold'));
  assert.equal(new Set(floor.triangles.filter(triangle => triangle.mesh.name === 'threshold').map(triangle => triangle.mesh)).size, 4);
  const uv = floor.triangles[0].mesh.geometry.getAttribute('transferUv');
  for (let i = 0; i < uv.count; i++) { assert.ok(uv.getX(i) > 0 && uv.getX(i) < 1); assert.ok(uv.getY(i) > 0 && uv.getY(i) < 1); }
  const curved = first.charts.filter(chart => chart.curvedMesh).map(chart => chart.curvedMesh!);
  const balls = curved.filter(mesh => mesh.name === 'socket-ball'), bowls = curved.filter(mesh => mesh.name === 'socket-bowl');
  for (const objects of [balls, bowls]) {
    assert.ok(objects.length > 1);
    assert.equal(objects[0].geometry.getAttribute('position'), objects[1].geometry.getAttribute('position'), 'Repeated shapes share vertex buffers');
    assert.notEqual(objects[0].geometry.getAttribute('transferUv'), objects[1].geometry.getAttribute('transferUv'));
  }
});
