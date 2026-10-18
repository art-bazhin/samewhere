import { test, expect } from '@playwright/test';

test('normal maps cannot catch a lamp behind the pedestal face, including its top shadow fringe', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const result = await page.evaluate(async () => {
    const threePath = '/node_modules/three/build/three.module.js', worldPath = '/src/world.ts';
    const THREE = await import(threePath), { ROOMS, PEDESTAL_APOTHEM, PEDESTAL_HEIGHT } = await import(worldPath);
    const space = window.__samewhere.space, renderer = space.renderer, room = space.rooms.A;
    space.render = () => {}; renderer.clippingPlanes = []; space.lightTransfer.bind('A');
    const pedestal = ROOMS.A.pedestals[0];
    const body = room.sockets.find((socket: any) => socket.ref.room === 'A').ball.parent.parent.getObjectByName('pedestal-body');
    const lamp = room.shadowLights.find((light: any) => Math.hypot(light.position.x - pedestal.x, light.position.z - pedestal.z) < .001);
    for (const light of room.shadowLights) light.intensity = light === lamp ? 9 : 0;
    const material = body.material, before = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey();
    material.map = material.roughnessMap = null; material.color.set(0xffffff); material.normalScale.setScalar(100);
    material.onBeforeCompile = (shader: any, context: any) => {
      before(shader, context);
      shader.fragmentShader = shader.fragmentShader.replace('vec4 roomLight =',
        'vec3 liveDirect = reflectedLight.directDiffuse + reflectedLight.directSpecular;\nvec4 roomLight =');
      shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', 'outgoingLight = liveDirect;\n#include <opaque_fragment>');
    };
    material.customProgramCacheKey = () => `${key}:back-face-light-probe`; material.needsUpdate = true;
    const target = new THREE.WebGLRenderTarget(48, 48, { type: THREE.FloatType }), pixels = new Float32Array(48 * 48 * 4);
    const camera = new THREE.OrthographicCamera(-.2, .2, .06, -.06, .001, 1);
    const x = pedestal.x - PEDESTAL_APOTHEM, y = PEDESTAL_HEIGHT - .06;
    camera.position.set(x - .3, y, pedestal.z); camera.lookAt(x, y, pedestal.z); camera.updateMatrixWorld(true);
    try {
      const samples: { optimized: boolean; shadows: boolean; maximum: number }[] = [];
      for (const optimized of [true, false]) for (const shadows of [true, false]) {
        space.assets.optimizations.value = optimized; body.receiveShadow = shadows;
        renderer.setRenderTarget(target); renderer.render(room.scene, camera); renderer.readRenderTargetPixels(target, 0, 0, 48, 48, pixels);
        let maximum = 0;
        for (let i = 0; i < pixels.length; i += 4) maximum = Math.max(maximum, pixels[i], pixels[i + 1], pixels[i + 2]);
        samples.push({ optimized, shadows, maximum });
      }
      return { samples, glError: renderer.getContext().getError() };
    } finally { renderer.setRenderTarget(null); target.dispose(); }
  });
  console.log('Back-facing pedestal direct-light fringe:', result);
  for (const sample of result.samples) expect(sample.maximum, JSON.stringify(sample)).toBeLessThan(.000001);
  expect(result.glError).toBe(0); expect(errors).toEqual([]);
});
