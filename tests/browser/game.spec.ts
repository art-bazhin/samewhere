import { test, expect, type Page } from '@playwright/test';
import { portalAngle, transformPoint, wallNormal, type SocketRef } from '../../src/world';

declare global { interface Window { __samewhere: any } }
async function ready(page: Page) {
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space && window.__samewhere.space.passes > 0);
}
async function pose(page: Page, x: number, z: number, yaw: number, pitch = 0, room = 'A') {
  await page.evaluate(({ x, z, yaw, pitch, room }) => {
    const app = window.__samewhere; Object.assign(app.game.player, { x, z, yaw, pitch, room }); app.space.updateCamera();
  }, { x, z, yaw, pitch, room });
  await page.waitForTimeout(80);
}
async function aim(page: Page, room: 'A' | 'B', side: number, x: number, z: number) {
  return page.evaluate(({ room, side, x, z }) => {
    const app = window.__samewhere;
    const p = app.game.player; Object.assign(p, { x, z });
    const target = app.space.rooms[p.room].sockets.find((s: any) => s.ref.room === room && s.ref.side === side);
    const point = target.ball.getWorldPosition(app.space.camera.position.clone());
    if (!target.ball.visible) point.y = 1.04;
    const dx = point.x - p.x, dz = point.z - p.z;
    p.yaw = Math.atan2(-dx, -dz); p.pitch = Math.atan2(point.y - 1.65, Math.hypot(dx, dz));
    return app.space.pick();
  }, { room, side, x, z });
}
async function walkTo(page: Page, x: number, z: number) {
  await page.evaluate(({ x, z }) => {
    const p = window.__samewhere.game.player; p.yaw = Math.atan2(p.x - x, p.z - z); p.pitch = -0.05;
  }, { x, z });
  await page.keyboard.down('KeyW');
  try { await page.waitForFunction(({ x, z }) => { const p = window.__samewhere.game.player; return Math.hypot(p.x - x, p.z - z) < 0.12; }, { x, z }, { timeout: 6000 }); }
  finally { await page.keyboard.up('KeyW'); }
}
async function cross(page: Page, yaw: number, backwards = false) {
  const count = await page.evaluate(yaw => { const app = window.__samewhere; app.game.player.yaw = yaw; return app.game.transitions; }, yaw);
  const key = backwards ? 'KeyS' : 'KeyW'; await page.keyboard.down(key);
  try { await page.waitForFunction(count => window.__samewhere.game.transitions === count + 1, count, { timeout: 3000 }); }
  finally { await page.keyboard.up(key); }
}
async function aimFromHere(page: Page, room: 'A' | 'B', side: number) {
  const p = await page.evaluate(() => ({ x: window.__samewhere.game.player.x, z: window.__samewhere.game.player.z }));
  return aim(page, room, side, p.x, p.z);
}

test('WebGL scene, actual mouse pick/place, and both shared pedestal representations', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await ready(page);
  await page.screenshot({ path: 'test-results/01-menu.png' });
  await page.locator('#play-button').click(); await expect(page.locator('#overlay')).toBeHidden();
  const hit = await aim(page, 'A', 0, -1.5, 2.75); expect(hit).toEqual({ room: 'A', side: 0 });
  await page.mouse.down(); await page.mouse.up();
  await expect(page.locator('#red-count')).toHaveText('1');
  const state = await page.evaluate(() => {
    const app = window.__samewhere;
    return { a: app.space.rooms.A.sockets[0].ball.visible, b: app.space.rooms.B.sockets[0].ball.visible, closedA0: app.space.rooms.A.walls[0].solid.visible, closedA2: app.space.rooms.A.walls[2].solid.visible };
  });
  expect(state).toEqual({ a: false, b: false, closedA0: true, closedA2: true });
  expect(await aim(page, 'B', 0, 1.5, -0.25)).toEqual({ room: 'B', side: 0 });
  await page.mouse.down(); await page.mouse.up(); await expect(page.locator('#red-count')).toHaveText('0');
  await page.keyboard.press('KeyZ'); await expect(page.locator('#red-count')).toHaveText('1');
  await page.keyboard.press('KeyR'); await expect(page.locator('#red-count')).toHaveText('0');
  await pose(page, -2.8, 3, -Math.PI / 4, -0.36);
  await page.screenshot({ path: 'test-results/02-room.png' });
  await pose(page, 0, 0, 0, -0.02);
  await page.screenshot({ path: 'test-results/03-recursion.png' });
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.__samewhere.space.passes)).toBeGreaterThanOrEqual(3);
});

