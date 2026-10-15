import * as THREE from 'three';
import { GpuTiming } from './gpu-timing';
import { ballAt, destination, DOOR_HEIGHT, DOOR_WIDTH, EYE_HEIGHT, Game, PEDESTAL_APOTHEM, portalAngle, ROOM_HEIGHT, ROOMS, SOCKET_RADIUS, wallAngle, wallNormal, type RoomId, type SocketRef } from './world';

const PALETTE = { background: 0xc9ceca, wall: 0xd8dbd4, floor: 0xb6bdb5, ceiling: 0xd1d5ce, graphite: 0x3b4947, top: 0x778781, red: 0xc95745, blue: 0x477baf };
const unitBox = new THREE.BoxGeometry(1, 1, 1);
const plane = new THREE.PlaneGeometry(1, 1);
const sphere = new THREE.SphereGeometry(0.145, 24, 16);
const socketGeometry = new THREE.CylinderGeometry(0.19, 0.19, 0.018, 32);
const ringGeometry = new THREE.TorusGeometry(0.194, 0.012, 6, 32);
const materials = {
  wall: new THREE.MeshStandardMaterial({ color: PALETTE.wall, roughness: 0.96 }),
  floor: new THREE.MeshStandardMaterial({ color: PALETTE.floor, roughness: 0.94 }),
  ceiling: new THREE.MeshStandardMaterial({ color: PALETTE.ceiling, roughness: 1 }),
  body: new THREE.MeshStandardMaterial({ color: PALETTE.graphite, roughness: 0.8 }),
  top: new THREE.MeshStandardMaterial({ color: PALETTE.top, roughness: 0.8 }),
  socket: new THREE.MeshStandardMaterial({ color: 0x34423f, roughness: 1 }),
  trim: new THREE.MeshStandardMaterial({ color: 0x93a099, roughness: 0.9 }),
  light: new THREE.MeshBasicMaterial({ color: 0xf4f2df }),
  marker: new THREE.MeshBasicMaterial({ color: 0xe1e2cd }),
  red: new THREE.MeshStandardMaterial({ color: PALETTE.red, roughness: 0.34, metalness: 0.06 }),
  blue: new THREE.MeshStandardMaterial({ color: PALETTE.blue, roughness: 0.34, metalness: 0.06 }),
  seam: new THREE.MeshBasicMaterial({ color: 0x9da89f, transparent: true, opacity: 0.3 }),
  shadow: new THREE.MeshBasicMaterial({ color: 0x25352f, transparent: true, opacity: 0.11, depthWrite: false }),
};

function box(parent: THREE.Object3D, material: THREE.Material, size: number[], position: number[]) {
  const mesh = new THREE.Mesh(unitBox, material);
  mesh.scale.set(size[0], size[1], size[2]); mesh.position.set(position[0], position[1], position[2]);
  parent.add(mesh); return mesh;
}

function polygonShape(sides: number, apothem: number) {
  const shape = new THREE.Shape(), radius = apothem / Math.cos(Math.PI / sides);
  for (let i = 0; i < sides; i++) {
    const angle = i * Math.PI * 2 / sides - Math.PI / sides;
    const x = Math.sin(angle) * radius, y = Math.cos(angle) * radius;
    if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
  }
  shape.closePath(); return shape;
}

interface Portal { side: number; mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>; to: SocketRef | null; transform: THREE.Matrix4; normal: { x: number; z: number }; receivingNormal: THREE.Vector3 }
interface SocketVisual { ref: SocketRef; hit: THREE.Mesh; ball: THREE.Mesh; ring: THREE.Mesh }
export interface RoomVisual { scene: THREE.Scene; portals: Portal[]; sockets: SocketVisual[]; blockers: THREE.Object3D[]; pickables: THREE.Object3D[]; partition: THREE.Group; walls: { solid: THREE.Group; open: THREE.Group }[]; labels: THREE.Sprite[] }

