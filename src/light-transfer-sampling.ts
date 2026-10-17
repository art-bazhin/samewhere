import { CEILING_LIGHT, ROOM_LIGHTS, SPOT_LIGHT_SHARE } from './lighting';
import { transferPathBlocked } from './light-path';
export { transferPathBlocked } from './light-path';
import { DOOR_HEIGHT, DOOR_WIDTH, portalDistance, portalPosition, transformPoint, WALL_THICKNESS, wallNormal, type SocketRef, type Vec2 } from './world';

interface Point extends Vec2 { y: number }

/** Direct diffuse transport from the source's lamps through exactly one passage. */
export function createTransferSampler(receiver: SocketRef, source: SocketRef) {
  const n = wallNormal(receiver.room, receiver.side), distance = portalDistance(receiver.room, receiver.side), center = portalPosition(receiver.room, receiver.side);
  const cone = Math.cos(CEILING_LIGHT.angle), penumbra = Math.cos(CEILING_LIGHT.angle * (1 - CEILING_LIGHT.penumbra));
  const lamps = ROOM_LIGHTS[source.room].map(lamp => ({ ...lamp, virtual: transformPoint(lamp, source, receiver) }));
  return (point: Point, result: Float32Array, normal?: Point) => {
    result.fill(0);
    for (const lamp of lamps) {
      const dx = lamp.virtual.x - point.x, dy = CEILING_LIGHT.height - point.y, dz = lamp.virtual.z - point.z;
      const length = Math.hypot(dx, dy, dz);
      if (length >= CEILING_LIGHT.distance || dy <= 0) continue;
      const receive = normal ? (normal.x * dx + normal.y * dy + normal.z * dz) / length : 0;
      if (normal && receive <= 0) continue;
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
      // Extend probes a little beyond the transition plane. Bilinear filtering
      // must not blend the doorway's illumination with an artificial black edge.
      const t = Math.max(0, (distance - signed) / normalStep);
      if (t >= 1) continue;
      const aperture = { x: point.x + dx * t, y: point.y + dy * t, z: point.z + dz * t };
      if (transferPathBlocked(receiver.room, point, aperture, receiver.side)) continue;
      const q = transformPoint(aperture, receiver, source);
      if (transferPathBlocked(source.room, { x: lamp.x, y: CEILING_LIGHT.height, z: lamp.z }, { ...q, y: aperture.y }, source.side)) continue;
      const spot = Math.max(0, Math.min(1, (dy / length - cone) / (penumbra - cone)));
      const cutoff = Math.max(0, 1 - (length / CEILING_LIGHT.distance) ** 4);
      // Across a doorway the diffuser is already distant: its central probe
      // retains the panel's cosine emission and the live spotlight's share.
      const emission = SPOT_LIGHT_SHARE * spot * spot * (3 - 2 * spot) + (1 - SPOT_LIGHT_SHARE) * dy / length;
      const energy = CEILING_LIGHT.intensity * emission * cutoff * cutoff / Math.max(length * length, .01);
      if (normal) { result[0] += energy * receive; continue; }
      result[dx < 0 ? 1 : 0] += energy * Math.abs(dx) / length;
      result[dy < 0 ? 3 : 2] += energy * Math.abs(dy) / length;
      result[dz < 0 ? 5 : 4] += energy * Math.abs(dz) / length;
    }
    return result;
  };
}

export function transferAt(receiver: SocketRef, source: SocketRef, point: Point, result = new Float32Array(6)) {
  return createTransferSampler(receiver, source)(point, result);
}

