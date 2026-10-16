import test from 'node:test';
import assert from 'node:assert/strict';
import { bakeTransfer, TRANSFER_AXES, TRANSFER_GRIDS, TRANSFER_SPACING, transferAt, transferPathBlocked } from '../src/light-transfer-field';
import { portalPosition, ROOM_IDS } from '../src/world';

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

test('six filtered directions have finite values and bounded half-float texture storage', () => {
  const grid = TRANSFER_GRIDS.A, count = grid.size.x * grid.size.y * grid.size.z;
  const result = bakeTransfer({ room: 'A', side: 0 }, { room: 'G', side: 0 });
  assert.equal(result.length, count * TRANSFER_AXES);
  assert.ok(result.every(value => Number.isFinite(value) && value >= 0));
  const x = Math.round(-grid.origin.x / TRANSFER_SPACING), z = Math.round((-4 - grid.origin.z) / TRANSFER_SPACING);
  assert.ok(result[x + grid.size.x * grid.size.y * z + count * 2] > 0);
  let bytes = 0;
  for (const room of ROOM_IDS) {
    const { origin, size } = TRANSFER_GRIDS[room], portal = portalPosition(room, 0);
    assert.ok(portal.x >= origin.x && portal.x <= origin.x + (size.x - 1) * TRANSFER_SPACING);
    assert.ok(portal.z >= origin.z && portal.z <= origin.z + (size.z - 1) * TRANSFER_SPACING);
    bytes += size.x * size.y * size.z * TRANSFER_AXES * 2;
  }
  assert.ok(bytes < 6 * 1024 * 1024, 'All seven cached lighting volumes fit within 6 MiB');
});