function portalMaterial() {
  // Keep the aperture rasterizable while the eye is closer than the normal near
  // plane. Restore its actual depth per fragment so foreground objects still occlude it.
  return new THREE.ShaderMaterial({
    uniforms: { image: { value: null }, viewOrigin: { value: new THREE.Vector2() }, imageRect: { value: new THREE.Vector4(0, 0, 1, 1) }, hasImage: { value: false }, mainView: { value: false }, fogColor: { value: new THREE.Color(PALETTE.background) } },
    vertexShader: `varying vec3 viewPosition; varying vec2 portalDepth; uniform bool mainView;
      void main() { vec4 p = modelViewMatrix * vec4(position, 1.); viewPosition = p.xyz; gl_Position = projectionMatrix * p; portalDepth = gl_Position.zw;
        if (mainView) gl_Position.z = 0.;
      }`,
    fragmentShader: `uniform sampler2D image; uniform vec2 viewOrigin; uniform vec4 imageRect; uniform bool hasImage; uniform bool mainView; uniform vec3 fogColor; varying vec3 viewPosition; varying vec2 portalDepth;
      void main() { vec2 uv = (gl_FragCoord.xy + viewOrigin - imageRect.xy) / imageRect.zw;
        vec3 color = hasImage ? texture2D(image, uv).rgb : fogColor;
        gl_FragDepth = mainView ? clamp(portalDepth.x / portalDepth.y * .5 + .5, 0., 1.) : gl_FragCoord.z;
        gl_FragColor = vec4(mix(color, fogColor, smoothstep(14., 32., length(viewPosition))), 1.);
        #include <colorspace_fragment>
      }`,
    toneMapped: false,
  });
}

function pedestal(parent: THREE.Scene, x: number, z: number, controls: RoomId, visuals: SocketVisual[], blockers: THREE.Object3D[]) {
  const group = new THREE.Group(); group.position.set(x, 0, z); parent.add(group);
  const sides = ROOMS[controls].sides;
  const bodyGeometry = new THREE.ExtrudeGeometry(polygonShape(sides, PEDESTAL_APOTHEM - 0.06), { depth: 0.86, bevelEnabled: true, bevelSize: 0.018, bevelThickness: 0.018, bevelSegments: 1, steps: 1 });
  bodyGeometry.rotateX(-Math.PI / 2);
  const body = new THREE.Mesh(bodyGeometry, materials.body); body.position.y = 0.07; group.add(body); blockers.push(body);
  const topGeometry = new THREE.ExtrudeGeometry(polygonShape(sides, PEDESTAL_APOTHEM + 0.04), { depth: 0.07, bevelEnabled: true, bevelSize: 0.018, bevelThickness: 0.018, bevelSegments: 1, steps: 1 });
  topGeometry.rotateX(-Math.PI / 2);
  const top = new THREE.Mesh(topGeometry, materials.top); top.position.y = 0.94; group.add(top); blockers.push(top);
  const base = new THREE.Mesh(new THREE.CircleGeometry(1.04, 48), materials.shadow); base.rotation.x = -Math.PI / 2; base.position.y = 0.004; group.add(base);
  const center = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(Array.from({ length: sides }, (_, i) => {
    const a = i * Math.PI * 2 / sides - Math.PI / sides;
    return new THREE.Vector3(Math.sin(a) * 0.18, 1.018, -Math.cos(a) * 0.18);
  })), new THREE.LineBasicMaterial({ color: 0xc1cbc0 })); group.add(center);
  const marker = new THREE.Mesh(new THREE.ConeGeometry(0.043, 0.09, 3), materials.marker);
  marker.rotation.x = -Math.PI / 2; marker.position.set(0, 1.02, -0.68); group.add(marker);
  for (let side = 0; side < sides; side++) {
    const n = wallNormal(controls, side), socket = new THREE.Group();
    socket.position.set(n.x * SOCKET_RADIUS, 1.026, n.z * SOCKET_RADIUS); group.add(socket);
    const hit = new THREE.Mesh(socketGeometry, materials.socket); socket.add(hit);
    const ball = new THREE.Mesh(sphere, materials.red); ball.position.y = 0.11; socket.add(ball);
    const ring = new THREE.Mesh(ringGeometry, materials.marker); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.016; ring.visible = false; socket.add(ring);
    const ref = { room: controls, side };
    hit.userData.socket = ref; ball.userData.socket = ref;
    visuals.push({ ref, hit, ball, ring });
  }
}

