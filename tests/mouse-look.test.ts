import test from 'node:test';
import assert from 'node:assert/strict';
import { MouseLook } from '../src/mouse-look';

test('direct input applies all received motion on the next frame without a tail', () => {
  const look = new MouseLook();
  look.push(12, -3); look.push(5, 2);
  assert.deepEqual(look.consume(), { x: 17, y: -1 });
  assert.deepEqual(look.consume(), { x: 0, y: 0 });
});

test('arbitrary packets and reversals preserve full movement at different render rates', () => {
  for (const rate of [30, 60, 120, 144]) {
    const look = new MouseLook();
    let packet = 1, expectedX = 0, expectedY = 0, actualX = 0, actualY = 0;
    for (let frame = 1; frame <= rate; frame++) {
      const now = frame * 1000 / rate;
      for (; packet <= Math.min(now, 900); packet++) {
        const x = Math.sin(packet / 50) * 7, y = Math.cos(packet / 50) * 3;
        look.push(x, y); expectedX += x; expectedY += y;
      }
      const delta = look.consume(); actualX += delta.x; actualY += delta.y;
    }
    assert.ok(Math.abs(actualX - expectedX) < 1e-9);
    assert.ok(Math.abs(actualY - expectedY) < 1e-9);
    assert.deepEqual(look.consume(), { x: 0, y: 0 });
  }
});

test('reset discards pending motion so it cannot turn the camera after undo, pause or an automatic sweep', () => {
  const look = new MouseLook(); look.push(100, -50); look.reset();
  assert.deepEqual(look.consume(), { x: 0, y: 0 });
  look.push(-3, 5);
  assert.deepEqual(look.consume(), { x: -3, y: 5 });
  assert.deepEqual(look.consume(), { x: 0, y: 0 });
});
