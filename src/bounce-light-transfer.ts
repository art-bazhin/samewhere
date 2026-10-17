import { bouncePatches } from './panel-light-bake';
import { transferPathBlocked } from './light-path';
import { DOOR_HEIGHT, DOOR_WIDTH, portalAngle, portalDistance, portalPosition, rotate, transformPoint, WALL_THICKNESS, wallNormal, type SocketRef } from './world';

interface Point { x: number; y: number; z: number }
const patches = new Map<string, ReturnType<typeof bouncePatches>>();

/** The same warm reflection used locally must also cross an open doorway. */
export function createBounceTransferSampler(receiver: SocketRef, source: SocketRef) {
  let sourcePatches = patches.get(source.room);
  if (!sourcePatches) { sourcePatches = bouncePatches(source.room); patches.set(source.room, sourcePatches); }
  const emitters = sourcePatches.map(patch => ({ ...patch,
    virtual: { ...transformPoint(patch.point, source, receiver), y: patch.point.y },
    direction: { ...rotate(patch.normal, portalAngle(source, receiver)), y: patch.normal.y },
  }));
  const n = wallNormal(receiver.room, receiver.side), center = portalPosition(receiver.room, receiver.side);
  const distance = portalDistance(receiver.room, receiver.side);
  return (point: Point, normal: Point, values: Float32Array, offset: number) => {
    // First-bounce transfer matters most at the junction. A smooth two-meter
    // apron keeps that junction continuous without a room-wide GI rebake.
    const depth = Math.max(0, distance - n.x * point.x - n.z * point.z);
    const lateral = Math.max(0, Math.abs(-n.z * (point.x - center.x) + n.x * (point.z - center.z)) - DOOR_WIDTH / 2);
    const vertical = Math.max(0, -point.y, point.y - DOOR_HEIGHT);
    const reach = Math.hypot(depth, lateral, vertical);
    if (reach >= 2) return;
    const t = Math.max(0, (reach - .5) / 1.5), gain = 1 - t * t * (3 - 2 * t);
    const origin = { x: point.x + normal.x * .005, y: point.y + normal.y * .005, z: point.z + normal.z * .005 };
    let red = 0, green = 0, blue = 0;
    for (const patch of emitters) {
      const x = patch.virtual.x - point.x, y = patch.virtual.y - point.y, z = patch.virtual.z - point.z;
      const receive = normal.x * x + normal.y * y + normal.z * z;
      const emit = -(patch.direction.x * x + patch.direction.y * y + patch.direction.z * z);
      if (receive <= 0 || emit <= 0) continue;
      const distance2 = x * x + y * y + z * z;
      const form = patch.area * receive * emit / (distance2 * distance2 + patch.area * patch.area * .25);
      if (form < .0001) continue;
      const step = n.x * x + n.z * z;
      if (step <= 1e-8) continue;
      const signed = n.x * point.x + n.z * point.z;
      let visible = true;
      for (const face of [-WALL_THICKNESS / 2, WALL_THICKNESS / 2]) {
        const t = Math.max(0, (distance + face - signed) / step);
        const px = point.x + x * t, py = point.y + y * t, pz = point.z + z * t;
        if (t >= 1 || py < 0 || py > DOOR_HEIGHT || Math.abs(-n.z * (px - center.x) + n.x * (pz - center.z)) > DOOR_WIDTH / 2) { visible = false; break; }
      }
      if (!visible) continue;
      const t = Math.max(0, (distance - signed) / step);
      const aperture = { x: point.x + x * t, y: point.y + y * t, z: point.z + z * t };
      if (transferPathBlocked(receiver.room, origin, aperture, receiver.side)) continue;
      const q = transformPoint(aperture, receiver, source);
      if (transferPathBlocked(source.room, { ...q, y: aperture.y }, patch.point, source.side)) continue;
      red += patch.color.r * form; green += patch.color.g * form; blue += patch.color.b * form;
    }
    values[offset] = red * gain; values[offset + 1] = green * gain; values[offset + 2] = blue * gain;
  };
}
