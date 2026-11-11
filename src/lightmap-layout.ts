import * as THREE from 'three';
import { DOOR_HEIGHT, DOOR_WIDTH, PEDESTAL_HEIGHT, portalPosition, ROOMS, roomWalls, WALL_THICKNESS, wallNormal, type RoomId } from './world';
import { createRoom } from './room-visual';
import { closestOnSegment, insideOutline, offsetOutline } from './geometry';
import { LIGHT_RAY_OFFSET, SURFACE_SAMPLE_OFFSET } from './light-path';

export const LIGHTMAP_SPACING = .25;
export const PASSAGE_LIGHT_SPACING = .1, PASSAGE_LIGHT_WIDTH = 1.1, PASSAGE_LIGHT_DEPTH = .6;
const PADDING = 1;
interface Triangle { mesh: THREE.Mesh; vertices: number[]; positions: THREE.Vector3[]; normals: THREE.Vector3[]; uv: THREE.Vector2[] }
export interface SurfaceChart {
  triangles: Triangle[]; curved: boolean; curvedMesh?: THREE.Mesh; min: THREE.Vector2; max: THREE.Vector2; step: THREE.Vector2;
  passage?: number; passageLocal?: boolean;
  reveal?: number; revealLocal?: boolean;
  x: number; y: number; width: number; height: number;
}
export interface SurfaceLayout { room: RoomId; width: number; height: number; charts: SurfaceChart[] }
export interface SurfaceSamples { positions: Float32Array; normals: Float32Array; texels: Uint32Array; passages: Int8Array }
const powerOfTwo = (value: number) => 2 ** Math.ceil(Math.log2(value));
const rounded = (value: number) => Math.round(value * 10000) / 10000;

