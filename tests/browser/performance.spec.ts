import { test, expect } from '@playwright/test';

test('startup prepares every room; ball changes only invalidate affected spotlights', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const result = await page.evaluate(async () => {
    const app = window.__samewhere, space = app.space, renderer = space.renderer;
    const rooms: any[] = Object.values(space.rooms);
    const dirty = () => Object.fromEntries(Object.entries(space.rooms).map(([id, room]: [string, any]) => [id, room.shadowLights.filter((light: any) => light.shadow.needsUpdate).length]));
    const maps = rooms.flatMap(room => room.shadowLights.map((light: any) => ({ allocated: !!light.shadow.map, size: light.shadow.map?.width, dirty: light.shadow.needsUpdate })));
    app.sync(); app.game.world.selected = 'blue'; app.sync();
    const unchanged = dirty(), before = { geometries: renderer.info.memory.geometries, programs: renderer.info.programs.length };
    // The first visit to any room must reuse uploaded buffers and compiled shaders.
    for (const room of Object.keys(space.rooms)) {
      Object.assign(app.game.player, { room, x: 0, z: 1.3, yaw: 0, pitch: -.3 }); space.render();
    }
    const after = { geometries: renderer.info.memory.geometries, programs: renderer.info.programs.length };
    // Keep an open passage in the hub while toggling a ball on another pedestal.
    app.game.world.balls[0].socket = { room: 'A', side: 0 };
    app.game.world.balls[1].socket = { room: 'G', side: 0 }; app.sync();
    for (const room of Object.keys(space.rooms)) { app.game.player.room = room; space.render(); }
    Object.assign(app.game.player, { room: 'G', x: -3.6, z: 5.5, yaw: 0, pitch: -.3 }); space.render();
    const steadyDraws = space.drawCalls;
    const action = app.game.interact({ room: 'C', side: 3 }); app.sync();
    const changed = dirty(); space.render(); const actionDraws = space.drawCalls;
    const pending = [Object.values(dirty()).reduce((sum: number, count: any) => sum + count, 0)];
    for (let i = 0; i < 3; i++) { space.render(); pending.push(Object.values(dirty()).reduce((sum: number, count: any) => sum + count, 0)); }
    await pageYield();
    return { maps, unchanged, before, after, action, changed, steadyDraws, actionDraws, pending, error: renderer.getContext().getError() };
    function pageYield() { return new Promise<void>(resolve => requestAnimationFrame(() => resolve())); }
  });
  console.log('Prepared resources and selective shadows:', result);
  expect(result.maps).toHaveLength(20);
  expect(result.maps.every(map => map.allocated && map.size === 1024 && !map.dirty)).toBe(true);
  expect(Object.values(result.unchanged).every(count => count === 0)).toBe(true);
  expect(result.after).toEqual(result.before);
  expect(result.action).toBe('take');
  expect(result.changed).toEqual({ A: 0, B: 2, C: 2, D: 0, E: 0, F: 0, G: 4 });
  expect(result.actionDraws).toBeLessThan(result.steadyDraws + 50);
  expect(result.pending).toEqual([3, 2, 1, 0]);
  expect(result.error).toBe(0);
});

