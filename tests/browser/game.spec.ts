import { test, expect, type Page } from '@playwright/test';
import { MAX_PORTAL_PASSES } from '../../src/visibility';
import { doorFrame, portalAngle, portalDistance, portalPosition, ROOM_IDS, ROOMS, transformPoint, WALL_THICKNESS, wallNormal, type RoomId, type SocketRef } from '../../src/world';

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
    // Aim inside a triangle, away from the circle fan's shared center and edges.
    if (!target.ball.visible) { point.x += .004; point.z += .002; }
    const dx = point.x - p.x, dz = point.z - p.z;
    p.yaw = Math.atan2(-dx, -dz); p.pitch = Math.atan2(point.y - 1.65, Math.hypot(dx, dz));
    return app.space.pick();
  }, { room, side, x, z });
}
async function walkStraight(page: Page, x: number, z: number) {
  const arrived = await page.evaluate(({ x, z }) => {
    const p = window.__samewhere.game.player; p.yaw = Math.atan2(p.x - x, p.z - z); p.pitch = -0.05;
    return Math.hypot(p.x - x, p.z - z) < .08;
  }, { x, z });
  if (arrived) return;
  await page.keyboard.down('KeyW');
  try { await page.waitForFunction(({ x, z }) => { const p = window.__samewhere.game.player; return Math.hypot(p.x - x, p.z - z) < 0.12; }, { x, z }, { timeout: 6000 }); }
  finally { await page.keyboard.up('KeyW'); }
}
async function walkTo(page: Page, x: number, z: number) {
  const waypoints = await page.evaluate(async target => {
    const path = '/src/world.ts', { ROOMS, roomOutline, canStand } = await import(path);
    const player = window.__samewhere.game.player, room = player.room;
    if (!ROOMS[room].outline) return [target];
    if (!canStand(room, target)) throw new Error(`Unwalkable target in ${room}: ${JSON.stringify(target)}`);
    const outline = roomOutline(room), step = .3, minX = Math.min(...outline.map((p: any) => p.x)), minZ = Math.min(...outline.map((p: any) => p.z));
    const width = Math.ceil((Math.max(...outline.map((p: any) => p.x)) - minX) / step) + 1;
    const height = Math.ceil((Math.max(...outline.map((p: any) => p.z)) - minZ) / step) + 1;
    const points = Array.from({ length: width * height }, (_, i) => ({ x: minX + i % width * step, z: minZ + Math.floor(i / width) * step }));
    const valid = points.map(p => canStand(room, p, .4));
    const nearest = (p: any) => points.reduce((best, point, i) => valid[i] && Math.hypot(point.x - p.x, point.z - p.z) < Math.hypot(points[best].x - p.x, points[best].z - p.z) ? i : best, valid.indexOf(true));
    const clear = (a: any, b: any) => {
      const count = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / .08);
      for (let i = 0; i <= count; i++) if (!canStand(room, { x: a.x + (b.x - a.x) * i / Math.max(1, count), z: a.z + (b.z - a.z) * i / Math.max(1, count) }, .36)) return false;
      return true;
    };
    const start = nearest(player), end = nearest(target), previous = new Int32Array(points.length).fill(-1), queue = [start]; previous[start] = start;
    for (let head = 0; head < queue.length && previous[end] < 0; head++) {
      const current = queue[head], cx = current % width, cz = Math.floor(current / width);
      for (const dx of [-1, 0, 1]) for (const dz of [-1, 0, 1]) {
        if ((!dx && !dz) || cx + dx < 0 || cx + dx >= width || cz + dz < 0 || cz + dz >= height) continue;
        const next = current + dx + dz * width;
        if (previous[next] < 0 && valid[next] && clear(points[current], points[next])) { previous[next] = current; queue.push(next); }
      }
    }
    if (previous[end] < 0) throw new Error(`No walking path in ${room}`);
    const route = [target];
    for (let i = end; i !== start; i = previous[i]) route.push(points[i]);
    route.push(points[start]); route.reverse();
    const smooth = [route[0]];
    for (let i = 0; i < route.length - 1;) {
      let next = route.length - 1; while (next > i + 1 && !clear(route[i], route[next])) next--;
      smooth.push(route[next]); i = next;
    }
    return smooth;
  }, { x, z });
  for (const p of waypoints) await walkStraight(page, p.x, p.z);
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
    .toEqual({ A: ['B0', 'B2'], B: ['B0', 'B2', 'C0', 'C3'], C: ['C0', 'C3'], D: [], E: ['B0', 'B2'], F: [], G: ['B0', 'B2', 'C0', 'C3'] });
  await page.screenshot({ path: 'test-results/01-menu.png' });
  await page.locator('#play-button').click(); await expect(page.locator('#overlay')).toBeHidden();
  const b = ROOMS.A.pedestals.find(p => p.controls === 'B')!;
  const hit = await aim(page, 'B', 0, b.x, b.z + 1.25); expect(hit).toEqual({ room: 'B', side: 0 });
  await page.mouse.down(); await page.mouse.up();
  await expect(page.locator('#red-count')).toHaveText('1');
  const state = await page.evaluate(() => {
    const app = window.__samewhere;
    return { a: app.space.rooms.A.sockets.find((s: any) => s.ref.room === 'B' && s.ref.side === 0).ball.visible, b: app.space.rooms.B.sockets.find((s: any) => s.ref.room === 'B' && s.ref.side === 0).ball.visible, closedB0: app.space.rooms.B.walls[0].solid.visible, closedB2: app.space.rooms.B.walls[2].solid.visible };
  });
  expect(state).toEqual({ a: false, b: false, closedB0: true, closedB2: true });
  const a = ROOMS.A.pedestals.find(p => p.controls === 'A')!;
  expect(await aim(page, 'A', 0, a.x, a.z + 1.25)).toEqual({ room: 'A', side: 0 });
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
        const { x: nx, z: nz } = room.portals[side].normal;
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
    const maps = ['wall', 'floor', 'ceiling'].flatMap(key => [materials[key].map, materials[key].normalMap ?? materials[key].bumpMap]
      .map(texture => [texture.image.width, texture.image.height]));
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
  expect(result.lines).toBe(0); expect(result.shadows).toEqual(Array(ROOMS.A.pedestals.length).fill(1024));
  expect(result.glError).toBe(0); expect(external).toEqual([]);
});

