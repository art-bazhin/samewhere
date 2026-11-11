export interface GalleryCell { x: number; z: number }
export interface GallerySign extends GalleryCell { side: number }
export interface GalleryState { cell: GalleryCell; signs: GallerySign[]; outside: boolean }

const STEPS = [{ x: 0, z: -1 }, { x: 1, z: 0 }, { x: 0, z: 1 }, { x: -1, z: 0 }];
// S5 → E5 → S5 → E10 → five north-east steps → E12.
// On the diagonal: red on the left, blue on the right.
// Sides: N=0, E=1, S=2, W=3.
const RUNS = [
  [2, 5], [1, 5], [2, 5], [1, 10],
  ...Array.from({ length: 5 }, (_, step) => [step % 2, 1]),
  [1, 12],
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

export function isGalleryExit(gallery: GalleryState, cell: GalleryCell, side: number): boolean {
  const last = gallery.signs.at(-1);
  return !!last && last.x === cell.x && last.z === cell.z && last.side === side;
}
