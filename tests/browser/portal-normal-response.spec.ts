import { test, expect } from '@playwright/test';

test('neighbor light retains normal relief both in the doorway blend and inside each room', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const result = await page.evaluate(async () => {
    const threePath = '/node_modules/three/build/three.module.js', worldPath = '/src/world.ts';
    const THREE = await import(threePath), { portalPosition, wallNormal } = await import(worldPath);
    const { game, space, sync } = window.__samewhere, renderer = space.renderer;
    game.world.balls.forEach((ball: any) => { ball.socket = null; });
    game.world.balls[0].socket = { room: 'A', side: 0 }; game.world.balls[1].socket = { room: 'G', side: 0 }; sync(); space.render();
    space.render = () => {}; renderer.clippingPlanes = []; space.lightTransfer.uniforms.bounceGain.value = 0;
    const scalar = { value: false }, finishes = new Set<any>();
    for (const room of Object.values(space.rooms) as any[]) {
      room.scene.environment = null;
      room.scene.children.forEach((object: any) => { if (object.isLight) object.intensity = 0; });
      room.scene.traverse((object: any) => { if (object.name === 'floor' || object.name === 'threshold') finishes.add(object.material); });
    }
    for (const material of finishes) {
      material.color.set(0xffffff); material.map = material.roughnessMap = material.envMap = null; material.sheen = 0;
      const before = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey();
      material.onBeforeCompile = (shader: any, context: any) => {
        before(shader, context); shader.uniforms.probeScalar = scalar;
        shader.fragmentShader = 'uniform bool probeScalar;\n' + shader.fragmentShader;
        // Isolate the neighbor contribution, including the real joined passage
        // atlas. Keep actual geometry, carpet normals and the oblique camera.
        shader.fragmentShader = shader.fragmentShader.replace(
          'reflectedLight.directDiffuse += (roomDirect + bounceGain * roomBounce) * BRDF_Lambert(material.diffuseColor);', '');
        for (const field of ['directField', 'joinedField', 'localField']) shader.fragmentShader = shader.fragmentShader.replace(
          `directionalBounce(${field}.r * transferColor, vec4(${field}.gba, ${field}.r), normal, nonPerturbedNormal)`,
          `(probeScalar ? ${field}.r * transferColor : directionalBounce(${field}.r * transferColor, vec4(${field}.gba, ${field}.r), normal, nonPerturbedNormal))`);
        shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>',
          'outgoingLight = reflectedLight.directDiffuse;\n#include <opaque_fragment>');
      };
      material.customProgramCacheKey = () => `${key}:portal-normal-probe`; material.needsUpdate = true;
    }
    const size = 64, target = new THREE.WebGLRenderTarget(size, size, { type: THREE.FloatType });
    const camera = new THREE.OrthographicCamera(-.15, .15, .1, -.1, .01, 5), pixels = new Float32Array(size * size * 4);
    const samples = [];
    try {
      for (const room of ['A', 'G']) for (const depth of [.2, 1.2]) {
        const p = portalPosition(room, 0), n = wallNormal(room, 0), x = p.x - n.x * depth, z = p.z - n.z * depth;
        camera.position.set(x - n.x * .35, .4, z - n.z * .35); camera.lookAt(x, 0, z); camera.updateMatrixWorld(true);
        space.lightTransfer.bind(room);
        const read = (scale: number, legacy = false) => {
          finishes.forEach(material => material.normalScale.setScalar(scale)); scalar.value = legacy;
          renderer.setRenderTarget(target); renderer.render(space.rooms[room].scene, camera);
          renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels); return pixels.slice();
        };
        const flat = read(0), legacy = read(0, true), relief = read(100);
        let flatError = 0, difference = 0, energy = 0;
        for (let i = 0; i < flat.length; i += 4) {
          flatError = Math.max(flatError, Math.abs(flat[i] - legacy[i]));
          difference += Math.abs(relief[i] - flat[i]); energy += flat[i];
        }
        samples.push({ room, depth, flatError, relativeRelief: difference / energy, energy });
      }
      return { samples, glError: renderer.getContext().getError() };
    } finally { renderer.setRenderTarget(null); target.dispose(); }
  });
  console.log('Portal normal response:', result);
  for (const sample of result.samples) {
    expect(sample.energy).toBeGreaterThan(1);
    expect(sample.flatError).toBeLessThan(.00001);
    expect(sample.relativeRelief).toBeGreaterThan(.05);
  }
  expect(result.glError).toBe(0); expect(errors).toEqual([]);
});

test('opposing lamps do not cancel relief at a hexagonal self-connection', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const result = await page.evaluate(async () => {
    const threePath = '/node_modules/three/build/three.module.js', worldPath = '/src/world.ts';
    const THREE = await import(threePath), { portalPosition, wallNormal } = await import(worldPath);
    const { game, space, sync } = window.__samewhere, renderer = space.renderer;
    space.render = () => {}; renderer.clippingPlanes = []; space.lightTransfer.uniforms.bounceGain.value = 0;
    const finishes = new Set<any>(), normalMap = new THREE.DataTexture(new Float32Array([.5, 1, .505, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    normalMap.needsUpdate = true;
    space.rooms.C.scene.traverse((object: any) => { if (object.name === 'floor' || object.name === 'threshold') finishes.add(object.material); });
    for (const material of finishes) {
      material.color.set(0xffffff); material.map = material.roughnessMap = material.envMap = null; material.normalMap = normalMap;
      const before = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey();
      material.onBeforeCompile = (shader: any, context: any) => {
        before(shader, context);
        shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>',
          'outgoingLight = reflectedLight.directDiffuse;\n#include <opaque_fragment>');
      };
      material.customProgramCacheKey = () => `${key}:opposing-normal-probe`; material.needsUpdate = true;
    }
    const target = new THREE.WebGLRenderTarget(16, 16, { type: THREE.FloatType }), pixels = new Float32Array(16 * 16 * 4);
    const camera = new THREE.OrthographicCamera(-.025, .025, .025, -.025, .01, 2), samples = [];
    camera.up.set(0, 0, 1);
    try {
      for (const side of [1, 2, 3]) {
        game.world.balls.forEach((ball: any) => { ball.socket = null; });
        game.world.balls[0].socket = { room: 'C', side: 0 }; game.world.balls[1].socket = { room: 'C', side }; sync();
        space.lightTransfer.direct.update(); space.lightTransfer.bind('C');
        const p = portalPosition('C', 0), n = wallNormal('C', 0), x = p.x - n.x * .1, z = p.z - n.z * .1;
        camera.position.set(x, .5, z); camera.lookAt(x, 0, z); camera.updateMatrixWorld(true);
        const energy = (scale: number) => {
          finishes.forEach(material => material.normalScale.setScalar(scale));
          renderer.setRenderTarget(target); renderer.render(space.rooms.C.scene, camera);
          renderer.readRenderTargetPixels(target, 0, 0, 16, 16, pixels);
          return pixels.reduce((sum, value, i) => sum + (i % 4 === 0 ? value : 0), 0);
        };
        const flat = energy(0), relief = energy(100); samples.push({ side, flat, relief, ratio: relief / flat });
      }
      return { samples, glError: renderer.getContext().getError() };
    } finally { renderer.setRenderTarget(null); target.dispose(); normalMap.dispose(); }
  });
  console.log('Opposing portal lamps:', result);
  for (const sample of result.samples) { expect(sample.flat).toBeGreaterThan(1); expect(sample.ratio).toBeGreaterThan(.3); }
  expect(result.glError).toBe(0); expect(errors).toEqual([]);
});
