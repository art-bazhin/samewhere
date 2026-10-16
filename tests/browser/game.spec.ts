import { test, expect, type Page } from '@playwright/test';
import { MAX_PORTAL_PASSES } from '../../src/visibility';
import { portalAngle, portalDistance, transformPoint, WALL_THICKNESS, wallNormal, type RoomId, type SocketRef } from '../../src/world';

declare global { interface Window { __samewhere: any } }
async function ready(page: Page) {
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space && window.__samewhere.space.passes > 0);
  await page.evaluate(() => window.__samewhere.space.ready);
}
async function pose(page: Page, x: number, z: number, yaw: number, pitch = 0, room = 'A') {
  await page.evaluate(({ x, z, yaw, pitch, room }) => {
    const app = window.__samewhere; Object.assign(app.game.player, { x, z, yaw, pitch, room }); app.space.updateCamera();
  }, { x, z, yaw, pitch, room });
  await page.waitForTimeout(80);
}
async function aim(page: Page, room: RoomId, side: number, x: number, z: number) {
  return page.evaluate(({ room, side, x, z }) => {
    const app = window.__samewhere;
    const p = app.game.player; Object.assign(p, { x, z });
    const target = app.space.rooms[p.room].sockets.find((s: any) => s.ref.room === room && s.ref.side === side);
    const point = (target.ball.visible ? target.ball : target.hit).getWorldPosition(app.space.camera.position.clone());
    // Avoid the circle fan's shared center vertex when aiming at an empty well.
    if (!target.ball.visible) point.x += .001;
    const dx = point.x - p.x, dz = point.z - p.z;
    p.yaw = Math.atan2(-dx, -dz); p.pitch = Math.atan2(point.y - 1.65, Math.hypot(dx, dz));
    return app.space.pick();
  }, { room, side, x, z });
}
async function walkTo(page: Page, x: number, z: number) {
  const arrived = await page.evaluate(({ x, z }) => {
    const p = window.__samewhere.game.player; p.yaw = Math.atan2(p.x - x, p.z - z); p.pitch = -0.05;
    return Math.hypot(p.x - x, p.z - z) < .08;
  }, { x, z });
  if (arrived) return;
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
async function aimFromHere(page: Page, room: RoomId, side: number) {
  const p = await page.evaluate(() => ({ x: window.__samewhere.game.player.x, z: window.__samewhere.game.player.z }));
  return aim(page, room, side, p.x, p.z);
}

test('initial ball placement, actual mouse pick/place, and both shared pedestal representations', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await ready(page);
  await expect(page.locator('#red-count')).toHaveText('0'); await expect(page.locator('#blue-count')).toHaveText('0');
  expect(await page.evaluate(() => Object.fromEntries(Object.entries(window.__samewhere.space.rooms).map(([id, room]: [string, any]) =>
    [id, room.sockets.filter((socket: any) => socket.ball.visible).map((socket: any) => `${socket.ref.room}${socket.ref.side}`)]))))
    .toEqual({ A: ['B0', 'B2'], B: ['B0', 'B2', 'C0', 'C3'], C: ['C0', 'C3'], D: [] });
  await page.screenshot({ path: 'test-results/01-menu.png' });
  await page.locator('#play-button').click(); await expect(page.locator('#overlay')).toBeHidden();
  const hit = await aim(page, 'B', 0, 1.5, -0.25); expect(hit).toEqual({ room: 'B', side: 0 });
  await page.mouse.down(); await page.mouse.up();
  await expect(page.locator('#red-count')).toHaveText('1');
  const state = await page.evaluate(() => {
    const app = window.__samewhere;
    return { a: app.space.rooms.A.sockets.find((s: any) => s.ref.room === 'B' && s.ref.side === 0).ball.visible, b: app.space.rooms.B.sockets.find((s: any) => s.ref.room === 'B' && s.ref.side === 0).ball.visible, closedB0: app.space.rooms.B.walls[0].solid.visible, closedB2: app.space.rooms.B.walls[2].solid.visible };
  });
  expect(state).toEqual({ a: false, b: false, closedB0: true, closedB2: true });
  expect(await aim(page, 'A', 0, -1.5, 2.75)).toEqual({ room: 'A', side: 0 });
  await page.mouse.down(); await page.mouse.up(); await expect(page.locator('#red-count')).toHaveText('0');
  await page.keyboard.press('KeyZ'); await expect(page.locator('#red-count')).toHaveText('1');
  await page.keyboard.press('KeyR'); await expect(page.locator('#red-count')).toHaveText('0');
  await pose(page, -2.8, 3, -Math.PI / 4, -0.36);
  await page.screenshot({ path: 'test-results/02-room.png' });
  await pose(page, 0, 0, 0, -0.02, 'B');
  await page.screenshot({ path: 'test-results/03-recursion.png' });
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.__samewhere.space.passes)).toBeGreaterThan(1);
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

