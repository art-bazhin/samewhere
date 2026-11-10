import { test, expect } from '@playwright/test';
import { createBounceSampler } from '../../src/panel-light-bake';
import { roomWalls, type RoomId } from '../../src/world';

test('baked diffuse bounce visibly lights the ceiling without extra render passes', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const result = await page.evaluate(() => {
    const app = window.__samewhere, space = app.space, gl = space.renderer.getContext();
    Object.assign(app.game.player, { room: 'A', x: 0, z: 0, yaw: 0, pitch: .9 });
    // Measure baked energy independently of the temporary x100 relief setting.
    // Normal-map response is covered by directional-light.spec.ts.
    space.rooms.A.scene.getObjectByName('ceiling').material.normalScale.setScalar(0);
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

test('baked wall bounce matches dense integration above the floor', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const result = await page.evaluate(async () => {
    const path = '/node_modules/three/build/three.module.js', worldPath = '/src/world.ts';
    const THREE = await import(path), { roomWalls } = await import(worldPath);
    const app = window.__samewhere, space = app.space, renderer = space.renderer;
    app.game.world.balls.forEach((ball: any) => { ball.socket = null; }); app.sync();
    const material = space.assets.materials.wall, before = material.onBeforeCompile, key = material.customProgramCacheKey;
    const render = space.render, clipping = renderer.clippingPlanes;
    space.render = () => {}; renderer.clippingPlanes = [];
    // Isolate the baked reflection from wallpaper, direct shadows and the
    // deliberately narrow contact profile; keep the actual wall atlas UVs.
    material.onBeforeCompile = (shader: any, context: any) => {
      before.call(material, shader, context);
      shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>',
        'outgoingLight = sampleSurfaceLightmap(panelLight, vTransferUv).gba;\n#include <opaque_fragment>');
    };
    material.customProgramCacheKey = () => `${key.call(material)}:wall-floor-bounce-probe`; material.needsUpdate = true;
    const camera = new THREE.OrthographicCamera(-.0001, .0001, .0001, -.0001, .001, 2);
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType }), pixel = new Float32Array(4);
    renderer.setRenderTarget(target);
    try {
      const profiles: { room: string; side: number; along: number; base: number; higher: number }[] = [];
      for (const id of ['A', 'B', 'C', 'D']) {
        space.lightTransfer.bind(id);
        for (const [side, wall] of roomWalls(id).entries()) for (const along of id === 'A' ? [.2, .5, .8] : [.1, .3, .5, .7, .9]) {
          const x = wall.a.x + (wall.b.x - wall.a.x) * along, z = wall.a.z + (wall.b.z - wall.a.z) * along;
          const read = (height: number) => {
            camera.position.set(x - wall.normal.x * .5, height, z - wall.normal.z * .5);
            camera.lookAt(x, height, z); camera.updateMatrixWorld(true);
            renderer.render(space.rooms[id].scene, camera); renderer.readRenderTargetPixels(target, 0, 0, 1, 1, pixel); return pixel[0];
          };
          profiles.push({ room: id, side, along, base: read(.005), higher: read(.25) });
        }
      }
      return { profiles, error: renderer.getContext().getError() };
    } finally {
      renderer.setRenderTarget(null); target.dispose(); space.render = render; renderer.clippingPlanes = clipping;
      material.onBeforeCompile = before; material.customProgramCacheKey = key; material.needsUpdate = true;
    }
  });
  await page.evaluate(() => {
    document.getElementById('overlay')!.hidden = true; document.getElementById('hud')!.hidden = true;
    const app = window.__samewhere;
    Object.assign(app.game.player, { room: 'A', x: 0, z: -3, yaw: .3, pitch: -.65 }); app.space.render();
  });
  await page.screenshot({ path: 'test-results/wall-floor-bounce.png' });
  await page.evaluate(() => {
    const app = window.__samewhere;
    Object.assign(app.game.player, { room: 'B', x: 0, z: 3.8, yaw: Math.PI + .15, pitch: -.6 }); app.space.render();
  });
  await page.screenshot({ path: 'test-results/wall-floor-pentagon.png' });
  console.log('Wall bounce near the floor:', [...result.profiles].sort((a, b) => a.base / a.higher - b.base / b.higher).slice(0, 5));
  expect(result.profiles).toHaveLength(82);
  const references = new Map<RoomId, ReturnType<typeof createBounceSampler>>(), rgb = new Float32Array(3);
  for (const profile of result.profiles) {
    const id = profile.room as RoomId, wall = roomWalls(id)[profile.side];
    if (!references.has(id)) references.set(id, createBounceSampler(id, 32, false, 'draft'));
    const normal = { x: -wall.normal.x, y: 0, z: -wall.normal.z };
    for (const [height, actual] of [[.005, profile.base], [.25, profile.higher]]) {
      references.get(id)!({ x: wall.a.x + (wall.b.x - wall.a.x) * profile.along + normal.x * .002, y: height,
        z: wall.a.z + (wall.b.z - wall.a.z) * profile.along + normal.z * .002 }, normal, rgb);
      expect(Math.abs(actual - rgb[0]), JSON.stringify({ ...profile, height, expected: rgb[0] })).toBeLessThan(.01);
    }
  }
  expect(result.error).toBe(0); expect(errors).toEqual([]);
});

