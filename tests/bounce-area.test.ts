import test from 'node:test';
import assert from 'node:assert/strict';
import { bounceFormFactor, type BounceArea } from '../src/bounce-area';
import { createBounceSampler } from '../src/panel-light-bake';
import { createBounceTransferSampler } from '../src/bounce-light-transfer';
import { floorBounceCells } from '../src/bounce-floor';
import { portalPosition, ROOM_IDS, roomOutline, roomWalls, wallNormal, type SocketRef } from '../src/world';

const factor = (area: BounceArea & { area: number }, point: { x: number; y: number; z: number }, normal = { x: 0, y: -1, z: 0 }) => {
  const x = area.point.x - point.x, y = area.point.y - point.y, z = area.point.z - point.z;
  return bounceFormFactor(area, normal, x, y, z, normal.x * x + normal.y * y + normal.z * z,
    -(area.normal.x * x + area.normal.y * y + area.normal.z * z), x * x + y * y + z * z);
};

test('finite reflectors integrate their projected solid angle without near-field overbrightening', () => {
  const area = { point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, halfU: { x: 1, y: 0, z: 0 }, halfV: { x: 0, y: 0, z: 1 }, area: 4 };
  for (const height of [.001, .02, .1, .5, 1]) {
    // Closed-form irradiance of a unit-radiance square, half-width one.
    const a = 1 / Math.sqrt(1 + height * height), expected = 4 * a * Math.atan(a);
    const actual = factor(area, { x: 0, y: height, z: 0 });
    assert.ok(Math.abs(actual - expected) < 1e-10, `${height}: ${actual} vs ${expected}`);
    assert.ok(actual > 0 && actual <= Math.PI);
  }
  const point = { x: 0, y: .1, z: 0 };
  let sum = 0;
  for (const x of [-.5, .5]) for (const z of [-.5, .5]) sum += factor({ ...area, point: { x, y: 0, z },
    halfU: { x: .5, y: 0, z: 0 }, halfV: { x: 0, y: 0, z: .5 }, area: 1 }, point);
  assert.ok(Math.abs(sum - factor(area, point)) < 1e-10, 'Splitting a uniformly lit area must preserve its near-field energy');
});

test('area bounce converges and has no wide hard occlusion band in the square room corner', () => {
  const sample = createBounceSampler('A'), reference = createBounceSampler('A', 8, false), rgb = new Float32Array(3);
  let maximum = 0, total = 0, count = 0, jump = 0;
  for (const y of [1, 2, 3]) {
    let previous = 0;
    for (let i = 0; i <= 100; i++) {
      const point = { x: 5 - i * .03, y, z: -4.998 }, normal = { x: 0, y: 0, z: 1 };
      sample(point, normal, rgb); const actual = rgb[0];
      reference(point, normal, rgb); const error = Math.abs(actual - rgb[0]);
      maximum = Math.max(maximum, error); total += error; count++;
      if (i > 0) jump = Math.max(jump, Math.abs(actual - previous)); previous = actual;
    }
  }
  assert.ok(maximum < .01, `Dense-reference maximum error: ${maximum}`);
  assert.ok(total / count < .003, `Dense-reference mean error: ${total / count}`);
  assert.ok(jump < .006, `Largest irradiance jump over 3 cm: ${jump}`);
});

test('wall bounce stays continuous at the floor boundary in every room shape', () => {
  const actual = new Float32Array(3), nearby = new Float32Array(3);
  for (const room of ROOM_IDS) {
    const sample = createBounceSampler(room);
    for (const wall of roomWalls(room)) for (const along of [.15, .5, .85]) {
      const normal = { x: -wall.normal.x, y: 0, z: -wall.normal.z };
      const point = { x: wall.a.x + (wall.b.x - wall.a.x) * along + normal.x * .002, y: 0,
        z: wall.a.z + (wall.b.z - wall.a.z) * along + normal.z * .002 };
      sample(point, normal, actual); sample({ ...point, y: .00002 }, normal, nearby);
      for (let c = 0; c < 3; c++) assert.ok(Math.abs(actual[c] - nearby[c]) < .001,
        `${room}: ${JSON.stringify({ point, actual: [...actual], nearby: [...nearby] })}`);
    }
  }
});