/** One atlas per room. Coplanar floor/threshold and both wall variants share UVs. */
export function prepareSurfaceLayout(scene: THREE.Scene, room: RoomId, direct = false): SurfaceLayout {
  const charts = new Map<string, SurfaceChart>(), meshes: THREE.Mesh[] = [];
  scene.updateMatrixWorld(true);
  scene.traverse(object => {
    if (!(object instanceof THREE.Mesh) || !(object.material instanceof THREE.MeshStandardMaterial)) return;
    if (direct && object.name === 'ceiling') return;
    const mesh = object, original = mesh.geometry;
    const curved = mesh.name === 'socket-ball' || mesh.name === 'socket-bowl';
    // Only the extra UV attribute is per instance. Positions, normals, indices
    // and material UVs stay shared, including the many identical balls/bowls.
    // Unique meshes retain their geometry object too, so the shadow proxy and
    // main view warm the very same geometry before either wall variant changes.
    const geometry = curved ? Object.assign(new THREE.BufferGeometry(), { type: original.type, parameters: original.parameters }) : original;
    if (curved) {
      geometry.attributes = { ...original.attributes }; geometry.index = original.index;
      geometry.groups = original.groups;
      geometry.boundingBox = original.boundingBox; geometry.boundingSphere = original.boundingSphere;
    }
    mesh.geometry = geometry; meshes.push(mesh);
    const position = mesh.geometry.getAttribute('position'), normal = mesh.geometry.getAttribute('normal'), uv = mesh.geometry.getAttribute('uv');
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    if (curved) {
      const chart: SurfaceChart = { triangles: [], curved, curvedMesh: mesh, min: new THREE.Vector2(Infinity, Infinity), max: new THREE.Vector2(-Infinity, -Infinity), step: new THREE.Vector2(), x: 0, y: 0, width: 0, height: 0 };
      for (let i = 0; i < uv.count; i++) { const p = new THREE.Vector2().fromBufferAttribute(uv, i); chart.min.min(p); chart.max.max(p); }
      charts.set(`curved:${mesh.uuid}`, chart); return;
    }
    const count = geometry.index?.count ?? position.count;
    for (let vertex = 0; vertex < count; vertex += 3) {
      const vertices = [0, 1, 2].map(i => geometry.index ? geometry.index.getX(vertex + i) : vertex + i);
      const positions = vertices.map(i => new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld));
      const normals = vertices.map(i => new THREE.Vector3().fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize()
        .multiplyScalar(mesh.material.side === THREE.BackSide ? -1 : 1));
      // Exterior faces and miter caps are hidden by the neighboring wall. They
      // must not occupy an atlas or contaminate visible corner padding.
      let reveal: number | undefined;
      if (mesh.name === 'room-wall' || mesh.name === 'boundary-wall') {
        const p = positions[0], n = normals[0];
        const visible = roomWalls(room).some(wall => {
          const depth = (p.x - wall.center.x) * wall.normal.x + (p.z - wall.center.z) * wall.normal.z;
          const facing = n.x * wall.normal.x + n.z * wall.normal.z;
          if (Math.abs(depth) < .0001 && facing < -.999) return true;
          const lateral = -(p.x - wall.center.x) * wall.normal.z + (p.z - wall.center.z) * wall.normal.x;
          const jamb = wall.portal !== null && Math.abs(Math.abs(lateral) - DOOR_WIDTH / 2) < .0001 &&
            depth >= -.0001 && depth <= WALL_THICKNESS / 2 + .0001 && Math.abs(facing) < .001 && Math.abs(n.y) < .001;
          if (jamb) reveal = wall.portal!;
          return jamb;
        });
        if (!visible) continue;
      }
      if (mesh.name === 'threshold' && normals[0].y < .999) continue;
      // Downward lamps cannot light the ceiling directly, but floor/wall bounce
      // can. BackSide ceiling normals must point into the room during the bake.
      if (mesh.name !== 'ceiling' && (positions.every(p => p.y > DOOR_HEIGHT) || normals.every(n => n.y < -.999))) continue;
      // These five-millimeter inner lips are below the diffuse model's scale;
      // its solid pedestal occluders would suppress their contribution anyway.
      if (mesh.name === 'pedestal-body' && normals.every(n => Math.abs(n.y) < .01) &&
        positions.every(p => p.y > PEDESTAL_HEIGHT - .006 && p.y <= PEDESTAL_HEIGHT + .001)) continue;
      const n = normals[0], u = Math.abs(n.y) > .999 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(n.z, 0, -n.x).normalize();
      const v = Math.abs(n.y) > .999 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
      const coordinates = positions.map(p => new THREE.Vector2(p.dot(u), p.dot(v)));
      const key = `${rounded(n.x)},${rounded(n.y)},${rounded(n.z)},${rounded(n.dot(positions[0]))}:${direct ? reveal ?? '' : ''}`;
      let chart = charts.get(key);
      if (!chart) {
        chart = { triangles: [], curved, reveal: direct ? reveal : undefined, min: new THREE.Vector2(Infinity, Infinity), max: new THREE.Vector2(-Infinity, -Infinity),
          step: new THREE.Vector2(), x: 0, y: 0, width: 0, height: 0 }; charts.set(key, chart);
      }
      for (const p of coordinates) { chart.min.min(p); chart.max.max(p); }
      chart.triangles.push({ mesh, vertices, positions, normals, uv: coordinates });
    }
  });
  const list = [...charts.values()];
  // The two halves of a passage use the same small grid in doorway coordinates,
  // independent of either room's polygon angle and coarse floor atlas.
  for (let side = 0; side < ROOMS[room].sides; side++) list.push({ triangles: [], curved: false, passage: side,
    min: new THREE.Vector2(-PASSAGE_LIGHT_WIDTH, 0), max: new THREE.Vector2(PASSAGE_LIGHT_WIDTH, PASSAGE_LIGHT_DEPTH),
    step: new THREE.Vector2(), x: 0, y: 0, width: 0, height: 0 });
  // Keep opposing direct-light directions separate until the normal response
  // has been evaluated. Only the small GPU passage charts need a second copy.
  if (direct) for (const chart of [...list]) if (chart.passage !== undefined)
    list.push({ ...chart, passageLocal: true, step: new THREE.Vector2() });
  if (direct) for (const chart of [...list]) if (chart.reveal !== undefined)
    list.push({ ...chart, revealLocal: true, step: new THREE.Vector2() });
  for (const chart of list) {
    if (chart.curved) {
      chart.width = 10; chart.height = 8;
      chart.step.set((chart.max.x - chart.min.x) / (chart.width - PADDING * 2 - 1), (chart.max.y - chart.min.y) / (chart.height - PADDING * 2 - 1));
    } else {
      const spacing = chart.passage !== undefined ? (direct ? .0125 : PASSAGE_LIGHT_SPACING)
        : direct ? .025 : chart.triangles[0].mesh.name === 'ceiling' ? LIGHTMAP_SPACING * 2 : LIGHTMAP_SPACING;
      // Resolve the steep floor-bounce profile on pedestal sides without
      // increasing horizontal density or the rest of the room's bake cost.
      const verticalSpacing = !direct && chart.triangles.some(t => t.mesh.name === 'pedestal-body' && Math.abs(t.normals[0].y) < .01) ? .05 : spacing;
      chart.min.x = Math.floor((chart.min.x + .00001) / spacing) * spacing;
      chart.min.y = Math.floor((chart.min.y + .00001) / verticalSpacing) * verticalSpacing;
      chart.step.set(spacing, verticalSpacing);
      chart.width = Math.ceil((chart.max.x - chart.min.x - .00001) / spacing) + 1 + PADDING * 2;
      chart.height = Math.ceil((chart.max.y - chart.min.y - .00001) / verticalSpacing) + 1 + PADDING * 2;
    }
  }
  const width = powerOfTwo(Math.max(32, ...list.map(c => c.width + 2), Math.sqrt(list.reduce((sum, c) => sum + (c.width + 1) * (c.height + 1), 0))));
  // Stable tie order is important: baking and runtime must use identical charts.
  list.sort((a, b) => b.height - a.height || b.width - a.width);
  let x = 1, y = 1, row = 0;
  for (const chart of list) {
    if (x + chart.width >= width) { x = 1; y += row + 1; row = 0; }
    chart.x = x; chart.y = y; x += chart.width + 1; row = Math.max(row, chart.height);
  }
  const height = powerOfTwo(y + row + 1);
  for (const mesh of meshes) {
    const count = mesh.geometry.getAttribute('position').count, components = direct ? 4 : 2, attribute = new THREE.Float32BufferAttribute(count * components, components);
    for (let i = 0; i < count; i++) attribute.setXY(i, .5 / width, .5 / height); // Reserved black texel.
    mesh.geometry.setAttribute(direct ? 'directUv' : 'transferUv', attribute);
  }
  const assign = (chart: SurfaceChart, attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, vertex: number, p: THREE.Vector2) => {
    const x = (chart.x + PADDING + (p.x - chart.min.x) / chart.step.x + .5) / width;
    const y = (chart.y + PADDING + (p.y - chart.min.y) / chart.step.y + .5) / height;
    if (chart.revealLocal) { attribute.setZ(vertex, x); attribute.setW(vertex, y); }
    else attribute.setXY(vertex, x, y);
  };
  for (const chart of list) {
    if (chart.curvedMesh) {
      const geometry = chart.curvedMesh.geometry, uv = geometry.getAttribute('uv'), attribute = geometry.getAttribute(direct ? 'directUv' : 'transferUv');
      for (let i = 0; i < uv.count; i++) assign(chart, attribute, i, new THREE.Vector2(uv.getX(i), uv.getY(i)));
    }
    for (const triangle of chart.triangles) triangle.uv.forEach((p, i) => assign(chart, triangle.mesh.geometry.getAttribute(direct ? 'directUv' : 'transferUv'), triangle.vertices[i], p));
  }
  return { room, width, height, charts: list };
}

