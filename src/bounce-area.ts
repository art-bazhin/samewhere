import { PEDESTAL_HEIGHT, pedestalOutline, ROOM_HEIGHT, ROOM_IDS, ROOMS, roomWalls, type RoomId } from './world';

export interface Point { x: number; y: number; z: number }
export interface BounceArea { point: Point; normal: Point; halfU: Point; halfV: Point }
const planes = new Float64Array(20);
interface Bounds { min: Point; max: Point }
const bounds = (points: Point[]): Bounds => ({
  min: { x: Math.min(...points.map(p => p.x)), y: Math.min(...points.map(p => p.y)), z: Math.min(...points.map(p => p.z)) },
  max: { x: Math.max(...points.map(p => p.x)), y: Math.max(...points.map(p => p.y)), z: Math.max(...points.map(p => p.z)) },
});
const blockers = Object.fromEntries(ROOM_IDS.map(room => [room, [
  ...roomWalls(room).map(wall => ({
    ...bounds([{ ...wall.a, y: 0 }, { ...wall.b, y: ROOM_HEIGHT }]), portal: wall.portal, wall: true,
  })),
  ...ROOMS[room].pedestals.map(p => ({
    ...bounds(pedestalOutline(p.controls).flatMap(q => [0, PEDESTAL_HEIGHT].map(y => ({ x: p.x + q.x, y, z: p.z + q.z })))), portal: null, wall: false,
  })),
]])) as Record<RoomId, (Bounds & { portal: number | null; wall: boolean })[]>;

/** Conservative pyramid/box test: only skip rays if the entire area is clear.
 * A box overlapping a pyramid may be a false positive; it can never hide an
 * occluder. Partial visibility still uses the actual room/pedestal silhouettes. */
export function bounceAreaClear(room: RoomId, origin: Point, area: BounceArea, exit = -1, interior = false) {
  const { point, normal, halfU: u, halfV: v } = area;
  const x = point.x - origin.x, y = point.y - origin.y, z = point.z - origin.z;
  const rx = Math.abs(u.x) + Math.abs(v.x), ry = Math.abs(u.y) + Math.abs(v.y), rz = Math.abs(u.z) + Math.abs(v.z);
  const minX = Math.min(origin.x, point.x - rx), maxX = Math.max(origin.x, point.x + rx);
  const minY = Math.min(origin.y, point.y - ry), maxY = Math.max(origin.y, point.y + ry);
  const minZ = Math.min(origin.z, point.z - rz), maxZ = Math.max(origin.z, point.z + rz);
  let prepared = false;
  // Convex walls cannot cross interior segments. Outside the room's inner
  // face, however, threshold probes still need the actual jamb visibility.
  const interiorSegment = !ROOMS[room].outline && (exit >= 0 || interior);
  for (const box of blockers[room]) {
    if (interiorSegment && box.wall) continue;
    if (box.portal === exit || box.max.x < minX || box.min.x > maxX || box.max.y < minY || box.min.y > maxY || box.max.z < minZ || box.min.z > maxZ) continue;
    if (!prepared) {
        for (let edge = 0; edge < 4; edge++) {
          const a = edge === 0 || edge === 3 ? -1 : 1, b = edge < 2 ? -1 : 1;
          const next = (edge + 1) % 4, c = next === 0 || next === 3 ? -1 : 1, d = next < 2 ? -1 : 1;
          const ax = x + a * u.x + b * v.x, ay = y + a * u.y + b * v.y, az = z + a * u.z + b * v.z;
          const bx = x + c * u.x + d * v.x, by = y + c * u.y + d * v.y, bz = z + c * u.z + d * v.z;
          let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
          if (nx * x + ny * y + nz * z < 0) { nx = -nx; ny = -ny; nz = -nz; }
          const i = edge * 4;
          planes[i] = nx; planes[i + 1] = ny; planes[i + 2] = nz; planes[i + 3] = -(nx * origin.x + ny * origin.y + nz * origin.z);
        }
        const sign = normal.x * -x + normal.y * -y + normal.z * -z >= 0 ? 1 : -1;
        planes[16] = normal.x * sign; planes[17] = normal.y * sign; planes[18] = normal.z * sign;
        planes[19] = -(normal.x * point.x + normal.y * point.y + normal.z * point.z) * sign;
      prepared = true;
    }
    let outside = false;
    for (let plane = 0; plane < 20; plane += 4) {
      const nx = planes[plane], ny = planes[plane + 1], nz = planes[plane + 2];
      if (nx * (nx >= 0 ? box.max.x : box.min.x) + ny * (ny >= 0 ? box.max.y : box.min.y) +
        nz * (nz >= 0 ? box.max.z : box.min.z) + planes[plane + 3] < -1e-9) { outside = true; break; }
    }
    if (!outside) return false;
  }
  return true;
}

const polygon = new Float64Array(24), clipped = new Float64Array(24);

/** Irradiance of a finite Lambertian rectangle. Near a surface, integrate its
 * projected solid angle instead of softening an inverse-square point source.
 * Small, distant cells use midpoint quadrature with a continuous transition. */
export function bounceFormFactor(area: BounceArea & { area: number }, normal: Point,
  x: number, y: number, z: number, receive: number, emit: number, distance2: number) {
  const midpoint = area.area * receive * emit / Math.max(distance2 * distance2, 1e-20);
  if (distance2 >= area.area * 4) return midpoint;
  const { halfU: u, halfV: v } = area;
  for (let i = 0; i < 4; i++) {
    const a = i === 0 || i === 3 ? -1 : 1, b = i < 2 ? -1 : 1;
    polygon[i * 3] = x + a * u.x + b * v.x;
    polygon[i * 3 + 1] = y + a * u.y + b * v.y;
    polygon[i * 3 + 2] = z + a * u.z + b * v.z;
  }
  // Clip at the receiver's horizon before integrating the spherical polygon.
  let count = 0, previous = 9;
  let before = normal.x * polygon[previous] + normal.y * polygon[previous + 1] + normal.z * polygon[previous + 2];
  for (let i = 0; i < 12; i += 3) {
    const after = normal.x * polygon[i] + normal.y * polygon[i + 1] + normal.z * polygon[i + 2];
    if ((before < 0 && after > 0) || (before > 0 && after < 0)) {
      const t = before / (before - after);
      for (let axis = 0; axis < 3; axis++) clipped[count * 3 + axis] = polygon[previous + axis] + t * (polygon[i + axis] - polygon[previous + axis]);
      count++;
    }
    if (after >= 0) { for (let axis = 0; axis < 3; axis++) clipped[count * 3 + axis] = polygon[i + axis]; count++; }
    before = after; previous = i;
  }
  let integral = 0;
  for (let i = 0; i < count; i++) {
    const a = i * 3, b = (i + 1) % count * 3;
    const ax = clipped[a], ay = clipped[a + 1], az = clipped[a + 2], bx = clipped[b], by = clipped[b + 1], bz = clipped[b + 2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const length = Math.hypot(nx, ny, nz);
    if (length < 1e-14) continue;
    integral += Math.atan2(length, ax * bx + ay * by + az * bz) * (nx * normal.x + ny * normal.y + nz * normal.z) / length;
  }
  const exact = Math.min(Math.PI, Math.abs(integral) / 2);
  const t = Math.max(0, Math.min(1, (distance2 / area.area - 1) / 3)), blend = t * t * (3 - 2 * t);
  return exact * (1 - blend) + midpoint * blend;
}