test('textured architecture loads locally and paired wall halves form a 30 cm passage', async ({ page }) => {
  const external: string[] = [];
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:5173/')) external.push(request.url()); });
  await ready(page);
  const result = await page.evaluate(() => {
    const space = window.__samewhere.space, depths: { open: number; solid: number }[] = [], ceilingBounds: { actual: number; expected: number }[] = [];
    let lines = 0;
    for (const id of Object.keys(space.rooms)) {
      const room = space.rooms[id]; room.scene.updateMatrixWorld(true);
      room.scene.traverse((object: any) => { if (object.isLine) lines++; });
      room.walls.forEach((wall: any, side: number) => {
        const angle = side * Math.PI * 2 / room.walls.length, nx = Math.sin(angle), nz = -Math.cos(angle);
        const depth = (group: any) => {
          let near = Infinity, far = -Infinity;
          group.traverse((mesh: any) => {
            if (!mesh.isMesh) return;
            const vertices = mesh.geometry.attributes.position, point = space.camera.position.clone();
            for (let i = 0; i < vertices.count; i++) {
              point.fromBufferAttribute(vertices, i).applyMatrix4(mesh.matrixWorld);
              const distance = point.x * nx + point.z * nz;
              near = Math.min(near, distance); far = Math.max(far, distance);
            }
          }); return far - near;
        };
        depths.push({ open: depth(wall.open), solid: depth(wall.solid) });
        const vertices = room.scene.getObjectByName('ceiling').geometry.attributes.position;
        let bound = -Infinity;
        for (let i = 0; i < vertices.count; i++) bound = Math.max(bound, vertices.getX(i) * nx + vertices.getZ(i) * nz);
        ceilingBounds.push({ actual: bound, expected: room.portals[side].distance });
      });
    }
    const materials = space.assets.materials;
    const maps = ['wall', 'floor', 'ceiling'].flatMap(key => ['map', 'bumpMap'].map(map => {
      const texture = materials[key][map]; return [texture.image.width, texture.image.height];
    }));
    space.render();
    return { depths, ceilingBounds, maps, lines, shadows: space.rooms.A.shadowLights.map((light: any) => light.shadow.map.width), glError: space.renderer.getContext().getError() };
  });
  for (const depth of result.depths) {
    expect(depth.solid).toBeCloseTo(WALL_THICKNESS, 5);
    expect(depth.open * 2).toBeCloseTo(WALL_THICKNESS, 5);
  }
  for (const bound of result.ceilingBounds) expect(bound.actual).toBeCloseTo(bound.expected, 5);
  expect(result.maps).toHaveLength(6);
  for (const [width, height] of result.maps) { expect(width).toBeGreaterThanOrEqual(1024); expect(height).toBeGreaterThanOrEqual(1024); }
  expect(result.lines).toBe(0); expect(result.shadows).toEqual([1024, 1024, 1024, 1024]);
  expect(result.glError).toBe(0); expect(external).toEqual([]);
});