test('native relative mouse input is applied once, preserves sensitivity, and settles without camera drift', async ({ page }) => {
  await ready(page); await page.locator('#play-button').click();
  await expect(page.locator('#overlay')).toBeHidden();
  await page.evaluate(() => {
    const app = window.__samewhere;
    app.mouseLook.reset(); app.game.player.yaw = app.game.player.pitch = 0;
    app.inputTotals = { x: 0, y: 0, packets: 0 };
    document.addEventListener(app.mouseEvent, ((event: MouseEvent) => {
      app.inputTotals.x += event.movementX; app.inputTotals.y += event.movementY; app.inputTotals.packets++;
    }) as EventListener);
  });
  for (let i = 0; i < 16; i++) await page.mouse.move(720 + i * 3, 480 + i);
  await page.waitForTimeout(80);
  const state = await page.evaluate(() => {
    const app = window.__samewhere;
    return { yaw: app.game.player.yaw, pitch: app.game.player.pitch, ...app.inputTotals };
  });
  expect(state.packets).toBeGreaterThan(0); expect(Math.abs(state.x)).toBeGreaterThan(0);
  expect(state.yaw).toBeCloseTo(-state.x * 0.002, 8);
  expect(state.pitch).toBeCloseTo(-state.y * 0.002, 8);

  const extra = await page.evaluate(() => {
    const app = window.__samewhere;
    const now = performance.now();
    const packet = (x: number, y: number, time: number) => {
      const event = new PointerEvent(app.mouseEvent, { movementX: x, movementY: y });
      Object.defineProperty(event, 'timeStamp', { value: time }); return event;
    };
    const event = packet(15, -6, now);
    Object.defineProperty(event, 'getCoalescedEvents', { value: () => [packet(10, -4, now - 4), packet(5, -2, now)] });
    document.dispatchEvent(event);
    // A compatibility event for the same movement must not count a second time.
    document.dispatchEvent(new MouseEvent(app.mouseEvent === 'mousemove' ? 'pointerrawupdate' : 'mousemove', { movementX: 15, movementY: -6 }));
    return { yaw: app.game.player.yaw, pitch: app.game.player.pitch };
  });
  await page.waitForTimeout(80);
  const settled = await page.evaluate(() => ({ ...window.__samewhere.game.player }));
  expect(settled.yaw).toBeCloseTo(extra.yaw - 15 * 0.002, 8);
  expect(settled.pitch).toBeCloseTo(extra.pitch + 6 * 0.002, 8);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => ({ ...window.__samewhere.game.player }))).toEqual(settled);

  await page.keyboard.press('F4'); await page.waitForTimeout(150);
  await page.mouse.move(800, 500); await page.keyboard.press('F4'); await page.waitForTimeout(80);
  expect(await page.evaluate(() => ({ ...window.__samewhere.game.player }))).toEqual(settled);
});

