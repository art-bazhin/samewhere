import { insideOutline } from './geometry';
import { CEILING_LIGHT } from './lighting';
import { DOOR_HEIGHT, DOOR_WIDTH, PEDESTAL_HEIGHT, pedestalOutline, portalDistance, portalPosition, ROOM_HEIGHT, ROOM_IDS, ROOMS, roomOutline, roomWalls, transformPoint, WALL_THICKNESS, wallNormal, type RoomId, type SocketRef, type Vec2 } from './world';

// A small directional irradiance volume. Fine surface detail still comes from
// the regular PBR lights; the transported diffuse component is softly filtered.
export const TRANSFER_SPACING = .25;
export const TRANSFER_AXES = 6;
export interface TransferGrid { origin: { x: number; y: number; z: number }; size: { x: number; y: number; z: number } }
export const TRANSFER_GRIDS = Object.fromEntries(ROOM_IDS.map(id => {
  const outline = roomOutline(id), minX = Math.min(...outline.map(p => p.x)), minZ = Math.min(...outline.map(p => p.z));
  const x = Math.floor(minX / TRANSFER_SPACING) * TRANSFER_SPACING - TRANSFER_SPACING;
  const z = Math.floor(minZ / TRANSFER_SPACING) * TRANSFER_SPACING - TRANSFER_SPACING;
  return [id, { origin: { x, y: 0, z }, size: {
    x: Math.ceil((Math.max(...outline.map(p => p.x)) - x) / TRANSFER_SPACING) + 2,
    y: Math.ceil(ROOM_HEIGHT / TRANSFER_SPACING) + 1,
    z: Math.ceil((Math.max(...outline.map(p => p.z)) - z) / TRANSFER_SPACING) + 2,
  } }];
})) as Record<RoomId, TransferGrid>;

interface Point extends Vec2 { y: number }
const pedestalShapes = Object.fromEntries(ROOM_IDS.map(id => [id, ROOMS[id].pedestals.map(p => pedestalOutline(p.controls).map(v => ({ x: v.x + p.x, z: v.z + p.z })))])) as Record<RoomId, Vec2[][]>;

function intersection(a: Vec2, b: Vec2, c: Vec2, d: Vec2) {
  const dx = b.x - a.x, dz = b.z - a.z, wx = d.x - c.x, wz = d.z - c.z;
  const determinant = dx * wz - dz * wx;
  if (Math.abs(determinant) < 1e-9) return -1;
  const ax = c.x - a.x, az = c.z - a.z;
  const t = (ax * wz - az * wx) / determinant, u = (ax * dz - az * dx) / determinant;
  return t > .00001 && t < .99999 && u >= 0 && u <= 1 ? t : -1;
}

/** Straight path within a room, including its concave corners and pedestal bodies. */
export function transferPathBlocked(room: RoomId, a: Point, b: Point, exit: number) {
  for (const wall of roomWalls(room)) {
    if (wall.portal !== exit && intersection(a, b, wall.a, wall.b) >= 0) return true;
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
  for (const shape of pedestalShapes[room]) {
    if (insideOutline(start, shape) || insideOutline(end, shape)) return true;
    for (let i = 0; i < shape.length; i++) if (intersection(start, end, shape[i], shape[(i + 1) % shape.length]) >= 0) return true;
  }
  return false;
}

/** Direct diffuse transport from the source's lamps through exactly one passage. */
function transferSampler(receiver: SocketRef, source: SocketRef) {
  const n = wallNormal(receiver.room, receiver.side), distance = portalDistance(receiver.room, receiver.side), center = portalPosition(receiver.room, receiver.side);
  const cone = Math.cos(CEILING_LIGHT.angle), penumbra = Math.cos(CEILING_LIGHT.angle * (1 - CEILING_LIGHT.penumbra));
  const lamps = ROOMS[source.room].pedestals.map(lamp => ({ ...lamp, virtual: transformPoint(lamp, source, receiver) }));
  return (point: Point, result: Float32Array) => {
    result.fill(0);
    for (const lamp of lamps) {
      const dx = lamp.virtual.x - point.x, dy = CEILING_LIGHT.height - point.y, dz = lamp.virtual.z - point.z;
      const length = Math.hypot(dx, dy, dz);
      if (length >= CEILING_LIGHT.distance || dy <= 0 || dy / length <= cone) continue;
      const normalStep = n.x * dx + n.z * dz;
      if (normalStep <= 1e-8) continue;
      const signed = n.x * point.x + n.z * point.z;
      let passes = true;
      // Both inner wall faces bound the aperture: light cannot cut diagonally
      // through a 30 cm jamb or through the header above the door.
      for (const face of [-WALL_THICKNESS / 2, WALL_THICKNESS / 2]) {
        const t = Math.max(0, (distance + face - signed) / normalStep);
        const x = point.x + dx * t, y = point.y + dy * t, z = point.z + dz * t;
        if (t >= 1 || y < 0 || y > DOOR_HEIGHT || Math.abs(-n.z * (x - center.x) + n.x * (z - center.z)) > DOOR_WIDTH / 2) { passes = false; break; }
      }
      if (!passes) continue;
      // Extend probes a little beyond the transition plane. Trilinear filtering
      // must not blend the doorway's illumination with an artificial black edge.
      const t = Math.max(0, (distance - signed) / normalStep);
      if (t >= 1) continue;
      const aperture = { x: point.x + dx * t, y: point.y + dy * t, z: point.z + dz * t };
      if (transferPathBlocked(receiver.room, point, aperture, receiver.side)) continue;
      const q = transformPoint(aperture, receiver, source);
      if (transferPathBlocked(source.room, { x: lamp.x, y: CEILING_LIGHT.height, z: lamp.z }, { ...q, y: aperture.y }, source.side)) continue;
      const spot = Math.max(0, Math.min(1, (dy / length - cone) / (penumbra - cone)));
      const cutoff = Math.max(0, 1 - (length / CEILING_LIGHT.distance) ** 4);
      const energy = CEILING_LIGHT.intensity * spot * spot * (3 - 2 * spot) * cutoff * cutoff / Math.max(length * length, .01);
      result[dx < 0 ? 1 : 0] += energy * Math.abs(dx) / length;
      result[dy < 0 ? 3 : 2] += energy * Math.abs(dy) / length;
      result[dz < 0 ? 5 : 4] += energy * Math.abs(dz) / length;
    }
    return result;
  };
}

export function transferAt(receiver: SocketRef, source: SocketRef, point: Point, result = new Float32Array(TRANSFER_AXES)) {
  return transferSampler(receiver, source)(point, result);
}

export function bakeTransfer(receiver: SocketRef, source: SocketRef) {
  const grid = TRANSFER_GRIDS[receiver.room], { x: nx, y: ny, z: nz } = grid.size;
  const count = nx * ny * nz, values = new Float32Array(count * TRANSFER_AXES), sample = new Float32Array(TRANSFER_AXES);
  const sampleTransfer = transferSampler(receiver, source);
  const point = { x: 0, y: 0, z: 0 };
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    point.x = grid.origin.x + x * TRANSFER_SPACING; point.y = y * TRANSFER_SPACING; point.z = grid.origin.z + z * TRANSFER_SPACING;
    sampleTransfer(point, sample);
    const index = x + nx * (y + ny * z);
    for (let axis = 0; axis < TRANSFER_AXES; axis++) values[index + axis * count] = sample[axis];
  }
  return values;
}
