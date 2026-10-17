import { test, expect } from '@playwright/test';

test('baked diffuse bounce visibly lights the ceiling without extra render passes', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const result = await page.evaluate(() => {
    const app = window.__samewhere, space = app.space, gl = space.renderer.getContext();
    Object.assign(app.game.player, { room: 'A', x: 0, z: 0, yaw: 0, pitch: .9 });
    const texture = space.lightTransfer.fields.A.panel, data = texture.image.data, saved = data.slice();
    const read = () => {
      space.render();
      const pixel = new Uint8Array(4);
      gl.readPixels(Math.floor(gl.drawingBufferWidth / 2), Math.floor(gl.drawingBufferHeight / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return Array.from(pixel.subarray(0, 3));
    };
    const lit = read(), passes = space.passes;
    for (let i = 0; i < data.length; i++) if (i % 4) data[i] = 0;
    texture.needsUpdate = true; const unlit = read(), unlitPasses = space.passes;
    data.set(saved); texture.needsUpdate = true; const restored = read();
    return { lit, unlit, restored, passes, unlitPasses, error: gl.getError() };
  });
  console.log('Ceiling diffuse bounce:', result);
  expect(result.lit[0] - result.unlit[0]).toBeGreaterThan(10);
  expect(result.restored).toEqual(result.lit); expect(result.unlitPasses).toBe(result.passes);
  expect(result.error).toBe(0); expect(errors).toEqual([]);
});

test('floor illumination stays continuous across polygonal passages and H entrances', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  // Center a pixel on the sample ray. Nearby 1.5 mm probes isolate the seam
  // from a legitimate, stronger light gradient across a two-centimeter gap.
  await page.setViewportSize({ width: 1441, height: 961 });
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const result = await page.evaluate(async () => {
    const path = '/src/world.ts', { portalPosition, wallNormal, ROOMS } = await import(path);
    const app = window.__samewhere, space = app.space, gl = space.renderer.getContext();
    // Isolate illumination from independently oriented carpet fibers/texture.
    const finishes = new Set<any>();
    for (const room of Object.values(space.rooms) as any[]) {
      room.scene.environment = null;
      room.scene.traverse((mesh: any) => { if (mesh.name === 'floor' || mesh.name === 'threshold') finishes.add(mesh.material); });
    }
    for (const material of finishes) {
      material.color.set(0xffffff); material.map = material.normalMap = material.roughnessMap = material.envMap = null;
      material.roughness = 1; material.sheen = 0; material.needsUpdate = true;
    }
    const read = (endpoint: any, lateral: number) => {
      const p = portalPosition(endpoint.room, endpoint.side), n = wallNormal(endpoint.room, endpoint.side);
      Object.assign(app.game.player, { room: endpoint.room, x: p.x - n.x * .0015 - n.z * lateral,
        z: p.z - n.z * .0015 + n.x * lateral, yaw: 0, pitch: -Math.PI / 2 });
      space.render();
      const pixels = new Uint8Array(4);
      gl.readPixels(Math.floor(gl.drawingBufferWidth / 2), Math.floor(gl.drawingBufferHeight / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return Array.from(pixels.subarray(0, 3));
    };
    const samples: any[] = [];
    for (const room of ['B', 'C']) for (let side = 0; side < ROOMS[room].sides; side++) {
      const from = { room, side }, to = { room: 'G', side: side % 4 };
      app.game.world.balls[0].socket = from; app.game.world.balls[1].socket = to;
      app.game.world.balls[2].socket = app.game.world.balls[3].socket = null; app.sync();
      for (let i = 0; i < 22; i++) space.render();
      for (const lateral of [-.5, 0, .5]) {
        const before = read(from, lateral), after = read(to, -lateral);
        samples.push({ room, side, lateral, before, after, max: Math.max(...before.map((value, c) => Math.abs(value - after[c]))) });
      }
    }
    return { samples, error: gl.getError() };
  });
  console.log('Passage lighting continuity:', result.samples.map(({ room, side, lateral, max }) => ({ room, side, lateral, max })));
  expect(result.samples).toHaveLength(33);
  for (const sample of result.samples) expect(sample.max, JSON.stringify(sample)).toBeLessThanOrEqual(2);
  expect(result.error).toBe(0); expect(errors).toEqual([]);
});

test('startup preparation keeps the displayed room visible without black frames', async ({ page }) => {
  await page.addInitScript(() => {
    const samples: { time: number; luma: number; preparing: boolean }[] = [];
    Object.assign(window, { __startupFrames: samples });
    const getContext = HTMLCanvasElement.prototype.getContext;
    (HTMLCanvasElement.prototype as any).getContext = function(this: HTMLCanvasElement, ...args: any[]) {
      const gl = (getContext as any).apply(this, args);
      if (this.id !== 'game' || args[0] !== 'webgl2' || !gl) return gl;
      let pending = false;
      const sample = () => {
        if (pending || gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) !== null) return;
        pending = true;
        // Observe the complete synchronous draw, before browser compositing can
        // discard a non-preserved WebGL drawing buffer. Offscreen work is ignored.
        queueMicrotask(() => {
          pending = false;
          const previous = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), pixel = new Uint8Array(4);
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
          let total = 0;
          for (const x of [.2, .5, .8]) for (const y of [.25, .5, .75]) {
            gl.readPixels(Math.floor(gl.drawingBufferWidth * x), Math.floor(gl.drawingBufferHeight * y), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
            total += pixel[0] + pixel[1] + pixel[2];
          }
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previous);
          samples.push({ time: performance.now(), luma: total / 27, preparing: !!window.__samewhere?.space?.compiling });
        });
      };
      for (const name of ['clear', 'drawArrays', 'drawElements']) {
        const original = gl[name].bind(gl);
        gl[name] = (...parameters: any[]) => { const result = original(...parameters); sample(); return result; };
      }
      return gl;
    };
  });
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const result = await page.evaluate(() => {
    const frames = (window as any).__startupFrames as { time: number; luma: number; preparing: boolean }[];
    const firstVisible = frames.findIndex(frame => frame.luma > 5), visible = frames.slice(firstVisible);
    return { frames: frames.length, firstVisible, preparingFrames: frames.filter(frame => frame.preparing).length,
      black: visible.filter(frame => frame.luma < 1), last: frames.at(-1) };
  });
  console.log('Startup frame continuity:', result);
  expect(result.firstVisible).toBeGreaterThanOrEqual(0); expect(result.preparingFrames).toBeGreaterThanOrEqual(5);
  expect(result.black).toEqual([]); expect(result.last!.luma).toBeGreaterThan(5);
});

