import * as THREE from 'three';
import { DOOR_WIDTH, pedestalOutline, ROOM_HEIGHT, roomOutline, roomWalls, WALL_THICKNESS, type RoomId } from './world';

// Maximum contact darkening in linear light.
export const WALL_CONTACT_STRENGTH = .1, PEDESTAL_CONTACT_STRENGTH = .1;
const WALL_EDGE_STRENGTH = .025, PEDESTAL_EDGE_STRENGTH = .025;
// Exponential decay in inverse meters; characteristic length = 1 / CONTACT_FALLOFF.
const CONTACT_FALLOFF = 50;

/** The same linear-light contact profile on every architectural surface. */
export function withContactShading(material: THREE.MeshStandardMaterial, distance: string,
  strength = WALL_CONTACT_STRENGTH, uniforms: Record<string, THREE.IUniform> = {}, declarations = '') {
  const before = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    before(shader, renderer); Object.assign(shader.uniforms, uniforms);
    const position = 'varying vec2 contactPosition; varying float contactHeight;\n';
    shader.vertexShader = position + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
      vec3 contactWorld = (modelMatrix * vec4(transformed, 1.)).xyz;
      contactPosition = contactWorld.xz; contactHeight = contactWorld.y;`);
    shader.fragmentShader = position + declarations + '\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <aomap_fragment>', `#include <aomap_fragment>
      float contactDistance = 100.; ${distance}
      float shade = 1. - ${strength} * exp(-max(contactDistance, 0.) * ${CONTACT_FALLOFF.toFixed(1)});
      reflectedLight.indirectDiffuse *= shade; reflectedLight.directDiffuse *= shade;
      reflectedLight.indirectSpecular *= shade; reflectedLight.directSpecular *= shade;
      totalEmissiveRadiance *= shade;
      #ifdef USE_SHEEN
        sheenSpecularIndirect *= shade; sheenSpecularDirect *= shade;
      #endif`);
  };
  material.customProgramCacheKey = () => `${key}:contacts:${strength}:${CONTACT_FALLOFF}:${distance}`;
  return material;
}

/** Floor/ceiling distance to actual wall segments, including open passage jambs. */
export function boundaryContactDistance(room: RoomId, floor: boolean, strength = WALL_CONTACT_STRENGTH) {
  // Express the weaker wall profile in the receiving material's strength.
  // Taking the minimum then selects the stronger contact without stacking them
  // or evaluating a second exponential on the floor.
  const offset = Math.log(strength / WALL_CONTACT_STRENGTH) / CONTACT_FALLOFF;
  const coordinate = (value: number) => value.toFixed(6);
  const walls = roomWalls(room).map(wall => {
    const { center, normal, width, portal } = wall;
    const opening = floor && portal !== null ? `
      if (contactOpenings[${portal}] != 0) {
        float sideGap = max(max(${DOOR_WIDTH / 2} - abs(lateral), abs(lateral) - ${coordinate(width / 2)}), 0.);
        squared = depth * depth + sideGap * sideGap;
        float jambGap = depth - clamp(depth, 0., ${(WALL_THICKNESS / 2).toFixed(6)});
        float jambSide = abs(lateral) - ${DOOR_WIDTH / 2};
        squared = min(squared, jambSide * jambSide + jambGap * jambGap);
      }` : '';
    return `{
      vec2 local = contactPosition - vec2(${coordinate(center.x)}, ${coordinate(center.z)});
      float depth = dot(local, vec2(${coordinate(normal.x)}, ${coordinate(normal.z)}));
      float lateral = dot(local, vec2(${coordinate(-normal.z)}, ${coordinate(normal.x)}));
      if (abs(depth) < 1. && abs(lateral) < ${coordinate(width / 2 + 1)}) {
        float gap = max(abs(lateral) - ${coordinate(width / 2)}, 0.);
        float squared = depth * depth + gap * gap; ${opening}
        wallContactSquared = min(wallContactSquared, squared);
      }
    }`;
  }).join('\n');
  return `float wallContactSquared = 10000.; ${walls}
    contactDistance = min(contactDistance, sqrt(wallContactSquared) + ${offset.toFixed(9)});`;
}

