import { test, expect } from '@playwright/test';

test('carpet rotations stay deterministic, unblended and aligned with normals and roughness', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const result = await page.evaluate(async () => {
    const threePath = '/node_modules/three/build/three.module.js', tilingPath = '/src/carpet-tiling.ts', materialsPath = '/src/materials.ts';
    const THREE = await import(threePath), { withCarpetTiling } = await import(tilingPath), { surfaceUV } = await import(materialsPath);
    const space = window.__samewhere.space, renderer = space.renderer;
    space.render = () => {}; renderer.clippingPlanes = []; renderer.shadowMap.enabled = false;
    const colors = new Uint8Array(16 * 16 * 4), normals = new Uint8Array(colors.length);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const i = (y * 16 + x) * 4, value = Math.round(x / 15 * 255);
      colors.set([value, value, 0, 255], i); normals.set([51, 128, 230, 255], i);
    }
    const map = new THREE.DataTexture(colors, 16, 16), normalMap = new THREE.DataTexture(normals, 16, 16);
    for (const texture of [map, normalMap]) {
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.repeat.setScalar(2);
      texture.minFilter = texture.magFilter = THREE.LinearFilter; texture.needsUpdate = true;
    }
    const material = new THREE.MeshStandardMaterial({ map, normalMap, roughnessMap: map, roughness: 1 }); material.normalScale.setScalar(.5);
    withCarpetTiling(material);
    const mode = { value: 0 }, compile = material.onBeforeCompile;
    material.onBeforeCompile = (shader: any, context: any) => {
      compile(shader, context); shader.uniforms.previewMode = mode;
      shader.fragmentShader = 'uniform int previewMode;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `#include <opaque_fragment>
        gl_FragColor.rgb = previewMode == 0 ? diffuseColor.rgb : previewMode == 1 ? normal * .5 + .5 : vec3(roughnessFactor);`);
    };
    const geometry = surfaceUV(new THREE.PlaneGeometry(8, 8).rotateX(-Math.PI / 2)), scene = new THREE.Scene();
    scene.add(new THREE.Mesh(geometry, material));
    const camera = new THREE.PerspectiveCamera(.001, 1, .001, 20), target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType });
    camera.up.set(0, 0, -1);
    const pixel = new Float32Array(4);
    const read = (x: number, z: number, preview = 0) => {
      mode.value = preview; camera.position.set(x, 10, z); camera.lookAt(x, 0, z); camera.updateMatrixWorld(true);
      renderer.setRenderTarget(target); renderer.render(scene, camera); renderer.readRenderTargetPixels(target, 0, 0, 1, 1, pixel);
      return Array.from(pixel.subarray(0, 3));
    };
    const orientations = new Set<string>(), alignment: number[] = [], roughness: number[] = [], edges: number[] = [];
    try {
      for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) {
        const px = x + .31, pz = z + .64, n = read(px, pz, 1).map(value => value * 2 - 1);
        const dx = read(px + .01, pz)[0] - read(px - .01, pz)[0], dy = read(px, pz - .01)[0] - read(px, pz + .01)[0];
        alignment.push((n[0] * dx + n[1] * dy) / (Math.hypot(n[0], n[1]) * Math.hypot(dx, dy)));
        orientations.add(Math.abs(n[0]) > Math.abs(n[1]) ? `x${Math.sign(n[0])}` : `y${Math.sign(n[1])}`);
        roughness.push(Math.abs(read(px, pz)[0] - read(px, pz, 2)[0]));
      }
      for (let edge = -2; edge <= 2; edge++) for (const sign of [-1, 1]) {
        // The ramp must extend unchanged toward each edge, without mixing in
        // the neighboring tile's differently rotated gradient.
        edges.push(Math.abs(read(edge + sign * .04, .37)[0] - (2 * read(edge + sign * .06, .37)[0] - read(edge + sign * .08, .37)[0])));
        edges.push(Math.abs(read(.37, edge + sign * .04)[0] - (2 * read(.37, edge + sign * .06)[0] - read(.37, edge + sign * .08)[0])));
      }
      const a = read(.31, .64), b = read(.31, .64);
      return { orientations: [...orientations], alignment, roughness, edges, stable: JSON.stringify(a) === JSON.stringify(b), error: renderer.getContext().getError(),
        installed: Object.values(space.rooms).every((room: any) => room.scene.getObjectByName('floor').material.customProgramCacheKey().includes('carpet-quarter-turns')) };
    } finally { renderer.setRenderTarget(null); target.dispose(); geometry.dispose(); material.dispose(); map.dispose(); normalMap.dispose(); }
  });
  expect(result.orientations).toHaveLength(4); expect(result.stable).toBe(true); expect(result.installed).toBe(true);
  for (const cosine of result.alignment) expect(cosine).toBeLessThan(-.99);
  expect(Math.max(...result.roughness)).toBeLessThan(.001); expect(Math.max(...result.edges)).toBeLessThan(.001);
  expect(result.error).toBe(0); expect(errors).toEqual([]);
});
