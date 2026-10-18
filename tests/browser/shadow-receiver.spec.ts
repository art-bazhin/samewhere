import { test, expect } from '@playwright/test';

test('lit pedestal faces do not shadow themselves and still receive other objects shadows', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const result = await page.evaluate(async () => {
    const threePath = '/node_modules/three/build/three.module.js', worldPath = '/src/world.ts';
    const THREE = await import(threePath), { ROOMS, PEDESTAL_APOTHEM } = await import(worldPath);
    const space = window.__samewhere.space, renderer = space.renderer, room = space.rooms.D;
    space.render = () => {}; renderer.clippingPlanes = []; space.lightTransfer.bind('D');
    const pedestal = ROOMS.D.pedestals.find((p: any) => p.controls === 'A');
    const body = room.sockets.find((s: any) => s.ref.room === 'A').ball.parent.parent.getObjectByName('pedestal-body');
    const lamp = room.shadowLights.find((light: any) => Math.abs(light.position.x - pedestal.x) < .001 && light.position.z > pedestal.z + 1);
    for (const light of room.shadowLights) light.intensity = light === lamp ? 9 : 0;
    const material = body.material, before = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey();
    material.map = material.normalMap = material.roughnessMap = null; material.color.set(0xffffff);
    material.onBeforeCompile = (shader: any, context: any) => {
      before(shader, context);
      shader.fragmentShader = shader.fragmentShader.replace('vec4 roomLight =', 'vec3 liveDiffuse = reflectedLight.directDiffuse;\nvec4 roomLight =');
      shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', 'outgoingLight = liveDiffuse;\n#include <opaque_fragment>');
    };
    material.customProgramCacheKey = () => `${key}:lit-receiver-probe`; material.needsUpdate = true;
    const camera = new THREE.OrthographicCamera(-.0001, .0001, .0001, -.0001, .001, 10);
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType }), pixel = new Float32Array(4);
    const read = (point: any, receiveShadow = true) => {
      body.receiveShadow = receiveShadow;
      camera.position.copy(point).add(new THREE.Vector3(0, 0, .03)); camera.lookAt(point); camera.updateMatrixWorld(true);
      renderer.render(room.scene, camera); renderer.readRenderTargetPixels(target, 0, 0, 1, 1, pixel);
      return Math.max(pixel[0], pixel[1], pixel[2]);
    };
    renderer.setRenderTarget(target);
    try {
      const samples: any[] = [];
      for (const x of [-.2, 0, .2]) for (let row = 0; row < 33; row++) {
        const point = new THREE.Vector3(pedestal.x + x, .12 + row * .03, pedestal.z + PEDESTAL_APOTHEM);
        samples.push({ x, row, shadowed: read(point), unshadowed: read(point, false) });
      }
      // A real blocker must still cast its shadow onto the same receiving face.
      const point = new THREE.Vector3(pedestal.x, .65, pedestal.z + PEDESTAL_APOTHEM);
      const blocker = new THREE.Mesh(new THREE.BoxGeometry(.35, .35, .35), new THREE.MeshBasicMaterial({ shadowSide: THREE.FrontSide }));
      blocker.position.copy(point).addScaledVector(lamp.position.clone().sub(point).normalize(), .7);
      blocker.castShadow = true; room.shadows.scene.add(blocker); blocker.updateMatrixWorld(true); lamp.shadow.needsUpdate = true;
      const blocked = read(point), lit = read(point, false);
      return { samples, blocked, lit, error: renderer.getContext().getError() };
    } finally { renderer.setRenderTarget(null); target.dispose(); }
  });
  console.log('Pedestal receiver planes:', { samples: result.samples.length,
    maxDifference: Math.max(...result.samples.map(s => Math.abs(s.shadowed - s.unshadowed))), blocked: result.blocked, lit: result.lit });
  for (const sample of result.samples) {
    expect(sample.unshadowed).toBeGreaterThan(.01);
    expect(Math.abs(sample.shadowed - sample.unshadowed), JSON.stringify(sample)).toBeLessThan(.0002);
  }
  expect(result.blocked).toBeLessThan(.0001); expect(result.lit).toBeGreaterThan(.01);
  expect(result.error).toBe(0); expect(errors).toEqual([]);
});