export function ceilingWithContacts(base: THREE.MeshStandardMaterial, room: RoomId) {
  const material = base.clone();
  // Material.clone does not retain custom shader hooks (portal coverage/fade).
  material.onBeforeCompile = base.onBeforeCompile.bind(base);
  const key = base.customProgramCacheKey(); material.customProgramCacheKey = () => key;
  return withContactShading(material, boundaryContactDistance(room, false));
}

export const WALL_HEIGHT_CONTACT = `contactDistance = min(max(contactHeight, 0.), max(${ROOM_HEIGHT.toFixed(6)} - contactHeight, 0.));`;

/** Distances along a wall to its two inward-facing room corners. Interpolating
 * each end separately keeps the profile exact on large wall triangles. */
export function wallCornerDistances(geometry: THREE.BufferGeometry, room: RoomId, side: number, matrix = new THREE.Matrix4()) {
  const outline = roomOutline(room), wall = roomWalls(room)[side], count = outline.length;
  const area = outline.reduce((sum, p, i) => sum + p.x * outline[(i + 1) % count].z - outline[(i + 1) % count].x * p.z, 0);
  const inward = (i: number) => {
    const a = outline[(i + count - 1) % count], b = outline[i], c = outline[(i + 1) % count];
    return ((b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x)) * area > .000001;
  };
  const start = inward(side), end = inward((side + 1) % count);
  const position = geometry.getAttribute('position'), distances = new THREE.Float32BufferAttribute(position.count * 2, 2), point = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    point.fromBufferAttribute(position, i).applyMatrix4(matrix);
    const along = ((point.x - wall.a.x) * (wall.b.x - wall.a.x) + (point.z - wall.a.z) * (wall.b.z - wall.a.z)) / wall.width;
    distances.setXY(i, start ? along : 1000, end ? wall.width - along : 1000);
  }
  geometry.setAttribute('verticalEdgeDistance', distances); return geometry;
}

/** Only the prism's outer vertical faces receive edge shading. The horizontal
 * top and the round socket lips retain their existing finish. */
export function pedestalEdgeDistances(geometry: THREE.BufferGeometry, controls: RoomId) {
  const outline = pedestalOutline(controls), position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal');
  const distances = new THREE.Float32BufferAttribute(position.count * 2, 2);
  for (let i = 0; i < position.count; i++) {
    distances.setXY(i, 1000, 1000);
    if (Math.abs(normal.getY(i)) > .1) continue;
    const x = position.getX(i), z = position.getZ(i);
    for (let edge = 0; edge < outline.length; edge++) {
      const a = outline[edge], b = outline[(edge + 1) % outline.length], dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
      if ((normal.getX(i) * dz - normal.getZ(i) * dx) / length < .9999 ||
        Math.abs((x - a.x) * dz - (z - a.z) * dx) / length > .00001) continue;
      const along = ((x - a.x) * dx + (z - a.z) * dz) / length;
      if (along < -.00001 || along > length + .00001) continue;
      distances.setXY(i, along, length - along); break;
    }
  }
  geometry.setAttribute('verticalEdgeDistance', distances); return geometry;
}

function withVerticalContacts(material: THREE.MeshStandardMaterial, distance: string, strength: number, edgeStrength: number) {
  const cornerOffset = Math.log(strength / edgeStrength) / CONTACT_FALLOFF;
  withContactShading(material, `${distance}
    contactDistance = min(contactDistance, max(min(contactCornerDistance.x, contactCornerDistance.y), 0.) + ${cornerOffset.toFixed(9)});`,
  strength, {}, 'varying vec2 contactCornerDistance;');
  const before = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    before(shader, renderer);
    shader.vertexShader = 'attribute vec2 verticalEdgeDistance; varying vec2 contactCornerDistance;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n contactCornerDistance = verticalEdgeDistance;');
  };
  return material;
}

export function withWallContacts(material: THREE.MeshStandardMaterial) {
  return withVerticalContacts(material, WALL_HEIGHT_CONTACT, WALL_CONTACT_STRENGTH, WALL_EDGE_STRENGTH);
}

export function withPedestalContacts(material: THREE.MeshStandardMaterial) {
  return withVerticalContacts(material, 'contactDistance = max(contactHeight, 0.);', PEDESTAL_CONTACT_STRENGTH, PEDESTAL_EDGE_STRENGTH);
}