test('floor illumination stays continuous up to both jambs across every room shape', async ({ page }) => {
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
    for (const room of Object.keys(ROOMS)) for (let side = 0; side < ROOMS[room].sides; side++) {
      const source = room === 'G' ? 'C' : 'G';
      const from = { room, side }, to = { room: source, side: side % ROOMS[source].sides };
      app.game.world.balls[0].socket = from; app.game.world.balls[1].socket = to;
      app.game.world.balls[2].socket = app.game.world.balls[3].socket = null; app.sync();
      for (let i = 0; i < 22; i++) space.render();
      for (const lateral of [-.895, -.88, -.8, -.5, 0, .5, .8, .88, .895]) {
        const before = read(from, lateral), after = read(to, -lateral);
        samples.push({ room, side, lateral, before, after, max: Math.max(...before.map((value, c) => Math.abs(value - after[c]))) });
      }
    }
    return { samples, error: gl.getError() };
  });
  console.log('Passage lighting continuity, worst cases:', [...result.samples].sort((a, b) => b.max - a.max).slice(0, 5));
  expect(result.samples).toHaveLength(261);
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

test('each launch loads the compressed lighting asset without creating a bake worker', async ({ page }) => {
  const errors: string[] = [], requests: string[] = [], encodings: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const asset = /\/assets\/lighting-[a-f0-9]{64}\.bin(?:\?|$)/;
  page.on('request', request => { if (asset.test(request.url())) requests.push(request.url()); });
  page.on('response', response => { if (asset.test(response.url())) encodings.push(response.headers()['content-encoding']); });
  await page.addInitScript(() => {
    (window as any).__bakeWorkers = 0;
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      constructor(url: string | URL, options?: WorkerOptions) { super(url, options); (window as any).__bakeWorkers++; }
    };
  });
  const launches = [];
  for (let launch = 0; launch < 2; launch++) {
    await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
    await page.evaluate(() => window.__samewhere.space.ready);
    await expect(page.locator('#play-button')).toBeEnabled();
    launches.push(await page.evaluate(() => {
      const light = window.__samewhere.space.lightTransfer;
      const buffers: any[] = Object.values(light.fields).flatMap((field: any) => field.buffers);
      return { fields: light.cacheSize, jobs: light.jobs, loadMs: light.loadMs, readyMs: performance.now(), bytes: light.preparedBytes,
        workers: (window as any).__bakeWorkers,
        twoDimensional: buffers.every(buffer => buffer.texture.isDataTexture && !buffer.texture.isData3DTexture),
        textureBytes: buffers.reduce((sum, buffer) => sum + buffer.texture.image.data.byteLength, 0) };
    }));
  }
  console.log('Build-baked lighting startup:', launches);
  for (const launch of launches) {
    expect(launch.fields).toBe(812); expect(launch.jobs).toBe(0); expect(launch.workers).toBe(0); expect(launch.loadMs).toBeGreaterThan(0);
    expect(launch.bytes).toBeLessThan(16 * 1024 * 1024);
    expect(launch.twoDimensional).toBe(true); expect(launch.textureBytes).toBeLessThan(8 * 1024 * 1024);
  }
  expect(requests).toHaveLength(2); expect(requests[0]).toBe(requests[1]); expect(encodings).toEqual(['br', 'br']); expect(errors).toEqual([]);
});

for (const status of [503, 200]) test(`lighting download failure (${status}) reports an error and keeps entry disabled`, async ({ page }) => {
  await page.route(/\/assets\/lighting-[a-f0-9]{64}\.bin/, route => route.fulfill({ status, contentType: 'application/octet-stream', body: 'Invalid lighting' }));
  await page.goto('/');
  await expect(page.locator('#error')).toBeVisible();
  await expect(page.locator('#error')).toContainText('Could not prepare the game');
  await expect(page.locator('#loading-screen')).toBeHidden();
  await expect(page.locator('#menu-content')).toBeVisible();
  await expect(page.locator('#play-button')).toBeDisabled();
  const result = await page.evaluate(() => {
    const light = window.__samewhere.space.lightTransfer; return { jobs: light.jobs, fields: light.cacheSize };
  });
  expect(result).toEqual({ jobs: 0, fields: 0 });
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