test('wallpaper stays fixed when passages open, close, and reopen on every wall', async ({ page }) => {
  await ready(page);
  const samples = await page.evaluate(async () => {
    const path = '/node_modules/three/build/three.module.js', THREE = await import(path);
    const app = window.__samewhere, ray = new THREE.Raycaster();
    const samples: { room: string; side: number; point: number[]; states: number[][] }[] = [];
    for (const id of Object.keys(app.space.rooms)) for (let side = 0; side < app.space.rooms[id].walls.length; side++) {
      const room = app.space.rooms[id], wall = room.walls[side], frame = wall.solid.parent;
      room.scene.updateMatrixWorld(true);
      // Points on the unchanged wall, including the lintel above the aperture.
      for (const [x, y] of [[-2, .4], [2, .4], [-2, 1.65], [2, 1.65], [-2, 3.1], [0, 3.1], [2, 3.1]]) {
        const origin = frame.localToWorld(new THREE.Vector3(x, y, .5));
        const direction = new THREE.Vector3(0, 0, -1).transformDirection(frame.matrixWorld);
        const states: number[][] = [];
        for (const open of [true, false, true]) {
          app.game.world.balls[0].socket = { room: id, side };
          app.game.world.balls[1].socket = open ? { room: id, side: (side + 1) % room.walls.length } : null;
          app.game.world.balls[2].socket = app.game.world.balls[3].socket = null; app.sync();
          ray.set(origin, direction);
          const mesh = (wall.open.visible ? wall.open : wall.solid).children[0];
          const hit = ray.intersectObject(mesh, false)[0];
          if (!hit?.uv) throw new Error(`Missing wall at ${id}${side}: ${x}, ${y}`);
          const mapUV = hit.uv.clone(), bumpUV = hit.uv.clone();
          mesh.material.map.transformUv(mapUV); mesh.material.bumpMap.transformUv(bumpUV);
          states.push([mapUV.x, mapUV.y, bumpUV.x, bumpUV.y]);
        }
        samples.push({ room: id, side, point: [x, y], states });
      }
    }
    return samples;
  });
  expect(samples).toHaveLength(126);
  for (const sample of samples) for (const state of sample.states.slice(1)) {
    for (let i = 0; i < state.length; i++) expect(state[i], JSON.stringify(sample)).toBeCloseTo(sample.states[0][i], 5);
  }
});

