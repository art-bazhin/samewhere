import { bouncePatches, type LightingBakeQuality } from './panel-light-bake';
import { bounceAreaClear, bounceFormFactor, type BounceArea } from './bounce-area';
import { APERTURE_EPSILON, transferPathBlocked } from './light-path';
import { DOOR_HEIGHT, DOOR_WIDTH, portalAngle, portalDistance, portalPosition, rotate, transformPoint, WALL_THICKNESS, wallNormal, type SocketRef } from './world';

interface Point { x: number; y: number; z: number }

/** Perspective aperture half-planes are shared by all reflector areas. */
function aperturePlanes(point: Point, n: Point, center: Point, distance: number, planes: Float64Array) {
  const lateral = -n.z * (point.x - center.x) + n.x * (point.z - center.z);
  for (let face = 0; face < 2; face++) {
    const t = Math.max(0, distance + (face - .5) * WALL_THICKNESS - n.x * point.x - n.z * point.z), offset = face * 20;
    planes.set([n.x, 0, n.z, -t,
      (point.y + APERTURE_EPSILON) * n.x, t, (point.y + APERTURE_EPSILON) * n.z, 0,
      (DOOR_HEIGHT + APERTURE_EPSILON - point.y) * n.x, -t, (DOOR_HEIGHT + APERTURE_EPSILON - point.y) * n.z, 0,
      (DOOR_WIDTH / 2 + APERTURE_EPSILON - lateral) * n.x + t * n.z, 0, (DOOR_WIDTH / 2 + APERTURE_EPSILON - lateral) * n.z - t * n.x, 0,
      (DOOR_WIDTH / 2 + APERTURE_EPSILON + lateral) * n.x - t * n.z, 0, (DOOR_WIDTH / 2 + APERTURE_EPSILON + lateral) * n.z + t * n.x, 0], offset);
  }
}

function apertureCoverage(point: Point, area: BounceArea, planes: Float64Array) {
  const x = area.point.x - point.x, y = area.point.y - point.y, z = area.point.z - point.z;
  let full = true;
  for (let i = 0; i < 40; i += 4) {
    const a = planes[i], b = planes[i + 1], c = planes[i + 2];
    const value = a * x + b * y + c * z + planes[i + 3];
    const radius = Math.abs(a * area.halfU.x + b * area.halfU.y + c * area.halfU.z) + Math.abs(a * area.halfV.x + b * area.halfV.y + c * area.halfV.z);
    if (value + radius < -1e-8) return -1;
    if (value - radius < 1e-8) full = false;
  }
  return full ? 1 : 0;
}

