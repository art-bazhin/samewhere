import { insideOutline } from './geometry';
import { DOOR_HEIGHT, DOOR_WIDTH, PEDESTAL_HEIGHT, pedestalOutline, ROOM_IDS, ROOMS, roomWalls, WALL_THICKNESS, type RoomId, type Vec2 } from './world';

interface Point extends Vec2 { y: number }
// Surface samples are stored as float32; a point exactly on a jamb must not
// become an outside-aperture sample after transforming or rounding coordinates.
export const APERTURE_EPSILON = .00001;
const pedestalShapes = Object.fromEntries(ROOM_IDS.map(id => [id, ROOMS[id].pedestals.map(p => pedestalOutline(p.controls).map(v => ({ x: v.x + p.x, z: v.z + p.z })))])) as Record<RoomId, Vec2[][]>;
const pedestalBounds = Object.fromEntries(ROOM_IDS.map(id => [id, pedestalShapes[id].map(shape => ({
  minX: Math.min(...shape.map(p => p.x)), maxX: Math.max(...shape.map(p => p.x)),
  minZ: Math.min(...shape.map(p => p.z)), maxZ: Math.max(...shape.map(p => p.z)),
}))])) as Record<RoomId, { minX: number; maxX: number; minZ: number; maxZ: number }[]>;

function intersection(a: Vec2, b: Vec2, c: Vec2, d: Vec2) {
  const dx = b.x - a.x, dz = b.z - a.z, wx = d.x - c.x, wz = d.z - c.z;
  const determinant = dx * wz - dz * wx;
  if (Math.abs(determinant) < 1e-9) return -1;
  const ax = c.x - a.x, az = c.z - a.z;
  const t = (ax * wz - az * wx) / determinant, u = (ax * dz - az * dx) / determinant;
  return t > .00001 && t < .99999 && u >= 0 && u <= 1 ? t : -1;
}

/** Straight path within a room, including its concave corners and pedestal bodies. */
export function transferPathBlocked(room: RoomId, a: Point, b: Point, exit: number, interior = false) {
  if (!interior || ROOMS[room].outline) for (const wall of roomWalls(room)) {
    if (wall.portal === exit) continue;
    const t = intersection(a, b, wall.a, wall.b);
    if (t < 0) continue;
    // Include the full wall thickness for passage-filter guard samples across
    // the transition plane, as well as this scene's visible half of the reveal.
    const inPassage = (p: Point) => {
      const depth = (p.x - wall.center.x) * wall.normal.x + (p.z - wall.center.z) * wall.normal.z;
      const lateral = -(p.x - wall.center.x) * wall.normal.z + (p.z - wall.center.z) * wall.normal.x;
      return wall.portal !== null && depth >= -.0001 && depth <= WALL_THICKNESS + .003 &&
        Math.abs(lateral) <= DOOR_WIDTH / 2 + .003 && p.y >= 0 && p.y <= DOOR_HEIGHT;
    };
    if (!inPassage(a) && !inPassage(b)) return true;
    const x = a.x + (b.x - a.x) * t - wall.center.x, z = a.z + (b.z - a.z) * t - wall.center.z;
    const y = a.y + (b.y - a.y) * t;
    if (Math.abs(-x * wall.normal.z + z * wall.normal.x) > DOOR_WIDTH / 2 + APERTURE_EPSILON || y < -APERTURE_EPSILON || y > DOOR_HEIGHT + APERTURE_EPSILON) return true;
  }
  // The 8 cm balls and individual saucers are below this diffuse cache's scale.
  // Pedestal silhouettes use the actual regular/concave footprint, not a box.
  const dy = b.y - a.y;
  let from = 0, to = 1;
  if (Math.abs(dy) < 1e-8) { if (a.y < 0 || a.y > PEDESTAL_HEIGHT) return false; }
  else {
    const t0 = -a.y / dy, t1 = (PEDESTAL_HEIGHT - a.y) / dy;
    from = Math.max(0, Math.min(t0, t1)); to = Math.min(1, Math.max(t0, t1));
    if (to <= from) return false;
  }
  const start = { x: a.x + (b.x - a.x) * from, z: a.z + (b.z - a.z) * from };
  const end = { x: a.x + (b.x - a.x) * to, z: a.z + (b.z - a.z) * to };
  for (const [index, shape] of pedestalShapes[room].entries()) {
    const box = pedestalBounds[room][index], dx = end.x - start.x, dz = end.z - start.z;
    let enter = 0, leave = 1;
    if (Math.abs(dx) < 1e-10) { if (start.x < box.minX || start.x > box.maxX) continue; }
    else { const a = (box.minX - start.x) / dx, b = (box.maxX - start.x) / dx; enter = Math.max(enter, Math.min(a, b)); leave = Math.min(leave, Math.max(a, b)); }
    if (Math.abs(dz) < 1e-10) { if (start.z < box.minZ || start.z > box.maxZ) continue; }
    else { const a = (box.minZ - start.z) / dz, b = (box.maxZ - start.z) / dz; enter = Math.max(enter, Math.min(a, b)); leave = Math.min(leave, Math.max(a, b)); }
    if (leave < enter) continue;
    if (insideOutline(start, shape) || insideOutline(end, shape)) return true;
    for (let i = 0; i < shape.length; i++) if (intersection(start, end, shape[i], shape[(i + 1) % shape.length]) >= 0) return true;
  }
  return false;
}

