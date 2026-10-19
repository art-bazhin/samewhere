import { Color, DataUtils } from 'three';
import { CEILING_LIGHT, ceilingPanelSamples, ROOM_LIGHTS, SPOT_LIGHT_SHARE } from './lighting';
import { LIGHT_RAY_OFFSET, transferPathBlocked } from './light-path';
import type { SurfaceSamples } from './lightmap-layout';
import { insideOutline } from './geometry';
import { DOOR_HEIGHT, DOOR_WIDTH, pedestalOutline, ROOM_HEIGHT, ROOMS, roomOutline, roomWalls, type RoomId } from './world';
import { bounceAreaClear, bounceFormFactor, type BounceArea } from './bounce-area';
import { floorBounceCells } from './bounce-floor';
import { addLightGradient, PANEL_LIGHTMAP_CHANNELS, luminance } from './directional-lightmap';

interface Point { x: number; y: number; z: number }
export type LightingBakeQuality = 'draft' | 'full';

/** Resolve partial panel visibility around concave corners without changing its energy. */
export function panelLightSampler(room: RoomId, share = 1 - SPOT_LIGHT_SHARE, quality: LightingBakeQuality = 'full') {
  const subdivisions = quality === 'full' && ROOMS[room].outline ? 9 : 3;
  const sources = ROOM_LIGHTS[room].flatMap(lamp => ceilingPanelSamples(lamp, subdivisions));
  const weight = CEILING_LIGHT.intensity * share / subdivisions ** 2;
  return (point: Point, normal: Point, gradient?: Float64Array) => {
    gradient?.fill(0);
    const origin = { x: point.x + normal.x * LIGHT_RAY_OFFSET, y: point.y + normal.y * LIGHT_RAY_OFFSET, z: point.z + normal.z * LIGHT_RAY_OFFSET };
    let light = 0;
    for (const source of sources) {
      const x = source.x - point.x, y = source.y - point.y, z = source.z - point.z;
      const cosine = x * normal.x + y * normal.y + z * normal.z;
      const distance2 = x * x + y * y + z * z;
      if (y <= 0 || cosine <= 0 || distance2 >= source.distance ** 2) continue;
      if (transferPathBlocked(room, origin, source, -1)) continue;
      const cutoff = Math.max(0, 1 - (distance2 / source.distance ** 2) ** 2);
      light += weight * y * cosine * cutoff * cutoff / Math.max(distance2 * distance2, .0001);
      if (gradient) {
        const slope = weight * y * cutoff * cutoff / Math.max(distance2 * distance2, .0001);
        gradient[0] += x * slope; gradient[1] += y * slope; gradient[2] += z * slope;
      }
    }
    if (gradient) gradient[3] = light;
    return light;
  };
}

/** Analytic counterpart of the live spot's diffuse term, used at floor joins. */
function spotLightSampler(room: RoomId) {
  const cone = Math.cos(CEILING_LIGHT.angle), penumbra = Math.cos(CEILING_LIGHT.angle * (1 - CEILING_LIGHT.penumbra));
  return (point: Point, normal: Point, gradient?: Float64Array) => {
    gradient?.fill(0);
    let light = 0;
    const origin = { x: point.x + normal.x * LIGHT_RAY_OFFSET, y: point.y + normal.y * LIGHT_RAY_OFFSET, z: point.z + normal.z * LIGHT_RAY_OFFSET };
    for (const lamp of ROOM_LIGHTS[room]) {
      const source = { ...lamp, y: CEILING_LIGHT.height }, x = source.x - point.x, y = source.y - point.y, z = source.z - point.z;
      const distance = Math.hypot(x, y, z), cosine = (normal.x * x + normal.y * y + normal.z * z) / distance;
      if (cosine <= 0 || distance >= lamp.distance || transferPathBlocked(room, origin, source, -1)) continue;
      const spot = Math.max(0, Math.min(1, (y / distance - cone) / (penumbra - cone)));
      const cutoff = Math.max(0, 1 - (distance / lamp.distance) ** 4);
      light += CEILING_LIGHT.intensity * SPOT_LIGHT_SHARE * spot * spot * (3 - 2 * spot) * cutoff * cutoff * cosine / Math.max(distance * distance, .01);
      if (gradient) {
        const slope = CEILING_LIGHT.intensity * SPOT_LIGHT_SHARE * spot * spot * (3 - 2 * spot) * cutoff * cutoff / Math.max(distance * distance, .01) / distance;
        gradient[0] += x * slope; gradient[1] += y * slope; gradient[2] += z * slope;
      }
    }
    if (gradient) gradient[3] = light;
    return light;
  };
}