test('near colors stay saturated and distant surfaces fade smoothly to black through portals', async ({ page }) => {
  await ready(page);
  const samples = await page.evaluate(async () => {
    const threePath = '/node_modules/three/build/three.module.js', visibilityPath = '/src/visibility.ts';
    const THREE = await import(threePath), { withDistanceFade } = await import(visibilityPath);
    const app = window.__samewhere, space = app.space;
    app.game.world.balls[0].socket = { room: 'A', side: 0 };
    app.game.world.balls[1].socket = { room: 'B', side: 0 };
    app.game.world.balls[2].socket = app.game.world.balls[3].socket = null; app.sync();
    for (const room of Object.values(space.rooms) as any[]) room.scene.traverse((object: any) => { if (object.isMesh) object.visible = false; });
    space.rooms.A.portals[0].mesh.visible = true;
    const geometry = new THREE.PlaneGeometry(8, 8), material = withDistanceFade(new THREE.MeshBasicMaterial({ color: 0xff3500 }));
    const reference = new THREE.Mesh(geometry, material); reference.position.y = 1.65; reference.rotation.y = Math.PI;
    space.rooms.B.scene.add(reference);
    const gl = space.renderer.getContext(), pixel = new Uint8Array(4);
    const read = () => {
      space.render(); gl.readPixels(Math.floor(gl.drawingBufferWidth / 2), Math.floor(gl.drawingBufferHeight / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return Array.from(pixel);
    };
    try {
      return [15, 28, 38, 48, 60].map(distance => {
        reference.position.z = distance - 5.8;
        Object.assign(app.game.player, { room: 'A', x: 0, z: -4.5, yaw: 0, pitch: 0 }); const portal = read();
        Object.assign(app.game.player, { room: 'B', z: -5.8, yaw: Math.PI });
        return { distance, portal, direct: read() };
      });
    } finally { space.rooms.B.scene.remove(reference); geometry.dispose(); material.dispose(); }
  });
  expect(samples[0].direct.slice(0, 3)).toEqual([255, 53, 0]);
  expect(samples[1].direct.slice(0, 3)).toEqual([255, 53, 0]);
  expect(samples[2].direct[0]).toBeGreaterThan(185); expect(samples[2].direct[0]).toBeLessThan(190);
  for (const sample of samples) {
    // A linear RGBA8 intermediate can round dim sRGB channels by two levels.
    for (let i = 0; i < 4; i++) expect(Math.abs(sample.portal[i] - sample.direct[i]), JSON.stringify(sample)).toBeLessThanOrEqual(2);
    expect(sample.direct[2]).toBe(0);
    if (sample.distance >= 48) expect(sample.direct.slice(0, 3)).toEqual([0, 0, 0]);
  }
});

test('saucer recesses are closed and support centered balls; four tile lights cast from their panels', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const path = '/node_modules/three/build/three.module.js', THREE = await import(path);
    const space = window.__samewhere.space, ray = new THREE.Raycaster(), point = new THREE.Vector3();
    const wallDistances: number[] = [], lipDistances: number[] = [], bottomDistances: number[] = [], fixtures: any[] = [], bowls: any[] = [];
    for (const room of Object.values(space.rooms) as any[]) {
      room.scene.updateMatrixWorld(true);
      const pedestals: any[] = [], lamps: any[] = [];
      room.scene.traverse((object: any) => {
        if (object.name === 'pedestal-body' || object.name === 'socket-bowl') pedestals.push(object);
        if (object.name === 'ceiling-lamp') lamps.push(object);
      });
      for (const socket of room.sockets) {
        const bowl = socket.hit.parent.getObjectByName('socket-bowl'), center = bowl.getWorldPosition(new THREE.Vector3());
        point.copy(center); point.y -= .0075;
        for (const direction of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
          ray.set(point, new THREE.Vector3(...direction));
          wallDistances.push(ray.intersectObjects(pedestals, false)[0]?.distance ?? Infinity);
        }
        ray.set(point, new THREE.Vector3(0, -1, 0));
        bottomDistances.push(ray.intersectObjects(pedestals, false)[0]?.distance ?? Infinity);
        socket.hit.getWorldPosition(point); point.y -= .0035;
        for (const direction of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
          ray.set(point, new THREE.Vector3(...direction));
          lipDistances.push(ray.intersectObjects(pedestals, false)[0]?.distance ?? Infinity);
        }
        const depths = [.0005, .01375, .0275, .04125, .05445].map(offset => {
          ray.set(new THREE.Vector3(center.x + offset, center.y + .05, center.z), new THREE.Vector3(0, -1, 0));
          const hit = ray.intersectObject(bowl, false)[0];
          return hit ? center.y - hit.point.y : Infinity;
        });
        const positions = bowl.geometry.attributes.position, normals = bowl.geometry.attributes.normal, radius = socket.ball.geometry.parameters.radius;
        let bottomY = Infinity, clearance = Infinity, minUpNormal = 1;
        for (let i = 0; i < positions.count; i++) {
          const r = Math.hypot(positions.getX(i), positions.getZ(i)), y = positions.getY(i) + bowl.position.y;
          bottomY = Math.min(bottomY, y); minUpNormal = Math.min(minUpNormal, normals.getY(i));
          if (r <= radius) clearance = Math.min(clearance, socket.ball.position.y - Math.sqrt(radius * radius - r * r) - y);
        }
        bowls.push({ depths, minUpNormal, clearance, lipDepth: -bowl.position.y, gap: socket.ball.position.y - radius - bottomY, centered: Math.hypot(socket.ball.position.x, socket.ball.position.z) });
      }
      fixtures.push({ sizes: lamps.map(lamp => [lamp.geometry.parameters.width, lamp.geometry.parameters.height]),
        offsets: room.shadowLights.map((light: any) => Math.min(...lamps.map(lamp => light.position.distanceTo(lamp.position)))),
        casts: room.shadowLights.every((light: any) => light.castShadow),
        baseY: Math.max(...pedestals.filter(p => p.name === 'pedestal-body').map(p => (p.geometry.computeBoundingBox(), p.geometry.boundingBox.min.y))) });
    }
    return { wallDistances, lipDistances, bottomDistances, fixtures, bowls };
  });
  for (const distance of result.wallDistances) { expect(distance).toBeGreaterThan(.03); expect(distance).toBeLessThan(.033); }
  for (const distance of result.lipDistances) expect(distance).toBeCloseTo(.055, 5);
  for (const distance of result.bottomDistances) { expect(distance).toBeGreaterThan(.0075); expect(distance).toBeLessThan(.0125); }
  expect(result.bowls).toHaveLength(36);
  for (const bowl of result.bowls) {
    expect(bowl.lipDepth).toBeCloseTo(.005, 6);
    expect(bowl.depths[0]).toBeGreaterThan(.016); expect(bowl.depths[4]).toBeLessThan(.0001);
    for (let i = 1; i < bowl.depths.length; i++) expect(bowl.depths[i]).toBeLessThan(bowl.depths[i - 1]);
    expect(Math.abs(bowl.gap)).toBeLessThan(.000001); expect(bowl.centered).toBe(0);
    expect(bowl.clearance).toBeGreaterThanOrEqual(-.000001); expect(bowl.minUpNormal).toBeGreaterThan(.9);
  }
  for (const fixture of result.fixtures) {
    expect(fixture.sizes).toEqual([[.55, .55], [.55, .55], [.55, .55], [.55, .55]]);
    for (const offset of fixture.offsets) expect(offset).toBeLessThan(.02);
    expect(fixture.casts).toBe(true); expect(fixture.baseY).toBeLessThan(0);
  }
});