test('concave footprints match the floor, ceiling, walls, and miniature cutouts', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const threePath = '/node_modules/three/build/three.module.js', worldPath = '/src/world.ts', geometryPath = '/src/geometry.ts';
    const THREE = await import(threePath), world = await import(worldPath), geometry = await import(geometryPath);
    const space = window.__samewhere.space, ray = new THREE.Raycaster(), failures: unknown[] = [];
    let checks = 0;
    const nearEdge = (p: any, outline: any[]) => outline.some((a, i) => {
      const q = geometry.closestOnSegment(p, a, outline[(i + 1) % outline.length]); return Math.hypot(p.x - q.x, p.z - q.z) < .0001;
    });
    const verify = (mesh: any, p: any, expected: boolean, label: string, up = false, origin = { x: 0, z: 0 }) => {
      ray.set(new THREE.Vector3(p.x + origin.x, up ? 1 : 2, p.z + origin.z), new THREE.Vector3(0, up ? 1 : -1, 0));
      ray.far = 4; checks++;
      if (!!ray.intersectObject(mesh, false).length !== expected && failures.length < 20) failures.push({ label, p, expected });
    };
    for (const id of ['E', 'F', 'G']) {
      const room = space.rooms[id], outline = world.roomOutline(id), roof = geometry.offsetOutline(outline, world.WALL_THICKNESS / 2);
      room.scene.updateMatrixWorld(true);
      for (let x = -7.5; x <= 7.5; x += .5) for (let z = -7.5; z <= 7.5; z += .5) {
        const p = { x, z };
        if (!nearEdge(p, outline)) verify(room.scene.getObjectByName('floor'), p, geometry.insideOutline(p, outline), `${id} floor`);
        if (!nearEdge(p, roof)) verify(room.scene.getObjectByName('ceiling'), p, geometry.insideOutline(p, roof), `${id} ceiling`, true);
      }
      const walls: any[] = []; room.scene.traverse((mesh: any) => { if (mesh.name === 'boundary-wall') walls.push(mesh); });
      for (const wall of world.roomWalls(id).filter((wall: any) => wall.portal === null)) {
        ray.set(new THREE.Vector3(wall.center.x - wall.normal.x * .5, 1.65, wall.center.z - wall.normal.z * .5), new THREE.Vector3(wall.normal.x, 0, wall.normal.z));
        const hit = ray.intersectObjects(walls, false)[0]; checks++;
        if (!hit || Math.abs(hit.distance - .5) > .0001) failures.push({ label: `${id} side wall`, distance: hit?.distance });
      }
    }
    for (const room of Object.values(space.rooms) as any[]) {
      const groups = new Set<any>();
      for (const socket of room.sockets) if (world.ROOMS[socket.ref.room].outline && !groups.has(socket.hit.parent.parent)) {
        const group = socket.hit.parent.parent; groups.add(group);
        const id = socket.ref.room, outline = world.pedestalOutline(id), centers = Array.from({ length: world.ROOMS[id].sides }, (_, side) => world.socketPosition(id, side));
        for (let ix = -10; ix <= 10; ix++) for (let iz = -10; iz <= 10; iz++) {
          const p = { x: ix * .05, z: iz * .05 };
          if (nearEdge(p, outline) || centers.some((q: any) => Math.hypot(p.x - q.x, p.z - q.z) < .058)) continue;
          verify(group.getObjectByName('pedestal-body'), p, geometry.insideOutline(p, outline), `${id} miniature`, false, group.position);
        }
      }
    }
    return { checks, failures };
  });
  expect(result.checks).toBeGreaterThan(7000); expect(result.failures).toEqual([]);
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
      const lateral = Math.min(2, wall.solid.children[0].geometry.parameters.width / 2 - .1);
      // Points on the unchanged wall, including the lintel above the aperture.
      for (const [x, y] of [[-lateral, .4], [lateral, .4], [-lateral, 1.65], [lateral, 1.65], [-lateral, 3.1], [0, 3.1], [lateral, 3.1]]) {
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
          mesh.material.map.transformUv(mapUV); (mesh.material.normalMap ?? mesh.material.bumpMap).transformUv(bumpUV);
          states.push([mapUV.x, mapUV.y, bumpUV.x, bumpUV.y]);
        }
        samples.push({ room: id, side, point: [x, y], states });
      }
    }
    return samples;
  });
  expect(samples).toHaveLength(ROOM_IDS.reduce((count, id) => count + ROOMS[id].sides * 7, 0));
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

