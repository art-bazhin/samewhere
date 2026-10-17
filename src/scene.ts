import * as THREE from 'three';
import { GpuTiming } from './gpu-timing';
import { LightTransfer } from './light-transfer';
import { createMaterials, optimizeLighting } from './materials';
import { MAX_PORTAL_DEPTH as MAX_DEPTH, MAX_PORTAL_PASSES as MAX_PASSES, VISIBILITY_END } from './visibility';
import { ballAt, destination, DOOR_WIDTH, EYE_HEIGHT, Game, portalAngle, portalDistance, portalPosition, ROOM_IDS, ROOMS, roomWalls, type RoomId, type SocketRef, type Vec2 } from './world';
import { createRoom, type RoomVisual, type Portal, type SocketVisual } from './room-visual';
import { preparePortalSurfaces } from './portal-surfaces';

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
  private ballEnvironment: THREE.WebGLRenderTarget | null = null;
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
    this.rooms = Object.fromEntries(ROOM_IDS.map(id => [id, createRoom(id, this.assets.materials, this.assets.optimizations, this.assets.environment.texture)])) as Record<RoomId, RoomVisual>;
    this.lightTransfer = new LightTransfer(this.rooms);
    for (const room of Object.values(this.rooms)) preparePortalSurfaces(room);
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
      this.render(); this.prepareBallReflections(); this.compiling = true;
      const previousTarget = this.renderer.getRenderTarget();
      try {
        // Main views use sRGB output; portal buffers use linear output.
        for (const target of [null, this.targets[0]]) {
          this.renderer.setRenderTarget(target);
          for (const id of ROOM_IDS) await this.renderer.compileAsync(this.rooms[id].scene, this.camera);
        }
        await this.prepareRooms();
      } finally { this.renderer.setRenderTarget(previousTarget); this.compiling = false; }
      // Entry becomes available only after a complete, final-lit main view.
      this.render();
    });
  }
  private prepareBallReflections() {
    const room = this.rooms.A, source = room.sockets.find(socket => socket.ball.visible) ?? room.sockets[0];
    // Capture the shaded saucer beneath the ball, rather than the lit concrete
    // at the pedestal's center, which produces a bright lower reflection rim.
    const position = source.ball.getWorldPosition(new THREE.Vector3());
    const panels = room.scene.children.filter(object => object.name === 'ceiling-lamp');
    const overhead = panels.reduce((nearest, panel) =>
      panel.position.distanceToSquared(position) < nearest.position.distanceToSquared(position) ? panel : nearest);
    // This shared probe cannot place other fixtures correctly for every socket.
    // Capture only the overhead diffuser; all lights still illuminate the room.
    const hidden = [...room.sockets.map(socket => socket.ball), ...room.portals.map(portal => portal.mesh),
      ...panels.filter(panel => panel !== overhead)];
    const visibility = hidden.map(object => object.visible), clipping = this.renderer.clippingPlanes;
    const lamp = this.assets.materials.lamp, color = lamp.color.clone(), generator = new THREE.PMREMGenerator(this.renderer);
    const surfaces = new Set<THREE.MeshStandardMaterial>();
    room.scene.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) if (material instanceof THREE.MeshStandardMaterial) surfaces.add(material);
    });
    const finishes = [...surfaces].map(material => ({ material, color: material.color.clone(), emissive: material.emissive.clone() }));
    try {
      // Capture the real textured, lit room once, without the balls themselves
      // or screen-projected portal images. Bright diffusers need HDR radiance
      // to produce a white reflection on a dielectric surface with low F0.
      for (const object of hidden) object.visible = false;
      // Keep the HDR lamps crisp, but prevent broad architectural reflections
      // from washing out the resin's saturated color near the pedestal.
      for (const { material } of finishes) { material.color.multiplyScalar(.28); material.emissive.multiplyScalar(.28); }
      this.renderer.clippingPlanes = []; lamp.color.multiplyScalar(14); this.lightTransfer.bind('A');
      this.ballEnvironment = generator.fromScene(room.scene, 0, .001, 30, { size: 256, position });
      for (const material of [this.assets.materials.red, this.assets.materials.blue]) {
        material.envMap = this.ballEnvironment.texture; material.needsUpdate = true;
      }
    } finally {
      hidden.forEach((object, index) => { object.visible = visibility[index]; });
      lamp.color.copy(color); this.renderer.clippingPlanes = clipping;
      for (const { material, color, emissive } of finishes) { material.color.copy(color); material.emissive.copy(emissive); }
      this.lightTransfer.bind(this.game.player.room); generator.dispose();
    }
  }
  private async prepareRooms() {
    // Match the portal framebuffer's actual sample count. A single-sample
    // texture does not warm the driver's multisampled linear-light pipeline.
    const target = new THREE.WebGLRenderTarget(64, 64, { samples: this.portalSamples, resolveDepthBuffer: false }), camera = this.camera.clone();
    camera.position.set(0, EYE_HEIGHT, 0); camera.updateMatrixWorld(true);
    try {
      for (const buffer of this.targets) { this.renderer.setRenderTarget(buffer); this.renderer.clear(); }
      for (const id of ROOM_IDS) {
        const room = this.rooms[id];
        this.clipPlane.setComponents(0, 1, 0, 1);
        this.lightTransfer.bind(id);
        for (const buffer of this.lightTransfer.fields[id].buffers) this.renderer.initTexture(buffer.texture);
        this.renderer.initTexture(this.lightTransfer.fields[id].panel);
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
        // Exercise updating an already sampled lightmap during loading as well.
        for (const buffer of this.lightTransfer.fields[id].buffers) {
          buffer.texture.needsUpdate = true; this.renderer.initTexture(buffer.texture);
        }
        // A non-preserved canvas loses the rest of its drawing buffer when a
        // 64x64 warmup is presented. Restore the complete normal view in this
        // same task, before yielding to the compositor or the loading UI.
        this.renderFrame();
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
        room.contactOpenings.value[side] = Number(active);
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
        const occupied = Number(!!ball);
        if (socket.occupied.getX(0) !== occupied) {
          socket.occupied.array.fill(occupied); socket.occupied.needsUpdate = true;
        }
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
    this.renderFrame();
  }
  private renderFrame() {
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
    this.assets.environment.dispose();
    this.ballEnvironment?.dispose();
    this.renderer.dispose();
  }
}
