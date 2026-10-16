import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import manifest from '../../src/light-transfer-manifest.json' with { type: 'json' };

test('each launch loads saved lighting without ray tracing', async ({ page }) => {
  const errors: string[] = [], requests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/\/lighting\/transfer-.*\.bin\.gz$/.test(request.url())) requests.push(request.url()); });
  const launches = [];
  for (let launch = 0; launch < 2; launch++) {
    // Exercise both HTTP gzip (decoded by fetch) and a raw .gz file on a
    // static host (decoded by the worker), across separate launches.
    if (launch === 1) await page.route('**/lighting/transfer-*.bin.gz', route => route.fulfill({
      path: fileURLToPath(new URL(`../../public/${manifest.url}`, import.meta.url)), contentType: 'application/gzip',
    }));
    await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
    await page.evaluate(() => window.__samewhere.space.ready);
    await expect(page.locator('#play-button')).toBeEnabled();
    launches.push(await page.evaluate(() => {
      const light = window.__samewhere.space.lightTransfer;
      const buffers: any[] = Object.values(light.fields).flatMap((field: any) => field.buffers);
      return { fields: light.cacheSize, jobs: light.jobs, loadMs: light.lastLoadMs, bytes: light.preparedBytes,
        twoDimensional: buffers.every(buffer => buffer.texture.isDataTexture && !buffer.texture.isData3DTexture),
        textureBytes: buffers.reduce((sum, buffer) => sum + buffer.texture.image.data.byteLength, 0) };
    }));
  }
  console.log('Loading saved lighting:', launches);
  for (const launch of launches) {
    expect(launch.fields).toBe(812); expect(launch.jobs).toBe(0); expect(launch.loadMs).toBeGreaterThan(0);
    expect(launch.bytes).toBeLessThan(4 * 1024 * 1024);
    expect(launch.twoDimensional).toBe(true); expect(launch.textureBytes).toBe(1572864);
  }
  expect(requests).toHaveLength(2); expect(new Set(requests).size).toBe(1); expect(errors).toEqual([]);
});

test('missing lighting data reports a startup error instead of silently recalculating', async ({ page }) => {
  await page.route('**/lighting/transfer-*.bin.gz', route => route.fulfill({ status: 404, body: 'Not found' }));
  await page.goto('/');
  await expect(page.locator('#error')).toBeVisible();
  await expect(page.locator('#error')).toContainText('Не удалось подготовить пространство');
  await expect(page.locator('#play-button')).toBeDisabled();
  expect(await page.evaluate(() => window.__samewhere.space.lightTransfer.jobs)).toBe(0);
});

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
    // Closing a passage disables its cached field immediately.
    app.game.interact({ room: 'G', side: 0 }); app.sync(); light.bind('A'); const closedGain = light.uniforms.transferGain.value;
    await light.whenSettled(); app.undo(); await light.whenSettled(); light.bind('A');
    return { meanAdded: sum / on.length, changed, max, offPasses, onPasses, offDraws, onDraws, unchanged, unrelatedUnchanged, unconnectedGain, closedGain,
      restoredGain: light.uniforms.transferGain.value, maps: Object.values(space.rooms).reduce((sum: number, room: any) => sum + room.shadowLights.length, 0),
      loadMs: light.lastLoadMs, cache: light.cacheSize, error: gl.getError() };
  });
  console.log('Neighbor diffuse lighting:', result);
  expect(result.meanAdded).toBeGreaterThan(.05); expect(result.changed).toBeGreaterThan(1000); expect(result.max).toBeGreaterThan(4);
  expect(result.onPasses).toBe(result.offPasses); expect(result.onDraws).toBe(result.offDraws); expect(result.maps).toBe(20);
  expect(result.unchanged).toBe(true); expect(result.unrelatedUnchanged).toBe(true);
  expect(result.unconnectedGain).toBe(0); expect(result.closedGain).toBe(0); expect(result.restoredGain).toBe(1);
  expect(result.cache).toBe(812); expect(result.error).toBe(0); expect(errors).toEqual([]);
});

