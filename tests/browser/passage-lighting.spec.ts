import { test, expect } from '@playwright/test';

test('square self-links and hub links keep both halves of each jamb evenly lit', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const result = await page.evaluate(async () => {
    const threePath = '/node_modules/three/build/three.module.js', worldPath = '/src/world.ts';
    const THREE = await import(threePath), { portalPosition, wallNormal, transformPoint } = await import(worldPath);
    const { game, space, sync } = window.__samewhere, renderer = space.renderer;
    space.render = () => {}; renderer.clippingPlanes = [];
    const materials = new Set<any>();
    for (const room of Object.values(space.rooms) as any[]) room.scene.traverse((object: any) => {
      if (object.name === 'room-wall' || object.name === 'boundary-wall') materials.add(object.material);
    });
    for (const material of materials) {
      material.map = material.normalMap = material.roughnessMap = null;
      material.color.set(0xffffff); material.roughness = 1; material.needsUpdate = true;
    }
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType });
    const camera = new THREE.PerspectiveCamera(.001, 1, .001, 40), pixel = new Float32Array(4), samples: any[] = [];
    const srgb = (value: number) => Math.round(255 * (value <= .0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - .055));
    const read = (endpoint: any, lateral: number, height: number, eye: any) => {
      const p = portalPosition(endpoint.room, endpoint.side), n = wallNormal(endpoint.room, endpoint.side);
      const point = new THREE.Vector3(p.x - n.x * .0001 - n.z * lateral, height, p.z - n.z * .0001 + n.x * lateral);
      camera.position.copy(eye); camera.lookAt(point); camera.updateMatrixWorld(true);
      space.lightTransfer.bind(endpoint.room); renderer.setRenderTarget(target);
      renderer.render(space.rooms[endpoint.room].scene, camera); renderer.readRenderTargetPixels(target, 0, 0, 1, 1, pixel);
      if (Math.max(...pixel.subarray(0, 3)) < .005) throw new Error('The jamb lighting probe did not render');
      return Array.from(pixel.subarray(0, 3), srgb);
    };
    try {
      for (let side = 0; side < 4; side++) for (const to of [
        ...[0, 1, 2, 3].filter(other => other > side).map(other => ({ room: 'A', side: other })),
        ...[0, 1, 2, 3].map(other => ({ room: 'G', side: other })),
      ]) {
        const from = { room: 'A', side };
        game.world.balls.forEach((ball: any) => { ball.socket = null; });
        game.world.balls[0].socket = from; game.world.balls[1].socket = to; sync(); space.lightTransfer.direct.update();
        const p = portalPosition('A', side), n = wallNormal('A', side);
        const eye = new THREE.Vector3(p.x - n.x * .8, 1.65, p.z - n.z * .8), q = transformPoint(eye, from, to);
        const otherEye = new THREE.Vector3(q.x, eye.y, q.z);
        for (const lateral of [-.9, .9]) for (const height of [.02, .1, .5, 1.2, 1.65, 2.3, 2.55, 2.59]) {
          const a = read(from, lateral, height, eye), b = read(to, -lateral, height, otherEye);
          samples.push({ from, to, lateral, height, difference: Math.max(...a.map((value, i) => Math.abs(value - b[i]))) });
        }
      }
      return { samples, error: renderer.getContext().getError() };
    } finally { renderer.setRenderTarget(null); target.dispose(); }
  });
  console.log('Jamb lighting seams:', [...result.samples].sort((a, b) => b.difference - a.difference).slice(0, 5));
  expect(result.samples).toHaveLength(352);
  for (const sample of result.samples) expect(sample.difference, JSON.stringify(sample)).toBeLessThanOrEqual(2);
  expect(result.error).toBe(0);
});

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
