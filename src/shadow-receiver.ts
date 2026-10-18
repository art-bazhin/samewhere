import * as THREE from 'three';

/** Compare every PCF tap against the receiver plane at that shadow texel. */
export function withReceiverPlaneShadows(material: THREE.MeshStandardMaterial) {
  const before = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey();
  const chunk = THREE.ShaderChunk.shadowmap_pars_fragment;
  const start = chunk.indexOf('float getShadow('), end = chunk.indexOf('vec2 cubeToUV(', start);
  if (start < 0 || end < 0) throw new Error('Unsupported Three.js shadow filter');
  const filter = chunk.slice(start, end)
    .replace('float getShadow(', 'float getReceiverPlaneShadow(')
    .replace('vec4 shadowCoord )', 'vec4 shadowCoord, vec2 receiverSlope )')
    .replace(/texture2DCompare\( shadowMap, ([\s\S]*?), shadowCoord.z \)/g,
      'receiverPlaneCompare( shadowMap, $1, shadowCoord.xyz, receiverSlope, shadowMapSize )');
  material.onBeforeCompile = (shader, renderer) => {
    before(shader, renderer);
    const varying = `#if defined(USE_SHADOWMAP) && NUM_SPOT_LIGHT_SHADOWS > 0
      varying vec2 receiverSlopes[NUM_SPOT_LIGHT_SHADOWS];
      #endif\n`;
    shader.vertexShader = varying + shader.vertexShader;
    // A projected planar face has a constant depth slope in shadow UV space.
    // Derive it from geometric tangents per vertex, avoiding noisy fragment
    // differences when the face fills the screen or the view is edge-on.
    shader.vertexShader = shader.vertexShader.replace('#include <shadowmap_vertex>', `${THREE.ShaderChunk.shadowmap_vertex}
      #if defined(USE_SHADOWMAP) && NUM_SPOT_LIGHT_SHADOWS > 0
        vec3 receiverU = abs(shadowWorldNormal.x) > abs(shadowWorldNormal.z)
          ? vec3(-shadowWorldNormal.y, shadowWorldNormal.x, 0.) : vec3(0., -shadowWorldNormal.z, shadowWorldNormal.y);
        vec3 receiverV = cross(shadowWorldNormal, receiverU);
        #pragma unroll_loop_start
        for ( int i = 0; i < NUM_SPOT_LIGHT_SHADOWS; i ++ ) {
          {
            vec4 u = spotLightMatrix[ i ] * vec4(receiverU, 0.);
            vec4 v = spotLightMatrix[ i ] * vec4(receiverV, 0.);
            vec3 receiver = vSpotLightCoord[ i ].xyz / vSpotLightCoord[ i ].w;
            vec3 plane = cross(u.xyz - receiver * u.w, v.xyz - receiver * v.w);
            receiverSlopes[ i ] = abs(plane.z) > 1.e-10 ? -plane.xy / plane.z : vec2(0.);
          }
        }
        #pragma unroll_loop_end
      #endif`);
    shader.fragmentShader = varying + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <shadowmap_pars_fragment>', `#include <shadowmap_pars_fragment>
      #if defined(USE_SHADOWMAP) && NUM_SPOT_LIGHT_SHADOWS > 0
        float receiverPlaneCompare(sampler2D depths, vec2 uv, vec3 receiver, vec2 slope, vec2 size) {
          // Packed depth maps use nearest sampling. Correct for the actual texel
          // center, including the fractional offset of the receiving fragment.
          vec2 center = (floor(uv * size) + .5) / size;
          return texture2DCompare(depths, uv, receiver.z + dot(slope, center - receiver.xy));
        }
        ${filter}
      #endif`);
    shader.fragmentShader = shader.fragmentShader.replace(
      /getShadow\( spotShadowMap\[ i \], ([^;]+), vSpotLightCoord\[ i \] \)/,
      'getReceiverPlaneShadow( spotShadowMap[ i ], $1, vSpotLightCoord[ i ], receiverSlopes[ i ] )',
    );
  };
  material.customProgramCacheKey = () => `${key}:receiver-plane-shadows`;
}