/** Rasterize actual triangles once, including a one-texel edge dilation. */
export function surfaceSamples(layout: SurfaceLayout): SurfaceSamples {
  const count = layout.width * layout.height, positions = new Float32Array(count * 3), normals = new Float32Array(count * 3);
  const passages = new Int8Array(count).fill(-1);
  const distance = new Float32Array(count).fill(Infinity), weights = new THREE.Vector3(), point = new THREE.Vector3(), normal = new THREE.Vector3();
  const closest = new THREE.Vector2();
  const walls = roomWalls(layout.room), outline = walls.map(wall => wall.a);
  const inset = offsetOutline(outline, -(SURFACE_SAMPLE_OFFSET + LIGHT_RAY_OFFSET));
  for (const chart of layout.charts) if (chart.passage !== undefined) {
    const origin = portalPosition(layout.room, chart.passage), n = wallNormal(layout.room, chart.passage);
    for (let y = 0; y < chart.height; y++) for (let x = 0; x < chart.width; x++) {
      const lateral = Math.max(chart.min.x, Math.min(chart.max.x, chart.min.x + (x - PADDING) * chart.step.x));
      // The cubic filter needs a real sample across the transition plane.
      // Repeating depth zero here biases each room toward its own light slope.
      const depth = Math.min(chart.max.y, (y - PADDING) * chart.step.y);
      const texel = (chart.y + y) * layout.width + chart.x + x;
      positions.set([origin.x - n.x * depth - n.z * lateral, .002, origin.z - n.z * depth + n.x * lateral], texel * 3);
      normals[texel * 3 + 1] = 1; passages[texel] = chart.passage; distance[texel] = 0;
    }
  }
  for (const chart of layout.charts) for (const triangle of chartTriangles(chart)) {
    const p = triangle.positions[0], n = triangle.normals[0];
    const wallSurface = (triangle.mesh.name === 'room-wall' || triangle.mesh.name === 'boundary-wall') && walls.some(wall =>
      n.x * wall.normal.x + n.z * wall.normal.z < -.999 &&
      Math.abs((p.x - wall.center.x) * wall.normal.x + (p.z - wall.center.z) * wall.normal.z) < .0001);
    const uv = triangle.uv.map(p => new THREE.Vector2((p.x - chart.min.x) / chart.step.x + PADDING, (p.y - chart.min.y) / chart.step.y + PADDING));
    const [a, b, c] = uv, determinant = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (Math.abs(determinant) < 1e-10) continue;
    const minX = Math.max(0, Math.floor(Math.min(...uv.map(p => p.x))) - PADDING), maxX = Math.min(chart.width - 1, Math.ceil(Math.max(...uv.map(p => p.x))) + PADDING);
    const minY = Math.max(0, Math.floor(Math.min(...uv.map(p => p.y))) - PADDING), maxY = Math.min(chart.height - 1, Math.ceil(Math.max(...uv.map(p => p.y))) + PADDING);
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const index = (chart.y + y) * layout.width + chart.x + x;
      if (distance[index] === 0) continue;
      weights.x = ((b.y - c.y) * (x - c.x) + (c.x - b.x) * (y - c.y)) / determinant;
      weights.y = ((c.y - a.y) * (x - c.x) + (a.x - c.x) * (y - c.y)) / determinant; weights.z = 1 - weights.x - weights.y;
      let best = 0;
      if (Math.min(weights.x, weights.y, weights.z) < -.000001) {
        best = Infinity;
        for (let edge = 0; edge < 3; edge++) {
          const p = uv[edge], q = uv[(edge + 1) % 3], dx = q.x - p.x, dy = q.y - p.y;
          const t = Math.max(0, Math.min(1, ((x - p.x) * dx + (y - p.y) * dy) / Math.max(dx * dx + dy * dy, 1e-20)));
          closest.set(p.x + dx * t, p.y + dy * t);
          const d = (x - closest.x) ** 2 + (y - closest.y) ** 2;
          if (d < best) { best = d; weights.set(0, 0, 0); weights.setComponent(edge, 1 - t); weights.setComponent((edge + 1) % 3, t); }
        }
      }
      if (best > 2.001 || best >= distance[index]) continue;
      distance[index] = best; point.set(0, 0, 0); normal.set(0, 0, 0);
      for (let i = 0; i < 3; i++) { point.addScaledVector(triangle.positions[i], weights.getComponent(i)); normal.addScaledVector(triangle.normals[i], weights.getComponent(i)); }
      normal.normalize();
      // The diffuse occluder uses solid pedestal footprints, without tiny cup
      // cutouts. Sample their lighting at rim height, retaining the curved normal.
      if (triangle.mesh.name === 'socket-bowl') point.y = Math.max(point.y, PEDESTAL_HEIGHT + .002);
      // The ceiling overlaps the wall shell by 15 cm. Extend interior irradiance
      // into that hidden overlap instead of filtering black outside-room probes.
      if (triangle.mesh.name === 'ceiling' && !insideOutline(point, outline)) {
        let best = Infinity, nearest = walls[0], position = { x: point.x, z: point.z };
        for (const wall of walls) {
          const p = closestOnSegment(point, wall.a, wall.b), distance = (p.x - point.x) ** 2 + (p.z - point.z) ** 2;
          if (distance < best) { best = distance; nearest = wall; position = p; }
        }
        const dx = nearest.center.x - position.x, dz = nearest.center.z - position.z, length = Math.max(Math.hypot(dx, dz), .003);
        point.x = position.x - nearest.normal.x * .003 + dx / length * .003;
        point.z = position.z - nearest.normal.z * .003 + dz / length * .003;
      }
      // Sample the interior of each vertical prism face. Rounded endpoints can
      // otherwise fall inside the adjoining arm at a concave corner.
      if (triangle.mesh.name === 'pedestal-body' && Math.abs(normal.y) < .01) {
        const tangent = new THREE.Vector3(normal.z, 0, -normal.x).normalize(), along = point.dot(tangent);
        const ends = triangle.positions.map(p => p.dot(tangent));
        point.addScaledVector(tangent, THREE.MathUtils.clamp(along,
          Math.min(...ends) + SURFACE_SAMPLE_OFFSET, Math.max(...ends) - SURFACE_SAMPLE_OFFSET) - along);
      }
      point.addScaledVector(normal, SURFACE_SAMPLE_OFFSET);
      // Project the ray origin into the inset footprint, then recover the
      // receiver. Both offsets stay inside every adjacent face at sharp corners.
      // Jambs retain their real positions in the doorway outside that footprint.
      if (wallSurface) {
        const origin = { x: point.x + normal.x * LIGHT_RAY_OFFSET, z: point.z + normal.z * LIGHT_RAY_OFFSET };
        if (!insideOutline(origin, inset)) {
          let nearest = origin, best = Infinity;
          for (let edge = 0; edge < inset.length; edge++) {
            const q = closestOnSegment(origin, inset[edge], inset[(edge + 1) % inset.length]);
            const distance = (q.x - origin.x) ** 2 + (q.z - origin.z) ** 2;
            if (distance < best) { best = distance; nearest = q; }
          }
          point.x = nearest.x - normal.x * LIGHT_RAY_OFFSET;
          point.z = nearest.z - normal.z * LIGHT_RAY_OFFSET;
        }
      }
      positions.set(point.toArray(), index * 3); normals.set(normal.toArray(), index * 3);
    }
  }
  const texels: number[] = [];
  for (let i = 0; i < count; i++) if (Number.isFinite(distance[i])) texels.push(i);
  return { positions, normals, texels: new Uint32Array(texels), passages };
}

