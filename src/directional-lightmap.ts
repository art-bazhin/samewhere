/** Two RGBA planes: existing irradiance, then its luminance-weighted direction. */
export const LIGHTMAP_CHANNELS = 8;

export const luminance = (r: number, g: number, b: number) => .2126 * r + .7152 * g + .0722 * b;

/** Keep moments additive, so connecting rooms can sum their light before decoding. */
export function addLightDirection(moment: Float32Array, x: number, y: number, z: number, energy: number) {
  const length = Math.hypot(x, y, z);
  if (length <= 1e-10) return;
  const weight = energy / length;
  moment[0] += x * weight; moment[1] += y * weight; moment[2] += z * weight; moment[3] += energy;
}

/** Dominant-direction diffuse approximation, normalized to preserve flat-surface light. */
export const DIRECTIONAL_LIGHTMAP_SHADER = `
vec3 directionalBounce(vec3 irradiance, vec4 moment, vec3 mappedNormal, vec3 baseNormal) {
  #ifdef USE_NORMALMAP
    vec3 direction = mat3(viewMatrix) * moment.xyz;
    float reference = moment.w + dot(baseNormal, direction);
    if (reference > .000001) {
      float response = max(0., moment.w + dot(mappedNormal, direction));
      irradiance *= response / reference;
    }
  #endif
  return irradiance;
}
`;
