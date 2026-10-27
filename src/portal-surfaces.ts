import * as THREE from 'three';
import { WALL_THICKNESS } from './world';
import type { RoomVisual } from './room-visual';

// Continue cut surfaces into the neighboring buffer's MSAA footprint. The
// physical mesh, collision boundary and shadow geometry retain their dimensions.
const PADDING = .05;

export function preparePortalSurfaces(room: RoomVisual) {
  const shells = new Set(room.walls.map(wall => wall.open.getObjectByName('room-wall')));
  room.scene.traverse(object => {
    if (!(object instanceof THREE.Mesh) || !['room-wall', 'boundary-wall'].includes(object.name)) return;
    const geometry = object.geometry, position = geometry.getAttribute('position'), uv = geometry.getAttribute('uv'), lightUv = geometry.getAttribute('transferUv');
    const offset = new THREE.Float32BufferAttribute(position.count * 3, 3);
    const uvOffset = new THREE.Float32BufferAttribute(position.count * 2, 2), lightOffset = new THREE.Float32BufferAttribute(position.count * 2, 2);
    geometry.setAttribute('portalOffset', offset); geometry.setAttribute('portalUvOffset', uvOffset); geometry.setAttribute('portalLightUvOffset', lightOffset);
    const joinedUv = geometry.getAttribute('joinedUv'), joinedOffset = new THREE.Float32BufferAttribute(position.count * 2, 2);
    geometry.setAttribute('portalJoinedUvOffset', joinedOffset);
    if (!shells.has(object)) return;
    const index = geometry.index, count = index?.count ?? position.count;
    for (let i = 0; i < count; i += 3) {
      const vertices = [0, 1, 2].map(k => index ? index.getX(i + k) : i + k);
      const points = vertices.map(v => new THREE.Vector3().fromBufferAttribute(position, v));
      const triangle = new THREE.Triangle(...points), weights = new THREE.Vector3();
      for (const [k, vertex] of vertices.entries()) {
        if (Math.abs(points[k].z + WALL_THICKNESS / 2) > .00001) continue;
        offset.setXYZ(vertex, 0, 0, -PADDING);
        // Extrapolate both UV sets, so the padding does not stretch the visible
        // wallpaper or change the illumination of the original 15 cm reveal.
        triangle.getBarycoord(points[k].clone().add(new THREE.Vector3(0, 0, -PADDING)), weights);
        const attributes = [[uv, uvOffset], [lightUv, lightOffset]];
        if (joinedUv) attributes.push([joinedUv, joinedOffset]);
        for (const [attribute, result] of attributes) {
          const value = new THREE.Vector2();
          vertices.forEach((v, j) => value.addScaledVector(new THREE.Vector2().fromBufferAttribute(attribute, v), weights.getComponent(j)));
          result.setXY(vertex, value.x - attribute.getX(vertex), value.y - attribute.getY(vertex));
        }
      }
    }
  });
}

export function withPortalSurfacePadding(material: THREE.MeshStandardMaterial) {
  const before = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    before(shader, renderer);
    shader.vertexShader = `#define PORTAL_SURFACE_PADDING
      attribute vec3 portalOffset; attribute vec2 portalUvOffset; attribute vec2 portalLightUvOffset;\n` + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n transformed += portalOffset;');
    shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', THREE.ShaderChunk.uv_vertex.replace(/vec3\( (\w+), 1 \)/g, 'vec3( $1 + portalUvOffset, 1 )'));
  };
  material.customProgramCacheKey = () => `${key}:portal-surface-padding`;
}