test('partition blocks the ray; control solution is traversable in the rendered world', async ({ page }) => {
  await ready(page); await page.locator('#play-button').click();
  await expect(page.locator('#overlay')).toBeHidden();
  await page.keyboard.press('F2');
  expect(await aim(page, 'B', 3, 0, 0.5)).toBeNull();
  // The same ray reaches the socket after removing the partition, proving it is an occlusion test.
  await page.keyboard.press('F2'); expect(await aim(page, 'B', 3, 0, 0.5)).toEqual({ room: 'B', side: 3 }); await page.keyboard.press('F2');
  await page.keyboard.press('KeyR');
  // Full reference route: no position teleports after resetting to the real start.
  await walkTo(page, -1.5, 3); await walkTo(page, -1.5, 2.75);
  expect(await aimFromHere(page, 'A', 0)).toEqual({ room: 'A', side: 0 }); await page.mouse.down(); await page.mouse.up();
  await expect(page.locator('#red-count')).toHaveText('1');
  await walkTo(page, -3, 2.75); await walkTo(page, -3, 0); await walkTo(page, -4.65, 0); await cross(page, Math.PI / 2);
  expect(await page.evaluate(() => window.__samewhere.game.transitions)).toBe(1);
  await walkTo(page, 2.8, 0); await walkTo(page, 1.5, -0.25);
  expect(await aimFromHere(page, 'B', 0)).toEqual({ room: 'B', side: 0 }); await page.mouse.down(); await page.mouse.up();
  await expect(page.locator('#red-count')).toHaveText('0');
  await walkTo(page, 3, 0); await walkTo(page, 4.65, 0); await cross(page, -Math.PI / 2);
  expect(await page.evaluate(() => window.__samewhere.game.transitions)).toBe(2);
  await walkTo(page, -3, 0); await walkTo(page, -3, 3.3); await walkTo(page, 0, 3.3); await walkTo(page, 0, 4.65); await cross(page, Math.PI);
  await expect(page.locator('#room-name')).toHaveText('Пятиугольная комната');
  await page.screenshot({ path: 'test-results/04-pentagon.png' });
  await cross(page, Math.PI, true);
  await expect(page.locator('#room-name')).toHaveText('Квадратная комната');
  await expect(page.locator('#objective')).toHaveClass(/solved/);
  await page.keyboard.press('KeyZ'); await expect(page.locator('#room-name')).toHaveText('Пятиугольная комната');
  await page.keyboard.press('KeyZ'); await expect(page.locator('#room-name')).toHaveText('Квадратная комната');
});

test('adjacent A portals, A–B and B self-loops render, with bounded GPU resources after 100 loops', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await ready(page); await page.locator('#play-button').click();
  await expect(page.locator('#overlay')).toBeHidden();
  await page.evaluate(() => {
    const app = window.__samewhere, balls = app.game.world.balls;
    balls[1].socket = { room: 'A', side: 1 }; balls[2].socket = null; balls[3].socket = null; app.sync();
  });
  await pose(page, 0.3, -4.3, 0); await page.screenshot({ path: 'test-results/05-adjacent.png' });
  await page.keyboard.down('KeyW'); await page.waitForTimeout(600); await page.keyboard.up('KeyW');
  expect(await page.evaluate(() => window.__samewhere.game.transitions)).toBe(1);
  await page.screenshot({ path: 'test-results/06-adjacent-after.png' });
  await page.evaluate(() => {
    const app = window.__samewhere; app.reset(); app.game.world.balls[0].socket = { room: 'B', side: 0 }; app.game.world.balls[1].socket = { room: 'B', side: 2 }; app.sync();
  });
  await pose(page, 0.3, -4.3, 0, 0, 'B'); await page.screenshot({ path: 'test-results/07-pentagon-loop.png' });
  await page.keyboard.down('KeyW'); await page.waitForTimeout(600); await page.keyboard.up('KeyW');
  expect(await page.evaluate(() => window.__samewhere.game.player.room)).toBe('B');
  expect(await page.evaluate(() => window.__samewhere.game.transitions)).toBe(1);
  await page.evaluate(() => window.__samewhere.reset()); await pose(page, 0.3, 0, 0);
  // Warm the fixed render-target pool from several directions before measuring.
  for (let i = 0; i < 4; i++) await pose(page, 0.3, 0, i * Math.PI / 2);
  const before = await page.evaluate(() => ({ ...window.__samewhere.space.renderer.info.memory }));
  for (let i = 0; i < 100; i++) {
    await page.evaluate(() => { const app = window.__samewhere; app.game.move({ x: 0, z: -10 }); app.space.render(); });
  }
  const after = await page.evaluate(() => { const app = window.__samewhere; return { memory: { ...app.space.renderer.info.memory }, targets: app.space.targets.length, passes: app.space.passes, transitions: app.game.transitions }; });
  expect(after.transitions).toBe(100); expect(after.targets).toBeLessThanOrEqual(23); expect(after.passes).toBeLessThanOrEqual(24);
  expect(after.memory.geometries).toBe(before.geometries); expect(after.memory.textures).toBeLessThanOrEqual(before.textures + 1);
  console.log('Resources after 100 loops:', after);
  expect(errors).toEqual([]);
});


