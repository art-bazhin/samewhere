export interface GalleryCell { x: number; z: number }
export interface GallerySign extends GalleryCell { side: number }
export interface GalleryState { cell: GalleryCell; signs: GallerySign[] }

const STEPS = [{ x: 0, z: -1 }, { x: 1, z: 0 }, { x: 0, z: 1 }, { x: -1, z: 0 }];
// The S→E sketch, rotated clockwise so its long diagonal faces north-east:
// red on the left, blue on the right. Sides: N=0, E=1, S=2, W=3.
const RUNS = [
  [2, 2],
  [3, 1], [2, 1], [3, 1], [2, 1], // Short south-west diagonal.
  [2, 3], [1, 3],
  ...Array.from({ length: 8 }, (_, step) => [step % 2, 1]),
  [0, 2], [1, 3], [2, 11], [3, 3], [2, 3],
];

export function galleryNeighbor(cell: GalleryCell, side: number): GalleryCell {
  return { x: cell.x + STEPS[side].x, z: cell.z + STEPS[side].z };
}

export function galleryRoute(): GallerySign[] {
  const signs: GallerySign[] = [];
  let cell = { x: 0, z: 0 };
  for (const [side, length] of RUNS) {
    for (let step = 0; step < length; step++) {
      signs.push({ ...cell, side }); cell = galleryNeighbor(cell, side);
    }
  }
  return signs;
}

export function galleryExitAt(gallery: GalleryState, cell: GalleryCell): number | null {
  return gallery.signs.find(sign => sign.x === cell.x && sign.z === cell.z)?.side ?? null;
}
