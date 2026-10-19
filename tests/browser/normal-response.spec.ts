import { test, expect } from '@playwright/test';

test('relief appears sooner on the H pedestal while preserving grazing and flat lighting', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const result = await page.evaluate(async () => {
    const threePath = '/node_modules/three/build/three.module.js', THREE = await import(threePath);
    const space = window.__samewhere.space, renderer = space.renderer, room = space.rooms.G;
    space.render = () => {}; renderer.clippingPlanes = []; renderer.shadowMap.enabled = false;
    space.lightTransfer.bind('G');
    const body = room.sockets.find((socket: any) => socket.ref.room === 'G').ball.parent.parent.getObjectByName('pedestal-body');
    const material = body.material, before = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey();
    material.map = material.roughnessMap = null; material.color.set(0xffffff);
    material.onBeforeCompile = (shader: any, context: any) => {
      before(shader, context);
      shader.fragmentShader = shader.fragmentShader.replace('vec4 roomLight =',
        'vec3 liveDiffuse = reflectedLight.directDiffuse;\nvec4 roomLight =');
      shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>',
        'outgoingLight = inverseTransformDirection(nonPerturbedNormal, viewMatrix).x > .9 ? liveDiffuse : vec3(0.);\n#include <opaque_fragment>');
    };
    material.customProgramCacheKey = () => `${key}:relief-response-probe`; material.needsUpdate = true;
    const scene = new THREE.Scene(), mesh = new THREE.Mesh(body.geometry, material);
    mesh.position.copy(body.parent.position); scene.add(mesh);
    // A directional source gives every point of the +X faces the same known
    // incidence angle. Keep the actual H geometry, normal map and angled camera.
    const lamp = new THREE.DirectionalLight(0xfff5d7, 1);
    lamp.target = new THREE.Object3D(); lamp.target.position.copy(mesh.position); scene.add(lamp, lamp.target);
    const camera = new THREE.PerspectiveCamera(40, 1, .01, 20);
    camera.position.set(mesh.position.x + 1.5, 2.1, 2.1); camera.lookAt(mesh.position.x, .65, mesh.position.z);
    camera.updateMatrixWorld(true);
    const size = 160, target = new THREE.WebGLRenderTarget(size, size, { type: THREE.FloatType });
    const pixels = new Float32Array(size * size * 4), curve = space.lightTransfer.uniforms.normalResponseCurve;
    const render = (scale: number, gain: number) => {
      material.normalScale.setScalar(scale); curve.value = gain;
      renderer.setRenderTarget(target); renderer.render(scene, camera);
      renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels); return pixels.slice();
    };
    try {
      const samples = [];
      for (const angle of [5, 10, 30, 60, 80, 90]) {
        const radians = angle * Math.PI / 180;
        lamp.position.set(mesh.position.x + 5 * Math.sin(radians), 5 * Math.cos(radians), mesh.position.z);
        const flat = render(0, 1), flatAdjusted = render(0, 4), original = render(100, 1), adjusted = render(100, 4);
        let flatError = 0, baseline = 0, enhanced = 0, difference = 0, energy = 0;
        for (let i = 0; i < flat.length; i += 4) {
          flatError = Math.max(flatError, Math.abs(flat[i] - flatAdjusted[i]));
          baseline += Math.abs(original[i] - flat[i]); enhanced += Math.abs(adjusted[i] - flat[i]);
          difference += Math.abs(adjusted[i] - original[i]); energy += flat[i];
        }
        samples.push({ angle, flatError, contrastIncrease: enhanced / baseline, relativeChange: difference / energy, energy });
      }
      return { samples, glError: renderer.getContext().getError() };
    } finally { renderer.setRenderTarget(null); target.dispose(); }
  });
  console.log('H pedestal relief response:', result);
  for (const sample of result.samples) {
    expect(sample.energy).toBeGreaterThan(1);
    expect(sample.flatError).toBeLessThan(.000001);
    if (sample.angle <= 10) expect(sample.relativeChange).toBeLessThan(.00001);
    else if (sample.angle === 90) expect(sample.relativeChange).toBeLessThan(.0001);
    else expect(sample.contrastIncrease).toBeGreaterThan(1.05);
  }
  expect(result.glError).toBe(0); expect(errors).toEqual([]);
});
