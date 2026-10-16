import * as THREE from 'three';
import { GpuTiming } from './gpu-timing';
import { RoomShadows } from './shadows';
import { LightTransfer } from './light-transfer';
import { CEILING_LIGHT } from './lighting';
import { createMaterials, floorWithContacts, optimizeLighting, surfaceUV, type MaterialSet } from './materials';
import { MAX_PORTAL_DEPTH as MAX_DEPTH, MAX_PORTAL_PASSES as MAX_PASSES, VISIBILITY_END } from './visibility';
import { offsetOutline } from './geometry';
import { ballAt, CEILING_TILE_SIZE, destination, DOOR_HEIGHT, DOOR_WIDTH, EYE_HEIGHT, Game, PEDESTAL_HEIGHT, pedestalOutline, portalAngle, portalDistance, portalPosition, ROOM_HEIGHT, ROOM_IDS, ROOMS, roomOutline, roomWalls, socketPosition, WALL_THICKNESS, wallAngle, wallNormal, type RoomId, type SocketRef, type Vec2 } from './world';

const PALETTE = { background: 0x000000 };
const plane = new THREE.PlaneGeometry(1, 1);
const BALL_RADIUS = 0.04;
const sphere = new THREE.SphereGeometry(BALL_RADIUS, 24, 16);
const SOCKET_OPENING = 0.055;
const SOCKET_DEPTH = 0.01625;
const SOCKET_RECESS = 0.005;
const socketGeometry = new THREE.CircleGeometry(SOCKET_OPENING, 32);
const socketBowlGeometry = createSocketBowl();

