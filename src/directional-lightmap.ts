/** Neighbor bounce uses two RGBA planes; local panels append the direct-light gradient. */
export const LIGHTMAP_CHANNELS = 8;
export const PANEL_LIGHTMAP_CHANNELS = 12;

export const luminance = (r: number, g: number, b: number) => .2126 * r + .7152 * g + .0722 * b;

/** Keep moments additive, so connecting rooms can sum their light before decoding. */
export function addLightGradient(moment: Float32Array, gradient: Float64Array, radiance: number, form: number) {
  moment[0] += gradient[0] * radiance; moment[1] += gradient[1] * radiance; moment[2] += gradient[2] * radiance;
  moment[3] += form * radiance;
}

/** First-order irradiance response; a flat normal preserves the original energy. */
export const DIRECTIONAL_LIGHTMAP_SHADER = `
uniform float normalResponseCurve;
// Ease toward the existing 10-degree relief without exceeding it. Angles are
// measured from the surface; preserve the original response at/below 10 degrees.
vec3 reliefLightGradient(vec3 gradient, vec3 baseNormal, float reference) {
  float facing = clamp(reference / max(length(gradient), .000001), 0., 1.);
  if (facing <= .17364818 || normalResponseCurve <= 1.) return gradient;
  float progress = clamp(sqrt(max(0., 1. - facing * facing)) / facing * .17632698, 0., 1.);
  float gain = progress > .0001 ? (1. - pow(1. - progress, normalResponseCurve)) / progress : normalResponseCurve;
  vec3 axial = baseNormal * dot(baseNormal, gradient);
  return axial + (gradient - axial) * gain;
}
vec3 directionalBounce(vec3 irradiance, vec4 moment, vec3 mappedNormal, vec3 baseNormal) {
  #ifdef USE_NORMALMAP
    vec3 gradient = mat3(viewMatrix) * moment.xyz;
    float reference = moment.w;
    if (reference > .000001) {
      gradient = reliefLightGradient(gradient, baseNormal, reference);
      float response = max(0., reference + dot(mappedNormal - baseNormal, gradient));
      irradiance *= response / reference;
    }
  #endif
  return irradiance;
}
`;
