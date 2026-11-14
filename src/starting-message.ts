import * as THREE from 'three';
import { EYE_HEIGHT, ROOMS } from './world';
import type { RoomVisual } from './room-visual';
import messageSvg from './assets/starting-message.svg?raw';
import { createMarkerInk, markerInkGLSL } from './marker-ink';

const MESSAGE_SCALE = 4;

/** Black marker on the starting wall, under the same relief and light as its symbols. */
export function createStartingMessage(room: RoomVisual, maxTextureSize: number) {
  const wall = room.walls[2], frame = wall.solid.parent!;
  // Keep the ink fixed above the square pedestal when the player's spawn changes.
  const pedestal = ROOMS.A.pedestals.find(p => p.controls === 'A')!;
  const center = frame.worldToLocal(new THREE.Vector3(pedestal.x, EYE_HEIGHT, frame.position.z));
  const material = (wall.solid.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>).material;
  const { texture, width, height } = createMarkerInk(messageSvg, maxTextureSize);
  const compile = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    compile(shader, renderer); shader.uniforms.startingMessageInk = { value: texture };
    shader.vertexShader = 'varying vec3 startingMessagePosition;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n startingMessagePosition = position;');
    shader.fragmentShader = 'uniform sampler2D startingMessageInk; varying vec3 startingMessagePosition;\n' + markerInkGLSL + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      vec2 messageUV = (startingMessagePosition.xy - vec2(${center.x.toFixed(6)}, ${center.y.toFixed(6)})) / vec2(${(width * MESSAGE_SCALE).toFixed(6)}, ${(height * MESSAGE_SCALE).toFixed(6)}) + .5;
      float messageInk = markerInk(startingMessageInk, messageUV, vec2(${texture.image.width.toFixed(1)}, ${texture.image.height.toFixed(1)})) * step(-.0001, startingMessagePosition.z);
      diffuseColor.rgb *= mix(1., .012, messageInk);`);
  };
  material.customProgramCacheKey = () => `${key}:starting-message:distance-and-coverage`;
  return texture;
}
