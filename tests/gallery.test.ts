import test from 'node:test';
import assert from 'node:assert/strict';
import { galleryExitAt, galleryNeighbor, galleryRoute, isGalleryExit } from '../src/gallery';

test('EXIT routes turn by 90 degrees, never reverse through the entrance, and never revisit a room', () => {
  const signs = galleryRoute(), gallery = { cell: { x: 0, z: 0 }, signs, outside: false };
  assert.equal(signs.length, 42);
  assert.equal(new Set(signs.map(sign => `${sign.x},${sign.z}`)).size, signs.length);
  assert.deepEqual(signs.map(sign => sign.side), [
    ...Array(5).fill(2), ...Array(5).fill(1), ...Array(5).fill(2), ...Array(10).fill(1),
    0, 1, 0, 1, 0, ...Array(5).fill(1), ...Array(7).fill(2),
  ], 'The route must follow the approved turns and finish with a right turn into seven southward crossings');
  for (const [index, sign] of signs.entries()) {
    assert.equal(galleryExitAt(gallery, sign), sign.side);
    if (!index) continue;
    const previous = signs[index - 1];
    assert.deepEqual({ x: sign.x, z: sign.z }, galleryNeighbor(previous, previous.side));
    assert.notEqual(sign.side, (previous.side + 2) % 4, 'The route points back through the entrance');
  }
  const last = signs.at(-1)!;
  assert.equal(isGalleryExit(gallery, last, last.side), true);
  assert.equal(isGalleryExit(gallery, signs[0], signs[0].side), false);
  assert.equal(isGalleryExit(gallery, last, (last.side + 1) % 4), false);
  assert.equal(galleryExitAt(gallery, galleryNeighbor(last, last.side)), null);
});

test('gallery coordinates identify the same room along different paths and on returning backwards', () => {
  const origin = { x: 0, z: 0 };
  assert.deepEqual(galleryNeighbor(galleryNeighbor(origin, 0), 1), galleryNeighbor(galleryNeighbor(origin, 1), 0));
  for (let side = 0; side < 4; side++) assert.deepEqual(galleryNeighbor(galleryNeighbor(origin, side), (side + 2) % 4), origin);
  const gallery = { cell: origin, signs: galleryRoute(), outside: false };
  const first = galleryExitAt(gallery, origin);
  gallery.cell = galleryNeighbor(origin, 1);
  assert.equal(galleryExitAt(gallery, gallery.cell), null);
  gallery.cell = galleryNeighbor(gallery.cell, 3);
  assert.equal(galleryExitAt(gallery, gallery.cell), first);
});
