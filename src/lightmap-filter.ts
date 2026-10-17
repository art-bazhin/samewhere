/** Positive cubic B-spline reconstruction, using four hardware bilinear reads. */
export const SURFACE_LIGHTMAP_FILTER = `
#ifdef FLOOR_PASSAGE_LIGHTING
vec4 sampleSurfaceLightmap(sampler2D lightmap, vec2 uv) {
  vec2 size = vec2(textureSize(lightmap, 0));
  vec2 p = uv * size - .5, cell = floor(p), f = fract(p);
  vec2 f2 = f * f, f3 = f2 * f;
  vec2 w0 = (1. - 3. * f + 3. * f2 - f3) / 6.;
  vec2 w1 = (4. - 6. * f2 + 3. * f3) / 6.;
  vec2 w2 = (1. + 3. * f + 3. * f2 - 3. * f3) / 6.;
  vec2 w3 = f3 / 6., g0 = w0 + w1, g1 = w2 + w3;
  vec2 a = (cell - 1. + w1 / g0 + .5) / size;
  vec2 b = (cell + 1. + w3 / g1 + .5) / size;
  return mix(mix(texture2D(lightmap, a), texture2D(lightmap, vec2(b.x, a.y)), g1.x),
             mix(texture2D(lightmap, vec2(a.x, b.y)), texture2D(lightmap, b), g1.x), g1.y);
}
#else
#define sampleSurfaceLightmap texture2D
#endif
`;