test('floor cells cover every outline and retain uniform irradiance along oblique walls', () => {
  for (const room of ROOM_IDS) {
    const outline = roomOutline(room), cells = [...floorBounceCells(outline)].map(({ cell }) => cell);
    const area = Math.abs(outline.reduce((sum, p, i) => {
      const q = outline[(i + 1) % outline.length]; return sum + p.x * q.z - q.x * p.z;
    }, 0)) / 2;
    assert.ok(Math.abs(cells.reduce((sum, cell) => sum + cell.area, 0) - area) < 1e-8, `${room}: floor partition has a gap or overlap`);
    for (const [side, wall] of roomWalls(room).entries()) for (let i = 10; i <= 90; i += 5) {
      const normal = { x: -wall.normal.x, y: 0, z: -wall.normal.z };
      const point = { x: wall.a.x + (wall.b.x - wall.a.x) * i / 100 + normal.x * .002, y: .0001,
        z: wall.a.z + (wall.b.z - wall.a.z) * i / 100 + normal.z * .002 };
      // At the floor, a uniformly emitting surface fills half the wall's
      // cosine-weighted hemisphere, irrespective of the grid or wall angle.
      const irradiance = cells.reduce((sum, cell) => sum + factor(cell, point, normal), 0);
      assert.ok(Math.abs(irradiance - Math.PI / 2) < .001, `${room}${side} at ${i}%: ${irradiance}`);
    }
  }
});

test('conservative area bounds retain the exact wall and pedestal occlusion of individual rays', () => {
  const actual = new Float32Array(3), expected = new Float32Array(3);
  for (const room of ROOM_IDS) {
    const sample = createBounceSampler(room), reference = createBounceSampler(room, 4, false);
    for (const wall of roomWalls(room)) for (const along of [.001, .15, .5, .85, .999]) for (const y of [.05, 1, 2.5, 3.45]) {
      const normal = { x: -wall.normal.x, y: 0, z: -wall.normal.z };
      const point = { x: wall.a.x + (wall.b.x - wall.a.x) * along + normal.x * .002, y,
        z: wall.a.z + (wall.b.z - wall.a.z) * along + normal.z * .002 };
      sample(point, normal, actual); reference(point, normal, expected);
      for (let c = 0; c < 3; c++) assert.ok(Math.abs(actual[c] - expected[c]) < .000001, `${room}: ${JSON.stringify({ point, actual: [...actual], expected: [...expected] })}`);
    }
    for (const wall of roomWalls(room)) if (wall.portal !== null) {
      const p = portalPosition(room, wall.portal), n = wallNormal(room, wall.portal), normal = { x: 0, y: 1, z: 0 };
      for (const depth of [-.1, 0, .2]) for (const lateral of [-1.05, -.9, -.895, 0, .895, .9, 1.05]) {
        const point = { x: Math.fround(p.x - n.x * depth - n.z * lateral), y: .002, z: Math.fround(p.z - n.z * depth + n.x * lateral) };
        sample(point, normal, actual); reference(point, normal, expected);
        for (let c = 0; c < 3; c++) assert.ok(Math.abs(actual[c] - expected[c]) < .000001,
          `Threshold ${room}: ${JSON.stringify({ point, actual: [...actual], expected: [...expected] })}`);
      }
    }

  }
});

test('area and aperture bounds preserve reflection through thick doorways and self-loops', () => {
  const pairs: [SocketRef, SocketRef][] = [
    [{ room: 'A', side: 0 }, { room: 'A', side: 1 }], [{ room: 'C', side: 1 }, { room: 'E', side: 0 }],
    [{ room: 'G', side: 3 }, { room: 'B', side: 2 }], [{ room: 'F', side: 1 }, { room: 'G', side: 0 }],
  ];
  const actual = new Float32Array(3), expected = new Float32Array(3);
  for (const [receiver, source] of pairs) {
    const sample = createBounceTransferSampler(receiver, source), reference = createBounceTransferSampler(receiver, source, 4, false);
    const p = portalPosition(receiver.room, receiver.side), n = wallNormal(receiver.room, receiver.side);
    for (const depth of [-.1, 0, .02, .3, 1.2]) for (const lateral of [-1.05, -.9, -.895, 0, .895, .9, 1.05]) for (const y of [.002, 1.6, 2.59]) {
      const point = { x: Math.fround(p.x - n.x * depth - n.z * lateral), y, z: Math.fround(p.z - n.z * depth + n.x * lateral) };
      const normal = y < .1 ? { x: 0, y: 1, z: 0 } : { x: n.z, y: 0, z: -n.x };
      actual.fill(0); expected.fill(0); sample(point, normal, actual, 0); reference(point, normal, expected, 0);
      for (let c = 0; c < 3; c++) assert.ok(Math.abs(actual[c] - expected[c]) < .000001,
        JSON.stringify({ receiver, source, point, actual: [...actual], expected: [...expected] }));
    }
  }
});
