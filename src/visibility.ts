import * as THREE from 'three';
import { EXIT_TUNNEL_LENGTH } from './world';

export const VISIBILITY_START = 28;
export const VISIBILITY_END = 48;
// Distance determines visibility; these caps only bound pathological branches.
export const MAX_PORTAL_DEPTH = 8;
export const MAX_PORTAL_PASSES = 32;
export const visibilityRange = { value: new THREE.Vector2(VISIBILITY_START, VISIBILITY_END) };
export function tunnelVisibility(z: number) {
  return Math.max(0, Math.min(EXIT_TUNNEL_LENGTH, z));
}

/** Fade toward black in linear light, without adding a colored fog layer. */
export function withDistanceFade<T extends THREE.Material>(material: T, range = visibilityRange): T {
  const compile = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    compile(shader, renderer);
    if (range) shader.uniforms.visibilityRange = range;
    shader.vertexShader = 'varying vec3 visibilityPosition;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
      visibilityPosition = mvPosition.xyz;`);
    shader.fragmentShader = `${range ? 'uniform vec2 visibilityRange;' : ''} varying vec3 visibilityPosition;\n` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <tonemapping_fragment>', `
      gl_FragColor.rgb *= 1. - smoothstep(${range ? 'visibilityRange.x, visibilityRange.y' : `${VISIBILITY_START.toFixed(1)}, ${VISIBILITY_END.toFixed(1)}`}, length(visibilityPosition));
      #include <tonemapping_fragment>`);
  };
  material.customProgramCacheKey = () => `${key}:distance-fade${range ? ':variable' : ''}`;
  return material;
}