export function* chartTriangles(chart: SurfaceChart): Generator<Triangle> {
  if (!chart.curvedMesh) { yield* chart.triangles; return; }
  const mesh = chart.curvedMesh, geometry = mesh.geometry, position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal'), uv = geometry.getAttribute('uv');
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld), count = geometry.index?.count ?? position.count;
  for (let vertex = 0; vertex < count; vertex += 3) {
    const vertices = [0, 1, 2].map(i => geometry.index ? geometry.index.getX(vertex + i) : vertex + i);
    yield { mesh, vertices,
      positions: vertices.map(i => new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld)),
      normals: vertices.map(i => new THREE.Vector3().fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize()),
      uv: vertices.map(i => new THREE.Vector2(uv.getX(i), uv.getY(i))),
    };
  }
}

/** Reuse the exact room geometry for startup baking, without DOM or textures. */
export function bakingLayout(room: RoomId) {
  const standard = new THREE.MeshStandardMaterial(), physical = new THREE.MeshPhysicalMaterial(), basic = new THREE.MeshBasicMaterial();
  const ceiling = new THREE.MeshStandardMaterial({ side: THREE.BackSide });
  const materials = { wall: standard, floor: physical, ceiling, pedestal: standard, socket: standard,
    red: physical, blue: physical, hit: basic, lamp: basic };
  return prepareSurfaceLayout(createRoom(room, materials, { value: true }).scene, room);
}
