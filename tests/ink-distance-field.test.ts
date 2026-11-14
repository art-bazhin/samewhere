import test from 'node:test';
import assert from 'node:assert/strict';
import { inkDistanceField } from '../src/ink-distance-field';

function field(alpha: number[], width: number, radius = 8) {
  const pixels = new Uint8ClampedArray(alpha.length * 4);
  alpha.forEach((value, index) => { pixels[index * 4 + 3] = value; });
  return inkDistanceField(pixels, width, alpha.length / width, radius);
}

test('ink distances match Euclidean distances and keep the contour halfway between pixels', () => {
  const width = 7, alpha = Array(width * width).fill(0), center = 3 * width + 3;
  alpha[center] = 255;
  const distance = field(alpha, width), radius = 8;
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
    const d = x === 3 && y === 3 ? -1 : Math.hypot(x - 3, y - 3);
    assert.equal(distance[y * width + x], Math.round(255 * (.5 - d / (2 * radius))));
  }
  assert.equal(distance[center] + distance[center + 1], 255);
  assert.deepEqual(Array.from(field(alpha.map(value => 255 - value), width)), Array.from(distance, value => 255 - value));
});

test('partial alpha retains the subpixel contour and distance values saturate away from ink', () => {
  const alpha = [0, 64, 128, 192, 255], distance = field(alpha, alpha.length);
  for (let i = 1; i < distance.length; i++) assert.ok(distance[i] > distance[i - 1]);
  assert.ok(distance[1] < 128); assert.equal(distance[2], 128); assert.ok(distance[3] > 128);
  assert.deepEqual(Array.from(field(Array(6).fill(0), 3)), Array(6).fill(0));
  assert.deepEqual(Array.from(field(Array(6).fill(255), 3)), Array(6).fill(255));
  assert.equal(field([255, 0, 0, 0, 0], 5, 2).at(-1), 0);
});

test('separate ink contours and holes match a brute-force distance calculation', () => {
  const rows = ['..###..', '.#...#.', '.#.#.#.', '.#...#.', '..###..'], width = rows[0].length;
  const alpha = [...rows.join('')].map(pixel => pixel === '#' ? 255 : 0), distance = field(alpha, width);
  for (let i = 0; i < alpha.length; i++) {
    let nearest = Infinity;
    for (let j = 0; j < alpha.length; j++) if (alpha[i] !== alpha[j]) {
      nearest = Math.min(nearest, Math.hypot(i % width - j % width, Math.floor(i / width) - Math.floor(j / width)));
    }
    const signed = alpha[i] ? -nearest : nearest;
    assert.equal(distance[i], Math.round(255 * (.5 - signed / 16)));
  }
});
