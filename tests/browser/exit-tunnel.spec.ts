import { writeFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

test('the final EXIT leads through a dark tunnel before revealing the white exterior', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const result = await page.evaluate(async () => {
    const path = '/src/world.ts';
    const { PASSAGE_GOALS, FINAL_PASSAGE_GOALS, EXIT_TUNNEL_LENGTH, portalPosition, wallNormal } = await import(path);
    const app = window.__samewhere, { game, space } = app;
    function check(condition: boolean, message: string) { if (!condition) throw new Error(message); }
    function capture() {
      const source = space.renderer.domElement, canvas = document.createElement('canvas');
      canvas.width = source.width; canvas.height = source.height;
      const context = canvas.getContext('2d')!; context.drawImage(source, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0, wall = 0, count = 0, white = 0;
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4, light = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
        sum += light; if (Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) > 245) white++;
        if (y > canvas.height * .3 && y < canvas.height * .7 &&
          (x > canvas.width * .1 && x < canvas.width * .25 || x > canvas.width * .75 && x < canvas.width * .9)) { wall += light; count++; }
      }
      const center = (Math.floor(canvas.height / 2) * canvas.width + Math.floor(canvas.width / 2)) * 4;
      return { pixels, image: canvas.toDataURL(), mean: sum / (canvas.width * canvas.height), wall: wall / count,
        white: white / (canvas.width * canvas.height), center: Array.from(pixels.slice(center, center + 3)) };
    }
    app.reset(); game.world.passageProgress = PASSAGE_GOALS.length;
    game.world.balls.forEach((ball: any) => { ball.socket = null; });
    for (const goal of FINAL_PASSAGE_GOALS) { game.world.selected = goal.color; game.interact(goal.from); }
    const gallery = game.world.gallery, last = gallery.signs.at(-1), p = portalPosition('A', last.side), n = wallNormal('A', last.side);
    gallery.cell = { x: last.x, z: last.z };
    Object.assign(game.player, { x: 0, z: 0, yaw: -Math.atan2(n.x, -n.z), pitch: 0 });
    app.sync(); space.render(); const entrance = capture();
    Object.assign(game.player, { x: p.x - n.x * .00001, z: p.z - n.z * .00001, yaw: -Math.atan2(n.x, -n.z), pitch: 0 });
    app.sync(); space.render(); const before = capture();
    game.move({ x: n.x * .00002, z: n.z * .00002 }); app.sync(); space.render();
    check(game.world.gallery.inTunnel, 'The final marked passage did not enter the tunnel');
    const after = capture(); let difference = 0;
    for (let i = 0; i < before.pixels.length; i += 4) for (let channel = 0; channel < 3; channel++) {
      difference += Math.abs(before.pixels[i + channel] - after.pixels[i + channel]);
    }
    const seamMean = difference / (before.pixels.length / 4 * 3);
    const images = [{ name: 'tunnel-entrance.png', data: entrance.image },
      { name: 'tunnel-seam-before.png', data: before.image }, { name: 'tunnel-seam-after.png', data: after.image }];
    const samples: { z: number; mean: number; wall: number; white: number; center: number[]; visibility: number }[] = [];
    for (const z of [0, 5, 10, 20, 30, 45, EXIT_TUNNEL_LENGTH - 5, EXIT_TUNNEL_LENGTH + 2]) {
      game.move({ x: -game.player.x, z: z - game.player.z });
      Object.assign(game.player, { yaw: Math.PI, pitch: 0 }); app.sync(); space.render();
      const image = capture(); samples.push({ z, mean: image.mean, wall: image.wall, white: image.white, center: image.center,
        visibility: space.exitTunnel.visibility.value.y });
      images.push({ name: `tunnel-${z}.png`, data: image.image });
    }
    game.move({ x: 0, z: EXIT_TUNNEL_LENGTH - .5 - game.player.z }); game.player.yaw = 0;
    let returnViews = 0; const render = space.renderer.render.bind(space.renderer);
    space.renderer.render = (scene: any, camera: any) => { if (scene === space.rooms.A.scene) returnViews++; return render(scene, camera); };
    try { app.sync(); space.render(); images.push({ name: 'tunnel-back-from-end.png', data: capture().image }); }
    finally { space.renderer.render = render; }
    const backVisibility = space.exitTunnel.visibility.value.y;
    check(space.pick() === null, 'A phantom square-room pedestal can be selected inside the tunnel');
    game.move({ x: 0, z: 10 - game.player.z }); game.player.yaw = 0; app.sync(); space.render();
    const reverse = capture(); images.push({ name: 'tunnel-turn-at-10.png', data: reverse.image });
    game.move({ x: 0, z: 1 - game.player.z }); app.sync(); space.render();
    images.push({ name: 'tunnel-return.png', data: capture().image });
    game.move({ x: 0, z: -1.2 }); app.sync(); space.render();
    check(!game.world.gallery.inTunnel && game.world.gallery.cell.x === last.x && game.world.gallery.cell.z === last.z, 'Returning lost the last gallery room');
    game.undo(); app.sync(); space.render(); check(game.world.gallery.inTunnel, 'Undo did not restore the tunnel');
    const lamps = space.exitTunnel.scene.children.filter((object: any) => object.name === 'tunnel-ceiling-lamp').length;
    const exitSource = { z: space.exitTunnel.exitLight.position.z, shadows: space.exitTunnel.exitLight.castShadow };
    app.reset(); space.render();
    return { seamMean, samples, lamps, length: EXIT_TUNNEL_LENGTH, images, exitSource, reverse: reverse.mean, entrance: entrance.center, returnViews, backVisibility };
  });
  for (const image of result.images) await writeFile(info.outputPath(image.name), Buffer.from(image.data.split(',')[1], 'base64'));
  console.log('Exit tunnel:', { seamMean: result.seamMean, samples: result.samples });
  expect(result.length).toBe(60); expect(result.lamps).toBe(1); expect(result.seamMean).toBeLessThan(.3);
  expect(Math.max(...result.entrance)).toBeLessThan(2);
  expect(Math.max(...result.samples[0].center)).toBeLessThan(2);
  for (const sample of result.samples) expect(sample.visibility).toBeCloseTo(48 + Math.min(result.length, sample.z), 6);
  expect(Math.min(...result.samples.find(sample => sample.z === 45)!.center)).toBeGreaterThan(240);
  expect(result.returnViews).toBeGreaterThan(0); expect(result.backVisibility).toBeCloseTo(107.5);
  expect(result.reverse).toBeGreaterThan(30);
  expect(result.exitSource.z).toBeGreaterThan(result.length + .15); expect(result.exitSource.shadows).toBe(true);
  expect(result.samples.at(-1)!.mean).toBeGreaterThan(253); expect(errors).toEqual([]);
});

