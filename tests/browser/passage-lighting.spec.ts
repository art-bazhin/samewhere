import { test, expect } from '@playwright/test';

test('hexagon and Y passages keep complete carpet lighting continuous at oblique views', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const result = await page.evaluate(async () => {
    const threePath = '/node_modules/three/build/three.module.js', worldPath = '/src/world.ts';
    const THREE = await import(threePath), { portalPosition, wallNormal, transformPoint } = await import(worldPath);
    const app = window.__samewhere, space = app.space, renderer = space.renderer;
    space.render = () => {}; renderer.clippingPlanes = [];
    const materials = new Set<any>();
    for (const room of Object.values(space.rooms) as any[]) room.scene.traverse((object: any) => {
      if (object.name === 'floor' || object.name === 'threshold') materials.add(object.material);
    });
    // Retain the full physical material, including sheen and reflections. Only
    // remove artwork/normal variation, which can legitimately differ in rotation.
    for (const material of materials) {
      material.map = material.normalMap = material.roughnessMap = null; material.color.set(0xffffff); material.needsUpdate = true;
    }
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType });
    const camera = new THREE.PerspectiveCamera(.01, 1, .001, 30), pixel = new Float32Array(4), samples: any[] = [];
    const read = (endpoint: any, lateral: number, eye: any) => {
      const p = portalPosition(endpoint.room, endpoint.side), n = wallNormal(endpoint.room, endpoint.side);
      // Detailed shadows can legitimately change across 3 mm. Probe a 0.2 mm
      // gap to isolate a discontinuity from the actual, now sharper gradient.
      const point = new THREE.Vector3(p.x - n.x * .0001 - n.z * lateral, 0, p.z - n.z * .0001 + n.x * lateral);
      camera.position.copy(eye); camera.lookAt(point); camera.updateMatrixWorld(true); space.lightTransfer.bind(endpoint.room);
      renderer.render(space.rooms[endpoint.room].scene, camera); renderer.readRenderTargetPixels(target, 0, 0, 1, 1, pixel);
      return Array.from(pixel.subarray(0, 3));
    };
    renderer.setRenderTarget(target);
    try {
      for (let c = 0; c < 6; c++) for (let y = 0; y < 3; y++) {
        const from = { room: 'C', side: c }, to = { room: 'E', side: y };
        app.game.world.balls.forEach((ball: any) => { ball.socket = null; });
        app.game.world.balls[0].socket = from; app.game.world.balls[1].socket = to; app.sync();
        // This test renders scenes directly, bypassing renderFrame's synchronous
        // update of the separate doorway shadow atlas.
        space.lightTransfer.direct.update();
        const p = portalPosition('C', c), n = wallNormal('C', c);
        for (const distance of [.8, 3]) {
          const eye = new THREE.Vector3(p.x - n.x * distance, 1.65, p.z - n.z * distance);
          const transformed = transformPoint(eye, from, to), otherEye = new THREE.Vector3(transformed.x, eye.y, transformed.z);
          for (const lateral of [-.88, -.5, 0, .5, .88]) {
            const a = read(from, lateral, eye), b = read(to, -lateral, otherEye);
            samples.push({ c, y, distance, lateral, difference: Math.max(...a.map((v, i) => Math.abs(v - b[i]))) });
          }
        }
      }
      return { samples, error: renderer.getContext().getError() };
    } finally { renderer.setRenderTarget(null); target.dispose(); }
  });
  console.log('Full carpet lighting at C–Y joins:', [...result.samples].sort((a, b) => b.difference - a.difference).slice(0, 5));
  expect(result.samples).toHaveLength(180);
  for (const sample of result.samples) expect(sample.difference, JSON.stringify(sample)).toBeLessThan(.001);
  expect(result.error).toBe(0); expect(errors).toEqual([]);
});
