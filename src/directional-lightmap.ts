/** Two RGBA planes: existing irradiance, then its angular gradient and luminance. */
export const LIGHTMAP_CHANNELS = 8;

export const luminance = (r: number, g: number, b: number) => .2126 * r + .7152 * g + .0722 * b;

/** Keep moments additive, so connecting rooms can sum their light before decoding. */
export function addLightGradient(moment: Float32Array, gradient: Float64Array, radiance: number, form: number) {
  moment[0] += gradient[0] * radiance; moment[1] += gradient[1] * radiance; moment[2] += gradient[2] * radiance;
  moment[3] += form * radiance;
}

/** First-order irradiance response; a flat normal preserves the original energy. */
export const DIRECTIONAL_LIGHTMAP_SHADER = `
vec3 directionalBounce(vec3 irradiance, vec4 moment, vec3 mappedNormal, vec3 baseNormal) {
  #ifdef USE_NORMALMAP
    vec3 gradient = mat3(viewMatrix) * moment.xyz;
    float reference = moment.w;
    if (reference > .000001) {
      float response = max(0., reference + dot(mappedNormal - baseNormal, gradient));
      irradiance *= response / reference;
    }
  #endif
  return irradiance;
}
`;
