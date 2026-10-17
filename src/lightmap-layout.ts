import * as THREE from 'three';
import { DOOR_HEIGHT, PEDESTAL_HEIGHT, type RoomId } from './world';
import { createRoom } from './room-visual';

export const LIGHTMAP_SPACING = .25;
const PADDING = 1;
interface Triangle { mesh: THREE.Mesh; vertices: number[]; positions: THREE.Vector3[]; normals: THREE.Vector3[]; uv: THREE.Vector2[] }
export interface SurfaceChart {
  triangles: Triangle[]; curved: boolean; curvedMesh?: THREE.Mesh; min: THREE.Vector2; max: THREE.Vector2; step: THREE.Vector2;
  x: number; y: number; width: number; height: number;
}
export interface SurfaceLayout { width: number; height: number; charts: SurfaceChart[] }
export interface SurfaceSamples { positions: Float32Array; normals: Float32Array; texels: Uint32Array }
const powerOfTwo = (value: number) => 2 ** Math.ceil(Math.log2(value));
const rounded = (value: number) => Math.round(value * 10000) / 10000;

/** One atlas per room. Coplanar floor/threshold and both wall variants share UVs. */
export function prepareSurfaceLayout(scene: THREE.Scene): SurfaceLayout {
  const charts = new Map<string, SurfaceChart>(), meshes: THREE.Mesh[] = [];
  scene.updateMatrixWorld(true);
  scene.traverse(object => {
    if (!(object instanceof THREE.Mesh) || !(object.material instanceof THREE.MeshStandardMaterial)) return;
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
      const normals = vertices.map(i => new THREE.Vector3().fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize());
      // Ceiling lamps cannot send light upward through the lower aperture.
      if (positions.every(p => p.y > DOOR_HEIGHT) || normals.every(n => n.y < -.999)) continue;
      // These five-millimeter inner lips are below the diffuse model's scale;
      // its solid pedestal occluders would suppress their contribution anyway.
      if (mesh.name === 'pedestal-body' && normals.every(n => Math.abs(n.y) < .01) &&
        positions.every(p => p.y > PEDESTAL_HEIGHT - .006 && p.y <= PEDESTAL_HEIGHT + .001)) continue;
      const n = normals[0], u = Math.abs(n.y) > .999 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(n.z, 0, -n.x).normalize();
      const v = Math.abs(n.y) > .999 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
      const coordinates = positions.map(p => new THREE.Vector2(p.dot(u), p.dot(v)));
      const key = `${rounded(n.x)},${rounded(n.y)},${rounded(n.z)},${rounded(n.dot(positions[0]))}`;
      let chart = charts.get(key);
      if (!chart) {
        chart = { triangles: [], curved, min: new THREE.Vector2(Infinity, Infinity), max: new THREE.Vector2(-Infinity, -Infinity),
          step: new THREE.Vector2(), x: 0, y: 0, width: 0, height: 0 }; charts.set(key, chart);
      }
      for (const p of coordinates) { chart.min.min(p); chart.max.max(p); }
      chart.triangles.push({ mesh, vertices, positions, normals, uv: coordinates });
    }
  });
  const list = [...charts.values()];
  for (const chart of list) {
    if (chart.curved) {
      chart.width = 10; chart.height = 8;
      chart.step.set((chart.max.x - chart.min.x) / (chart.width - PADDING * 2 - 1), (chart.max.y - chart.min.y) / (chart.height - PADDING * 2 - 1));
    } else {
      chart.min.x = Math.floor((chart.min.x + .00001) / LIGHTMAP_SPACING) * LIGHTMAP_SPACING;
      chart.min.y = Math.floor((chart.min.y + .00001) / LIGHTMAP_SPACING) * LIGHTMAP_SPACING;
      chart.step.setScalar(LIGHTMAP_SPACING);
      chart.width = Math.ceil((chart.max.x - chart.min.x - .00001) / LIGHTMAP_SPACING) + 1 + PADDING * 2;
      chart.height = Math.ceil((chart.max.y - chart.min.y - .00001) / LIGHTMAP_SPACING) + 1 + PADDING * 2;
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
    const count = mesh.geometry.getAttribute('position').count, attribute = new THREE.Float32BufferAttribute(count * 2, 2);
    for (let i = 0; i < count; i++) attribute.setXY(i, .5 / width, .5 / height); // Reserved black texel.
    mesh.geometry.setAttribute('transferUv', attribute);
  }
  const assign = (chart: SurfaceChart, attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, vertex: number, p: THREE.Vector2) => attribute.setXY(vertex,
      (chart.x + PADDING + (p.x - chart.min.x) / chart.step.x + .5) / width,
      (chart.y + PADDING + (p.y - chart.min.y) / chart.step.y + .5) / height);
  for (const chart of list) {
    if (chart.curvedMesh) {
      const geometry = chart.curvedMesh.geometry, uv = geometry.getAttribute('uv'), attribute = geometry.getAttribute('transferUv');
      for (let i = 0; i < uv.count; i++) assign(chart, attribute, i, new THREE.Vector2(uv.getX(i), uv.getY(i)));
    }
    for (const triangle of chart.triangles) triangle.uv.forEach((p, i) => assign(chart, triangle.mesh.geometry.getAttribute('transferUv'), triangle.vertices[i], p));
  }
  return { width, height, charts: list };
}

/** Rasterize actual triangles once, including a one-texel edge dilation. */
export function surfaceSamples(layout: SurfaceLayout): SurfaceSamples {
  const count = layout.width * layout.height, positions = new Float32Array(count * 3), normals = new Float32Array(count * 3);
  const distance = new Float32Array(count).fill(Infinity), weights = new THREE.Vector3(), point = new THREE.Vector3(), normal = new THREE.Vector3();
  const closest = new THREE.Vector2();
  for (const chart of layout.charts) for (const triangle of chartTriangles(chart)) {
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
      point.addScaledVector(normal, .002);
      positions.set(point.toArray(), index * 3); normals.set(normal.toArray(), index * 3);
    }
  }
  const texels: number[] = [];
  for (let i = 0; i < count; i++) if (Number.isFinite(distance[i])) texels.push(i);
  return { positions, normals, texels: new Uint32Array(texels) };
}

function* chartTriangles(chart: SurfaceChart): Generator<Triangle> {
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
  const materials = { wall: standard, floor: physical, ceiling: standard, pedestal: standard, socket: standard,
    red: physical, blue: physical, lampFrame: standard, hit: basic, lamp: basic };
  return prepareSurfaceLayout(createRoom(room, materials, { value: true }).scene);
}
