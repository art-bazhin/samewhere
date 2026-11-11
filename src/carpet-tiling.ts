import { MeshStandardMaterial, ShaderChunk } from 'three';

/** Stable quarter-turns in material UV space. */
export function withCarpetTiling(material: MeshStandardMaterial) {
  const before = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    before(shader, renderer);
    shader.fragmentShader = `
      mat2 carpetRotation(vec2 cell) {
        vec3 hash = fract(vec3(cell.xyx) * .1031);
        hash += dot(hash, hash.yzx + 33.33);
        float turn = floor(fract((hash.x + hash.y) * hash.z) * 4.);
        if (turn < 1.) return mat2(1., 0., 0., 1.);
        if (turn < 2.) return mat2(0., 1., -1., 0.);
        if (turn < 3.) return mat2(-1., 0., 0., -1.);
        return mat2(0., -1., 1., 0.);
      }
      vec4 carpetSample(sampler2D image, vec2 uv, bool normalMap) {
        vec2 dx = dFdx(uv), dy = dFdy(uv);
        mat2 rotation = carpetRotation(floor(uv));
        vec4 value = textureGrad(image, rotation * (fract(uv) - .5) + .5, rotation * dx, rotation * dy);
        if (normalMap) {
          vec2 normal = value.xy * 2. - 1.;
          value.xy = vec2(dot(rotation[0], normal), dot(rotation[1], normal)) * .5 + .5;
        }
        return value;
      }
      \n` + shader.fragmentShader;
    for (const [chunk, sample, replacement] of [
      ['map_fragment', 'texture2D( map, vMapUv )', 'carpetSample(map, vMapUv, false)'],
      ['normal_fragment_maps', 'texture2D( normalMap, vNormalMapUv )', 'carpetSample(normalMap, vNormalMapUv, true)'],
      ['roughnessmap_fragment', 'texture2D( roughnessMap, vRoughnessMapUv )', 'carpetSample(roughnessMap, vRoughnessMapUv, false)'],
    ] as const) shader.fragmentShader = shader.fragmentShader.replace(`#include <${chunk}>`, ShaderChunk[chunk].replaceAll(sample, replacement));
  };
  material.customProgramCacheKey = () => `${key}:carpet-quarter-turns`;
}