function createSocketBowl() {
  // A rounded dish with a horizontal tangent at both the center and the lip.
  // Its bottom curvature is wider than the ball, so the ball rests at its lowest point.
  const profile = Array.from({ length: 25 }, (_, i) => {
    const t = 1 - i / 24;
    return new THREE.Vector2(SOCKET_OPENING * t, -SOCKET_DEPTH * (1 - t * t) ** 2);
  });
  const geometry = new THREE.LatheGeometry(profile, 48);
  const positions = geometry.getAttribute('position'), normals = geometry.getAttribute('normal');
  const colors = new Float32Array(positions.count * 3), normal = new THREE.Vector3();
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i), z = positions.getZ(i), radius = Math.hypot(x, z);
    const t = Math.min(radius / SOCKET_OPENING, 1), curve = 1 - t * t;
    const slope = 4 * SOCKET_DEPTH / (SOCKET_OPENING * SOCKET_OPENING) * curve;
    normal.set(-slope * x, 1, -slope * z).normalize(); normals.setXYZ(i, normal.x, normal.y, normal.z);
    // Gentle cavity shading fades to the pedestal's exact color at the rim.
    const shade = 1 - .18 * curve * curve; colors.set([shade, shade, shade], i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function box(parent: THREE.Object3D, material: THREE.Material, size: number[], position: number[]) {
  // Project in the parent's coordinates, just like the extruded passage shell.
  // Both wall variants must anchor the wallpaper at floor level.
  const geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
  geometry.translate(position[0], position[1], position[2]);
  const mesh = new THREE.Mesh(surfaceUV(geometry), material); mesh.castShadow = mesh.receiveShadow = true;
  parent.add(mesh); return mesh;
}

function footprintShape(outline: Vec2[]) {
  const shape = new THREE.Shape();
  outline.forEach(({ x, z }, index) => { if (index === 0) shape.moveTo(x, -z); else shape.lineTo(x, -z); });
  shape.closePath(); return shape;
}

interface Portal { side: number; mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>; to: SocketRef | null; transform: THREE.Matrix4; normal: Vec2; center: Vec2; distance: number; receivingDistance: number }
interface SocketVisual { ref: SocketRef; hit: THREE.Mesh; ball: THREE.Mesh }
export interface RoomVisual { scene: THREE.Scene; portals: Portal[]; sockets: SocketVisual[]; blockers: THREE.Object3D[]; pickables: THREE.Object3D[]; walls: { solid: THREE.Group; open: THREE.Group }[]; shadowLights: THREE.SpotLight[]; shadows: RoomShadows }

function portalMaterial() {
  // Keep the aperture rasterizable while the eye is closer than the normal near
  // plane. Restore its actual depth per fragment so foreground objects still occlude it.
  return new THREE.ShaderMaterial({
    uniforms: { image: { value: null }, viewOrigin: { value: new THREE.Vector2() }, imageRect: { value: new THREE.Vector4(0, 0, 1, 1) }, hasImage: { value: false }, mainView: { value: false }, apertureOffset: { value: 0 }, endColor: { value: new THREE.Color(0) } },
    vertexShader: `#include <clipping_planes_pars_vertex>
      varying vec2 portalDepth; uniform bool mainView; uniform float apertureOffset;
      void main() { vec3 aperture = position; aperture.z -= apertureOffset;
        vec4 p = modelViewMatrix * vec4(aperture, 1.); gl_Position = projectionMatrix * p; portalDepth = gl_Position.zw;
        vec4 mvPosition = p;
        #include <clipping_planes_vertex>
        if (mainView) gl_Position.z = 0.;
      }`,
    fragmentShader: `#include <clipping_planes_pars_fragment>
      uniform sampler2D image; uniform vec2 viewOrigin; uniform vec4 imageRect; uniform bool hasImage; uniform bool mainView; uniform vec3 endColor; varying vec2 portalDepth;
      void main() {
        #include <clipping_planes_fragment>
        vec2 uv = (gl_FragCoord.xy + viewOrigin - imageRect.xy) / imageRect.zw;
        vec3 color = hasImage ? texture2D(image, uv).rgb : endColor;
        gl_FragDepth = mainView ? clamp(portalDepth.x / portalDepth.y * .5 + .5, 0., 1.) : gl_FragCoord.z;
        gl_FragColor = vec4(color, 1.);
        #include <colorspace_fragment>
      }`,
    toneMapped: false, clipping: true,
  });
}

function pedestal(parent: THREE.Scene, x: number, z: number, controls: RoomId, visuals: SocketVisual[], blockers: THREE.Object3D[], materials: MaterialSet) {
  const group = new THREE.Group(); group.position.set(x, 0, z); parent.add(group);
  const sides = ROOMS[controls].sides;
  const shape = footprintShape(pedestalOutline(controls));
  const centers = Array.from({ length: sides }, (_, side) => socketPosition(controls, side));
  for (let side = 0; side < sides; side++) {
    const p = centers[side], hole = new THREE.Path();
    hole.absarc(p.x, -p.z, SOCKET_OPENING, 0, Math.PI * 2, false);
    shape.holes.push(hole);
  }
  // Keep a short vertical lip above each recessed bowl, with no gap between them.
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: PEDESTAL_HEIGHT + .006, bevelEnabled: false, steps: 1, curveSegments: 24 });
  geometry.rotateX(-Math.PI / 2); geometry.translate(0, -.006, 0);
  const positions = geometry.getAttribute('position'), normals = geometry.getAttribute('normal');
  for (let i = 0; i < positions.count; i++) {
    const bore = Math.abs(normals.getY(i)) < .1 && centers.some(p => Math.hypot(positions.getX(i) - p.x, positions.getZ(i) - p.z) < SOCKET_OPENING + .001);
    if (bore) positions.setY(i, Math.max(positions.getY(i), PEDESTAL_HEIGHT - SOCKET_RECESS));
  }
  const body = new THREE.Mesh(surfaceUV(geometry), materials.pedestal); body.name = 'pedestal-body';
  body.castShadow = body.receiveShadow = true; group.add(body); blockers.push(body);
  for (let side = 0; side < sides; side++) {
    const p = centers[side], socket = new THREE.Group();
    socket.position.set(p.x, PEDESTAL_HEIGHT, p.z); group.add(socket);
    const bowl = new THREE.Mesh(socketBowlGeometry, materials.socket); bowl.name = 'socket-bowl'; bowl.position.y = -SOCKET_RECESS; bowl.castShadow = bowl.receiveShadow = true; socket.add(bowl); blockers.push(bowl);
    const hit = new THREE.Mesh(socketGeometry, materials.hit); hit.rotation.x = -Math.PI / 2; hit.position.y = 0.001; socket.add(hit);
    const ball = new THREE.Mesh(sphere, materials.red); ball.position.y = BALL_RADIUS - SOCKET_DEPTH - SOCKET_RECESS; ball.castShadow = ball.receiveShadow = true; socket.add(ball);
    const ref = { room: controls, side };
    hit.userData.socket = ref; ball.userData.socket = ref;
    visuals.push({ ref, hit, ball });
  }
}

