import { DIRECT_RELIEF, NORMAL_RESPONSE_CURVE } from './lighting';

/** Neighbor bounce uses two RGBA planes; local panels append the direct-light gradient. */
export const LIGHTMAP_CHANNELS = 8;
export const PANEL_LIGHTMAP_CHANNELS = 12;

export const luminance = (r: number, g: number, b: number) => .2126 * r + .7152 * g + .0722 * b;

/** Keep moments additive, so connecting rooms can sum their light before decoding. */
export function addLightGradient(moment: Float32Array, gradient: Float64Array, radiance: number, form: number) {
  moment[0] += gradient[0] * radiance; moment[1] += gradient[1] * radiance; moment[2] += gradient[2] * radiance;
  moment[3] += form * radiance;
}

export const directReliefDistanceGain = (distance2: number) => Math.max(1, Math.min(DIRECT_RELIEF.maxGain, distance2 / DIRECT_RELIEF.referenceDistance ** 2));

/** Apply source-dependent relief before summing lamps, while keeping their
 * geometric irradiance in the separate reference channel unchanged. */
export function addDirectLightGradient(moment: Float64Array, x: number, y: number, z: number,
  normal: { x: number; y: number; z: number }, slope: number, distance2: number) {
  const reference = normal.x * x + normal.y * y + normal.z * z;
  const facing = Math.max(0, Math.min(1, reference / Math.max(Math.sqrt(distance2), .000001)));
  let angular = 1;
  if (facing > .17364818) {
    const progress = Math.max(0, Math.min(1, Math.sqrt(Math.max(0, 1 - facing * facing)) / facing * .17632698));
    angular = progress > .0001 ? (1 - (1 - progress) ** NORMAL_RESPONSE_CURVE) / progress : NORMAL_RESPONSE_CURVE;
  }
  const weight = slope * directReliefDistanceGain(distance2);
  moment[0] += (normal.x * reference + (x - normal.x * reference) * angular) * weight;
  moment[1] += (normal.y * reference + (y - normal.y * reference) * angular) * weight;
  moment[2] += (normal.z * reference + (z - normal.z * reference) * angular) * weight;
}

/** Shared by live lamp shading and the GPU direct-light bake. */
export const LIGHT_GRADIENT_SHADER = `
// Ease toward the existing 10-degree relief without exceeding it. Angles are
// measured from the surface; preserve the original response at/below 10 degrees.
vec3 curvedLightGradient(vec3 gradient, vec3 baseNormal, float reference, float curve) {
  float facing = clamp(reference / max(length(gradient), .000001), 0., 1.);
  if (facing <= .17364818 || curve <= 1.) return gradient;
  float progress = clamp(sqrt(max(0., 1. - facing * facing)) / facing * .17632698, 0., 1.);
  float gain = progress > .0001 ? (1. - pow(1. - progress, curve)) / progress : curve;
  vec3 axial = baseNormal * dot(baseNormal, gradient);
  return axial + (gradient - axial) * gain;
}
float directReliefDistanceGain(float distance2) {
  return clamp(distance2 / ${(DIRECT_RELIEF.referenceDistance ** 2).toFixed(6)}, 1., ${DIRECT_RELIEF.maxGain.toFixed(6)});
}
vec3 directLightGradient(vec3 gradient, vec3 baseNormal, float reference, float distance2) {
  return curvedLightGradient(gradient, baseNormal, reference, ${NORMAL_RESPONSE_CURVE.toFixed(6)}) * directReliefDistanceGain(distance2);
}
`;

/** Flat normals preserve irradiance even when the relief gradient is amplified. */
export const DIRECTIONAL_LIGHTMAP_SHADER = `${LIGHT_GRADIENT_SHADER}
uniform float normalResponseCurve;
vec3 reliefLightGradient(vec3 gradient, vec3 baseNormal, float reference) {
  return curvedLightGradient(gradient, baseNormal, reference, normalResponseCurve);
}
vec3 applyLightGradient(vec3 irradiance, float reference, vec3 gradient, vec3 mappedNormal, vec3 baseNormal) {
  #ifdef USE_NORMALMAP
    if (reference > .000001) {
      float response = max(0., reference + dot(mappedNormal - baseNormal, gradient));
      irradiance *= response / reference;
    }
  #endif
  return irradiance;
}
vec3 directionalBounce(vec3 irradiance, vec4 moment, vec3 mappedNormal, vec3 baseNormal) {
  vec3 gradient = reliefLightGradient(mat3(viewMatrix) * moment.xyz, baseNormal, moment.w);
  return applyLightGradient(irradiance, moment.w, gradient, mappedNormal, baseNormal);
}
vec3 directionalDirect(vec3 irradiance, vec4 moment, vec3 mappedNormal, vec3 baseNormal) {
  return applyLightGradient(irradiance, moment.w, mat3(viewMatrix) * moment.xyz, mappedNormal, baseNormal);
}
`;
