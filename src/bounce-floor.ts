import { ShapeUtils, Vector2 } from 'three';
import type { BounceArea } from './bounce-area';
import { closestOnSegment, type Vec2 } from './geometry';

const cross = (a: Vec2, b: Vec2, p: Vec2) => (b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x);
function measure(polygon: Vec2[]) {
  let twice = 0, x = 0, z = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length], weight = a.x * b.z - b.x * a.z;
    twice += weight; x += (a.x + b.x) * weight; z += (a.z + b.z) * weight;
  }
  return { area: Math.abs(twice) / 2, point: { x: x / (3 * twice), y: 0, z: z / (3 * twice) } };
}
function clip(polygon: Vec2[], triangle: Vec2[]) {
  const sign = Math.sign(cross(triangle[0], triangle[1], triangle[2]));
  for (let edge = 0; edge < 3 && polygon.length; edge++) {
    const a = triangle[edge], b = triangle[(edge + 1) % 3], result: Vec2[] = [];
    let previous = polygon[polygon.length - 1], before = sign * cross(a, b, previous);
    for (const point of polygon) {
      const after = sign * cross(a, b, point);
      if (before < 0 && after > 0 || before > 0 && after < 0) {
        const t = before / (before - after);
        result.push({ x: previous.x + (point.x - previous.x) * t, z: previous.z + (point.z - previous.z) * t });
      }
      if (after >= 0) result.push(point);
      previous = point; before = after;
    }
    polygon = result;
  }
  return polygon;
}

/** Partition the exposed floor, clipping cells at walls and pedestal footprints.
 * Interior rectangles retain their original sampling pattern. */
export function* floorBounceCells(outline: Vec2[], subdivisions = 4, holes: Vec2[][] = [], refine = true): Generator<{
  key: string; group: BounceArea; cell: BounceArea & { area: number };
}> {
  const vertices = [outline, ...holes].flat();
  const triangles = ShapeUtils.triangulateShape(outline.map(p => new Vector2(p.x, p.z)), holes.map(hole => hole.map(p => new Vector2(p.x, p.z))))
    .map(indices => indices.map(i => vertices[i]));
  const minX = Math.min(...outline.map(p => p.x)), maxX = Math.max(...outline.map(p => p.x));
  const minZ = Math.min(...outline.map(p => p.z)), maxZ = Math.max(...outline.map(p => p.z)), step = 2.5 / subdivisions;
  const holeBounds = holes.map(hole => ({ minX: Math.min(...hole.map(p => p.x)), maxX: Math.max(...hole.map(p => p.x)),
    minZ: Math.min(...hole.map(p => p.z)), maxZ: Math.max(...hole.map(p => p.z)) }));
  const nx = Math.ceil((maxX - minX) / step), nz = Math.ceil((maxZ - minZ) / step), dx = (maxX - minX) / nx, dz = (maxZ - minZ) / nz;
  for (let x = 0; x < nx; x++) for (let z = 0; z < nz; z++) {
    const cellX = minX + x * dx, cellZ = minZ + z * dz;
    // Near a pedestal, resolve the floor's shadow before assigning a cell's
    // radiance: a lit center must not brighten the dark floor at its foot.
    const nearPedestal = refine && holeBounds.some(b => cellX + dx >= b.minX - dx && cellX <= b.maxX + dx &&
      cellZ + dz >= b.minZ - dz && cellZ <= b.maxZ + dz);
    // The first floor cell dominates wall receivers near y=0. Keep its
    // radiance accurate even when the rest of the draft grid is coarser.
    const nearWall = refine && subdivisions < 16 && outline.some((a, i) => {
      const center = { x: cellX + dx / 2, z: cellZ + dz / 2 }, p = closestOnSegment(center, a, outline[(i + 1) % outline.length]);
      return Math.hypot(center.x - p.x, center.z - p.z) <= Math.hypot(dx, dz) / 2 + .00001;
    });
    const splits = nearPedestal ? 4 : nearWall ? Math.ceil(16 / subdivisions) : 1;
    const ix = Math.floor(x / subdivisions) * subdivisions, iz = Math.floor(z / subdivisions) * subdivisions;
    const width = Math.min(subdivisions, nx - ix) * dx, depth = Math.min(subdivisions, nz - iz) * dz;
    const group: BounceArea = { point: { x: minX + ix * dx + width / 2, y: 0, z: minZ + iz * dz + depth / 2 },
      normal: { x: 0, y: 1, z: 0 }, halfU: { x: width / 2, y: 0, z: 0 }, halfV: { x: 0, y: 0, z: depth / 2 } };
    const key = `floor:${ix}:${iz}`;
    for (let sx = 0; sx < splits; sx++) for (let sz = 0; sz < splits; sz++) {
      const cellWidth = dx / splits, cellDepth = dz / splits, left = cellX + sx * cellWidth, low = cellZ + sz * cellDepth;
      const rectangle = [{ x: left, z: low }, { x: left + cellWidth, z: low },
        { x: left + cellWidth, z: low + cellDepth }, { x: left, z: low + cellDepth }];
      const pieces = triangles.map(triangle => clip(rectangle, triangle)).filter(polygon => polygon.length >= 3)
        .map(vertices => ({ vertices, ...measure(vertices) })).filter(piece => piece.area > 1e-10);
      if (!pieces.length) continue;
      if (Math.abs(pieces.reduce((sum, piece) => sum + piece.area, 0) - cellWidth * cellDepth) < 1e-9) {
        yield { key, group, cell: { point: { x: left + cellWidth / 2, y: 0, z: low + cellDepth / 2 }, normal: group.normal,
          halfU: { x: cellWidth / 2, y: 0, z: 0 }, halfV: { x: 0, y: 0, z: cellDepth / 2 }, area: cellWidth * cellDepth } };
      } else for (const piece of pieces) {
        const vertices = piece.vertices.map(p => ({ x: p.x - piece.point.x, y: 0, z: p.z - piece.point.z }));
        yield { key, group, cell: { point: piece.point, normal: group.normal, vertices, area: piece.area,
          halfU: { x: Math.max(...vertices.map(p => Math.abs(p.x))), y: 0, z: 0 },
          halfV: { x: 0, y: 0, z: Math.max(...vertices.map(p => Math.abs(p.z))) } } };
      }
    }
  }
}
