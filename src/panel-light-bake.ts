import { Color, DataUtils } from 'three';
import { CEILING_LIGHT, ceilingPanelSamples, SPOT_LIGHT_SHARE } from './lighting';
import { transferPathBlocked } from './light-path';
import type { SurfaceSamples } from './lightmap-layout';
import { insideOutline } from './geometry';
import { DOOR_WIDTH, ROOM_HEIGHT, ROOMS, roomOutline, roomWalls, type RoomId } from './world';

interface Point { x: number; y: number; z: number }

/** Nine deterministic probes cover the fluorescent diffuser's actual footprint. */
export function panelLightSampler(room: RoomId, share = 1 - SPOT_LIGHT_SHARE) {
  const sources = ROOMS[room].pedestals.flatMap(ceilingPanelSamples);
  const weight = CEILING_LIGHT.intensity * share / 9;
  return (point: Point, normal: Point) => {
    const origin = { x: point.x + normal.x * .005, y: point.y + normal.y * .005, z: point.z + normal.z * .005 };
    let light = 0;
    for (const source of sources) {
      const x = source.x - point.x, y = source.y - point.y, z = source.z - point.z;
      const cosine = x * normal.x + y * normal.y + z * normal.z;
      const distance2 = x * x + y * y + z * z;
      if (y <= 0 || cosine <= 0 || distance2 >= CEILING_LIGHT.distance ** 2) continue;
      if (transferPathBlocked(room, origin, source, -1)) continue;
      const cutoff = Math.max(0, 1 - (distance2 / CEILING_LIGHT.distance ** 2) ** 2);
      light += weight * y * cosine * cutoff * cutoff / Math.max(distance2 * distance2, .0001);
    }
    return light;
  };
}

/** Coarse Lambertian patches approximate one warm diffuse reflection. */
export function bouncePatches(room: RoomId) {
  const direct = panelLightSampler(room, 1), outline = roomOutline(room), patches: { point: Point; normal: Point; area: number; color: Color }[] = [];
  const carpet = new Color(0xb6a078), wallpaper = new Color(0xbda444), step = 2.5;
  const xs = outline.map(p => p.x), zs = outline.map(p => p.z);
  const nx = Math.ceil((Math.max(...xs) - Math.min(...xs)) / step), nz = Math.ceil((Math.max(...zs) - Math.min(...zs)) / step);
  const dx = (Math.max(...xs) - Math.min(...xs)) / nx, dz = (Math.max(...zs) - Math.min(...zs)) / nz;
  for (let x = 0; x < nx; x++) for (let z = 0; z < nz; z++) {
    const point = { x: Math.min(...xs) + (x + .5) * dx, y: .015, z: Math.min(...zs) + (z + .5) * dz };
    if (insideOutline(point, outline)) patches.push({ point, normal: { x: 0, y: 1, z: 0 }, area: dx * dz, color: carpet });
  }
  for (const wall of roomWalls(room)) {
    const count = Math.ceil(wall.width / 3.5);
    for (let i = 0; i < count; i++) {
      const t = (i + .5) / count, lateral = (t - .5) * wall.width;
      // No reflected-light emitter may occupy a potentially open doorway.
      if (wall.portal !== null && Math.abs(lateral) < DOOR_WIDTH / 2 + wall.width / count / 2) continue;
      patches.push({ point: { x: wall.a.x + (wall.b.x - wall.a.x) * t - wall.normal.x * .015,
        y: ROOM_HEIGHT / 2, z: wall.a.z + (wall.b.z - wall.a.z) * t - wall.normal.z * .015 },
        normal: { x: -wall.normal.x, y: 0, z: -wall.normal.z }, area: wall.width * ROOM_HEIGHT / count, color: wallpaper });
    }
  }
  const lamp = new Color(CEILING_LIGHT.color);
  return patches.map(patch => ({ ...patch, color: patch.color.clone().multiply(lamp).multiplyScalar(direct(patch.point, patch.normal) / Math.PI) }))
    .filter(patch => Math.max(patch.color.r, patch.color.g, patch.color.b) > .0001);
}

export function bakePanelLight(room: RoomId, samples: SurfaceSamples, texelCount: number) {
  const values = new Uint16Array(texelCount * 4), sample = panelLightSampler(room), patches = bouncePatches(room);
  const point = { x: 0, y: 0, z: 0 }, normal = { ...point };
  for (const texel of samples.texels) {
    const i = texel * 3;
    point.x = samples.positions[i]; point.y = samples.positions[i + 1]; point.z = samples.positions[i + 2];
    normal.x = samples.normals[i]; normal.y = samples.normals[i + 1]; normal.z = samples.normals[i + 2];
    const out = texel * 4; values[out] = DataUtils.toHalfFloat(sample(point, normal));
    const origin = { x: point.x + normal.x * .005, y: point.y + normal.y * .005, z: point.z + normal.z * .005 };
    let red = 0, green = 0, blue = 0;
    for (const patch of patches) {
      const x = patch.point.x - point.x, y = patch.point.y - point.y, z = patch.point.z - point.z;
      const receive = normal.x * x + normal.y * y + normal.z * z, emit = -(patch.normal.x * x + patch.normal.y * y + patch.normal.z * z);
      if (receive <= 0 || emit <= 0) continue;
      const distance2 = x * x + y * y + z * z;
      const form = patch.area * receive * emit / (distance2 * distance2 + patch.area * patch.area * .25);
      if (form < .0001 || transferPathBlocked(room, origin, patch.point, -1)) continue;
      red += patch.color.r * form; green += patch.color.g * form; blue += patch.color.b * form;
    }
    values[out + 1] = DataUtils.toHalfFloat(red); values[out + 2] = DataUtils.toHalfFloat(green); values[out + 3] = DataUtils.toHalfFloat(blue);
  }
  return values;
}