test('saucer recesses support centered balls; each pedestal has a light aligned to the ceiling tiles', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const path = '/node_modules/three/build/three.module.js', THREE = await import(path);
    const space = window.__samewhere.space, ray = new THREE.Raycaster(), point = new THREE.Vector3();
    const wallDistances: number[] = [], lipDistances: number[] = [], bottomDistances: number[] = [], fixtures: any[] = [], bowls: any[] = [];
    for (const [id, room] of Object.entries(space.rooms) as [string, any][]) {
      room.scene.updateMatrixWorld(true);
      const pedestals: any[] = [], lamps: any[] = [], frames: any[] = [];
      room.scene.traverse((object: any) => {
        if (object.name === 'pedestal-body' || object.name === 'socket-bowl') pedestals.push(object);
        if (object.name === 'ceiling-lamp') lamps.push(object);
        if (object.name === 'ceiling-lamp-frame') frames.push(object);
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
      const bodies = pedestals.filter(p => p.name === 'pedestal-body'), ceiling = room.scene.getObjectByName('ceiling'), texture = ceiling.material.map;
      texture.updateMatrix();
      const ceilingUV = (x: number, z: number) => {
        ray.set(new THREE.Vector3(x, 2, z), new THREE.Vector3(0, 1, 0));
        const hit = ray.intersectObject(ceiling, false)[0];
        if (!hit?.uv) throw new Error(`Missing ceiling in ${id} at ${x}, ${z}`);
        texture.transformUv(hit.uv); return hit.uv.toArray();
      };
      const coordinates = (objects: any[]) => objects.map(object => { const p = object.getWorldPosition(new THREE.Vector3()); return [p.x, p.z]; }).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      fixtures.push({ id, pedestalCount: bodies.length, lightCount: room.shadowLights.length,
        sizes: lamps.map(lamp => [lamp.geometry.parameters.width, lamp.geometry.parameters.height]),
        frameSizes: frames.map(frame => [frame.geometry.parameters.width, frame.geometry.parameters.height]),
        pedestalPositions: coordinates(bodies), lampPositions: coordinates(lamps), lightPositions: coordinates(room.shadowLights),
        targetPositions: coordinates(room.shadowLights.map((light: any) => light.target)),
        centerUVs: lamps.map(lamp => ceilingUV(lamp.position.x, lamp.position.z)),
        cornerUVs: frames.flatMap(frame => [-1, 1].flatMap(x => [-1, 1].map(z => ceilingUV(frame.position.x + x * frame.geometry.parameters.width / 2, frame.position.z + z * frame.geometry.parameters.height / 2)))),
        offsets: room.shadowLights.map((light: any) => Math.min(...lamps.map(lamp => light.position.distanceTo(lamp.position)))),
        casts: room.shadowLights.every((light: any) => light.castShadow),
        baseY: Math.max(...bodies.map(p => (p.geometry.computeBoundingBox(), p.geometry.boundingBox.min.y))) });
    }
    return { wallDistances, lipDistances, bottomDistances, fixtures, bowls };
  });
  for (const distance of result.wallDistances) { expect(distance).toBeGreaterThan(.03); expect(distance).toBeLessThan(.033); }
  for (const distance of result.lipDistances) expect(distance).toBeCloseTo(.055, 5);
  for (const distance of result.bottomDistances) { expect(distance).toBeGreaterThan(.0075); expect(distance).toBeLessThan(.0125); }
  expect(result.bowls).toHaveLength(ROOM_IDS.reduce((count, id) => count + ROOMS[id].pedestals.reduce((sum, p) => sum + ROOMS[p.controls].sides, 0), 0));
  for (const bowl of result.bowls) {
    expect(bowl.lipDepth).toBeCloseTo(.005, 6);
    expect(bowl.depths[0]).toBeGreaterThan(.016); expect(bowl.depths[4]).toBeLessThan(.0001);
    for (let i = 1; i < bowl.depths.length; i++) expect(bowl.depths[i]).toBeLessThan(bowl.depths[i - 1]);
    expect(Math.abs(bowl.gap)).toBeLessThan(.000001); expect(bowl.centered).toBe(0);
    expect(bowl.clearance).toBeGreaterThanOrEqual(-.000001); expect(bowl.minUpNormal).toBeGreaterThan(.9);
  }
  for (const fixture of result.fixtures) {
    expect(fixture.pedestalCount).toBe(ROOMS[fixture.id as RoomId].pedestals.length);
    expect(fixture.sizes).toHaveLength(fixture.pedestalCount); expect(fixture.frameSizes).toHaveLength(fixture.pedestalCount);
    expect(fixture.lightCount).toBe(fixture.pedestalCount);
    expect(fixture.lampPositions).toEqual(fixture.pedestalPositions); expect(fixture.lightPositions).toEqual(fixture.pedestalPositions);
    expect(fixture.targetPositions).toEqual(fixture.pedestalPositions);
    for (const size of fixture.sizes) for (const dimension of size) expect(dimension).toBeCloseTo(.6, 8);
    for (const size of fixture.frameSizes) for (const dimension of size) expect(dimension).toBeCloseTo(.65, 8);
    for (const uv of fixture.centerUVs) for (const value of uv) expect(value).toBeCloseTo(.5, 5);
    for (const uv of fixture.cornerUVs) for (const value of uv) expect(Math.min(Math.abs(value), Math.abs(1 - value))).toBeLessThan(.00001);
    for (const offset of fixture.offsets) expect(offset).toBeLessThan(.02);
    expect(fixture.casts).toBe(true); expect(fixture.baseY).toBeLessThan(0);
  }
});

