import * as THREE from 'three';
import { DirectSurfaceLight } from './direct-surface-light';
import { CEILING_LIGHT, CEILING_PANEL_SIZE, ROOM_LIGHTS, SPOT_LIGHT_SHARE, type CeilingLamp } from './lighting';
import { PANEL_APERTURE_SHADER } from './panel-aperture';
import { LIGHT_GRADIENT_SHADER } from './directional-lightmap';
import { connections, DOOR_HEIGHT, DOOR_WIDTH, PEDESTAL_HEIGHT, pedestalOutline, portalAngle, portalPosition, ROOM_HEIGHT, ROOM_IDS, ROOMS, roomWalls, rotate, transformPoint, wallNormal, type RoomId, type SocketRef, type Vec2, type WorldState } from './world';

const TILE_WIDTH = 256, TILE_HEIGHT = 512, ATLAS_SIZE = 2048;
const DATA_WIDTH = 1024, DATA_STRIDE = 16;
interface Link { receiver: SocketRef; source: SocketRef; key: string }
interface Slot { key: string; link: Link | null; dirty: boolean; cameras: THREE.PerspectiveCamera[]; matrices: THREE.Matrix4[]; frames: THREE.Vector4; lamps: CeilingLamp[]; axis: Vec2 }

/** Compact silhouettes, matching the diffuse bake's solid pedestal model. Cups
 * and 8 cm balls retain their separate local contact shadows. */
function shadowRoom(room: RoomId, material: THREE.Material) {
  const group = new THREE.Group(), fixed: number[] = [], doors: THREE.Mesh[] = [], walls: THREE.Mesh[] = [];
  const vertex = (p: Vec2, y: number) => [p.x, y, p.z];
  const quad = (out: number[], a: number[], b: number[], c: number[], d: number[]) => out.push(...a, ...b, ...c, ...a, ...c, ...d);
  const wall = (out: number[], a: Vec2, b: Vec2, low: number, high: number) => quad(out, vertex(a, low), vertex(b, low), vertex(b, high), vertex(a, high));
  const mesh = (positions: number[]) => {
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const object = new THREE.Mesh(geometry, material); group.add(object); return object;
  };
  for (const boundary of roomWalls(room)) {
    const { a, b, center, normal, portal } = boundary;
    if (portal === null) { wall(fixed, a, b, 0, ROOM_HEIGHT); continue; }
    const left = { x: center.x + normal.z * DOOR_WIDTH / 2, z: center.z - normal.x * DOOR_WIDTH / 2 };
    const right = { x: center.x - normal.z * DOOR_WIDTH / 2, z: center.z + normal.x * DOOR_WIDTH / 2 };
    const surround: number[] = [];
    wall(surround, a, left, 0, ROOM_HEIGHT); wall(surround, right, b, 0, ROOM_HEIGHT);
    wall(surround, left, right, DOOR_HEIGHT, ROOM_HEIGHT); walls[portal] = mesh(surround);
    const plug: number[] = []; wall(plug, left, right, 0, DOOR_HEIGHT); doors[portal] = mesh(plug);
  }
  for (const pedestal of ROOMS[room].pedestals) {
    const shape = pedestalOutline(pedestal.controls).map(p => ({ x: p.x + pedestal.x, z: p.z + pedestal.z }));
    for (let i = 0; i < shape.length; i++) wall(fixed, shape[i], shape[(i + 1) % shape.length], 0, PEDESTAL_HEIGHT);
    for (const triangle of THREE.ShapeUtils.triangulateShape(shape.map(p => new THREE.Vector2(p.x, p.z)), []))
      for (const index of triangle) fixed.push(...vertex(shape[index], PEDESTAL_HEIGHT));
  }
  mesh(fixed); group.matrixAutoUpdate = false;
  return { group, doors, walls };
}

/** Preallocated cropped depth tiles for the ordinary network or a fixed room
 * connection. No shader compilation, GPU allocation, or CPU lighting bake on interaction. */