function debugLabel(text: string) {
  const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 64;
  const context = canvas.getContext('2d')!; context.fillStyle = '#3a4a44'; context.font = '32px monospace'; context.textAlign = 'center'; context.fillText(text, 64, 43);
  const texture = new THREE.CanvasTexture(canvas);
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: true })); label.scale.set(0.75, 0.375, 1); label.visible = false; return label;
}

function createRoom(id: RoomId): RoomVisual {
  const definition = ROOMS[id], scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.background); scene.fog = new THREE.Fog(PALETTE.background, 14, 32);
  scene.add(new THREE.HemisphereLight(0xf1f3e7, 0x69796e, 2.45));
  const sun = new THREE.DirectionalLight(0xfff0d7, 2.1); sun.position.set(-2, 6, 3); scene.add(sun);
  const fill = new THREE.DirectionalLight(0xc9dbe1, 1.0); fill.position.set(3, 3, -3); scene.add(fill);
  const floorGeometry = new THREE.ShapeGeometry(polygonShape(definition.sides, 5.13)); floorGeometry.rotateX(-Math.PI / 2);
  const floor = new THREE.Mesh(floorGeometry, materials.floor); scene.add(floor);
  const ceiling = new THREE.Mesh(floorGeometry, materials.ceiling); ceiling.position.y = ROOM_HEIGHT; ceiling.rotation.x = Math.PI; scene.add(ceiling);
  const sockets: SocketVisual[] = [], portals: Portal[] = [], blockers: THREE.Object3D[] = [], walls: RoomVisual['walls'] = [], labels: THREE.Sprite[] = [];
  const wallWidth = 10 * Math.tan(Math.PI / definition.sides) + 0.06;
  // Floor joints are geometry, and are clipped by the convex room footprint.
  for (let axis = 0; axis < 2; axis++) for (let offset = -4; offset <= 4; offset += 2) {
    let min = -8, max = 8;
    for (let side = 0; side < definition.sides; side++) {
      const n = wallNormal(id, side), varying = axis ? n.x : n.z, fixed = axis ? n.z : n.x;
      if (Math.abs(varying) < 1e-5) continue;
      const limit = (4.99 - fixed * offset) / varying;
      if (varying > 0) max = Math.min(max, limit); else min = Math.max(min, limit);
    }
    box(scene, materials.seam, axis ? [max - min, 0.002, 0.008] : [0.008, 0.002, max - min], axis ? [(max + min) / 2, 0.002, offset] : [offset, 0.002, (max + min) / 2]);
  }
  for (let side = 0; side < definition.sides; side++) {
    const n = wallNormal(id, side), wall = new THREE.Group();
    wall.position.set(n.x * 5, 0, n.z * 5); wall.rotation.y = -wallAngle(id, side); scene.add(wall);
    const solid = new THREE.Group(), open = new THREE.Group(); wall.add(solid, open);
    blockers.push(box(solid, materials.wall, [wallWidth, ROOM_HEIGHT, 0.16], [0, ROOM_HEIGHT / 2, -0.08]));
    const wing = (wallWidth - DOOR_WIDTH) / 2;
    for (const sign of [-1, 1]) {
      blockers.push(box(open, materials.wall, [wing, ROOM_HEIGHT, 0.16], [sign * (DOOR_WIDTH + wing) / 2, ROOM_HEIGHT / 2, -0.08]));
      box(open, materials.trim, [0.024, DOOR_HEIGHT, 0.022], [sign * (DOOR_WIDTH / 2 + 0.012), DOOR_HEIGHT / 2, 0.014]);
    }
    blockers.push(box(open, materials.wall, [DOOR_WIDTH, ROOM_HEIGHT - DOOR_HEIGHT, 0.16], [0, (ROOM_HEIGHT + DOOR_HEIGHT) / 2, -0.08]));
    // A quiet skirting line and a ceiling luminaire establish scale.
    for (const sign of [-1, 1]) box(wall, materials.trim, [wing, 0.045, 0.025], [sign * (DOOR_WIDTH + wing) / 2, 0.045, 0.018]);
    box(wall, materials.light, [2.6, 0.035, 0.032], [0, 3.26, 0.04]);
    if (side === 0) {
      const mark = new THREE.Mesh(new THREE.ConeGeometry(0.10, 0.17, 3), materials.body); mark.rotation.z = Math.PI; mark.position.set(-1.15, 2.83, 0.035); wall.add(mark);
    }
    const portal = new THREE.Mesh(plane, portalMaterial()); portal.scale.set(DOOR_WIDTH, DOOR_HEIGHT, 1); portal.position.set(0, DOOR_HEIGHT / 2, -0.001); wall.add(portal);
    portals.push({ side, mesh: portal, to: null, transform: new THREE.Matrix4(), normal: n, receivingNormal: new THREE.Vector3() }); walls.push({ solid, open });
    const label = debugLabel(`${id}${side}`); label.position.set(n.x * 4.91, 2.91, n.z * 4.91); scene.add(label); labels.push(label);
  }
  for (const p of definition.pedestals) pedestal(scene, p.x, p.z, p.controls, sockets, blockers);
  const partition = new THREE.Group(); scene.add(partition);
  const divider = box(partition, materials.wall, [Math.sqrt(200) + 0.25, ROOM_HEIGHT, 0.14], [0, ROOM_HEIGHT / 2, 0]); divider.rotation.y = -Math.PI / 4; blockers.push(divider);
  for (const sign of [-1, 1]) {
    const trim = box(partition, materials.trim, [Math.sqrt(200), 0.04, 0.02], [sign * 0.06, 0.05, -sign * 0.06]); trim.rotation.y = -Math.PI / 4;
  }
  partition.visible = false;
  scene.updateMatrixWorld(true);
  return { scene, portals, sockets, blockers, pickables: [], partition, walls, labels };
}

