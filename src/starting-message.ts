import * as THREE from 'three';
import { EYE_HEIGHT, ROOMS } from './world';
import type { RoomVisual } from './room-visual';
import messageSvg from './assets/starting-message.svg?raw';
import { inkDistanceField } from './ink-distance-field';

const MESSAGE_SCALE = 4;

function messageTexture(maxTextureSize: number) {
  const svg = new DOMParser().parseFromString(messageSvg, 'image/svg+xml').documentElement;
  const [, , width, height] = svg.getAttribute('viewBox')!.split(/\s+/).map(Number);
  const canvas = document.createElement('canvas');
  canvas.width = Math.min(4096, maxTextureSize);
  // Exact 2:1 mip reductions preserve average ink coverage at every distance.
  canvas.height = THREE.MathUtils.ceilPowerOfTwo(Math.ceil(canvas.width * height / width));
  const context = canvas.getContext('2d')!;
  context.scale(canvas.width / width, canvas.height / height);
  context.fillStyle = '#fff';
  context.fill(new Path2D(svg.querySelector('path')!.getAttribute('d')!), 'evenodd');
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const distances = inkDistanceField(pixels, canvas.width, canvas.height), data = new Uint8Array(distances.length * 2);
  // Distance reconstructs enlarged edges; averaged coverage preserves thin ink when reduced.
  for (let i = 0; i < distances.length; i++) { data[i * 2] = distances[i]; data[i * 2 + 1] = pixels[i * 4 + 3]; }
  const texture = new THREE.DataTexture(data, canvas.width, canvas.height, THREE.RGFormat);
  texture.flipY = true; texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true; texture.needsUpdate = true;
  // SVG dimensions are in millimeters, calibrated against the original A5 scan.
  return { texture, width: parseFloat(svg.getAttribute('width')!) / 1000,
    height: parseFloat(svg.getAttribute('height')!) / 1000 };
}

/** Black marker on the starting wall, under the same relief and light as its symbols. */
export function createStartingMessage(room: RoomVisual, maxTextureSize: number) {
  const wall = room.walls[2], frame = wall.solid.parent!;
  // Keep the ink fixed above the square pedestal when the player's spawn changes.
  const pedestal = ROOMS.A.pedestals.find(p => p.controls === 'A')!;
  const center = frame.worldToLocal(new THREE.Vector3(pedestal.x, EYE_HEIGHT, frame.position.z));
  const material = (wall.solid.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>).material;
  const { texture, width, height } = messageTexture(maxTextureSize);
  const compile = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    compile(shader, renderer); shader.uniforms.startingMessageInk = { value: texture };
    shader.vertexShader = 'varying vec3 startingMessagePosition;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n startingMessagePosition = position;');
    shader.fragmentShader = 'uniform sampler2D startingMessageInk; varying vec3 startingMessagePosition;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      vec2 messageUV = (startingMessagePosition.xy - vec2(${center.x.toFixed(6)}, ${center.y.toFixed(6)})) / vec2(${(width * MESSAGE_SCALE).toFixed(6)}, ${(height * MESSAGE_SCALE).toFixed(6)}) + .5;
      vec2 messageSample = texture2D(startingMessageInk, messageUV).rg;
      float messageDistance = messageSample.r;
      float messageAA = max(.5 * fwidth(messageDistance), 1. / 255.);
      vec2 messageTexels = vec2(${texture.image.width.toFixed(1)}, ${texture.image.height.toFixed(1)});
      float messageFootprint = max(length(dFdx(messageUV) * messageTexels), length(dFdy(messageUV) * messageTexels));
      vec2 messagePixel = max(fwidth(messageUV), vec2(.000001));
      vec2 messageBounds = clamp((1. - messageUV) / messagePixel + .5, 0., 1.) - clamp(-messageUV / messagePixel + .5, 0., 1.);
      float messageInk = mix(smoothstep(.5 - messageAA, .5 + messageAA, messageDistance), messageSample.g, smoothstep(1., 2., messageFootprint))
        * messageBounds.x * messageBounds.y
        * step(-.0001, startingMessagePosition.z);
      diffuseColor.rgb *= mix(1., .012, messageInk);`);
  };
  material.customProgramCacheKey = () => `${key}:starting-message:distance-and-coverage`;
  return texture;
}
