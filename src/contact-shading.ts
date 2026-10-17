import * as THREE from 'three';
import { DOOR_WIDTH, ROOM_HEIGHT, roomWalls, WALL_THICKNESS, type RoomId } from './world';

// Subtle contact shading, with one shared 5.6 cm falloff.
const CONTACT_STRENGTH = .15, CONTACT_FALLOFF = 18;

/** The same linear-light contact profile on every architectural surface. */
export function withContactShading(material: THREE.MeshStandardMaterial, distance: string,
  uniforms: Record<string, THREE.IUniform> = {}, declarations = '') {
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
      float shade = 1. - ${CONTACT_STRENGTH} * exp(-max(contactDistance, 0.) * ${CONTACT_FALLOFF.toFixed(1)});
      reflectedLight.indirectDiffuse *= shade; reflectedLight.directDiffuse *= shade;
      reflectedLight.indirectSpecular *= shade; reflectedLight.directSpecular *= shade;
      totalEmissiveRadiance *= shade;
      #ifdef USE_SHEEN
        sheenSpecularIndirect *= shade; sheenSpecularDirect *= shade;
      #endif`);
  };
  material.customProgramCacheKey = () => `${key}:contacts:${CONTACT_STRENGTH}:${CONTACT_FALLOFF}:${distance}`;
  return material;
}

/** Floor/ceiling distance to actual wall segments, including open passage jambs. */
export function boundaryContactDistance(room: RoomId, floor: boolean) {
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
    contactDistance = min(contactDistance, sqrt(wallContactSquared));`;
}

export function ceilingWithContacts(base: THREE.MeshStandardMaterial, room: RoomId) {
  const material = base.clone();
  // Material.clone does not retain custom shader hooks (portal coverage/fade).
  material.onBeforeCompile = base.onBeforeCompile.bind(base);
  const key = base.customProgramCacheKey(); material.customProgramCacheKey = () => key;
  return withContactShading(material, boundaryContactDistance(room, false));
}

export const WALL_HEIGHT_CONTACT = `contactDistance = min(max(contactHeight, 0.), max(${ROOM_HEIGHT.toFixed(6)} - contactHeight, 0.));`;
