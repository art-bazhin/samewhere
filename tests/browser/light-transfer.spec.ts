import { test, expect } from '@playwright/test';

test('neighbor light changes the receiving floor without extra render passes or walking-time updates', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const result = await page.evaluate(async () => {
    const app = window.__samewhere, space = app.space, light = space.lightTransfer, gl = space.renderer.getContext();
    app.game.world.balls[0].socket = { room: 'A', side: 0 }; app.game.world.balls[1].socket = { room: 'G', side: 0 };
    app.game.world.balls[2].socket = app.game.world.balls[3].socket = null; app.sync(); await light.whenSettled();
    Object.assign(app.game.player, { room: 'A', x: 1.6, z: -3, yaw: .6, pitch: -.85 });
    // Drain the bounded background shadow preparation before comparing draw calls.
    for (let i = 0; i < 20; i++) space.render();
    const read = () => {
      const data = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
      gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, data); return data;
    };
    light.enabled = false; space.render(); const off = read(), offPasses = space.passes, offDraws = space.drawCalls;
    light.enabled = true; space.render(); const on = read(), onPasses = space.passes, onDraws = space.drawCalls;
    let sum = 0, changed = 0, max = 0;
    for (let i = 0; i < on.length; i++) { const delta = on[i] - off[i]; sum += delta; max = Math.max(max, delta); if (delta > 1) changed++; }
    const jobs = light.jobs, revision = light.revision, versions = Object.values(light.fields).map((field: any) => field.texture.version);
    for (let i = 0; i < 30; i++) {
      app.game.move({ x: .01, z: .01 }); app.game.player.yaw += .01;
      app.game.world.selected = i % 2 ? 'red' : 'blue'; app.sync(); space.render();
    }
    const unchanged = jobs === light.jobs && revision === light.revision && versions.every((version, i) => version === (Object.values(light.fields)[i] as any).texture.version);
    light.bind('F'); const unconnectedGain = light.uniforms.transferGain.value;
    const redVersions = [light.fields.A.texture.version, light.fields.G.texture.version];
    app.game.world.balls[2].socket = { room: 'C', side: 0 }; app.game.world.balls[3].socket = { room: 'C', side: 3 };
    app.sync(); await light.whenSettled();
    const unrelatedUnchanged = redVersions[0] === light.fields.A.texture.version && redVersions[1] === light.fields.G.texture.version;
    // Closing a passage disables its cached field immediately, before the worker replies.
    app.game.interact({ room: 'G', side: 0 }); app.sync(); light.bind('A'); const closedGain = light.uniforms.transferGain.value;
    await light.whenSettled(); app.undo(); await light.whenSettled(); light.bind('A');
    return { meanAdded: sum / on.length, changed, max, offPasses, onPasses, offDraws, onDraws, unchanged, unrelatedUnchanged, unconnectedGain, closedGain,
      restoredGain: light.uniforms.transferGain.value, maps: Object.values(space.rooms).reduce((sum: number, room: any) => sum + room.shadowLights.length, 0),
      bakeMs: light.lastBakeMs, cache: light.cacheSize, error: gl.getError() };
  });
  console.log('Neighbor diffuse lighting:', result);
  expect(result.meanAdded).toBeGreaterThan(.05); expect(result.changed).toBeGreaterThan(1000); expect(result.max).toBeGreaterThan(4);
  expect(result.onPasses).toBe(result.offPasses); expect(result.onDraws).toBe(result.offDraws); expect(result.maps).toBe(20);
  expect(result.unchanged).toBe(true); expect(result.unrelatedUnchanged).toBe(true);
  expect(result.unconnectedGain).toBe(0); expect(result.closedGain).toBe(0); expect(result.restoredGain).toBe(1);
  expect(result.cache).toBeLessThanOrEqual(24); expect(result.error).toBe(0); expect(errors).toEqual([]);
});

test('rapid reconnection uses the latest field and reuses textures and shader programs', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const result = await page.evaluate(async () => {
    const app = window.__samewhere, space = app.space, light = space.lightTransfer;
    const before = { ...space.renderer.info.memory, programs: space.renderer.info.programs.length }, jobs = light.jobs;
    app.game.world.balls[2].socket = app.game.world.balls[3].socket = null;
    for (let i = 0; i < 12; i++) {
      app.game.world.balls[0].socket = { room: 'A', side: i % 4 };
      app.game.world.balls[1].socket = { room: i % 2 ? 'G' : 'C', side: i % 4 }; app.sync();
    }
    await light.whenSettled();
    const valid = ['A', 'G'].every(room => light.fields[room].key === light.fields[room].expected && !!light.fields[room].expected);
    Object.assign(app.game.player, { room: 'A', x: 0, z: 0, yaw: 0, pitch: -.2 }); space.render();
    return { before, after: { ...space.renderer.info.memory, programs: space.renderer.info.programs.length }, valid,
      key: light.fields.A.expected, jobs: light.jobs - jobs, cache: light.cacheSize, error: space.renderer.getContext().getError() };
  });
  console.log('Coalesced lighting changes:', result);
  expect(result.valid).toBe(true); expect(result.key).toBe('A3<G3'); expect(result.jobs).toBeLessThanOrEqual(2);
  expect(result.after).toEqual(result.before); expect(result.cache).toBeLessThanOrEqual(24); expect(result.error).toBe(0);
});

