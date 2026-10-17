import * as THREE from 'three';
import { RoomShadows } from './shadows';
import { CEILING_LIGHT, SPOT_LIGHT_SHARE } from './lighting';
import { floorWithContacts, surfaceUV, type MaterialSet } from './materials';
import { offsetOutline } from './geometry';
import { CEILING_TILE_SIZE, DOOR_HEIGHT, DOOR_WIDTH, PEDESTAL_HEIGHT, pedestalOutline, portalDistance, portalPosition, ROOM_HEIGHT, ROOMS, roomOutline, roomWalls, socketPosition, WALL_THICKNESS, wallAngle, wallNormal, type RoomId, type SocketRef, type Vec2 } from './world';

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

export interface Portal { side: number; mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>; to: SocketRef | null; transform: THREE.Matrix4; normal: Vec2; center: Vec2; distance: number; receivingDistance: number }
export interface SocketVisual { ref: SocketRef; hit: THREE.Mesh; ball: THREE.Mesh }
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
  const bevel = .002, curveSegments = 24;
  const centers = Array.from({ length: sides }, (_, side) => socketPosition(controls, side));
  for (let side = 0; side < sides; side++) {
    const p = centers[side], hole = new THREE.Path();
    hole.absarc(p.x, -p.z, SOCKET_OPENING, 0, Math.PI * 2, false);
    shape.holes.push(hole);
  }
  // Keep a short vertical lip above each recessed bowl, with no gap between them.
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: PEDESTAL_HEIGHT + .006 - bevel * 2, bevelEnabled: true,
    bevelThickness: bevel, bevelSize: bevel, bevelOffset: -bevel, bevelSegments: 2, steps: 1, curveSegments });
  // Round only 2 mm at the edges while retaining the exact floor/top heights.
  geometry.rotateX(-Math.PI / 2); geometry.translate(0, -.006 + bevel, 0);
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
    const ball = new THREE.Mesh(sphere, materials.red); ball.name = 'socket-ball'; ball.position.y = BALL_RADIUS - SOCKET_DEPTH - SOCKET_RECESS; ball.castShadow = ball.receiveShadow = true; socket.add(ball);
    const ref = { room: controls, side };
    hit.userData.socket = ref; ball.userData.socket = ref;
    visuals.push({ ref, hit, ball });
  }
}

export function createRoom(id: RoomId, materials: MaterialSet, optimizations: THREE.IUniform<boolean>, environment?: THREE.Texture): RoomVisual {
  const definition = ROOMS[id], scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.background);
  scene.environment = environment ?? null; scene.environmentIntensity = .2;
  scene.add(new THREE.HemisphereLight(0xfff8df, 0xc2a568, .5), new THREE.AmbientLight(0xfff6dd, .04));
  const shadowLights: THREE.SpotLight[] = [];
  for (const { x, z } of definition.pedestals) {
    const light = new THREE.SpotLight(CEILING_LIGHT.color, CEILING_LIGHT.intensity * SPOT_LIGHT_SHARE, CEILING_LIGHT.distance, CEILING_LIGHT.angle, CEILING_LIGHT.penumbra, 2);
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
    threshold.name = 'threshold';
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