test('rendered perspective remains continuous within 2 mm of every kind of seam', async ({ page }) => {
  await ready(page);
  const routes: [SocketRef, SocketRef][] = [
    [{ room: 'A', side: 0 }, { room: 'A', side: 2 }],
    [{ room: 'A', side: 0 }, { room: 'A', side: 1 }],
    [{ room: 'A', side: 2 }, { room: 'B', side: 0 }],
    [{ room: 'B', side: 0 }, { room: 'B', side: 2 }],
  ];
  for (const [from, to] of routes) {
    await page.evaluate(({ from, to }) => {
      const app = window.__samewhere; app.reset();
      app.game.world.balls[0].socket = from; app.game.world.balls[1].socket = to;
      app.game.world.balls[2].socket = null; app.game.world.balls[3].socket = null; app.sync();
    }, { from, to });
    const n = wallNormal(from.room, from.side), yaw = Math.atan2(-n.x, -n.z);
    async function sample(x: number, z: number, room: string, angle: number) {
      return page.evaluate(({ x, z, room, angle }) => {
        const app = window.__samewhere; Object.assign(app.game.player, { x, z, room, yaw: angle, pitch: -0.02 }); app.space.render();
        const gl = app.space.renderer.getContext(), width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
        const pixels = new Uint8Array(320 * 200 * 4); gl.readPixels(Math.floor(width / 2 - 160), Math.floor(height / 2 - 100), 320, 200, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return Array.from(pixels);
      }, { x, z, room, angle });
    }
    const before = await sample(n.x * 4.999 - n.z * 0.25, n.z * 4.999 + n.x * 0.25, from.room, yaw);
    await page.screenshot({ path: `test-results/seam-${from.room}${from.side}-before.png` });
    const afterPoint = transformPoint({ x: n.x * 5.001 - n.z * 0.25, z: n.z * 5.001 + n.x * 0.25 }, from, to);
    const after = await sample(afterPoint.x, afterPoint.z, to.room, yaw - portalAngle(from, to));
    await page.screenshot({ path: `test-results/seam-${from.room}${from.side}-after.png` });
    let difference = 0; for (let i = 0; i < before.length; i++) difference += Math.abs(before[i] - after[i]);
    const mean = difference / before.length;
    console.log(`Seam ${from.room}${from.side} → ${to.room}${to.side}: mean pixel difference ${mean.toFixed(3)}/255`);
    expect(mean).toBeLessThan(4);
  }
});

test('cropped portal textures match full-frame textures while turning in either room', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(() => {
    const app = window.__samewhere, space = app.space, renderer = space.renderer;
    const gl = renderer.getContext(), width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
    const optimized = new Uint8Array(width * height * 4), reference = new Uint8Array(optimized.length);
    const original = space.targetAt.bind(space);
    let maxDelta = 0, pixels = 0, fullPixels = 0, totalDelta = 0, changed = 0;
    const differences: unknown[] = [];
    try {
      for (const room of ['A', 'B']) {
        app.reset();
        if (room === 'B') {
          app.game.world.balls[0].socket = { room: 'B', side: 0 };
          app.game.world.balls[1].socket = { room: 'B', side: 2 }; app.sync();
        }
        for (let i = 0; i < 8; i++) {
          Object.assign(app.game.player, { room, x: -2.8, z: 3, yaw: i * Math.PI / 4 + 0.1, pitch: -0.12 });
          space.targetAt = original; space.render();
          pixels += space.portalPixels; fullPixels += (space.passes - 1) * space.targetWidth * space.targetHeight;
          gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, optimized);
          space.targetAt = (index: number) => original(index, { minX: -1, minY: -1, maxX: 1, maxY: 1 });
          space.render(); gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, reference);
          let poseMax = 0, poseChanged = 0;
          for (let p = 0; p < optimized.length; p++) {
            const delta = Math.abs(optimized[p] - reference[p]); maxDelta = Math.max(maxDelta, delta); poseMax = Math.max(poseMax, delta);
            totalDelta += delta; if (delta > 1) { changed++; poseChanged++; }
          }
          if (poseChanged) differences.push({ room, pose: i, max: poseMax, changed: poseChanged });
        }
      }
    } finally { space.targetAt = original; }
    return { maxDelta, pixels, fullPixels, meanDelta: totalDelta / (optimized.length * 16), changedFraction: changed / (optimized.length * 16), differences };
  });
  console.log('Portal crop comparison:', result);
  // Integer viewport translations can round a handful of MSAA edge samples
  // differently. Flat regions and pixel alignment must still agree throughout.
  expect(result.maxDelta).toBeLessThanOrEqual(64);
  expect(result.meanDelta).toBeLessThan(0.001);
  expect(result.changedFraction).toBeLessThan(0.00001);
  expect(result.pixels).toBeLessThan(result.fullPixels * 0.5);
});

