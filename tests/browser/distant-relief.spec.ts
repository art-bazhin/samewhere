import { test, expect } from '@playwright/test';

test('a distant lamp keeps its normal detail without changing flat irradiance', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const result = await page.evaluate(async () => {
    const path = '/node_modules/three/build/three.module.js', THREE = await import(path);
    const { space } = window.__samewhere, renderer = space.renderer;
    space.render = () => {}; renderer.clippingPlanes = []; renderer.shadowMap.enabled = false; space.lightTransfer.bind('G');
    const room = space.rooms.G, body = room.sockets.find((socket: any) => socket.ref.room === 'G').ball.parent.parent.getObjectByName('pedestal-body');
    const material = body.material, before = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey(), compensated = { value: false };
    material.map = material.roughnessMap = null; material.color.set(0xffffff);
    material.onBeforeCompile = (shader: any, context: any) => {
      before(shader, context); shader.uniforms.probeCompensated = compensated;
      shader.fragmentShader = 'uniform bool probeCompensated;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('directReliefDistanceGain(directReliefDistance2)', '(probeCompensated ? directReliefDistanceGain(directReliefDistance2) : 1.)');
      shader.fragmentShader = shader.fragmentShader.replace('vec4 roomLight =', 'vec3 liveDiffuse = reflectedLight.directDiffuse;\nvec4 roomLight =');
      shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', 'outgoingLight = liveDiffuse;\n#include <opaque_fragment>');
    };
    material.customProgramCacheKey = () => `${key}:distant-relief-probe`; material.needsUpdate = true;
    const scene = new THREE.Scene(), mesh = new THREE.Mesh(body.geometry, material); mesh.position.copy(body.parent.position); scene.add(mesh);
    const point = new THREE.Vector3(mesh.position.x + .318, .6, mesh.position.z), lamp = new THREE.PointLight(0xffffff, 25, 0, 2); scene.add(lamp);
    const camera = new THREE.OrthographicCamera(-.06, .06, .06, -.06, .01, 5);
    camera.position.copy(point).add(new THREE.Vector3(.8, .4, .6)); camera.lookAt(point); camera.updateMatrixWorld(true);
    const target = new THREE.WebGLRenderTarget(64, 64, { type: THREE.FloatType }), pixels = new Float32Array(64 * 64 * 4);
    const render = (scale: number, enabled: boolean) => {
      material.normalScale.setScalar(scale); compensated.value = enabled;
      renderer.setRenderTarget(target); renderer.render(scene, camera); renderer.readRenderTargetPixels(target, 0, 0, 64, 64, pixels); return pixels.slice();
    };
    try {
      const samples = [];
      for (const distance of [2, 3, 10, 20]) {
        lamp.position.copy(point).add(new THREE.Vector3(1, 1, 0).normalize().multiplyScalar(distance));
        const flat = render(0, false), flatAdjusted = render(0, true), original = render(1, false), adjusted = render(1, true);
        let flatError = 0, baseline = 0, detail = 0;
        for (let i = 0; i < flat.length; i += 4) {
          flatError = Math.max(flatError, Math.abs(flat[i] - flatAdjusted[i]));
          baseline += Math.abs(original[i] - flat[i]); detail += Math.abs(adjusted[i] - flat[i]);
        }
        samples.push({ distance, flatError, baseline, detail, gain: detail / baseline });
      }
      return { samples, glError: renderer.getContext().getError() };
    } finally { renderer.setRenderTarget(null); target.dispose(); }
  });
  console.log('Distant direct relief:', result);
  for (const sample of result.samples) {
    expect(sample.baseline).toBeGreaterThan(0); expect(sample.flatError).toBeLessThan(.000001);
    if (sample.distance === 2) expect(sample.gain).toBeCloseTo(1, 4);
    if (sample.distance === 10) { expect(sample.gain).toBeGreaterThan(14); expect(sample.gain).toBeLessThan(16); }
    // Clamping dark microfacets can reduce the measured contrast slightly.
    if (sample.distance === 20) { expect(sample.gain).toBeGreaterThan(24); expect(sample.gain).toBeLessThanOrEqual(25.05); }
  }
  const near = result.samples.find(s => s.distance === 3)!, far = result.samples.find(s => s.distance === 10)!;
  expect(far.detail / near.detail).toBeGreaterThan(.85); expect(far.detail / near.detail).toBeLessThan(1.15);
  expect(result.glError).toBe(0); expect(errors).toEqual([]);
});