type Rect = { minX: number; minY: number; maxX: number; maxY: number };
const FULL: Rect = { minX: -1, minY: -1, maxX: 1, maxY: 1 };
const MAX_DEPTH = 4;
const MAX_PASSES = 24;
const TARGET_BLOCK = 128;
interface PortalView { portal: Portal; rect: Rect; image: THREE.WebGLRenderTarget | null; area: number }
function clipDistance(point: THREE.Vector4, plane: number) {
  switch (plane) {
    case 0: return point.w - 0.00001;
    case 1: return point.x + point.w;
    case 2: return point.w - point.x;
    case 3: return point.y + point.w;
    default: return point.w - point.y;
  }
}
export class SpaceRenderer {
  renderer: THREE.WebGLRenderer;
  gpuTiming: GpuTiming;
  camera = new THREE.PerspectiveCamera(67, 1, 0.025, 80);
  rooms: Record<RoomId, RoomVisual>;
  targets: THREE.WebGLRenderTarget[] = [];
  cameras = Array.from({ length: MAX_DEPTH + 1 }, () => new THREE.PerspectiveCamera());
  passes = 0;
  width = 1; height = 1; targetWidth = 1; targetHeight = 1;
  readonly portalSamples: number;
  targetAllocations = 0;
  raycaster = new THREE.Raycaster();
  hovered: SocketVisual | null = null;
  drawCalls = 0;
  portalPixels = 0;
  private readonly center = new THREE.Vector2();
  private readonly bufferSize = new THREE.Vector2();
  private readonly hits: THREE.Intersection[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly translation = new THREE.Matrix4();
  private readonly clipPlane = new THREE.Plane();
  private readonly clipVector = new THREE.Vector4();
  private readonly clipCorner = new THREE.Vector4();
  private readonly clipPointsA = Array.from({ length: 12 }, () => new THREE.Vector4());
  private readonly clipPointsB = Array.from({ length: 12 }, () => new THREE.Vector4());
  private readonly views: PortalView[][] = Array.from({ length: MAX_DEPTH + 1 }, () => []);
  constructor(public canvas: HTMLCanvasElement, public game: Game) {
    // Create the context explicitly: this Three.js release requests alpha:true
    // internally even with renderer alpha:false. The game is always opaque.
    const context = canvas.getContext('webgl2', { alpha: false, antialias: true, depth: true, stencil: false, powerPreference: 'high-performance' });
    if (!context) throw new Error('WebGL 2 is unavailable');
    this.renderer = new THREE.WebGLRenderer({ canvas, context });
    this.portalSamples = Math.min(context.getParameter(context.SAMPLES), this.renderer.capabilities.maxSamples);
    this.gpuTiming = new GpuTiming(context);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.info.autoReset = false;
    this.rooms = { A: createRoom('A'), B: createRoom('B') };
    this.resize(); this.sync();
  }
  resize() {
    this.width = innerWidth; this.height = innerHeight;
    this.renderer.setSize(this.width, this.height);
    this.camera.aspect = this.width / this.height; this.camera.updateProjectionMatrix();
    this.renderer.getDrawingBufferSize(this.bufferSize);
    this.targetWidth = this.bufferSize.x; this.targetHeight = this.bufferSize.y;
    // Warm the largest front view and five smaller branches before play. Buffers
    // grow in blocks, never shrink during movement, and are reused on every frame.
    for (let i = 0; i < Math.max(6, this.targets.length); i++) {
      this.allocateTarget(i, i === 0 ? this.targetWidth : i < 6 ? Math.ceil(this.targetWidth / 2) : 1,
        i === 0 ? this.targetHeight : i < 6 ? Math.ceil(this.targetHeight / 2) : 1);
    }
  }
  private allocateTarget(index: number, width: number, height: number) {
    let target = this.targets[index];
    width = Math.min(this.targetWidth, Math.max(target?.width ?? 0, Math.ceil(width / TARGET_BLOCK) * TARGET_BLOCK));
    height = Math.min(this.targetHeight, Math.max(target?.height ?? 0, Math.ceil(height / TARGET_BLOCK) * TARGET_BLOCK));
    if (!target) {
      target = new THREE.WebGLRenderTarget(width, height, {
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true,
        samples: this.portalSamples, resolveDepthBuffer: false, type: THREE.UnsignedByteType,
      });
      this.targets[index] = target; this.renderer.initRenderTarget(target); this.targetAllocations++;
    } else if (target.width !== width || target.height !== height) {
      target.setSize(width, height); this.renderer.initRenderTarget(target); this.targetAllocations++;
    }
    return target;
  }
  private targetAt(index: number, clip: Rect) {
    const x = Math.max(0, Math.floor((clip.minX + 1) * 0.5 * this.targetWidth) - 2);
    const y = Math.max(0, Math.floor((clip.minY + 1) * 0.5 * this.targetHeight) - 2);
    const right = Math.min(this.targetWidth, Math.ceil((clip.maxX + 1) * 0.5 * this.targetWidth) + 2);
    const top = Math.min(this.targetHeight, Math.ceil((clip.maxY + 1) * 0.5 * this.targetHeight) + 2);
    const target = this.allocateTarget(index, right - x, top - y);
    // Translate the full-size viewport into a cropped texture. Every texture pixel
    // still corresponds to exactly one main-frame pixel, at all recursion depths.
    target.viewport.set(-x, -y, this.targetWidth, this.targetHeight);
    target.scissor.set(0, 0, right - x, top - y); target.scissorTest = true;
    return target;
  }
  sync() {
    const world = this.game.world;
    for (const id of ['A', 'B'] as const) {
      const room = this.rooms[id]; room.partition.visible = id === 'A' && world.mode === 'puzzle';
      for (let side = 0; side < ROOMS[id].sides; side++) {
        const portal = room.portals[side];
        portal.to = destination(world, { room: id, side });
        const active = !!portal.to;
        if (portal.to) {
          const from = { room: id, side }, n = wallNormal(portal.to.room, portal.to.side);
          portal.receivingNormal.set(-n.x, 0, -n.z);
          portal.transform.makeTranslation(n.x * 5, 0, n.z * 5)
            .multiply(this.matrix.makeRotationY(-portalAngle(from, portal.to)))
            .multiply(this.translation.makeTranslation(-portal.normal.x * 5, 0, -portal.normal.z * 5));
        }
        room.walls[side].solid.visible = !active; room.walls[side].open.visible = active; room.portals[side].mesh.visible = active;
      }
      for (const socket of room.sockets) {
        const ball = ballAt(world, socket.ref); socket.ball.visible = !!ball;
        if (ball) socket.ball.material = materials[ball.color];
      }
      room.pickables.length = 0;
      for (const object of [...room.blockers, ...room.sockets.flatMap(s => [s.hit, s.ball])]) {
        let visible = true;
        for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) if (!parent.visible) { visible = false; break; }
        if (visible) room.pickables.push(object);
      }
      room.scene.updateMatrixWorld(true);
    }
  }
  updateCamera() {
    const p = this.game.player;
    this.camera.position.set(p.x, EYE_HEIGHT, p.z); this.camera.rotation.set(p.pitch, p.yaw, 0, 'YXZ'); this.camera.updateMatrixWorld(true);
  }
  setDebug(show: boolean) { for (const room of Object.values(this.rooms)) for (const label of room.labels) label.visible = show; }
  pick(): SocketRef | null {
    if (this.hovered) this.hovered.ring.visible = false;
    this.updateCamera();
    const room = this.rooms[this.game.player.room];
    this.raycaster.setFromCamera(this.center, this.camera); this.raycaster.far = 2.25;
    this.hits.length = 0;
    const hit = this.raycaster.intersectObjects(room.pickables, false, this.hits)[0];
    this.hovered = hit?.object.userData.socket ? room.sockets.find(s => s.ref.room === hit.object.userData.socket.room && s.ref.side === hit.object.userData.socket.side)! : null;
    if (this.hovered) this.hovered.ring.visible = true;
    return this.hovered?.ref ?? null;
  }
  private portalRect(portal: Portal, camera: THREE.PerspectiveCamera, clip: Rect, bounds: Rect): boolean {
    const n = portal.normal;
    if (n.x * camera.position.x + n.z * camera.position.z > 5.025) return false;
    this.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(portal.mesh.matrixWorld);
    // Clip the aperture polygon in homogeneous space, including apertures crossing the eye plane.
    let points = this.clipPointsA, output = this.clipPointsB, count = 4;
    points[0].set(-0.5, -0.5, 0, 1).applyMatrix4(this.matrix);
    points[1].set(0.5, -0.5, 0, 1).applyMatrix4(this.matrix);
    points[2].set(0.5, 0.5, 0, 1).applyMatrix4(this.matrix);
    points[3].set(-0.5, 0.5, 0, 1).applyMatrix4(this.matrix);
    for (let plane = 0; plane < 5; plane++) {
      let written = 0;
      for (let i = 0; i < count; i++) {
        const a = points[i], b = points[(i + 1) % count], da = clipDistance(a, plane), db = clipDistance(b, plane);
        if (da >= 0) output[written++].copy(a);
        if ((da >= 0) !== (db >= 0)) output[written++].copy(a).lerp(b, da / (da - db));
      }
      count = written; if (!count) return false;
      const swap = points; points = output; output = swap;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < count; i++) {
      const p = points[i], x = p.x / p.w, y = p.y / p.w;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    bounds.minX = Math.max(clip.minX, minX); bounds.maxX = Math.min(clip.maxX, maxX);
    bounds.minY = Math.max(clip.minY, minY); bounds.maxY = Math.min(clip.maxY, maxY);
    return bounds.maxX - bounds.minX > 0.002 && bounds.maxY - bounds.minY > 0.002;
  }
  private childCamera(camera: THREE.PerspectiveCamera, portal: Portal, depth: number) {
    const child = this.cameras[depth]; child.copy(this.camera, false);
    this.matrix.multiplyMatrices(portal.transform, camera.matrixWorld).decompose(child.position, child.quaternion, child.scale); child.updateMatrixWorld(true);
    // Replace the near plane with the receiving wall. Geometry behind the aperture
    // is removed before rasterization, even for adjacent/self-connected walls.
    const clip = this.clipPlane.set(portal.receivingNormal, 4.998).applyMatrix4(child.matrixWorldInverse);
    const c = this.clipVector.set(clip.normal.x, clip.normal.y, clip.normal.z, clip.constant);
    const p = child.projectionMatrix.elements;
    const q = this.clipCorner.set((Math.sign(c.x) + p[8]) / p[0], (Math.sign(c.y) + p[9]) / p[5], -1, (1 + p[10]) / p[14]);
    c.multiplyScalar(2 / c.dot(q));
    p[2] = c.x; p[6] = c.y; p[10] = c.z + 1; p[14] = c.w;
    child.projectionMatrixInverse.copy(child.projectionMatrix).invert();
    return child;
  }
  private renderRoom(id: RoomId, camera: THREE.PerspectiveCamera, depth: number, clip: Rect, target: THREE.WebGLRenderTarget | null, incoming?: number) {
    const room = this.rooms[id];
    const views = this.views[depth]; let count = 0;
    for (const portal of room.portals) {
      if (!portal.to || portal.side === incoming) continue;
      const view = views[count] ??= { portal, rect: { ...FULL }, image: null, area: 0 };
      if (!this.portalRect(portal, camera, clip, view.rect)) continue;
      view.portal = portal; view.image = null; view.area = (view.rect.maxX - view.rect.minX) * (view.rect.maxY - view.rect.minY); count++;
    }
    // At most five candidates; sort only the live prefix without allocating arrays.
    for (let i = 1; i < count; i++) {
      const view = views[i]; let j = i;
      while (j > 0 && views[j - 1].area < view.area) { views[j] = views[j - 1]; j--; }
      views[j] = view;
    }
    for (let i = 0; i < count; i++) {
      if (depth >= MAX_DEPTH || this.passes >= MAX_PASSES - 1) break;
      const view = views[i], to = view.portal.to!;
      const image = this.targetAt(this.passes++, view.rect);
      const child = this.childCamera(camera, view.portal, depth + 1);
      this.renderRoom(to.room, child, depth + 1, view.rect, image, to.side);
      view.image = image;
    }
    // Shared scenes are rebound AFTER their children finish; each branch has its own target.
    for (const portal of room.portals) {
      const uniforms = portal.mesh.material.uniforms;
      uniforms.hasImage.value = false; uniforms.image.value = null;
      uniforms.mainView.value = depth === 0;
      uniforms.viewOrigin.value.set(target ? -target.viewport.x : 0, target ? -target.viewport.y : 0);
    }
    for (let i = 0; i < count; i++) {
      const view = views[i], uniforms = view.portal.mesh.material.uniforms;
      uniforms.image.value = view.image?.texture ?? null; uniforms.hasImage.value = !!view.image;
      if (view.image) uniforms.imageRect.value.set(-view.image.viewport.x, -view.image.viewport.y, view.image.width, view.image.height);
    }
    if (target) {
      this.portalPixels += target.scissor.z * target.scissor.w;
    }
    this.renderer.setRenderTarget(target);
    this.renderer.render(room.scene, camera);
  }
  render() {
    this.updateCamera(); this.passes = 0; this.portalPixels = 0; this.renderer.info.reset();
    this.gpuTiming.begin();
    try { this.renderRoom(this.game.player.room, this.camera, 0, FULL, null); }
    finally { this.gpuTiming.end(); }
    this.drawCalls = this.renderer.info.render.calls; this.passes++;
  }
  dispose() {
    this.gpuTiming.dispose();
    for (const target of this.targets) target.dispose();
    const geometries = new Set<THREE.BufferGeometry>(), mats = new Set<THREE.Material>();
    for (const room of Object.values(this.rooms)) room.scene.traverse(object => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Sprite) {
        if ('geometry' in object) geometries.add(object.geometry);
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) mats.add(material);
      }
    });
    geometries.forEach(g => g.dispose()); mats.forEach(m => { if ('map' in m) (m.map as THREE.Texture | null)?.dispose(); m.dispose(); });
    this.renderer.dispose();
  }
}