test('the complete layout reaches the H hub and all seven pedestals work with native movement and clicks', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await ready(page);
  await expect(page.locator('[data-mode], #mode-label, #objective')).toHaveCount(0);
  await page.locator('#play-button').click();
  await expect(page.locator('#overlay')).toBeHidden();
  const initialB = ROOMS.A.pedestals.find(p => p.controls === 'B')!;
  expect(await aim(page, 'B', 3, initialB.x, initialB.z + 1.3)).toEqual({ room: 'B', side: 3 });
  const before = await page.evaluate(() => window.__samewhere.game.snapshot());
  await page.keyboard.press('F2');
  expect(await page.evaluate(() => window.__samewhere.game.snapshot())).toEqual(before);
  await page.keyboard.press('KeyR');
  // No teleports after reset: operate only the pedestals present in each room.
  async function center() {
    const { z, room } = await page.evaluate(() => window.__samewhere.game.player);
    if (ROOMS[room as RoomId].outline) { await walkTo(page, 0, room === 'G' ? 1.1 : 0); return; }
    await walkTo(page, 0, z); await walkTo(page, 0, 0);
  }
  async function operate(room: RoomId, side: number) {
    await center();
    const point = await page.evaluate(async room => {
      const app = window.__samewhere, socket = app.space.rooms[app.game.player.room].sockets.find((s: any) => s.ref.room === room);
      if (!socket) throw new Error(`Missing ${room} pedestal`);
      const path = '/src/world.ts', { canStand } = await import(path), p = socket.hit.parent.parent.position;
      const point = [1.3, 1].map(distance => ({ x: p.x, z: p.z + distance })).find(point => canStand(app.game.player.room, point, .4));
      if (!point) throw new Error(`No approach to ${room} pedestal in ${app.game.player.room}`);
      return point;
    }, room);
    const currentRoom = await page.evaluate(() => window.__samewhere.game.player.room) as RoomId;
    if (!ROOMS[currentRoom].outline) await walkTo(page, 0, point.z);
    await walkTo(page, point.x, point.z);
    await expect.poll(() => aimFromHere(page, room, side), { timeout: 1500 }).toEqual({ room, side });
    await page.mouse.down(); await page.mouse.up();
  }
  async function enter(side: number, expected: RoomId) {
    await center();
    const room = await page.evaluate(() => window.__samewhere.game.player.room) as RoomId;
    const n = wallNormal(room, side), frame = doorFrame(room, side);
    // Approach diagonal doorways along the wall to walk around the pedestals.
    if (!ROOMS[room].outline) await walkTo(page, 0, frame.center.z - n.z * .35);
    await walkTo(page, frame.center.x - n.x * .35, frame.center.z - n.z * .35); await cross(page, Math.atan2(-n.x, -n.z));
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

  await operate('A', 0); await operate('E', 0);
  await operate('A', 1); await operate('E', 1);
  await enter(0, 'E'); await expect(page.locator('#room-name')).toHaveText('Y-комната');
  await expect(page.locator('#room-shape')).toHaveClass('shape y-room');
  await page.screenshot({ path: 'test-results/room-E.png' });
  await enter(1, 'C'); await operate('D', 0); await enter(0, 'E');
  await operate('B', 0); await enter(0, 'B');
  await operate('C', 0); await enter(0, 'E');
  await operate('B', 0); await operate('F', 0); await enter(0, 'F');
  await expect(page.locator('#room-name')).toHaveText('Комната-крест');
  await expect(page.locator('#room-shape')).toHaveClass('shape cross-room');
  await page.keyboard.press('Digit2'); await operate('G', 0);
  await page.screenshot({ path: 'test-results/room-F.png' });
  await enter(0, 'E'); await enter(1, 'G'); await center();
  await expect(page.locator('#room-name')).toHaveText('H-комната');
  await expect(page.locator('#room-shape')).toHaveClass('shape h-room');
  await expect(page.locator('#objective')).toHaveCount(0);
  expect(await page.evaluate(() => window.__samewhere.game.transitions)).toBe(13);
  await expect(page.locator('#red-count')).toHaveText('0'); await expect(page.locator('#blue-count')).toHaveText('0');
  expect(await page.evaluate(() => window.__samewhere.game.world.balls.length)).toBe(4);
  await page.screenshot({ path: 'test-results/room-G.png' });

  const atHub = await page.evaluate(() => ({ world: window.__samewhere.game.snapshot().world, history: window.__samewhere.game.history.length }));
  await operate('E', 0); // Borrow one ball to exercise every control in the hub.
  for (const room of ROOM_IDS) {
    const side = await page.evaluate(({ room, sides }) => {
      const balls = window.__samewhere.game.world.balls;
      for (let side = 0; side < sides; side++) if (!balls.some((ball: any) => ball.socket?.room === room && ball.socket.side === side)) return side;
      throw new Error(`No free socket in ${room}`);
    }, { room, sides: ROOMS[room].sides });
    await operate(room, side);
    expect(await page.evaluate(({ room, side }) => window.__samewhere.game.world.balls.find((ball: any) => ball.socket?.room === room && ball.socket.side === side)?.color, { room, side })).toBe('red');
    for (let socket = 0; socket < ROOMS[room].sides; socket++) expect(await aimFromHere(page, room, socket)).toEqual({ room, side: socket });
    expect(await aimFromHere(page, room, side)).toEqual({ room, side });
    await page.mouse.down(); await page.mouse.up();
    await expect(page.locator('#red-count')).toHaveText('1');
  }
  await operate('E', 0);
  const hubActions = await page.evaluate(history => window.__samewhere.game.history.length - history, atHub.history);
  for (let i = 0; i < hubActions; i++) await page.keyboard.press('KeyZ');
  expect(await page.evaluate(() => window.__samewhere.game.world)).toEqual(atHub.world);
  await page.keyboard.press('KeyZ'); await expect(page.locator('#room-name')).toHaveText('Y-комната');
  await page.keyboard.press('KeyZ'); await expect(page.locator('#room-name')).toHaveText('Комната-крест');
  await page.keyboard.press('KeyR'); await expect(page.locator('#room-name')).toHaveText('Квадратная комната');
  expect(await page.evaluate(() => window.__samewhere.game.world.balls.map((ball: any) => ball.socket?.room))).toEqual(['B', 'B', 'C', 'C']);
  expect(errors).toEqual([]);
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
    const path = '/src/world.ts', { portalPosition, wallNormal, ROOMS } = await import(path);
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
      [{ room: 'D', side: 0 }, { room: 'E', side: 0 }],
      [{ room: 'E', side: 0 }, { room: 'F', side: 0 }],
      [{ room: 'E', side: 1 }, { room: 'G', side: 0 }],
    ];
    const samples = [];
    for (const route of routes) for (const [from, to] of [route, [...route].reverse()]) for (const lateral of [-3.3, 3.3]) {
      app.game.world.balls[0].socket = from; app.game.world.balls[1].socket = to;
      app.game.world.balls[2].socket = app.game.world.balls[3].socket = null; app.sync();
      const n = wallNormal(from.room, from.side), origin = portalPosition(from.room, from.side), corridor = !!ROOMS[from.room].outline;
      const approach = corridor ? 5 : 8.5, offset = corridor ? Math.sign(lateral) * .8 : lateral;
      const x = origin.x - n.x * approach - n.z * offset, z = origin.z - n.z * approach + n.x * offset;
      Object.assign(app.game.player, { room: from.room, x, z, yaw: Math.atan2(x - origin.x, z - origin.z), pitch: -Math.atan2(1.65, Math.hypot(approach, offset)) });
      space.render();
      let minRed = 255;
      for (const offset of [-.5, 0, .5]) {
        const point = space.camera.position.clone().set(origin.x - n.z * offset, 0, origin.z + n.x * offset).project(space.camera);
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
    [{ room: 'D', side: 0 }, { room: 'E', side: 0 }],
    [{ room: 'E', side: 0 }, { room: 'F', side: 0 }],
    [{ room: 'E', side: 1 }, { room: 'G', side: 0 }],
  ];
  for (const [from, to] of routes) {
    await page.evaluate(({ from, to }) => {
      const app = window.__samewhere; app.reset();
      app.game.world.balls[0].socket = from; app.game.world.balls[1].socket = to;
      app.game.world.balls[2].socket = null; app.game.world.balls[3].socket = null; app.sync();
    }, { from, to });
    const n = wallNormal(from.room, from.side), yaw = Math.atan2(-n.x, -n.z), origin = portalPosition(from.room, from.side);
    async function sample(x: number, z: number, room: string, angle: number) {
      return page.evaluate(({ x, z, room, angle }) => {
        const app = window.__samewhere; Object.assign(app.game.player, { x, z, room, yaw: angle, pitch: -0.02 }); app.space.render();
        const gl = app.space.renderer.getContext(), width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
        const pixels = new Uint8Array(320 * 200 * 4); gl.readPixels(Math.floor(width / 2 - 160), Math.floor(height / 2 - 100), 320, 200, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return Array.from(pixels);
      }, { x, z, room, angle });
    }
    const before = await sample(origin.x - n.x * .001 - n.z * .25, origin.z - n.z * .001 + n.x * .25, from.room, yaw);
    await page.screenshot({ path: `test-results/seam-${from.room}${from.side}-before.png` });
    const afterPoint = transformPoint({ x: origin.x + n.x * .001 - n.z * .25, z: origin.z + n.z * .001 + n.x * .25 }, from, to);
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
    const { portalPosition, portalAngle, transformPoint, wallNormal } = await import(modulePath);
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
      [{ room: 'D', side: 0 }, { room: 'E', side: 0 }],
      [{ room: 'E', side: 0 }, { room: 'F', side: 0 }],
      [{ room: 'E', side: 1 }, { room: 'G', side: 0 }],
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
      const n = wallNormal(from.room, from.side), origin = portalPosition(from.room, from.side);
      for (const [lateral, angle] of [[0, 0], [.65, .45], [-.65, -.45], [.2, Math.PI]]) for (const epsilon of [.00001, 0]) {
        const yaw = Math.atan2(-n.x, -n.z) + angle;
        read({ x: origin.x - n.x * epsilon - n.z * lateral, z: origin.z - n.z * epsilon + n.x * lateral }, from.room, yaw, before);
        const point = transformPoint({ x: origin.x + n.x * epsilon - n.z * lateral, z: origin.z + n.z * epsilon + n.x * lateral }, from, to);
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