interface BounceSample extends BounceArea { area: number; color: Color }
export interface BouncePatch extends BounceArea { samples: BounceSample[] }
const bounceCache = new Map<string, BouncePatch[]>();
/** Concave rooms need finer cells to resolve visibility around inner corners.
 * Groups only accelerate queries; cells retain independent light and occlusion. */
export function bouncePatches(room: RoomId, subdivisions?: number, quality: LightingBakeQuality = 'full'): BouncePatch[] {
  subdivisions ??= quality === 'full' && ROOMS[room].outline ? 16 : 4;
  const key = `${room}:${subdivisions}:${quality}`, cached = bounceCache.get(key);
  if (cached) return cached;
  const direct = panelLightSampler(room, 1, quality), outline = roomOutline(room), patches = new Map<string, BouncePatch>();
  const lamp = new Color(CEILING_LIGHT.color);
  const add = (key: string, patch: BounceArea, sample: BounceSample) => {
    sample.color = sample.color.clone().multiply(lamp).multiplyScalar(direct(sample.point, sample.normal) / Math.PI);
    if (Math.max(sample.color.r, sample.color.g, sample.color.b) <= .000001) return;
    let group = patches.get(key);
    if (!group) { group = { ...patch, samples: [] }; patches.set(key, group); }
    group.samples.push(sample);
  };
  const carpet = new Color(0xb6a078), wallpaper = new Color(0xbda444), step = 2.5 / subdivisions;
  const holes = ROOMS[room].pedestals.map(p => pedestalOutline(p.controls).map(v => ({ x: p.x + v.x, z: p.z + v.z })));
  for (const { key, group, cell } of floorBounceCells(outline, subdivisions, holes)) add(key, group, { ...cell, color: carpet });
  for (const [side, wall] of roomWalls(room).entries()) {
    const normal = { x: -wall.normal.x, y: 0, z: -wall.normal.z };
    const rectangles = wall.portal === null ? [[0, wall.width, 0, ROOM_HEIGHT]] : [
      [0, wall.width / 2 - DOOR_WIDTH / 2, 0, ROOM_HEIGHT],
      [wall.width / 2 + DOOR_WIDTH / 2, wall.width, 0, ROOM_HEIGHT],
      [wall.width / 2 - DOOR_WIDTH / 2, wall.width / 2 + DOOR_WIDTH / 2, DOOR_HEIGHT, ROOM_HEIGHT],
    ];
    for (const [region, [left, right, low, high]] of rectangles.entries()) {
      const columns = Math.ceil((right - left) / step), rows = Math.ceil((high - low) / step);
      const width = (right - left) / columns, height = (high - low) / rows;
      const position = (along: number, y: number) => ({ x: wall.a.x + (wall.b.x - wall.a.x) * along / wall.width,
        y, z: wall.a.z + (wall.b.z - wall.a.z) * along / wall.width });
      const horizontal = (length: number) => ({ x: (wall.b.x - wall.a.x) * length / wall.width / 2, y: 0, z: (wall.b.z - wall.a.z) * length / wall.width / 2 });
      for (let x = 0; x < columns; x++) for (let y = 0; y < rows; y++) {
        const ix = Math.floor(x / subdivisions) * subdivisions, iy = Math.floor(y / subdivisions) * subdivisions;
        const groupWidth = Math.min(subdivisions, columns - ix) * width, groupHeight = Math.min(subdivisions, rows - iy) * height;
        add(`wall:${side}:${region}:${ix}:${iy}`, {
          point: position(left + ix * width + groupWidth / 2, low + iy * height + groupHeight / 2), normal,
          halfU: horizontal(groupWidth), halfV: { x: 0, y: groupHeight / 2, z: 0 },
        }, {
          point: position(left + (x + .5) * width, low + (y + .5) * height), normal,
          halfU: horizontal(width), halfV: { x: 0, y: height / 2, z: 0 }, area: width * height, color: wallpaper,
        });
      }
    }
  }
  const result = [...patches.values()]; bounceCache.set(key, result); return result;
}

