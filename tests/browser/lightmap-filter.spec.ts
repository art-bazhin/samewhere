import { test, expect } from '@playwright/test';

test('floor lightmaps reconstruct a continuous shadow slope across texel boundaries', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const result = await page.evaluate(async () => {
    const threePath = '/node_modules/three/build/three.module.js', filterPath = '/src/lightmap-filter.ts';
    const THREE = await import(threePath), { SURFACE_LIGHTMAP_FILTER } = await import(filterPath);
    const renderer = window.__samewhere.space.renderer, gl = renderer.getContext();
    // A low-resolution diagonal shadow exposes the slope changes that look like
    // stairs. Read linear floats, so display quantization cannot hide the kink.
    const data = new Uint8Array(8 * 8 * 4);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const i = (y * 8 + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = x + y >= 7 ? 255 : 0; data[i + 3] = 255;
    }
    const texture = new THREE.DataTexture(data, 8, 8);
    texture.minFilter = texture.magFilter = THREE.LinearFilter; texture.needsUpdate = true;
    const target = new THREE.WebGLRenderTarget(5, 1, { type: THREE.FloatType, depthBuffer: false });
    // Hardware bilinear weights have finite precision. Probe over 1/8 texel,
    // rather than measuring that subpixel quantization with an infinitesimal h.
    const h = .125, material = new THREE.ShaderMaterial({
      defines: { FLOOR_PASSAGE_LIGHTING: '' }, uniforms: { lightmap: { value: texture }, h: { value: h } },
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0., 1.); }',
      fragmentShader: `${SURFACE_LIGHTMAP_FILTER}
        uniform sampler2D lightmap; uniform float h;
        void main() {
          float index = floor(gl_FragCoord.x);
          vec2 p = vec2(4. + (index - 1.) * h, 3.35);
          if (index == 3.) p = vec2(0.);
          if (index == 4.) p = vec2(7.);
          vec2 uv = (p + .5) / 8.;
          gl_FragColor = vec4(sampleSurfaceLightmap(lightmap, uv).r, texture2D(lightmap, uv).r, 0., 1.);
        }`,
    });
    const geometry = new THREE.PlaneGeometry(2, 2), scene = new THREE.Scene();
    scene.add(new THREE.Mesh(geometry, material));
    const previous = renderer.getRenderTarget(), pixels = new Float32Array(5 * 4);
    try {
      renderer.setRenderTarget(target); renderer.render(scene, new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1));
      renderer.readRenderTargetPixels(target, 0, 0, 5, 1, pixels);
      const values = Array.from({ length: 5 }, (_, i) => ({ smooth: pixels[i * 4], linear: pixels[i * 4 + 1] }));
      const jump = (channel: 'smooth' | 'linear') => Math.abs((values[1][channel] - values[0][channel]) / h - (values[2][channel] - values[1][channel]) / h);
      return { values, smoothJump: jump('smooth'), linearJump: jump('linear'), error: gl.getError() };
    } finally {
      renderer.setRenderTarget(previous); texture.dispose(); target.dispose(); geometry.dispose(); material.dispose();
    }
  });
  console.log('Shadow slope at a lightmap grid boundary:', result);
  expect(result.error).toBe(0);
  expect(result.linearJump).toBeGreaterThan(.3);
  expect(result.smoothJump).toBeLessThan(result.linearJump * .2);
  for (const sample of result.values) expect(sample.smooth).toBeGreaterThanOrEqual(0);
  for (const sample of result.values) expect(sample.smooth).toBeLessThanOrEqual(1);
  expect(result.values[3].smooth).toBeCloseTo(0, 5);
  expect(result.values[4].smooth).toBeCloseTo(1, 5);
});