function createRoom(id: RoomId, materials: MaterialSet, optimizations: THREE.IUniform<boolean>): RoomVisual {
  const definition = ROOMS[id], scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.background);
  scene.add(new THREE.HemisphereLight(0xfff8df, 0xc2a568, 1), new THREE.AmbientLight(0xfff6dd, 0.12));
  const shadowLights: THREE.SpotLight[] = [];
  for (const { x, z } of definition.pedestals) {
    const light = new THREE.SpotLight(CEILING_LIGHT.color, CEILING_LIGHT.intensity, CEILING_LIGHT.distance, CEILING_LIGHT.angle, CEILING_LIGHT.penumbra, 2);
    light.position.set(x, CEILING_LIGHT.height, z); light.target.position.set(x, 0, z);
    light.castShadow = true; light.shadow.mapSize.set(1024, 1024);
    light.shadow.camera.near = 0.1; light.shadow.camera.far = 18;
    light.shadow.bias = -0.00002; light.shadow.normalBias = 0.0015;
    light.shadow.autoUpdate = false; light.shadow.needsUpdate = true;
    scene.add(light, light.target); shadowLights.push(light);
    const frame = new THREE.Mesh(new THREE.PlaneGeometry(CEILING_TILE_SIZE, CEILING_TILE_SIZE), materials.lampFrame); frame.name = 'ceiling-lamp-frame';
    frame.rotation.x = Math.PI / 2; frame.position.set(x, ROOM_HEIGHT - 0.002, z); scene.add(frame);
    const lens = new THREE.Mesh(new THREE.PlaneGeometry(CEILING_TILE_SIZE - .05, CEILING_TILE_SIZE - .05), materials.lamp); lens.name = 'ceiling-lamp';
    lens.rotation.x = Math.PI / 2; lens.position.set(x, ROOM_HEIGHT - 0.004, z); scene.add(lens);
  }
  const outline = roomOutline(id);
  const floorGeometry = new THREE.ShapeGeometry(footprintShape(outline)); floorGeometry.rotateX(-Math.PI / 2); surfaceUV(floorGeometry);
  const floor = new THREE.Mesh(floorGeometry, floorWithContacts(materials.floor, definition.pedestals, optimizations)); floor.name = 'floor'; floor.receiveShadow = true; scene.add(floor);
  // Preserve the footprint orientation. Mirroring it by rotating the other way
  // leaves triangular gaps above a pentagon's walls; render the back face instead.
  const ceilingGeometry = new THREE.ShapeGeometry(footprintShape(offsetOutline(outline, WALL_THICKNESS / 2))); ceilingGeometry.rotateX(-Math.PI / 2); surfaceUV(ceilingGeometry);
  const ceiling = new THREE.Mesh(ceilingGeometry, materials.ceiling); ceiling.name = 'ceiling'; ceiling.position.y = ROOM_HEIGHT; ceiling.receiveShadow = true; scene.add(ceiling);
  const sockets: SocketVisual[] = [], portals: Portal[] = [], blockers: THREE.Object3D[] = [], walls: RoomVisual['walls'] = [];
  const outside = offsetOutline(outline, WALL_THICKNESS);
  for (const [index, boundary] of roomWalls(id).entries()) {
    if (boundary.portal === null) {
      // A mitered shell follows the complete concave footprint without boxes
      // protruding into the inside corners or hidden walls across a junction.
      const shape = footprintShape([boundary.a, boundary.b, outside[(index + 1) % outside.length], outside[index]]);
      const geometry = new THREE.ExtrudeGeometry(shape, { depth: ROOM_HEIGHT, bevelEnabled: false, steps: 1 }); geometry.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(surfaceUV(geometry), materials.wall); mesh.name = 'boundary-wall'; mesh.castShadow = mesh.receiveShadow = true;
      scene.add(mesh); blockers.push(mesh); continue;
    }
    const side = boundary.portal, n = wallNormal(id, side), wall = new THREE.Group();
    const wallWidth = definition.outline ? boundary.width + WALL_THICKNESS * 2 : 2 * (definition.apothem + WALL_THICKNESS) * Math.tan(Math.PI / definition.sides) + .02;
    wall.position.set(boundary.center.x, 0, boundary.center.z); wall.rotation.y = -wallAngle(id, side); scene.add(wall);
    const solid = new THREE.Group(), open = new THREE.Group(); wall.add(solid, open);
    blockers.push(box(solid, materials.wall, [wallWidth, ROOM_HEIGHT, WALL_THICKNESS], [0, ROOM_HEIGHT / 2, -WALL_THICKNESS / 2]));
    const opening = new THREE.Shape();
    opening.moveTo(-wallWidth / 2, 0); opening.lineTo(-DOOR_WIDTH / 2, 0);
    opening.lineTo(-DOOR_WIDTH / 2, DOOR_HEIGHT); opening.lineTo(DOOR_WIDTH / 2, DOOR_HEIGHT);
    opening.lineTo(DOOR_WIDTH / 2, 0); opening.lineTo(wallWidth / 2, 0);
    opening.lineTo(wallWidth / 2, ROOM_HEIGHT); opening.lineTo(-wallWidth / 2, ROOM_HEIGHT); opening.closePath();
    // Each scene owns only its half of an open shared wall. The receiving scene
    // supplies the other half, so reveals never overlap across the portal plane.
    const geometry = new THREE.ExtrudeGeometry(opening, { depth: WALL_THICKNESS / 2, bevelEnabled: false, steps: 1 }); geometry.translate(0, 0, -WALL_THICKNESS / 2);
    const shell = new THREE.Mesh(surfaceUV(geometry), materials.wall); shell.castShadow = shell.receiveShadow = true; open.add(shell); blockers.push(shell);
    const threshold = box(open, floor.material, [DOOR_WIDTH, 0.012, WALL_THICKNESS / 2], [0, -0.006, -WALL_THICKNESS / 4]);
    // Continue the room's carpet coordinates across the rotated doorway.
    wall.updateMatrix();
    const carpetGeometry = surfaceUV(threshold.geometry.clone().applyMatrix4(wall.matrix));
    threshold.geometry.setAttribute('uv', carpetGeometry.getAttribute('uv')); carpetGeometry.dispose();
    threshold.castShadow = false;
    const portal = new THREE.Mesh(plane, portalMaterial()); portal.scale.set(DOOR_WIDTH, DOOR_HEIGHT, 1); portal.position.set(0, DOOR_HEIGHT / 2, -WALL_THICKNESS / 2); wall.add(portal);
    // Establish portal depth first, so hidden PBR surfaces do not shade the whole
    // screen again when the player is standing right in front of a passage.
    portal.renderOrder = -1;
    portals[side] = { side, mesh: portal, to: null, transform: new THREE.Matrix4(), normal: n, center: portalPosition(id, side), distance: portalDistance(id, side), receivingDistance: 0 }; walls[side] = { solid, open };
  }
  for (const p of definition.pedestals) pedestal(scene, p.x, p.z, p.controls, sockets, blockers, materials);
  scene.updateMatrixWorld(true);
  const shadows = new RoomShadows(scene, shadowLights, new Set([...walls.flatMap(w => [w.solid, w.open]), ...sockets.map(s => s.ball)]));
  // Architecture, fixtures and socket positions never move. Visibility and ball
  // color can change without recomputing hundreds of world matrices per view.
  scene.traverse(object => { object.matrixAutoUpdate = false; });
  return { scene, portals, sockets, blockers, pickables: [], walls, shadowLights, shadows };
}