test('all connections are prepared before play and reconnections apply lighting synchronously', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const result = await page.evaluate(async () => {
    const app = window.__samewhere, space = app.space, light = space.lightTransfer;
    const before = { ...space.renderer.info.memory, programs: space.renderer.info.programs.length }, jobs = light.jobs;
    let valid = true;
    app.game.world.balls[2].socket = app.game.world.balls[3].socket = null;
    // Previously each new combination needed a background calculation and a
    // later texture update. No async turn is allowed between these changes.
    for (let i = 0; i < 100; i++) {
      app.game.world.balls[0].socket = { room: 'A', side: i % 4 };
      app.game.world.balls[1].socket = { room: i % 2 ? 'G' : 'C', side: i % 4 }; app.sync();
      valid &&= Object.values(light.fields).every((field: any) => field.key === field.expected);
    }
    const versions = Object.values(light.fields).map((field: any) => field.texture.version);
    app.game.interact({ room: 'G', side: 3 }); app.sync();
    app.game.interact({ room: 'G', side: 3 }); app.sync();
    const reused = versions.every((version, i) => version === (Object.values(light.fields)[i] as any).texture.version);
    Object.assign(app.game.player, { room: 'A', x: 0, z: 0, yaw: 0, pitch: -.2 }); space.render();
    return { before, after: { ...space.renderer.info.memory, programs: space.renderer.info.programs.length }, valid,
      key: light.fields.A.expected, jobs: light.jobs - jobs, reused, cache: light.cacheSize, bytes: light.preparedBytes, error: space.renderer.getContext().getError() };
  });
  console.log('Precomputed connections and immediate lighting:', result);
  expect(result.valid).toBe(true); expect(result.key).toBe('A3<G3'); expect(result.jobs).toBe(0);
  expect(result.reused).toBe(true);
  expect(result.after).toEqual(result.before); expect(result.cache).toBe(812); expect(result.bytes).toBeLessThan(4 * 1024 * 1024); expect(result.error).toBe(0);
});

test('opening, closing and rearranging connections have their final light on the first frame', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const result = await page.evaluate(async () => {
    const app = window.__samewhere, space = app.space, light = space.lightTransfer, gl = space.renderer.getContext();
    Object.assign(app.game.player, { room: 'A', x: 1.6, z: -3, yaw: .6, pitch: -.85 });
    const sockets = [{ room: 'A', side: 0 }, { room: 'G', side: 0 }, { room: 'A', side: 1 }, { room: 'C', side: 0 }];
    app.game.world.balls.forEach((ball: any, index: number) => { ball.socket = sockets[index]; }); app.sync();
    const read = () => {
      const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
      gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels); return pixels;
    };
    const changes: any[] = [], jobs = light.jobs;
    for (const socket of [{ room: 'C', side: 0 }, { room: 'F', side: 2 }, { room: 'G', side: 0 }, { room: 'B', side: 2 }]) {
      app.game.interact(socket); app.sync(); space.render();
      const first = read(), key = light.fields.A.key, expected = light.fields.A.expected;
      const versions = Object.values(light.fields).map((field: any) => field.texture.version);
      for (let frame = 0; frame < 6; frame++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      space.render(); const later = read(); let difference = 0;
      for (let i = 0; i < first.length; i++) difference += Math.abs(first[i] - later[i]);
      changes.push({ key, expected, difference: difference / first.length,
        unchanged: versions.every((version, i) => version === (Object.values(light.fields)[i] as any).texture.version) });
    }
    return { changes, jobs: light.jobs - jobs, error: gl.getError() };
  });
  console.log('First-frame vs later lighting:', result);
  for (const change of result.changes) {
    expect(change.key).toBe(change.expected); expect(change.difference).toBe(0); expect(change.unchanged).toBe(true);
  }
  expect(result.jobs).toBe(0); expect(result.error).toBe(0);
});
