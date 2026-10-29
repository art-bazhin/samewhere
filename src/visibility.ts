import * as THREE from 'three';

export const VISIBILITY_START = 48;
export const VISIBILITY_END = 68;
// Distance determines visibility; these caps only bound pathological branches.
export const MAX_PORTAL_DEPTH = 10;
export const MAX_PORTAL_PASSES = 32;

/** Fade toward black in linear light, without adding a colored fog layer. */
export function withDistanceFade<T extends THREE.Material>(material: T): T {
  const compile = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    compile(shader, renderer);
    shader.vertexShader = 'varying vec3 visibilityPosition;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
      visibilityPosition = mvPosition.xyz;`);
    shader.fragmentShader = 'varying vec3 visibilityPosition;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <tonemapping_fragment>', `
      gl_FragColor.rgb *= 1. - smoothstep(${VISIBILITY_START.toFixed(1)}, ${VISIBILITY_END.toFixed(1)}, length(visibilityPosition));
      #include <tonemapping_fragment>`);
  };
  material.customProgramCacheKey = () => `${key}:distance-fade`;
  return material;
}