test('oblique views have continuous floor lighting across the tunnel threshold', async ({ page }, info) => {
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  await page.locator('#play-button').click(); await expect(page.locator('#overlay')).toBeHidden();
  await page.keyboard.press('Digit9'); await page.keyboard.press('KeyT');
  const result = await page.evaluate(async () => {
    const threePath = '/node_modules/three/build/three.module.js', worldPath = '/src/world.ts';
    const { Vector3 } = await import(threePath), { EYE_HEIGHT, portalPosition, wallNormal } = await import(worldPath);
    const { game, space, sync } = window.__samewhere;
    const last = game.world.gallery.signs.at(-1), p = portalPosition('A', last.side), n = wallNormal('A', last.side);
    const images: { name: string; data: string }[] = [], differences: number[] = [];
    for (const lateral of [-2.2, 2.2]) {
      const x = p.x - n.x * 1.7 - n.z * lateral, z = p.z - n.z * 1.7 + n.x * lateral;
      Object.assign(game.player, { x, z, yaw: -Math.atan2(p.x - x, z - p.z), pitch: -Math.atan2(EYE_HEIGHT, Math.hypot(p.x - x, p.z - z)) });
      sync(); space.render();
      const source = space.renderer.domElement, canvas = document.createElement('canvas'); canvas.width = source.width; canvas.height = source.height;
      const context = canvas.getContext('2d')!; context.drawImage(source, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const sample = (along: number, depth: number) => {
        const point = new Vector3(p.x - n.z * along + n.x * depth, 0, p.z + n.x * along + n.z * depth).project(space.camera);
        const cx = Math.round((point.x + 1) * canvas.width / 2), cy = Math.round((1 - point.y) * canvas.height / 2), rgb = [0, 0, 0];
        for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) for (let c = 0; c < 3; c++) rgb[c] += pixels[(y * canvas.width + x) * 4 + c] / 9;
        return rgb;
      };
      for (const along of [-.5, 0, .5]) {
        const before = sample(along, -.05), after = sample(along, .05);
        differences.push(Math.max(...before.map((channel, c) => Math.abs(channel - after[c]))));
      }
      images.push({ name: `tunnel-oblique-flat-${lateral}.png`, data: canvas.toDataURL() });
    }
    return { differences, images };
  });
  for (const image of result.images) await writeFile(info.outputPath(image.name), Buffer.from(image.data.split(',')[1], 'base64'));
  console.log('Tunnel threshold differences:', result.differences);
  expect(Math.max(...result.differences)).toBeLessThan(7);
  await page.keyboard.press('KeyT');
  const textured = await page.evaluate(() => {
    const { game, space } = window.__samewhere; game.player.pitch = -.12; space.render();
    const source = space.renderer.domElement, canvas = document.createElement('canvas'); canvas.width = source.width; canvas.height = source.height;
    canvas.getContext('2d')!.drawImage(source, 0, 0); return canvas.toDataURL();
  });
  await writeFile(info.outputPath('tunnel-oblique-textured.png'), Buffer.from(textured.split(',')[1], 'base64'));
  const pedestal = await page.evaluate(() => {
    const { game, space } = window.__samewhere;
    const target = space.rooms.A.scene.getObjectsByProperty('name', 'pedestal-body')[0];
    const center = target.parent.position;
    Object.assign(game.player, { x: -.5, z: 3.4, yaw: -Math.atan2(center.x + .5, 3.4 - center.z), pitch: -.45 });
    space.render();
    const source = space.renderer.domElement, canvas = document.createElement('canvas'); canvas.width = source.width; canvas.height = source.height;
    canvas.getContext('2d')!.drawImage(source, 0, 0); return canvas.toDataURL();
  });
  await writeFile(info.outputPath('tunnel-pedestal.png'), Buffer.from(pedestal.split(',')[1], 'base64'));
});