test.describe('portal detail on Retina', () => {
  test.use({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });

  test('one-pixel detail and MSAA match the main view, including after a resize', async ({ page }) => {
    await ready(page);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const results = [];
    for (const viewport of [{ width: 1920, height: 1080 }, { width: 1511, height: 901 }]) {
      await page.setViewportSize(viewport);
      results.push(await page.evaluate(async () => {
        const modulePath = '/node_modules/three/build/three.module.js';
        const THREE = await import(modulePath);
        const app = window.__samewhere, space = app.space;
        app.reset(); space.resize();
        app.game.world.balls[2].socket = app.game.world.balls[3].socket = null; app.sync();
        // A one-pixel checkerboard inside the receiving room reveals any scaling
        // or filtering that can be hidden by broad, flat-colored room surfaces.
        const geometry = new THREE.PlaneGeometry(4, 3);
        const material = new THREE.ShaderMaterial({
          vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
          fragmentShader: 'void main() { float c = mod(floor(gl_FragCoord.x) + floor(gl_FragCoord.y), 2.); gl_FragColor = vec4(vec3(c), 1.); }',
        });
        const pattern = new THREE.Mesh(geometry, material); pattern.position.set(0, 1.65, 0);
        space.rooms.A.scene.add(pattern);
        const gl = space.renderer.getContext(), width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
        const read = () => {
          const pixels = new Uint8Array(128 * 128 * 4);
          gl.readPixels(Math.floor(width / 2 - 64), Math.floor(height / 2 - 64), 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          return pixels;
        };
        try {
          Object.assign(app.game.player, { room: 'A', x: 0, z: -4.5, yaw: 0, pitch: 0 }); space.render();
          const portal = read();
          // The identical virtual camera, rendered directly from outside A2.
          Object.assign(app.game.player, { z: 5.5 }); space.render();
          const direct = read();
          let maxDelta = 0, contrast = 0;
          for (let i = 0; i < portal.length; i++) maxDelta = Math.max(maxDelta, Math.abs(portal[i] - direct[i]));
          for (let y = 0; y < 128; y++) for (let x = 1; x < 128; x++) {
            const p = (y * 128 + x) * 4; contrast += Math.abs(portal[p] - portal[p - 4]);
          }
          return { maxDelta, contrast: contrast / (128 * 127), buffer: [width, height], portalBuffer: [space.targetWidth, space.targetHeight],
            samples: gl.getParameter(gl.SAMPLES), portalSamples: space.portalSamples, glError: gl.getError() };
        } finally { space.rooms.A.scene.remove(pattern); geometry.dispose(); material.dispose(); }
      }));
    }
    for (const result of results) {
      expect(result.portalBuffer).toEqual(result.buffer);
      expect(result.portalSamples).toBe(result.samples);
      expect(result.maxDelta).toBeLessThanOrEqual(1);
      expect(result.contrast).toBeGreaterThan(250);
      expect(result.glError).toBe(0);
    }
    console.log('Portal one-pixel detail:', results);
    expect(errors).toEqual([]);
  });
});