test('the four-room route reaches D using native movement and pedestal clicks', async ({ page }) => {
  test.setTimeout(90_000);
  await ready(page);
  await expect(page.locator('[data-mode], #mode-label, #objective')).toHaveCount(0);
  await page.locator('#play-button').click();
  await expect(page.locator('#overlay')).toBeHidden();
  expect(await aim(page, 'B', 3, 0, 0.35)).toEqual({ room: 'B', side: 3 });
  const before = await page.evaluate(() => window.__samewhere.game.snapshot());
  await page.keyboard.press('F2');
  expect(await page.evaluate(() => window.__samewhere.game.snapshot())).toEqual(before);
  await page.keyboard.press('KeyR');
  // No teleports after reset: operate only the pedestals present in each room.
  async function center() {
    const z = await page.evaluate(() => window.__samewhere.game.player.z);
    await walkTo(page, 0, z); await walkTo(page, 0, 0);
  }
  async function operate(room: RoomId, side: number) {
    await center();
    const point = await page.evaluate(room => {
      const app = window.__samewhere, socket = app.space.rooms[app.game.player.room].sockets.find((s: any) => s.ref.room === room);
      if (!socket) throw new Error(`Missing ${room} pedestal`);
      const p = socket.hit.parent.parent.position; return { x: p.x, z: p.z + 1.3 };
    }, room);
    await walkTo(page, 0, point.z); await walkTo(page, point.x, point.z);
    expect(await aimFromHere(page, room, side)).toEqual({ room, side });
    await page.mouse.down(); await page.mouse.up();
  }
  async function enter(side: number, expected: RoomId) {
    await center();
    const room = await page.evaluate(() => window.__samewhere.game.player.room) as RoomId;
    const n = wallNormal(room, side);
    await walkTo(page, n.x * 4.65, n.z * 4.65); await cross(page, Math.atan2(-n.x, -n.z));
    expect(await page.evaluate(() => window.__samewhere.game.player.room)).toBe(expected);
  }
  await operate('B', 2); await operate('A', 0);
  await enter(0, 'B'); await expect(page.locator('#room-name')).toHaveText('Пятиугольная комната');
  await page.screenshot({ path: 'test-results/room-B.png' });
  await operate('C', 3); await enter(0, 'A');
  await operate('A', 1); await operate('B', 0); await enter(1, 'C'); await expect(page.locator('#room-name')).toHaveText('Шестиугольная комната');
  await page.screenshot({ path: 'test-results/room-C.png' });
  await operate('D', 0); await enter(0, 'A'); await enter(0, 'D');
  await center(); await expect(page.locator('#room-name')).toHaveText('Треугольная комната');
  await expect(page.locator('#room-shape')).toHaveClass('shape triangle');
  await expect(page.locator('#objective')).toHaveCount(0);
  expect(await page.evaluate(() => window.__samewhere.game.transitions)).toBe(5);
  await page.screenshot({ path: 'test-results/room-D.png' });
  await page.keyboard.press('KeyZ'); await expect(page.locator('#room-name')).toHaveText('Квадратная комната');
  await page.keyboard.press('KeyZ'); await expect(page.locator('#room-name')).toHaveText('Шестиугольная комната');
});

