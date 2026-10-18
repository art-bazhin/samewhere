import { test, expect } from '@playwright/test';

test('normal maps affect reflected light on the shadowed lower pedestal and preserve flat lighting', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const result = await page.evaluate(async () => {
    const threePath = '/node_modules/three/build/three.module.js', worldPath = '/src/world.ts';
    const THREE = await import(threePath), { ROOMS, PEDESTAL_APOTHEM } = await import(worldPath);
    const space = window.__samewhere.space, renderer = space.renderer, material = space.assets.materials.pedestal;
    space.render = () => {}; renderer.clippingPlanes = []; space.lightTransfer.bind('A');
    const pedestal = ROOMS.A.pedestals[0], x = pedestal.x - PEDESTAL_APOTHEM;
    const camera = new THREE.OrthographicCamera(-.18, .18, .18, -.18, .01, 3);
    camera.position.set(x - 1, .4, pedestal.z); camera.lookAt(x, .4, pedestal.z); camera.updateMatrixWorld(true);
    const target = new THREE.WebGLRenderTarget(48, 48, { type: THREE.FloatType }), pixels = new Float32Array(48 * 48 * 4);
    const render = () => {
      renderer.setRenderTarget(target); renderer.render(space.rooms.A.scene, camera);
      renderer.readRenderTargetPixels(target, 0, 0, 48, 48, pixels); return pixels.slice();
    };
    // Check the shipped material too: an effect visible only in an isolated
    // bounce probe can disappear under the room's other lighting components.
    material.normalScale.setScalar(100);
    const fullRelief = render(), field = space.lightTransfer.fields.A;
    const maps = [field.panel, field.texture], saved = maps.map((map: any) => map.image.data.slice(map.image.data.length / 2));
    maps.forEach((map: any) => { map.image.data.fill(0, map.image.data.length / 2); map.needsUpdate = true; });
    const fullOriginal = render();
    maps.forEach((map: any, index: number) => { map.image.data.set(saved[index], map.image.data.length / 2); map.needsUpdate = true; });
    let fullDifference = 0, fullEnergy = 0;
    for (let i = 0; i < fullRelief.length; i += 4) { fullDifference += Math.abs(fullRelief[i] - fullOriginal[i]); fullEnergy += fullOriginal[i]; }
    material.color.set(0xffffff); material.map = null;
    const before = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey();
    const reference = { value: false };
    material.onBeforeCompile = (shader: any, context: any) => {
      before(shader, context); shader.uniforms.probeReference = reference;
      shader.fragmentShader = 'uniform bool probeReference;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>',
        'outgoingLight = (probeReference ? roomLight.gba : roomBounce) * BRDF_Lambert(material.diffuseColor);\n#include <opaque_fragment>');
    };
    material.customProgramCacheKey = () => `${key}:directional-bounce-probe`; material.needsUpdate = true;
    const read = (scale: number, original = false) => {
      material.normalScale.setScalar(scale); reference.value = original;
      return render();
    };
    try {
      const flat = read(0), original = read(0, true), relief = read(100);
      let preservationError = 0, reliefDifference = 0, energy = 0;
      for (let i = 0; i < flat.length; i += 4) {
        preservationError = Math.max(preservationError, Math.abs(flat[i] - original[i]));
        reliefDifference += Math.abs(relief[i] - flat[i]); energy += flat[i];
      }
      return { preservationError, relativeRelief: reliefDifference / energy, fullRelativeRelief: fullDifference / fullEnergy,
        energy, glError: renderer.getContext().getError() };
    } finally { renderer.setRenderTarget(null); target.dispose(); }
  });
  console.log('Shadowed pedestal directional bounce:', result);
  expect(result.energy).toBeGreaterThan(1);
  expect(result.preservationError).toBeLessThan(.00001);
  expect(result.relativeRelief).toBeGreaterThan(.08);
  expect(result.fullRelativeRelief).toBeGreaterThan(.02);
  expect(result.glError).toBe(0); expect(errors).toEqual([]);
});