export class DirectLight {
  readonly surfaces: DirectSurfaceLight;
  readonly target = new THREE.WebGLRenderTarget(ATLAS_SIZE, ATLAS_SIZE, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  readonly data = new Float32Array(DATA_WIDTH * 7 * 4);
  readonly uniforms = {
    directShadowAtlas: { value: this.target.texture }, directNeighborCount: { value: 0 },
    directLightData: { value: new THREE.DataTexture(this.data, DATA_WIDTH, 7, THREE.RGBAFormat, THREE.FloatType) }, directRow: { value: 0 },
    directLocalStarts: { value: new Int32Array(4) }, directLocalCounts: { value: new Int32Array(4) },
  };
  readonly slots: Slot[];
  updates = 0;
  private readonly scene = new THREE.Scene();
  private readonly material = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
  private readonly receiver: Record<RoomId, ReturnType<typeof shadowRoom>>;
  private readonly source: typeof this.receiver;
  private readonly ids: RoomId[];
  private readonly stride: number;
  private readonly localPassages: boolean;
  private readonly matrix = new THREE.Matrix4();
  private readonly transform = new THREE.Matrix4();
  private readonly bias = new THREE.Matrix4().set(.5, 0, 0, .5, 0, .5, 0, .5, 0, 0, .5, .5, 0, 0, 0, 1);
  private readonly point = new THREE.Vector3();
  private state = '';
  private readonly counts = new Int32Array(7);
  private readonly starts = new Int32Array(28);
  private readonly localCounts = new Int32Array(28);
  constructor(private readonly renderer: THREE.WebGLRenderer, rooms: Record<RoomId, { scene: THREE.Scene }>,
    options: { ids?: RoomId[]; slots?: number; stride?: number; attribute?: string; localPassages?: boolean } = {}) {
    this.ids = options.ids ?? ROOM_IDS; this.stride = options.stride ?? 7; this.localPassages = options.localPassages ?? true;
    this.slots = Array.from({ length: options.slots ?? 4 }, () => ({ key: '', link: null, dirty: false,
      cameras: Array.from({ length: 7 }, () => new THREE.PerspectiveCamera(110, 1, .05, CEILING_LIGHT.distance * 2)),
      matrices: Array.from({ length: 7 }, () => new THREE.Matrix4()), frames: new THREE.Vector4(), lamps: [], axis: { x: 1, z: 0 } }));
    this.receiver = Object.fromEntries(this.ids.map(room => [room, shadowRoom(room, this.material)])) as typeof this.receiver;
    this.source = Object.fromEntries(this.ids.map(room => [room, shadowRoom(room, this.material)])) as typeof this.source;
    for (const room of this.ids) this.scene.add(this.receiver[room].group, this.source[room].group);
    this.surfaces = new DirectSurfaceLight(rooms, this.uniforms, DIRECT_LIGHT_SHADER, DIRECT_SHADOW_SHADER, this.ids, options.attribute);
  }
  sync(world: WorldState) {
    const links: Link[] = connections(world).flatMap(({ ends }) => [
      { receiver: ends[0], source: ends[1], key: `${ends[0].room}${ends[0].side}<${ends[1].room}${ends[1].side}` },
      { receiver: ends[1], source: ends[0], key: `${ends[1].room}${ends[1].side}<${ends[0].room}${ends[0].side}` },
    ]);
    this.syncLinks(links);
  }
  syncLinks(links: Link[]) {
    const state = links.map(link => link.key).sort().join('|');
    if (state === this.state) return;
    this.state = state;
    for (const slot of this.slots) if (!links.some(link => link.key === slot.key)) slot.link = null;
    for (const link of links) {
      const slot = this.slots.find(slot => slot.key === link.key) ?? this.slots.find(slot => !slot.link)!;
      const changed = slot.key !== link.key; slot.key = link.key; slot.link = link;
      // Opening another door changes only its plug. Refresh all active views
      // synchronously, using a few hundred batched triangles per room.
      slot.dirty = true;
      if (!changed) continue;
      const p = portalPosition(link.receiver.room, link.receiver.side), n = wallNormal(link.receiver.room, link.receiver.side);
      slot.frames.set(n.x, n.z, p.x * n.x + p.z * n.z, -n.z * p.x + n.x * p.z);
      slot.lamps = ROOM_LIGHTS[link.source.room].map(lamp => ({ ...transformPoint(lamp, link.source, link.receiver), distance: lamp.distance }));
      slot.axis = rotate({ x: 1, z: 0 }, portalAngle(link.source, link.receiver));
      slot.lamps.forEach((lamp, index) => {
        const camera = slot.cameras[index]; camera.far = lamp.distance * 2;
        camera.clearViewOffset(); camera.position.set(lamp.x, CEILING_LIGHT.height, lamp.z);
        camera.up.set(0, 1, 0); camera.lookAt(p.x, DOOR_HEIGHT / 2, p.z); camera.updateMatrixWorld(true);
        // All useful rays pass through this rectangle. Crop the depth camera
        // to it instead of spending a 1024² map on an almost empty light cone.
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const emitterRadius = CEILING_PANEL_SIZE * Math.SQRT1_2;
        for (const depth of [-.6 - emitterRadius, .6 + emitterRadius]) for (const lateral of [-1.1 - emitterRadius, 1.1 + emitterRadius]) for (const y of [0, DOOR_HEIGHT]) {
          this.point.set(p.x + n.x * depth - n.z * lateral, y, p.z + n.z * depth + n.x * lateral).project(camera);
          minX = Math.min(minX, this.point.x); minY = Math.min(minY, this.point.y);
          maxX = Math.max(maxX, this.point.x); maxY = Math.max(maxY, this.point.y);
        }
        const paddingX = (maxX - minX) * 2 / TILE_WIDTH, paddingY = (maxY - minY) * 2 / TILE_HEIGHT;
        minX -= paddingX; maxX += paddingX; minY -= paddingY; maxY += paddingY;
        camera.setViewOffset(1024, 1024, (minX + 1) * 512, (1 - maxY) * 512, (maxX - minX) * 512, (maxY - minY) * 512);
        slot.matrices[index].copy(this.bias).multiply(camera.projectionMatrix).multiply(camera.matrixWorldInverse);
      });
    }
    for (const room of this.ids) this.receiver[room].doors.forEach((door, side) => {
      const open = links.some(link => link.receiver.room === room && link.receiver.side === side);
      door.visible = this.source[room].doors[side].visible = !open;
    });
    this.pack();
  }
  update() {
    if (!this.slots.some(slot => slot.link && slot.dirty)) return;
    const renderer = this.renderer, previous = renderer.getRenderTarget(), clipping = renderer.clippingPlanes;
    const clear = renderer.getClearColor(new THREE.Color()), alpha = renderer.getClearAlpha(), autoClear = renderer.autoClear;
    const shadow = renderer.shadowMap.enabled, viewport = renderer.getViewport(new THREE.Vector4()), scissor = renderer.getScissor(new THREE.Vector4()), scissorTest = renderer.getScissorTest();
    try {
      renderer.clippingPlanes = []; renderer.autoClear = false; renderer.shadowMap.enabled = false; renderer.setClearColor(0xffffff, 1);
      for (const [slotIndex, slot] of this.slots.entries()) {
        if (!slot.link || !slot.dirty) continue;
        const { receiver, source } = slot.link;
        for (const room of this.ids) {
          this.receiver[room].group.visible = room === receiver.room; this.source[room].group.visible = room === source.room;
          this.receiver[room].walls.forEach((wall, side) => { wall.visible = side !== receiver.side; });
          this.source[room].walls.forEach((wall, side) => { wall.visible = side !== source.side; });
        }
        // The two connected wall faces are evaluated against the whole panel
        // analytically. A center-only depth silhouette would cut off penumbrae.
        const from = portalPosition(source.room, source.side), to = portalPosition(receiver.room, receiver.side);
        this.source[source.room].group.matrix.makeTranslation(to.x, 0, to.z)
          .multiply(this.matrix.makeRotationY(-portalAngle(source, receiver)))
          .multiply(this.matrix.makeTranslation(-from.x, 0, -from.z));
        for (let lamp = 0; lamp < slot.lamps.length; lamp++) {
          const tile = slotIndex * this.stride + lamp, x = tile % 8 * TILE_WIDTH, y = Math.floor(tile / 8) * TILE_HEIGHT;
          // Render-target rectangles are physical texels. Renderer setters use
          // logical screen pixels and would apply the display's pixel ratio.
          this.target.viewport.set(x, y, TILE_WIDTH, TILE_HEIGHT);
          this.target.scissor.set(x, y, TILE_WIDTH, TILE_HEIGHT); this.target.scissorTest = true;
          renderer.setRenderTarget(this.target);
          renderer.clear(); renderer.render(this.scene, slot.cameras[lamp]); this.updates++;
        }
        slot.dirty = false;
      }
      for (const room of this.ids) if (this.slots.some(slot => slot.link?.receiver.room === room))
        this.surfaces.render(renderer, room, () => this.bind(room, true), this.uniforms.directLocalStarts.value, this.uniforms.directLocalCounts.value);
    } finally {
      renderer.clippingPlanes = clipping; renderer.autoClear = autoClear; renderer.shadowMap.enabled = shadow; renderer.setClearColor(clear, alpha);
      renderer.setRenderTarget(previous); renderer.setViewport(viewport); renderer.setScissor(scissor); renderer.setScissorTest(scissorTest);
    }
  }
  private pack() {
    this.data.fill(0); this.starts.fill(0); this.localCounts.fill(0);
    const matrix = new THREE.Matrix4();
    for (const [row, room] of this.ids.entries()) {
      let count = 0;
      const write = (lamp: CeilingLamp, frame: THREE.Vector4, shadow: THREE.Matrix4, tile: number, axis: Vec2) => {
        const out = (row * DATA_WIDTH + count * DATA_STRIDE) * 4;
        this.data.set([lamp.x, lamp.z, tile % 8, Math.floor(tile / 8)], out);
        frame.toArray(this.data, out + 4); shadow.toArray(this.data, out + 8);
        this.data.set([axis.x, axis.z, lamp.distance], out + 24);
        count++;
      };
      this.slots.forEach((slot, index) => {
        if (slot.link?.receiver.room !== room) return;
        slot.lamps.forEach((lamp, light) => {
          write(lamp, slot.frames, slot.matrices[light], index * this.stride + light, slot.axis);
        });
      });
      this.counts[row] = count;
      const active = this.slots.filter(slot => slot.link?.receiver.room === room).map(slot => slot.link!.receiver.side).sort((a, b) => a - b);
      this.surfaces.fields[room].active = active;
      if (this.localPassages) active.forEach((side, passage) => {
        const forward = this.slots.find(slot => slot.link?.receiver.room === room && slot.link.receiver.side === side)!;
        const link = forward.link!, reverseIndex = this.slots.findIndex(slot => slot.link?.receiver.room === link.source.room && slot.link.receiver.side === link.source.side);
        const reverse = this.slots[reverseIndex];
        const from = portalPosition(room, side), to = portalPosition(link.source.room, link.source.side);
        const transform = this.transform.makeTranslation(to.x, 0, to.z)
          .multiply(this.matrix.makeRotationY(-portalAngle(link.receiver, link.source)))
          .multiply(this.matrix.makeTranslation(-from.x, 0, -from.z));
        this.starts[row * 4 + passage] = count;
        this.localCounts[row * 4 + passage] = ROOM_LIGHTS[room].length;
        ROOM_LIGHTS[room].forEach((lamp, light) => {
          write(lamp, forward.frames, matrix.copy(reverse.matrices[light]).multiply(transform), reverseIndex * this.stride + light, { x: 1, z: 0 });
        });
      });
    }
    this.uniforms.directLightData.value.needsUpdate = true;
  }
  bind(room: RoomId, enabled: boolean) {
    const row = this.ids.indexOf(room); this.uniforms.directRow.value = row;
    this.uniforms.directNeighborCount.value = enabled ? this.counts[row] : 0;
    for (let passage = 0; passage < 4; passage++) {
      this.uniforms.directLocalStarts.value[passage] = this.starts[row * 4 + passage];
      this.uniforms.directLocalCounts.value[passage] = enabled ? this.localCounts[row * 4 + passage] : 0;
    }
    this.surfaces.uniform.value = this.surfaces.fields[room].target.texture;
  }
  prepare() {
    const renderer = this.renderer, target = renderer.getRenderTarget(), clipping = renderer.clippingPlanes;
    const viewport = renderer.getViewport(new THREE.Vector4()), scissor = renderer.getScissor(new THREE.Vector4()), scissorTest = renderer.getScissorTest();
    const shadow = renderer.shadowMap.enabled;
    const clear = renderer.getClearColor(new THREE.Color()), alpha = renderer.getClearAlpha();
    const visible = this.scene.children.map(object => object.visible);
    try {
      // Exercise every caster geometry with the final depth material and atlas
      // before play, including rooms not in either initial connection.
      this.scene.traverse(object => { object.frustumCulled = false; object.visible = true; });
      renderer.clippingPlanes = []; renderer.shadowMap.enabled = false;
      this.target.viewport.set(2047, 2047, 1, 1); this.target.scissor.set(2047, 2047, 1, 1); this.target.scissorTest = true;
      renderer.setRenderTarget(this.target);
      renderer.render(this.scene, this.slots[0].cameras[0]);
      for (const room of this.ids) this.surfaces.render(renderer, room, () => this.bind(room, true), this.uniforms.directLocalStarts.value, this.uniforms.directLocalCounts.value, true);
    } finally {
      this.scene.children.forEach((object, index) => { object.visible = visible[index]; });
      renderer.clippingPlanes = clipping; renderer.shadowMap.enabled = shadow; renderer.setRenderTarget(target);
      renderer.setClearColor(clear, alpha);
      renderer.setViewport(viewport); renderer.setScissor(scissor); renderer.setScissorTest(scissorTest);
      // Restore plug visibility after the warmup's forced draw.
      for (const room of this.ids) this.receiver[room].doors.forEach((door, side) => {
        const open = this.slots.some(slot => slot.link?.receiver.room === room && slot.link.receiver.side === side);
        door.visible = this.source[room].doors[side].visible = !open;
      });
    }
  }
  dispose() {
    this.target.dispose(); this.material.dispose();
    this.surfaces.dispose();
    this.uniforms.directLightData.value.dispose();
    this.scene.traverse(object => { if (object instanceof THREE.Mesh) object.geometry.dispose(); });
  }
}

export const DIRECT_LIGHT_SHADER = `
${LIGHT_GRADIENT_SHADER}
uniform sampler2D directShadowAtlas, directLightData;
uniform int directNeighborCount, directRow;
uniform int directLocalStarts[4], directLocalCounts[4];
varying vec3 directWorldPosition;
vec4 directRecord(int light, int component) { return texelFetch(directLightData, ivec2(light * ${DATA_STRIDE} + component, directRow), 0); }
float directEnergy(vec3 point, vec3 normal, vec2 lamp, float range) {
  vec3 ray = vec3(lamp.x, ${CEILING_LIGHT.height.toFixed(6)}, lamp.y) - point;
  float distance2 = dot(ray, ray), distance = sqrt(distance2);
  if (distance >= range || ray.y <= 0.) return 0.;
  float receive = max(0., dot(normal, ray) / distance);
  float spot = smoothstep(${Math.cos(CEILING_LIGHT.angle).toFixed(8)}, ${Math.cos(CEILING_LIGHT.angle * (1 - CEILING_LIGHT.penumbra)).toFixed(8)}, ray.y / distance);
  float cutoff = max(0., 1. - pow(distance / range, 4.));
  return ${CEILING_LIGHT.intensity.toFixed(6)} * (${SPOT_LIGHT_SHARE.toFixed(6)} * spot + ${(1 - SPOT_LIGHT_SHARE).toFixed(6)} * ray.y / distance) * receive * cutoff * cutoff / max(distance2, .01);
}
`;

/** Declared after Three's packing functions, which decode the depth atlas. */
export const DIRECT_SHADOW_SHADER = `
float directVisibility(int light, vec3 point, vec3 normal) {
  mat4 matrix = mat4(directRecord(light, 2), directRecord(light, 3), directRecord(light, 4), directRecord(light, 5));
  vec4 projected = matrix * vec4(point, 1.);
  vec3 q = projected.xyz / projected.w;
  if (q.z < 0. || q.z > 1. || any(lessThan(q.xy, vec2(0.))) || any(greaterThan(q.xy, vec2(1.)))) return 0.;
  vec3 u = abs(normal.x) > abs(normal.z) ? vec3(-normal.y, normal.x, 0.) : vec3(0., -normal.z, normal.y);
  vec3 v = cross(normal, u);
  vec4 pu = matrix * vec4(u, 0.), pv = matrix * vec4(v, 0.);
  vec3 plane = cross(pu.xyz - q * pu.w, pv.xyz - q * pv.w);
  vec2 slope = abs(plane.z) > 1.e-10 ? -plane.xy / plane.z : vec2(0.);
  vec2 size = vec2(${TILE_WIDTH}., ${TILE_HEIGHT}.), p = q.xy * size - .5, cell = floor(p), f = fract(p);
  float visibility = 0.;
  for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) {
    vec2 center = (cell + vec2(float(x), float(y)) + .5) / size;
    vec2 uv = (directRecord(light, 0).zw * size + center * size) / ${ATLAS_SIZE}.;
    float depth = unpackRGBAToDepth(texture2D(directShadowAtlas, uv));
    float weight = (x == 0 ? 1. - f.x : f.x) * (y == 0 ? 1. - f.y : f.y);
    visibility += weight * step(q.z + dot(slope, center - q.xy) - .00002, depth);
  }
  return visibility;
}
${PANEL_APERTURE_SHADER}
float directIncident(int light, vec3 point, vec3 normal, vec3 geometricNormal) {
  float energy = directEnergy(point, normal, directRecord(light, 0).xy, directRecord(light, 6).z);
  if (energy <= .000001) return 0.;
  float aperture = directPanelVisibility(light, point);
  if (aperture <= .000001) return 0.;
  return energy * aperture * directVisibility(light, point, geometricNormal);
}
vec4 directIncidentField(int light, vec3 point, vec3 normal) {
  float energy = directIncident(light, point, normal, normal);
  vec2 lamp = directRecord(light, 0).xy;
  vec3 ray = vec3(lamp.x, ${CEILING_LIGHT.height.toFixed(6)}, lamp.y) - point;
  // Keep the geometric irradiance and its world-space normal gradient together.
  vec3 gradient = ray * (energy / max(dot(normal, ray), .000001));
  return vec4(energy, directLightGradient(gradient, normal, energy, dot(ray, ray)));
}
vec4 directNeighborField(vec3 point, vec3 normal) {
  vec4 light = vec4(0.);
  for (int lamp = 0; lamp < 28; lamp++) {
    if (lamp >= directNeighborCount) break;
    light += directIncidentField(lamp, point, normal);
  }
  return light;
}
float directNeighborLight(vec3 point, vec3 normal, vec3 geometricNormal) {
  float light = 0.;
  for (int lamp = 0; lamp < 28; lamp++) {
    if (lamp >= directNeighborCount) break;
    light += directIncident(lamp, point, normal, geometricNormal);
  }
  return light;
}
`;