test('adjacent A portals, A–B and B self-loops render, with bounded GPU resources after 100 loops', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await ready(page); await page.locator('#play-button').click();
  await expect(page.locator('#overlay')).toBeHidden();
  await page.evaluate(() => {
    const app = window.__samewhere, balls = app.game.world.balls;
    balls[0].socket = { room: 'A', side: 0 }; balls[1].socket = { room: 'A', side: 1 }; balls[2].socket = null; balls[3].socket = null; app.sync();
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
  await page.evaluate(() => {
    const app = window.__samewhere; app.reset();
    app.game.world.balls[0].socket = { room: 'A', side: 0 }; app.game.world.balls[1].socket = { room: 'A', side: 2 };
    app.game.world.balls[2].socket = app.game.world.balls[3].socket = null; app.sync();
  }); await pose(page, 0.3, 0, 0);
  // Warm the fixed render-target pool from several directions before measuring.
  for (let i = 0; i < 4; i++) await pose(page, 0.3, 0, i * Math.PI / 2);
  const before = await page.evaluate(() => ({ ...window.__samewhere.space.renderer.info.memory }));
  for (let i = 0; i < 100; i++) {
    await page.evaluate(distance => { const app = window.__samewhere; app.game.move({ x: 0, z: -distance }); app.space.render(); }, 2 * portalDistance('A'));
  }
  const after = await page.evaluate(() => { const app = window.__samewhere; return { memory: { ...app.space.renderer.info.memory }, targets: app.space.targets.length, passes: app.space.passes, transitions: app.game.transitions }; });
  expect(after.transitions).toBe(100); expect(after.targets).toBeLessThanOrEqual(MAX_PORTAL_PASSES - 1); expect(after.passes).toBeLessThanOrEqual(MAX_PORTAL_PASSES);
  expect(after.memory.geometries).toBe(before.geometries); expect(after.memory.textures).toBeLessThanOrEqual(before.textures + 1);
  console.log('Resources after 100 loops:', after);
  expect(errors).toEqual([]);
});


test('distant floor joins have no missing MSAA coverage at grazing angles', async ({ page }) => {
  await ready(page);
  const samples = await page.evaluate(async () => {
    const path = '/src/world.ts', { portalDistance, wallNormal } = await import(path);
    const app = window.__samewhere, space = app.space, gl = space.renderer.getContext();
    const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight, pixels = new Uint8Array(3 * 3 * 4);
    for (const room of Object.values(space.rooms) as any[]) {
      // A uniform emissive floor exposes lost coverage independently of carpet,
      // lighting differences, or shadows. Keep the actual floor shader hooks.
      const material = room.scene.getObjectByName('floor').material;
      material.map = material.bumpMap = null; material.color.set(0); material.emissive.set(0xff0000); material.needsUpdate = true;
      room.scene.traverse((object: any) => { if (object.name === 'pedestal-body') object.parent.visible = false; });
    }
    const routes = [
      [{ room: 'A', side: 0 }, { room: 'A', side: 2 }],
      [{ room: 'A', side: 0 }, { room: 'A', side: 1 }],
      [{ room: 'A', side: 2 }, { room: 'B', side: 0 }],
      [{ room: 'B', side: 0 }, { room: 'B', side: 2 }],
      [{ room: 'A', side: 1 }, { room: 'C', side: 0 }],
      [{ room: 'C', side: 0 }, { room: 'D', side: 1 }],
      [{ room: 'A', side: 0 }, { room: 'D', side: 0 }],
      [{ room: 'C', side: 0 }, { room: 'C', side: 3 }],
      [{ room: 'D', side: 0 }, { room: 'D', side: 2 }],
    ];
    const samples = [];
    for (const route of routes) for (const [from, to] of [route, [...route].reverse()]) for (const lateral of [-3.3, 3.3]) {
      app.game.world.balls[0].socket = from; app.game.world.balls[1].socket = to;
      app.game.world.balls[2].socket = app.game.world.balls[3].socket = null; app.sync();
      const n = wallNormal(from.room, from.side), distance = portalDistance(from.room);
      const x = n.x * (distance - 8.5) - n.z * lateral, z = n.z * (distance - 8.5) + n.x * lateral;
      Object.assign(app.game.player, { room: from.room, x, z, yaw: Math.atan2(x - n.x * distance, z - n.z * distance), pitch: -Math.atan2(1.65, Math.hypot(8.5, lateral)) });
      space.render();
      let minRed = 255;
      for (const offset of [-.5, 0, .5]) {
        const point = space.camera.position.clone().set(n.x * distance - n.z * offset, 0, n.z * distance + n.x * offset).project(space.camera);
        const px = Math.floor((point.x + 1) * width / 2), py = Math.floor((point.y + 1) * height / 2);
        gl.readPixels(px - 1, py - 1, 3, 3, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        for (let i = 0; i < pixels.length; i += 4) minRed = Math.min(minRed, pixels[i]);
      }
      samples.push({ from, to, lateral, minRed });
    }
    return samples;
  });
  for (const sample of samples) expect(sample.minRed, JSON.stringify(sample)).toBeGreaterThanOrEqual(254);
});

test('rendered perspective remains continuous within 2 mm of every kind of seam', async ({ page }) => {
  await ready(page);
  const routes: [SocketRef, SocketRef][] = [
    [{ room: 'A', side: 0 }, { room: 'A', side: 2 }],
    [{ room: 'A', side: 0 }, { room: 'A', side: 1 }],
    [{ room: 'A', side: 2 }, { room: 'B', side: 0 }],
    [{ room: 'B', side: 0 }, { room: 'B', side: 2 }],
    [{ room: 'A', side: 1 }, { room: 'C', side: 0 }],
    [{ room: 'C', side: 0 }, { room: 'D', side: 1 }],
    [{ room: 'A', side: 0 }, { room: 'D', side: 0 }],
    [{ room: 'C', side: 0 }, { room: 'C', side: 3 }],
    [{ room: 'D', side: 0 }, { room: 'D', side: 2 }],
  ];
  for (const [from, to] of routes) {
    await page.evaluate(({ from, to }) => {
      const app = window.__samewhere; app.reset();
      app.game.world.balls[0].socket = from; app.game.world.balls[1].socket = to;
      app.game.world.balls[2].socket = null; app.game.world.balls[3].socket = null; app.sync();
    }, { from, to });
    const n = wallNormal(from.room, from.side), yaw = Math.atan2(-n.x, -n.z), seam = portalDistance(from.room);
    async function sample(x: number, z: number, room: string, angle: number) {
      return page.evaluate(({ x, z, room, angle }) => {
        const app = window.__samewhere; Object.assign(app.game.player, { x, z, room, yaw: angle, pitch: -0.02 }); app.space.render();
        const gl = app.space.renderer.getContext(), width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
        const pixels = new Uint8Array(320 * 200 * 4); gl.readPixels(Math.floor(width / 2 - 160), Math.floor(height / 2 - 100), 320, 200, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return Array.from(pixels);
      }, { x, z, room, angle });
    }
    const before = await sample(n.x * (seam - 0.001) - n.z * 0.25, n.z * (seam - 0.001) + n.x * 0.25, from.room, yaw);
    await page.screenshot({ path: `test-results/seam-${from.room}${from.side}-before.png` });
    const afterPoint = transformPoint({ x: n.x * (seam + 0.001) - n.z * 0.25, z: n.z * (seam + 0.001) + n.x * 0.25 }, from, to);
    const after = await sample(afterPoint.x, afterPoint.z, to.room, yaw - portalAngle(from, to));
    await page.screenshot({ path: `test-results/seam-${from.room}${from.side}-after.png` });
    let difference = 0; for (let i = 0; i < before.length; i++) difference += Math.abs(before[i] - after[i]);
    const mean = difference / before.length;
    console.log(`Seam ${from.room}${from.side} → ${to.room}${to.side}: mean pixel difference ${mean.toFixed(3)}/255`);
    expect(mean).toBeLessThan(4);
  }
});

test('the entire frame stays continuous at the eye plane, including angled and reverse crossings', async ({ page }) => {
  await ready(page);
  const results = await page.evaluate(async () => {
    const modulePath = '/src/world.ts';
    const { portalDistance, portalAngle, transformPoint, wallNormal } = await import(modulePath);
    const app = window.__samewhere, space = app.space, gl = space.renderer.getContext();
    const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
    const before = new Uint8Array(width * height * 4), after = new Uint8Array(before.length);
    const routes = [
      [{ room: 'A', side: 0 }, { room: 'A', side: 2 }],
      [{ room: 'A', side: 0 }, { room: 'A', side: 1 }],
      [{ room: 'A', side: 2 }, { room: 'B', side: 0 }],
      [{ room: 'B', side: 0 }, { room: 'B', side: 2 }],
      [{ room: 'A', side: 1 }, { room: 'C', side: 0 }],
      [{ room: 'C', side: 0 }, { room: 'D', side: 1 }],
      [{ room: 'A', side: 0 }, { room: 'D', side: 0 }],
      [{ room: 'C', side: 0 }, { room: 'C', side: 3 }],
      [{ room: 'D', side: 0 }, { room: 'D', side: 2 }],
    ];
    const results = [];
    const read = (point: any, room: string, yaw: number, pixels: Uint8Array) => {
      Object.assign(app.game.player, { ...point, room, yaw, pitch: .12 }); space.render();
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    };
    for (const route of routes) for (const [from, to] of [route, [...route].reverse()]) {
      app.reset();
      app.game.world.balls[0].socket = from; app.game.world.balls[1].socket = to;
      app.game.world.balls[2].socket = app.game.world.balls[3].socket = null; app.sync();
      const n = wallNormal(from.room, from.side), seam = portalDistance(from.room);
      for (const [lateral, angle] of [[0, 0], [.65, .45], [-.65, -.45], [.2, Math.PI]]) for (const epsilon of [.00001, 0]) {
        const yaw = Math.atan2(-n.x, -n.z) + angle;
        read({ x: n.x * (seam - epsilon) - n.z * lateral, z: n.z * (seam - epsilon) + n.x * lateral }, from.room, yaw, before);
        const point = transformPoint({ x: n.x * (seam + epsilon) - n.z * lateral, z: n.z * (seam + epsilon) + n.x * lateral }, from, to);
        read(point, to.room, yaw - portalAngle(from, to), after);
        let difference = 0, changed = 0;
        for (let i = 0; i < before.length; i++) {
          const delta = Math.abs(before[i] - after[i]); difference += delta; if (delta > 20) changed++;
        }
        results.push({ route: `${from.room}${from.side}–${to.room}${to.side}`, lateral, angle, epsilon,
          mean: difference / before.length, changedFraction: changed / before.length });
      }
    }
    return results;
  });
  console.log('Eye-plane continuity, worst cases:', [...results].sort((a, b) => b.mean - a.mean).slice(0, 5));
  for (const result of results) {
    expect(result.mean, JSON.stringify(result)).toBeLessThan(1);
    expect(result.changedFraction, JSON.stringify(result)).toBeLessThan(.001);
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
        app.game.world.balls[0].socket = { room, side: 0 };
        app.game.world.balls[1].socket = { room, side: 2 };
        app.game.world.balls[2].socket = app.game.world.balls[3].socket = null; app.sync();
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
  // Integer viewport translations can round MSAA edges and texture derivatives
  // by a few levels. Fewer than 0.01% of channels may differ by more than one.
  expect(result.maxDelta).toBeLessThanOrEqual(64);
  expect(result.meanDelta).toBeLessThan(0.001);
  expect(result.changedFraction).toBeLessThan(0.0001);
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
      results.push(await page.evaluate(async seam => {
        const modulePath = '/node_modules/three/build/three.module.js';
        const THREE = await import(modulePath);
        const app = window.__samewhere, space = app.space;
        app.reset(); space.resize();
        app.game.world.balls[0].socket = { room: 'A', side: 0 }; app.game.world.balls[1].socket = { room: 'A', side: 2 };
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
          Object.assign(app.game.player, { z: 2 * seam - 4.5 }); space.render();
          const direct = read();
          let maxDelta = 0, contrast = 0;
          for (let i = 0; i < portal.length; i++) maxDelta = Math.max(maxDelta, Math.abs(portal[i] - direct[i]));
          for (let y = 0; y < 128; y++) for (let x = 1; x < 128; x++) {
            const p = (y * 128 + x) * 4; contrast += Math.abs(portal[p] - portal[p - 4]);
          }
          return { maxDelta, contrast: contrast / (128 * 127), buffer: [width, height], portalBuffer: [space.targetWidth, space.targetHeight],
            samples: gl.getParameter(gl.SAMPLES), portalSamples: space.portalSamples, glError: gl.getError() };
        } finally { space.rooms.A.scene.remove(pattern); geometry.dispose(); material.dispose(); }
      }, portalDistance('A')));
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