test('batched and selectively cached shadows match a full redraw of the original meshes', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const result = await page.evaluate(async () => {
    const path = '/src/world.ts', { ROOM_IDS, ROOMS } = await import(path);
    const app = window.__samewhere, space = app.space, renderer = space.renderer, gl = renderer.getContext();
    const optimized = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4), reference = new Uint8Array(optimized.length);
    let total = 0, changed = 0, max = 0, comparisons = 0;
    const differences: unknown[] = [];
    function compare(id: string, label: string, controls = id) {
      const pedestal = ROOMS[id].pedestals.find((p: any) => p.controls === controls) ?? ROOMS[id].pedestals[0];
      Object.assign(app.game.player, { room: id, x: pedestal.x + .1, z: pedestal.z + 1.8, yaw: .08, pitch: -.5 });
      // First render the cached result; then force an independent reference
      // shadow pass using the original meshes, bypassing the batched scene.
      space.render(); gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, optimized);
      const room = space.rooms[id], batched = room.shadows.scene.children;
      room.shadows.scene.children = room.scene.children;
      for (const light of room.shadowLights) light.shadow.needsUpdate = true;
      try { space.render(); gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, reference); }
      finally { room.shadows.scene.children = batched; }
      let deltaSum = 0, different = 0, peak = 0;
      for (let i = 0; i < optimized.length; i++) {
        const delta = Math.abs(optimized[i] - reference[i]); deltaSum += delta; peak = Math.max(peak, delta); if (delta > 1) different++;
      }
      total += deltaSum; changed += different; max = Math.max(max, peak); comparisons++;
      if (different) differences.push({ room: id, state: label, mean: deltaSum / optimized.length, changed: different / optimized.length, max: peak });
    }
    // Every doorway switches open/closed and its balls change in the room and
    // on the shared hub pedestal. Compare each change before forcing a refresh.
    for (const id of ROOM_IDS) {
      for (let side = 0; side < ROOMS[id].sides; side++) {
        app.game.world.balls.forEach((ball: any) => { ball.socket = null; });
        app.game.world.balls[0].socket = { room: id, side };
        app.game.world.balls[1].socket = { room: id, side: (side + 1) % ROOMS[id].sides }; app.sync();
        compare(id, `${id}${side}`); if (id !== 'G') compare('G', `${id}${side}`, id);
      }
    }
    app.reset(); app.game.interact({ room: 'C', side: 3 }); app.sync(); app.undo();
    for (const id of ROOM_IDS) compare(id, 'undo');
    app.reset(); for (const id of ROOM_IDS) compare(id, 'reset');
    return { mean: total / (comparisons * optimized.length), changed: changed / (comparisons * optimized.length), max, comparisons, differences, error: gl.getError() };
  });
  console.log('Original vs batched shadow comparison:', result);
  expect(result.comparisons).toBe(68);
  // Baking transforms into float32 can round a shadow edge by a subpixel.
  expect(result.mean).toBeLessThan(.01); expect(result.changed).toBeLessThan(.0001);
  expect(result.error).toBe(0);
});

test('wall occlusion avoids hidden portal views without changing their visible pixels', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const result = await page.evaluate(async () => {
    const path = '/src/world.ts', { canStand, portalPosition } = await import(path);
    const app = window.__samewhere, space = app.space, gl = space.renderer.getContext();
    const optimized = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4), reference = new Uint8Array(optimized.length);
    const original = space.portalOccluded.bind(space);
    let total = 0, changed = 0, culled = 0, savedPasses = 0, comparisons = 0, seed = 87421;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    try {
      for (const room of ['E', 'F', 'G']) {
        const layouts = [
          [{ room, side: 0 }, { room, side: 2 }, null, null],
          [{ room, side: 0 }, { room, side: 1 }, null, null],
          [{ room, side: 0 }, { room: 'B', side: 2 }, { room, side: 2 }, { room: 'A', side: 0 }],
        ];
        for (const layout of layouts) {
          app.game.world.balls.forEach((ball: any, i: number) => { ball.socket = layout[i]; }); app.sync();
          for (let i = 0; i < 20; i++) {
            let x: number, z: number;
            do { x = random() * 13 - 6.5; z = random() * 13 - 6.5; } while (!canStand(room, { x, z }, .05));
            const target = portalPosition(room, i % 3);
            Object.assign(app.game.player, { room, x, z, yaw: Math.atan2(x - target.x, z - target.z) + (random() - .5), pitch: (random() - .5) * .8 });
            space.portalOccluded = original; space.render(); culled += space.occludedPortals; const passes = space.passes;
            gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, optimized);
            space.portalOccluded = () => false; space.render(); savedPasses += space.passes - passes;
            gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, reference);
            for (let j = 0; j < optimized.length; j++) {
              const delta = Math.abs(optimized[j] - reference[j]); total += delta; if (delta > 1) changed++;
            }
            comparisons++;
          }
        }
      }
    } finally { space.portalOccluded = original; }
    return { mean: total / (comparisons * optimized.length), changed: changed / (comparisons * optimized.length), comparisons, culled, savedPasses, error: gl.getError() };
  });
  console.log('Hidden portal comparison:', result);
  expect(result.comparisons).toBe(180); expect(result.culled).toBeGreaterThan(0); expect(result.savedPasses).toBeGreaterThan(0);
  expect(result.mean).toBeLessThan(.001); expect(result.changed).toBeLessThan(.0001); expect(result.error).toBe(0);
});