export function bakePanelLight(room: RoomId, samples: SurfaceSamples, texelCount: number, quality: LightingBakeQuality = 'full') {
  const values = new Uint16Array(texelCount * PANEL_LIGHTMAP_CHANNELS), sample = panelLightSampler(room, 1 - SPOT_LIGHT_SHARE, quality), sampleSpot = spotLightSampler(room), sampleBounce = createBounceSampler(room, undefined, true, quality), bounce = new Float32Array(3), moment = new Float32Array(4);
  const direct = new Float64Array(4), spot = new Float64Array(4);
  const point = { x: 0, y: 0, z: 0 }, normal = { ...point };
  for (const texel of samples.texels) {
    const i = texel * 3;
    point.x = samples.positions[i]; point.y = samples.positions[i + 1]; point.z = samples.positions[i + 2];
    normal.x = samples.normals[i]; normal.y = samples.normals[i + 1]; normal.z = samples.normals[i + 2];
    const out = texel * 4, panel = sample(point, normal, direct);
    spot.fill(0);
    const passage = samples.passages[texel] >= 0 ? sampleSpot(point, normal, spot) : 0;
    values[out] = DataUtils.toHalfFloat(panel + passage);
    sampleBounce(point, normal, bounce, moment);
    values[out + 1] = DataUtils.toHalfFloat(bounce[0]); values[out + 2] = DataUtils.toHalfFloat(bounce[1]); values[out + 3] = DataUtils.toHalfFloat(bounce[2]);
    for (let channel = 0; channel < 4; channel++) values[texelCount * 4 + out + channel] = DataUtils.toHalfFloat(moment[channel]);
    for (let channel = 0; channel < 4; channel++) values[texelCount * 8 + out + channel] = DataUtils.toHalfFloat(direct[channel] + spot[channel]);
  }
  return values;
}

/** One diffuse reflection, integrated over independently lit surface cells. */
export function createBounceSampler(room: RoomId, subdivisions?: number, optimized = true, quality: LightingBakeQuality = 'full') {
  const patches = bouncePatches(room, subdivisions, quality);
  const walls = roomWalls(room);
  const gradient = new Float64Array(3);
  return (surface: Point, normal: Point, result: Float32Array, moment?: Float32Array) => {
    moment?.fill(0);
    // Evaluate the interior limit at shared edges. At y=0, coplanar floor
    // emitters would all be rejected, darkening the entire bottom atlas row.
    // Keep reflectors on their real planes so corner receivers stay in front.
    const point = { ...surface, y: Math.max(surface.y, .00001) };
    for (const wall of walls) {
      const x = point.x - wall.a.x, z = point.z - wall.a.z;
      const depth = x * wall.normal.x + z * wall.normal.z;
      const along = (x * (wall.b.x - wall.a.x) + z * (wall.b.z - wall.a.z)) / wall.width;
      if (depth > -.001 && depth < .00001 && along >= -.001 && along <= wall.width + .001) {
        point.x -= wall.normal.x * (depth + .001); point.z -= wall.normal.z * (depth + .001);
      }
    }
    const origin = { x: point.x + normal.x * LIGHT_RAY_OFFSET, y: point.y + normal.y * LIGHT_RAY_OFFSET, z: point.z + normal.z * LIGHT_RAY_OFFSET };
    const interior = insideOutline(origin, roomOutline(room));
    let red = 0, green = 0, blue = 0;
    for (const area of patches) {
      if (area.normal.x * (point.x - area.point.x) + area.normal.y * (point.y - area.point.y) + area.normal.z * (point.z - area.point.z) <= 0) continue;
      const clear = optimized && bounceAreaClear(room, origin, area, -1, interior);
      for (const patch of area.samples) {
        const x = patch.point.x - point.x, y = patch.point.y - point.y, z = patch.point.z - point.z;
        const receive = normal.x * x + normal.y * y + normal.z * z, emit = -(patch.normal.x * x + patch.normal.y * y + patch.normal.z * z);
        if (emit <= 0) continue;
        const distance2 = x * x + y * y + z * z;
        const form = bounceFormFactor(patch, normal, x, y, z, receive, emit, distance2, moment ? gradient : undefined);
        if (form < .000001 || !clear && transferPathBlocked(room, origin, patch.point, -1, optimized && interior)) continue;
        red += patch.color.r * form; green += patch.color.g * form; blue += patch.color.b * form;
        if (moment) addLightGradient(moment, gradient, luminance(patch.color.r, patch.color.g, patch.color.b), form);
      }
    }
    result[0] = red; result[1] = green; result[2] = blue;
  };
}