test('the exterior white space does not leak through terminal wall corners', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  await page.locator('#play-button').click(); await expect(page.locator('#overlay')).toBeHidden(); await page.keyboard.press('Digit9');
  const result = await page.evaluate(async () => {
    const threePath = '/node_modules/three/build/three.module.js', worldPath = '/src/world.ts';
    const { Vector3 } = await import(threePath), { EXIT_TUNNEL_LENGTH: length, EXIT_TUNNEL_WIDTH: width, ROOM_HEIGHT: height, WALL_THICKNESS } = await import(worldPath);
    const { game, space, sync } = window.__samewhere;
    game.world.gallery.inTunnel = true;
    Object.assign(game.player, { x: .25, z: length - 5, yaw: Math.PI + .04, pitch: .08 }); sync();
    const capture = () => {
      space.render(); const source = space.renderer.domElement, canvas = document.createElement('canvas'); canvas.width = source.width; canvas.height = source.height;
      const context = canvas.getContext('2d')!; context.drawImage(source, 0, 0);
      return { image: canvas.toDataURL(), pixels: context.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height };
    };
    const lit = capture(), intensity = space.exitTunnel.exitLight.intensity;
    space.exitTunnel.exitLight.intensity = 0; const dark = capture(); space.exitTunnel.exitLight.intensity = intensity;
    const points: number[][] = [], z = length - WALL_THICKNESS / 2;
    for (let i = 1; i < 40; i++) {
      const x = -width / 2 + width * i / 40, y = height * i / 40;
      points.push([x, height, z], [-width / 2, y, z], [width / 2, y, z]);
      if (Math.abs(x) > 1) points.push([x, 0, z]);
    }
    let brightest = 0, litBrightest = 0;
    for (const coordinates of points) {
      const p = new Vector3(...coordinates).project(space.camera), cx = Math.round((p.x + 1) * dark.width / 2), cy = Math.round((1 - p.y) * dark.height / 2);
      for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) {
        if (x < 0 || y < 0 || x >= dark.width || y >= dark.height) continue;
        const i = (y * dark.width + x) * 4;
        brightest = Math.max(brightest, Math.min(dark.pixels[i], dark.pixels[i + 1], dark.pixels[i + 2]));
        litBrightest = Math.max(litBrightest, Math.min(lit.pixels[i], lit.pixels[i + 1], lit.pixels[i + 2]));
      }
    }
    return { brightest, litBrightest, images: [{ name: 'tunnel-exit-oblique.png', data: lit.image }, { name: 'tunnel-exit-without-light.png', data: dark.image }] };
  });
  for (const image of result.images) await writeFile(info.outputPath(image.name), Buffer.from(image.data.split(',')[1], 'base64'));
  console.log('Exterior wall corner brightness:', { dark: result.brightest, lit: result.litBrightest });
  expect(result.brightest).toBeLessThan(140); expect(result.litBrightest).toBeLessThan(140); expect(errors).toEqual([]);
});