test('a surviving doorway keeps identical floor lighting while another connection is removed or added', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const result = await page.evaluate(async () => {
    const app = window.__samewhere, space = app.space, light = space.lightTransfer, gl = space.renderer.getContext();
    // Prime a different cached subset first. It must never displace the light
    // already visible when that old connection is opened again later.
    app.game.world.balls[0].socket = app.game.world.balls[1].socket = null;
    app.game.world.balls[2].socket = { room: 'A', side: 1 }; app.game.world.balls[3].socket = { room: 'F', side: 2 };
    app.sync(); await light.whenSettled();
    const sockets = [{ room: 'A', side: 0 }, { room: 'G', side: 0 }, { room: 'A', side: 1 }, { room: 'C', side: 0 }];
    app.game.world.balls.forEach((ball: any, index: number) => { ball.socket = sockets[index]; }); app.sync(); await light.whenSettled();
    Object.assign(app.game.player, { room: 'A', x: 1.6, z: -3, yaw: .6, pitch: -.85 });
    for (let i = 0; i < 20; i++) space.render();
    const read = () => {
      const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
      gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels); return pixels;
    };
    const added = (on: Uint8Array, off: Uint8Array) => on.reduce((sum, value, index) => sum + value - off[index], 0) / on.length;
    const post = light.worker.postMessage.bind(light.worker);
    let held: any = null;
    const hold = () => { light.worker.postMessage = (request: any) => { held = request; }; };
    const release = () => { light.worker.postMessage = post; if (held) { post(held); held = null; } };
    try {
      // Deliberately stop the worker: the pending frame must already have the
      // exact red-only field, rather than one dark frame followed by relighting.
      hold(); app.game.interact({ room: 'C', side: 0 }); app.sync(); space.render();
      const immediate = read(), removalKey = light.fields.A.key, removalGain = light.uniforms.transferGain.value, version = light.fields.A.texture.version;
      light.enabled = false; space.render(); const off = read(); light.enabled = true;
      release(); await light.whenSettled(); space.render(); const settled = read();
      let difference = 0; for (let i = 0; i < settled.length; i++) difference += Math.abs(immediate[i] - settled[i]);
      const noSecondUpload = version === light.fields.A.texture.version;
      // This combination is uncached, although its blue-only subset is cached.
      // It must preserve the visible red field until their combined field is ready.
      hold(); app.game.interact({ room: 'F', side: 2 }); app.sync(); space.render();
      const addition = read(), additionKey = light.fields.A.key;
      light.enabled = false; space.render(); const additionOff = read(); light.enabled = true;
      release(); await light.whenSettled();
      return { removalKey, removalGain, removalAdded: added(immediate, off), difference: difference / immediate.length, noSecondUpload,
        additionKey, additionAdded: added(addition, additionOff), settledKey: light.fields.A.key, expected: light.fields.A.expected, error: gl.getError() };
    } finally { release(); }
  });
  console.log('Lighting during delayed recalculation:', result);
  expect(result.removalKey).toBe('A0<G0'); expect(result.removalGain).toBe(1); expect(result.removalAdded).toBeGreaterThan(.05);
  expect(result.difference).toBeLessThan(.001); expect(result.noSecondUpload).toBe(true);
  expect(result.additionKey).toBe('A0<G0'); expect(result.additionAdded).toBeGreaterThan(.05);
  expect(result.settledKey).toBe(result.expected); expect(result.settledKey).toContain('A1<F2'); expect(result.settledKey).not.toContain('C0');
  expect(result.error).toBe(0);
});

test('cache eviction retains the subsets needed to remove a connection after many rearrangements', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const result = await page.evaluate(async () => {
    const app = window.__samewhere, space = app.space, light = space.lightTransfer;
    app.game.world.balls[0].socket = { room: 'C', side: 0 }; app.game.world.balls[1].socket = { room: 'G', side: 0 };
    for (let i = 0; i < 12; i++) {
      app.game.world.balls[2].socket = { room: 'C', side: 1 + Math.floor(i / 4) };
      app.game.world.balls[3].socket = { room: 'A', side: i % 4 }; app.sync(); await light.whenSettled();
    }
    const hasRed = light.snapshots.has('C0<G0');
    app.game.interact({ room: 'A', side: 3 }); app.sync(); light.bind('C');
    const immediateKey = light.fields.C.key, gain = light.uniforms.transferGain.value;
    await light.whenSettled();
    return { hasRed, immediateKey, gain, snapshots: light.snapshots.size, bytes: light.snapshotBytes, sourceCache: light.cacheSize };
  });
  console.log('Bounded lighting subset cache:', result);
  expect(result.hasRed).toBe(true); expect(result.immediateKey).toBe('C0<G0'); expect(result.gain).toBe(1);
  expect(result.snapshots).toBeLessThanOrEqual(32); expect(result.bytes).toBeLessThanOrEqual(20 * 1024 * 1024); expect(result.sourceCache).toBeLessThanOrEqual(24);
});