test('each launch computes all lighting in one worker without fetching an asset', async ({ page }) => {
  const errors: string[] = [], requests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/\/lighting\/|\.bin\.gz(?:\?|$)/.test(request.url())) requests.push(request.url()); });
  const launches = [];
  for (let launch = 0; launch < 2; launch++) {
    await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
    await expect(page.locator('#play-button')).toBeDisabled();
    const responsiveFrames = await page.evaluate(async () => {
      const light = window.__samewhere.space.lightTransfer;
      let frames = 0, pending = true;
      const heartbeat = () => { if (pending) { frames++; requestAnimationFrame(heartbeat); } };
      requestAnimationFrame(heartbeat);
      await light.ready; pending = false; return frames;
    });
    await page.evaluate(() => window.__samewhere.space.ready);
    await expect(page.locator('#play-button')).toBeEnabled();
    launches.push({ responsiveFrames, ...await page.evaluate(() => {
      const light = window.__samewhere.space.lightTransfer;
      const buffers: any[] = Object.values(light.fields).flatMap((field: any) => field.buffers);
      return { fields: light.cacheSize, jobs: light.jobs, bakeMs: light.lastBakeMs, bytes: light.preparedBytes,
        twoDimensional: buffers.every(buffer => buffer.texture.isDataTexture && !buffer.texture.isData3DTexture),
        textureBytes: buffers.reduce((sum, buffer) => sum + buffer.texture.image.data.byteLength, 0) };
    }) });
  }
  console.log('Startup lighting calculation:', launches);
  for (const launch of launches) {
    expect(launch.fields).toBe(812); expect(launch.jobs).toBe(1); expect(launch.bakeMs).toBeGreaterThan(0);
    expect(launch.responsiveFrames).toBeGreaterThan(0); expect(launch.bytes).toBeLessThan(8 * 1024 * 1024);
    expect(launch.twoDimensional).toBe(true); expect(launch.textureBytes).toBeLessThan(4 * 1024 * 1024);
  }
  expect(requests).toEqual([]); expect(errors).toEqual([]);
});

test('a calculation failure reports an error and keeps entry disabled', async ({ page }) => {
  await page.route(url => url.pathname.endsWith('/light-transfer-worker.ts') && url.searchParams.has('worker_file'),
    route => route.fulfill({ contentType: 'text/javascript', body: "self.onmessage = () => self.postMessage({ error: 'Test lighting failure' });" }));
  await page.goto('/');
  await expect(page.locator('#error')).toBeVisible();
  await expect(page.locator('#error')).toContainText('Не удалось подготовить пространство');
  await expect(page.locator('#play-button')).toBeDisabled();
  const result = await page.evaluate(() => {
    const light = window.__samewhere.space.lightTransfer; return { jobs: light.jobs, fields: light.cacheSize };
  });
  expect(result).toEqual({ jobs: 1, fields: 0 });
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
      bakeMs: light.lastBakeMs, cache: light.cacheSize, error: gl.getError() };
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
  expect(result.after).toEqual(result.before); expect(result.cache).toBe(812); expect(result.bytes).toBeLessThan(8 * 1024 * 1024); expect(result.error).toBe(0);
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
