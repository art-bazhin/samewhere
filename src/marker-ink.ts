import * as THREE from 'three';
import { inkDistanceField } from './ink-distance-field';

export interface MarkerInk { texture: THREE.DataTexture; width: number; height: number }

/** Rasterize clean SVG contours once, retaining distance and coverage for both viewing scales. */
export function createMarkerInk(source: string, maxTextureSize: number, resolution = 4096): MarkerInk {
  const svg = new DOMParser().parseFromString(source, 'image/svg+xml').documentElement;
  const [, , width, height] = svg.getAttribute('viewBox')!.split(/\s+/).map(Number);
  const canvas = document.createElement('canvas');
  canvas.width = Math.min(resolution, maxTextureSize);
  // Exact 2:1 mip reductions preserve average ink coverage at every distance.
  canvas.height = Math.min(resolution, maxTextureSize, THREE.MathUtils.ceilPowerOfTwo(Math.ceil(canvas.width * height / width)));
  const context = canvas.getContext('2d')!;
  context.scale(canvas.width / width, canvas.height / height);
  context.fillStyle = '#fff';
  for (const path of svg.querySelectorAll('path')) context.fill(new Path2D(path.getAttribute('d')!), 'evenodd');
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const distances = inkDistanceField(pixels, canvas.width, canvas.height), data = new Uint8Array(distances.length * 2);
  for (let i = 0; i < distances.length; i++) { data[i * 2] = distances[i]; data[i * 2 + 1] = pixels[i * 4 + 3]; }
  const texture = new THREE.DataTexture(data, canvas.width, canvas.height, THREE.RGFormat);
  texture.flipY = true; texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true; texture.needsUpdate = true;
  // Keep physical dimensions from the grid-calibrated source; choose enlargement separately.
  return { texture, width: parseFloat(svg.getAttribute('width')!) / 1000,
    height: parseFloat(svg.getAttribute('height')!) / 1000 };
}

export const markerInkGLSL = `
  #ifndef SAMEWHERE_MARKER_INK
  #define SAMEWHERE_MARKER_INK
  float markerInk(sampler2D mask, vec2 uv, vec2 texels) {
    vec2 dx = dFdx(uv), dy = dFdy(uv);
    vec2 sampleInk = textureGrad(mask, uv, dx, dy).rg;
    float edgeAA = max(.5 * fwidth(sampleInk.r), 1. / 255.);
    float footprint = max(length(dx * texels), length(dy * texels));
    vec2 pixel = max(fwidth(uv), vec2(.000001));
    vec2 bounds = clamp((1. - uv) / pixel + .5, 0., 1.) - clamp(-uv / pixel + .5, 0., 1.);
    if (footprint > 1. && min(bounds.x, bounds.y) > 0.) {
      // Integrate four half-pixel footprints: a single coarse mip blurs subpixel marker lines too broadly.
      sampleInk.g = .25 * (textureGrad(mask, uv + .25 * (dx + dy), dx * .5, dy * .5).g
        + textureGrad(mask, uv + .25 * (dx - dy), dx * .5, dy * .5).g
        + textureGrad(mask, uv + .25 * (-dx + dy), dx * .5, dy * .5).g
        + textureGrad(mask, uv - .25 * (dx + dy), dx * .5, dy * .5).g);
    }
    return mix(smoothstep(.5 - edgeAA, .5 + edgeAA, sampleInk.r), sampleInk.g, smoothstep(1., 2., footprint)) * bounds.x * bounds.y;
  }
  #endif
`;