type Rect = { minX: number; minY: number; maxX: number; maxY: number };
const FULL: Rect = { minX: -1, minY: -1, maxX: 1, maxY: 1 };
const TARGET_BLOCK = 128;
const MIN_APERTURE_DISTANCE = 0.0001;
const occluders = Object.fromEntries(ROOM_IDS.map(id => [id, roomWalls(id).map(wall => {
  const dx = (wall.b.x - wall.a.x) / wall.width * DOOR_WIDTH / 2, dz = (wall.b.z - wall.a.z) / wall.width * DOOR_WIDTH / 2;
  return { ...wall, left: { x: wall.center.x - dx, z: wall.center.z - dz }, right: { x: wall.center.x + dx, z: wall.center.z + dz } };
})])) as Record<RoomId, (ReturnType<typeof roomWalls>[number] & { left: Vec2; right: Vec2 })[]>;

function blockedRay(eye: Vec2, target: Vec2, a: Vec2, b: Vec2) {
  const dx = target.x - eye.x, dz = target.z - eye.z, wx = b.x - a.x, wz = b.z - a.z;
  const determinant = dx * wz - dz * wx;
  if (Math.abs(determinant) < 1e-8) return false;
  const ax = a.x - eye.x, az = a.z - eye.z;
  const ray = (ax * wz - az * wx) / determinant, wall = (ax * dz - az * dx) / determinant;
  // Leave grazing corners visible: a conservative test must never remove pixels.
  return ray > .0001 && ray < .9999 && wall > .0001 && wall < .9999;
}
interface PortalView { portal: Portal; rect: Rect; image: THREE.WebGLRenderTarget | null; area: number }
function clipDistance(point: THREE.Vector4, plane: number) {
  switch (plane) {
    case 0: return point.w - 0.00000001;
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
  readonly assets: ReturnType<typeof createMaterials>;
  readonly ready: Promise<void>;
  readonly lightTransfer: LightTransfer;
  targets: THREE.WebGLRenderTarget[] = [];
  cameras = Array.from({ length: MAX_DEPTH + 2 }, () => new THREE.PerspectiveCamera());
  passes = 0;
  width = 1; height = 1; targetWidth = 1; targetHeight = 1;
  readonly portalSamples: number;
  targetAllocations = 0;
  raycaster = new THREE.Raycaster();
  hovered: SocketVisual | null = null;
  drawCalls = 0;
  shadowPixels = 0;
  portalPixels = 0;
  occludedPortals = 0;
  readonly maxPasses = MAX_PASSES;
  readonly visibilityDistance = VISIBILITY_END;
  private readonly center = new THREE.Vector2();
  private readonly bufferSize = new THREE.Vector2();
  private readonly hits: THREE.Intersection[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly translation = new THREE.Matrix4();
  private readonly clipPlane = new THREE.Plane();
  private readonly clipPointsA = Array.from({ length: 12 }, () => new THREE.Vector4());
  private readonly clipPointsB = Array.from({ length: 12 }, () => new THREE.Vector4());
  private readonly views: PortalView[][] = Array.from({ length: MAX_DEPTH + 2 }, () => []);
  private readonly preparationScene = new THREE.Scene();
  private readonly preparationLight = new THREE.SpotLight();
  private readonly preparationTarget = new THREE.WebGLRenderTarget(1, 1);
  private preparationRoom: RoomVisual | null = null;
  private compiling = false;
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
    // Keep a normal projection and depth distribution, even at the portal plane.
    // One shared world-space clip plane is rebound for each recursive scene.
    this.renderer.clippingPlanes = [this.clipPlane];
    this.renderer.info.autoReset = false;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.assets = createMaterials(this.renderer);
    this.rooms = Object.fromEntries(ROOM_IDS.map(id => [id, createRoom(id, this.assets.materials, this.assets.optimizations)])) as Record<RoomId, RoomVisual>;
    this.lightTransfer = new LightTransfer();
    const litMaterials = new Set<THREE.Material>(Object.values(this.assets.materials));
    for (const room of Object.values(this.rooms)) room.scene.traverse(object => {
      if (object instanceof THREE.Mesh) for (const material of Array.isArray(object.material) ? object.material : [object.material]) litMaterials.add(material);
    });
    for (const material of litMaterials) if (material instanceof THREE.MeshStandardMaterial) {
      optimizeLighting(material, this.assets.optimizations); this.lightTransfer.install(material);
    }
    const shadowScenes = new Map(Object.values(this.rooms).map(room => [room.scene, room.shadows]));
    const renderShadows = this.renderer.shadowMap.render.bind(this.renderer.shadowMap);
    // Three's shadow pass accepts a separate scene. Use the prebatched exact
    // casters, while the regular pass and ray picking retain the original meshes.
    this.renderer.shadowMap.render = (lights, scene, camera) => {
      const shadows = scene === this.preparationScene ? this.preparationRoom!.shadows : shadowScenes.get(scene);
      if (!shadows) { renderShadows(lights, scene, camera); return; }
      this.shadowPixels += shadows.beforeRender(lights);
      try { renderShadows(lights, shadows.scene, camera); }
      finally { shadows.afterRender(lights); }
    };
    this.preparationLight.castShadow = true;
    this.preparationScene.add(this.preparationLight, this.preparationLight.target);
    this.resize(); this.sync();
    this.ready = Promise.all([this.assets.ready, this.lightTransfer.ready]).then(async () => {
      // Initialize clipping/shadows, then compile each room's light count while
      // the menu is loading. Shared materials must not be rebound by rendering
      // another scene while compileAsync waits for its programs to finish.
      this.render(); this.compiling = true;
      const previousTarget = this.renderer.getRenderTarget();
      try {
        // Main views use sRGB output; portal buffers use linear output.
        for (const target of [null, this.targets[0]]) {
          this.renderer.setRenderTarget(target);
          for (const id of ROOM_IDS) await this.renderer.compileAsync(this.rooms[id].scene, this.camera);
        }
        await this.prepareRooms();
      } finally { this.renderer.setRenderTarget(previousTarget); this.compiling = false; }
    });
  }
  private async prepareRooms() {
    // Match the portal framebuffer's actual sample count. A single-sample
    // texture does not warm the driver's multisampled linear-light pipeline.
    const target = new THREE.WebGLRenderTarget(64, 64, { samples: this.portalSamples, resolveDepthBuffer: false }), camera = this.camera.clone();
    camera.position.set(0, EYE_HEIGHT, 0); camera.updateMatrixWorld(true);
    this.clipPlane.setComponents(0, 1, 0, 1);
    try {
      for (const buffer of this.targets) { this.renderer.setRenderTarget(buffer); this.renderer.clear(); }
      for (const id of ROOM_IDS) {
        const room = this.rooms[id];
        this.lightTransfer.bind(id);
        for (const buffer of this.lightTransfer.fields[id].buffers) this.renderer.initTexture(buffer.texture);
        this.renderer.setRenderTarget(target);
        // Allocate and calculate every room's shadow maps before enabling play.
        this.renderer.render(room.scene, camera);
        const originals: { object: THREE.Object3D; visible: boolean; culled: boolean }[] = [];
        room.scene.traverse(object => {
          originals.push({ object, visible: object.visible, culled: object.frustumCulled });
          object.visible = true; object.frustumCulled = false;
        });
        try {
          this.lightTransfer.bind(id, true);
          // Upload both wall variants and currently empty sockets too. A first
          // visit or placement must not trigger a geometry/texture upload.
          this.renderer.render(room.scene, camera);
          // compileAsync prepares GLSL programs, but drivers can still defer the
          // framebuffer/MSAA pipeline until its first draw. Exercise the actual
          // sRGB canvas too, rather than only the linear offscreen target.
          this.renderer.setRenderTarget(null);
          this.renderer.setViewport(0, 0, 64, 64); this.renderer.setScissor(0, 0, 64, 64); this.renderer.setScissorTest(true);
          try { this.renderer.render(room.scene, camera); }
          finally { this.renderer.setScissorTest(false); this.renderer.setViewport(0, 0, this.width, this.height); }
        } finally {
          this.lightTransfer.bind(id);
          for (const { object, visible, culled } of originals) { object.visible = visible; object.frustumCulled = culled; }
        }
        // Exercise updating an already sampled volume during loading as well.
        for (const buffer of this.lightTransfer.fields[id].buffers) {
          buffer.texture.needsUpdate = true; this.renderer.initTexture(buffer.texture);
        }
        // Let the loading UI paint and the GPU consume the previous room's work.
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
      // Complete uploads and the initial shadows before play, without a blocking
      // gl.finish/readback on the UI thread.
      const gl = this.renderer.getContext() as WebGL2RenderingContext, fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (fence) {
        gl.flush();
        try {
          let status = gl.clientWaitSync(fence, 0, 0);
          while (status === gl.TIMEOUT_EXPIRED) {
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            status = gl.clientWaitSync(fence, 0, 0);
          }
          if (status === gl.WAIT_FAILED) throw new Error('GPU preparation failed');
        } finally { gl.deleteSync(fence); }
      }
    } finally { target.dispose(); }
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
    const materials = this.assets.materials;
    for (const id of ROOM_IDS) {
      const room = this.rooms[id];
      for (let side = 0; side < ROOMS[id].sides; side++) {
        const portal = room.portals[side];
        portal.to = destination(world, { room: id, side });
        const active = !!portal.to;
        if (portal.to) {
          const from = { room: id, side }, to = portalPosition(portal.to.room, portal.to.side);
          portal.receivingDistance = portalDistance(portal.to.room, portal.to.side);
          portal.transform.makeTranslation(to.x, 0, to.z)
            .multiply(this.matrix.makeRotationY(-portalAngle(from, portal.to)))
            .multiply(this.translation.makeTranslation(-portal.center.x, 0, -portal.center.z));
        }
        room.walls[side].solid.visible = !active; room.walls[side].open.visible = active; room.portals[side].mesh.visible = active;
      }
      for (const socket of room.sockets) {
        const ball = ballAt(world, socket.ref); socket.ball.visible = !!ball;
        if (ball) socket.ball.material = materials[ball.color];
      }
      room.shadows.sync();
      room.pickables.length = 0;
      for (const object of [...room.blockers, ...room.sockets.flatMap(s => [s.hit, s.ball])]) {
        let visible = true;
        for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) if (!parent.visible) { visible = false; break; }
        if (visible) room.pickables.push(object);
      }
    }
    this.lightTransfer.sync(world);
  }
  updateCamera() {
    const p = this.game.player;
    this.camera.position.set(p.x, EYE_HEIGHT, p.z); this.camera.rotation.set(p.pitch, p.yaw, 0, 'YXZ'); this.camera.updateMatrixWorld(true);
  }
  pick(): SocketRef | null {
    this.updateCamera();
    const room = this.rooms[this.game.player.room];
    this.raycaster.setFromCamera(this.center, this.camera); this.raycaster.far = 2.25;
    this.hits.length = 0;
    const hit = this.raycaster.intersectObjects(room.pickables, false, this.hits)[0];
    this.hovered = hit?.object.userData.socket ? room.sockets.find(s => s.ref.room === hit.object.userData.socket.room && s.ref.side === hit.object.userData.socket.side)! : null;
    return this.hovered?.ref ?? null;
  }
  private portalRect(portal: Portal, camera: THREE.PerspectiveCamera, clip: Rect, bounds: Rect): boolean {
    const n = portal.normal;
    const distance = portal.distance - n.x * camera.position.x - n.z * camera.position.z;
    if (distance < -0.025) return false;
    const sideDistance = Math.max(0, Math.abs(-n.z * (camera.position.x - portal.center.x) + n.x * (camera.position.z - portal.center.z)) - DOOR_WIDTH / 2);
    if (Math.hypot(distance, sideDistance) >= VISIBILITY_END) return false;
    // The projection of a plane through the eye is degenerate. From inside the
    // aperture its forward view fills the frame; keep a complete image available.
    const lateral = -n.z * (camera.position.x - portal.center.x) + n.x * (camera.position.z - portal.center.z);
    if (camera === this.camera && distance >= -1e-8 && distance < MIN_APERTURE_DISTANCE && Math.abs(lateral) < DOOR_WIDTH / 2) {
      Object.assign(bounds, clip); return true;
    }
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
    return child;
  }
  private portalOccluded(id: RoomId, portal: Portal, camera: THREE.PerspectiveCamera, incoming?: number) {
    const eye = { x: camera.position.x, z: camera.position.z }, n = portal.normal, center = portal.center;
    const left = { x: center.x + n.z * DOOR_WIDTH / 2, z: center.z - n.x * DOOR_WIDTH / 2 };
    const right = { x: center.x - n.z * DOOR_WIDTH / 2, z: center.z + n.x * DOOR_WIDTH / 2 };
    const blocks = (a: Vec2, b: Vec2) => blockedRay(eye, left, a, b) && blockedRay(eye, right, a, b);
    for (const wall of occluders[id]) {
      if (wall.portal !== null && (wall.portal === portal.side || wall.portal === incoming)) continue;
      // Both horizontal aperture edges must be behind the same floor-to-ceiling
      // wall segment. Open passages contribute only their opaque jambs.
      if (wall.portal !== null && this.rooms[id].portals[wall.portal].to) {
        if (blocks(wall.a, wall.left) || blocks(wall.right, wall.b)) return true;
      } else if (blocks(wall.a, wall.b)) return true;
    }
    return false;
  }
  private renderRoom(id: RoomId, camera: THREE.PerspectiveCamera, depth: number, clip: Rect, target: THREE.WebGLRenderTarget | null, incoming?: number, hops = 0) {
    const room = this.rooms[id];
    const views = this.views[depth]; let count = 0;
    for (const portal of room.portals) {
      if (!portal.to || portal.side === incoming) continue;
      const view = views[count] ??= { portal, rect: { ...FULL }, image: null, area: 0 };
      if (!this.portalRect(portal, camera, clip, view.rect)) continue;
      if (this.portalOccluded(id, portal, camera, incoming)) { this.occludedPortals++; continue; }
      view.portal = portal; view.image = null; view.area = (view.rect.maxX - view.rect.minX) * (view.rect.maxY - view.rect.minY); count++;
    }
    // At most five candidates; sort only the live prefix without allocating arrays.
    for (let i = 1; i < count; i++) {
      const view = views[i]; let j = i;
      while (j > 0 && views[j - 1].area < view.area) { views[j] = views[j - 1]; j--; }
      views[j] = view;
    }
    for (let i = 0; i < count; i++) {
      if (hops >= MAX_DEPTH || this.passes >= MAX_PASSES - 1) break;
      const view = views[i], to = view.portal.to!;
      const image = this.targetAt(this.passes++, view.rect);
      const child = this.childCamera(camera, view.portal, depth + 1);
      // A passage at the eye is already the receiving view. Do not spend a hop
      // on it, or the distant recursion limit visibly jumps at the crossing.
      const distance = view.portal.distance - view.portal.normal.x * camera.position.x - view.portal.normal.z * camera.position.z;
      const atEye = depth === 0 && distance >= -1e-8 && distance < this.camera.near;
      this.renderRoom(to.room, child, depth + 1, view.rect, image, to.side, hops + (atEye ? 0 : 1));
      view.image = image;
    }
    // Shared scenes are rebound AFTER their children finish; each branch has its own target.
    for (const portal of room.portals) {
      const uniforms = portal.mesh.material.uniforms;
      uniforms.hasImage.value = false; uniforms.image.value = null;
      uniforms.mainView.value = depth === 0;
      const distance = portal.distance - portal.normal.x * camera.position.x - portal.normal.z * camera.position.z;
      uniforms.apertureOffset.value = depth === 0 && distance >= -1e-8 ? Math.max(0, MIN_APERTURE_DISTANCE - distance) : 0;
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
    if (incoming === undefined) this.clipPlane.setComponents(0, 1, 0, 1);
    else {
      const normal = room.portals[incoming].normal;
      this.clipPlane.setComponents(-normal.x, 0, -normal.z, room.portals[incoming].distance - 0.00001);
    }
    this.renderer.setRenderTarget(target);
    this.lightTransfer.bind(id);
    this.renderer.render(room.scene, camera);
  }
  private preparePendingShadow() {
    // Visible rooms have already updated their shadows. Prepare at most one
    // remaining map per frame, so walking to a changed room does not defer all
    // its shadow work until the first visible frame.
    for (const id of ROOM_IDS) {
      const room = this.rooms[id], light = room.shadowLights.find(light => light.shadow.needsUpdate);
      if (!light) continue;
      const proxy = this.preparationLight;
      proxy.position.copy(light.position); proxy.target.position.copy(light.target.position);
      proxy.angle = light.angle; proxy.distance = light.distance; proxy.shadow = light.shadow;
      this.preparationRoom = room;
      this.renderer.setRenderTarget(this.preparationTarget);
      try { this.renderer.render(this.preparationScene, this.camera); }
      finally { this.renderer.setRenderTarget(null); this.preparationRoom = null; }
      return;
    }
  }
  render() {
    if (this.compiling) return;
    this.updateCamera(); this.passes = 0; this.portalPixels = 0; this.shadowPixels = 0; this.occludedPortals = 0; this.renderer.info.reset();
    this.gpuTiming.begin();
    try { this.renderRoom(this.game.player.room, this.camera, 0, FULL, null); this.preparePendingShadow(); }
    finally { this.gpuTiming.end(); }
    this.drawCalls = this.renderer.info.render.calls; this.passes++;
  }
  dispose() {
    this.gpuTiming.dispose();
    this.lightTransfer.dispose();
    for (const target of this.targets) target.dispose();
    this.preparationTarget.dispose();
    for (const room of Object.values(this.rooms)) for (const light of room.shadowLights) light.shadow.dispose();
    for (const room of Object.values(this.rooms)) room.shadows.dispose();
    const geometries = new Set<THREE.BufferGeometry>(), mats = new Set<THREE.Material>();
    for (const room of Object.values(this.rooms)) room.scene.traverse(object => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Sprite) {
        if ('geometry' in object) geometries.add(object.geometry);
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) mats.add(material);
      }
    });
    for (const material of Object.values(this.assets.materials)) mats.add(material);
    geometries.forEach(g => g.dispose()); mats.forEach(m => m.dispose());
    this.assets.textures.forEach(texture => texture.dispose());
    this.renderer.dispose();
  }
}