/** The same surface-area quadrature used locally crosses each open doorway. */
export function createBounceTransferSampler(receiver: SocketRef, source: SocketRef, subdivisions?: number, optimized = true, quality: LightingBakeQuality = 'full') {
  const angle = portalAngle(source, receiver), direction = (p: Point) => ({ ...rotate(p, angle), y: p.y });
  const emitters = bouncePatches(source.room, subdivisions, quality).map(area => ({ area,
    virtual: { point: { ...transformPoint(area.point, source, receiver), y: area.point.y }, normal: direction(area.normal),
      halfU: direction(area.halfU), halfV: direction(area.halfV) },
    samples: area.samples.map(patch => ({ ...patch,
      virtual: { ...transformPoint(patch.point, source, receiver), y: patch.point.y }, direction: direction(patch.normal),
      halfU: direction(patch.halfU), halfV: direction(patch.halfV),
      vertices: patch.vertices?.map(direction),
    })),
  }));
  const n = { ...wallNormal(receiver.room, receiver.side), y: 0 }, center = { ...portalPosition(receiver.room, receiver.side), y: 0 };
  const distance = portalDistance(receiver.room, receiver.side), planes = new Float64Array(40);
  return (point: Point, normal: Point, values: Float32Array, offset: number) => {
    const depth = Math.max(0, distance - n.x * point.x - n.z * point.z);
    const lateral = Math.max(0, Math.abs(-n.z * (point.x - center.x) + n.x * (point.z - center.z)) - DOOR_WIDTH / 2);
    const vertical = Math.max(0, -point.y, point.y - DOOR_HEIGHT);
    const reach = Math.hypot(depth, lateral, vertical);
    if (reach >= 2) return;
    const t = Math.max(0, (reach - .5) / 1.5), gain = 1 - t * t * (3 - 2 * t);
    const origin = { x: point.x + normal.x * .005, y: point.y + normal.y * .005, z: point.z + normal.z * .005 };
    const sourceOrigin = { ...transformPoint(origin, receiver, source), y: origin.y };
    aperturePlanes(point, n, center, distance, planes);
    let red = 0, green = 0, blue = 0;
    for (const area of emitters) {
      const ray = { x: area.virtual.point.x - point.x, y: area.virtual.point.y - point.y, z: area.virtual.point.z - point.z };
      const emit = -(area.virtual.normal.x * ray.x + area.virtual.normal.y * ray.y + area.virtual.normal.z * ray.z);
      const receive = normal.x * ray.x + normal.y * ray.y + normal.z * ray.z;
      const receiveRadius = Math.abs(normal.x * area.virtual.halfU.x + normal.y * area.virtual.halfU.y + normal.z * area.virtual.halfU.z) +
        Math.abs(normal.x * area.virtual.halfV.x + normal.y * area.virtual.halfV.y + normal.z * area.virtual.halfV.z);
      if (emit <= 0 || receive + receiveRadius <= 0) continue;
      const coverage = optimized ? apertureCoverage(point, area.virtual, planes) : 0;
      if (coverage < 0) continue;
      const receiverClear = optimized && bounceAreaClear(receiver.room, origin, area.virtual, receiver.side);
      const sourceClear = optimized && bounceAreaClear(source.room, sourceOrigin, area.area, source.side);
      for (const patch of area.samples) {
        const x = patch.virtual.x - point.x, y = patch.virtual.y - point.y, z = patch.virtual.z - point.z;
        const receive = normal.x * x + normal.y * y + normal.z * z;
        const emit = -(patch.direction.x * x + patch.direction.y * y + patch.direction.z * z);
        if (emit <= 0) continue;
        const distance2 = x * x + y * y + z * z;
        const form = bounceFormFactor(patch, normal, x, y, z, receive, emit, distance2);
        if (form < .000001) continue;
        const step = n.x * x + n.z * z;
        if (step <= 1e-8) continue;
        const signed = n.x * point.x + n.z * point.z;
        if (!coverage) {
          let visible = true;
          for (const face of [-WALL_THICKNESS / 2, WALL_THICKNESS / 2]) {
            const t = Math.max(0, (distance + face - signed) / step);
            const px = point.x + x * t, py = point.y + y * t, pz = point.z + z * t;
            if (t >= 1 || py < -APERTURE_EPSILON || py > DOOR_HEIGHT + APERTURE_EPSILON || Math.abs(-n.z * (px - center.x) + n.x * (pz - center.z)) > DOOR_WIDTH / 2 + APERTURE_EPSILON) { visible = false; break; }
          }
          if (!visible) continue;
        }
        if (!receiverClear || !sourceClear) {
          const t = Math.max(0, (distance - signed) / step);
          const aperture = { x: point.x + x * t, y: point.y + y * t, z: point.z + z * t };
          if (!receiverClear && transferPathBlocked(receiver.room, origin, aperture, receiver.side, optimized)) continue;
          if (!sourceClear) {
            const q = transformPoint(aperture, receiver, source);
            if (transferPathBlocked(source.room, { ...q, y: aperture.y }, patch.point, source.side, optimized)) continue;
          }
        }
        red += patch.color.r * form; green += patch.color.g * form; blue += patch.color.b * form;
      }
    }
    values[offset] = red * gain; values[offset + 1] = green * gain; values[offset + 2] = blue * gain;
  };
}
