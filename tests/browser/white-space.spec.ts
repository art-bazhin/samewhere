import { writeFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

test('the white EXIT fades in over the normal visibility range through successive gallery rooms', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  await page.locator('#play-button').click(); await expect(page.locator('#overlay')).toBeHidden();
  await page.keyboard.press('Digit9');
  const result = await page.evaluate(async () => {
    const path = '/src/world.ts', { portalPosition, portalDistance, wallNormal } = await import(path);
    const { game, space } = window.__samewhere, gallery = game.world.gallery, last = gallery.signs.at(-1);
    const p = portalPosition('A', last.side), n = wallNormal('A', last.side), period = portalDistance('A') * 2;
    const canvas = document.createElement('canvas'), source = space.renderer.domElement;
    canvas.width = source.width; canvas.height = source.height;
    const context = canvas.getContext('2d')!, samples: { distance: number; rgb: number[] }[] = [], images: { name: string; data: string }[] = [];
    for (const distance of [49, 48.05, 47.95, 46, 44, 40, 36, period * 3 + .001, period * 3 - .001, 28, 24]) {
      const rooms = Math.floor(distance / period), local = distance - rooms * period;
      gallery.cell = { x: Math.round(last.x - n.x * rooms), z: Math.round(last.z - n.z * rooms) };
      Object.assign(game.player, { x: p.x - n.x * local, z: p.z - n.z * local });
      space.render(); context.drawImage(source, 0, 0);
      const rgb = Array.from(context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data.slice(0, 3));
      samples.push({ distance, rgb });
      if ([49, 40, 28].includes(distance)) images.push({ name: `exit-distance-${distance}.png`, data: canvas.toDataURL() });
    }
    return { samples, images };
  });
  for (const image of result.images) await writeFile(info.outputPath(image.name), Buffer.from(image.data.split(',')[1], 'base64'));
  console.log('White EXIT distance fade:', result.samples);
  expect(Math.max(...result.samples[0].rgb)).toBeLessThan(3);
  expect(Math.max(...result.samples[2].rgb)).toBeLessThan(3);
  for (let i = 1; i < result.samples.length; i++) expect(result.samples[i].rgb[0]).toBeGreaterThanOrEqual(result.samples[i - 1].rgb[0] - 2);
  const middle = result.samples.find(sample => sample.distance === 40)!.rgb;
  expect(Math.min(...middle)).toBeGreaterThan(80); expect(Math.max(...middle)).toBeLessThan(220);
  expect(Math.abs(result.samples[7].rgb[0] - result.samples[8].rgb[0])).toBeLessThan(3);
  expect(result.samples.at(-1)!.rgb).toEqual([255, 255, 255]); expect(errors).toEqual([]);
});

test('9 prepares the final EXIT into unlit white space, with a continuous crossing and return', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  await page.locator('#play-button').click(); await expect(page.locator('#overlay')).toBeHidden();
  const initial = await page.evaluate(() => window.__samewhere.game.snapshot());
  await page.keyboard.press('Digit9');
  const result = await page.evaluate(async () => {
    const path = '/src/world.ts', { portalPosition, wallNormal } = await import(path);
    const { game, space, sync } = window.__samewhere;
    const last = game.world.gallery.signs.at(-1), p = portalPosition('A', last.side), n = wallNormal('A', last.side);
    function capture() {
      space.render();
      const source = space.renderer.domElement, canvas = document.createElement('canvas');
      canvas.width = source.width; canvas.height = source.height;
      const context = canvas.getContext('2d')!; context.drawImage(source, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const center = (Math.floor(canvas.height / 2) * canvas.width + Math.floor(canvas.width / 2)) * 4;
      let white = 0;
      for (let i = 0; i < pixels.length; i += 4) if (Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) > 250) white++;
      return { image: canvas.toDataURL(), pixels, center: Array.from(pixels.slice(center, center + 3)), white: white / (canvas.width * canvas.height) };
    }
    const entrance = capture();
    Object.assign(game.player, { x: p.x - n.x * .00001, z: p.z - n.z * .00001 });
    const before = capture(); game.move({ x: n.x * .00002, z: n.z * .00002 }); sync();
    const after = capture(); let difference = 0;
    for (let i = 0; i < before.pixels.length; i += 4) for (let c = 0; c < 3; c++) difference += Math.abs(before.pixels[i + c] - after.pixels[i + c]);
    const outside = game.world.gallery.outside;
    game.move({ x: n.x * 3, z: n.z * 3 }); const forward = capture();
    game.player.yaw += Math.PI; const back = capture();
    const pick = space.pick(), lights = space.whiteSpace.scene.children.filter((object: any) => object.isLight).length;
    game.move({ x: -n.x * 4, z: -n.z * 4 }); sync(); capture();
    const returned = !game.world.gallery.outside && game.world.gallery.cell.x === last.x && game.world.gallery.cell.z === last.z;
    game.undo(); sync(); const undoOutside = game.world.gallery.outside;
    return { entrance: entrance.center, outside, forward: forward.white, back: back.white, pick, lights, returned, undoOutside,
      seamMean: difference / (before.pixels.length / 4 * 3),
      images: [{ name: 'exit-entrance.png', data: entrance.image }, { name: 'exit-forward.png', data: forward.image }, { name: 'exit-back.png', data: back.image }] };
  });
  for (const image of result.images) await writeFile(info.outputPath(image.name), Buffer.from(image.data.split(',')[1], 'base64'));
  expect(result.entrance).toEqual([255, 255, 255]); expect(result.outside).toBe(true);
  expect(result.forward).toBe(1); expect(result.back).toBeGreaterThan(.5); expect(result.back).toBeLessThan(.99);
  expect(result.lights).toBe(0); expect(result.pick).toBeNull(); expect(result.returned).toBe(true); expect(result.undoOutside).toBe(true);
  expect(result.seamMean).toBeLessThan(.3);
  await page.keyboard.press('Numpad9');
  expect(await page.evaluate(() => window.__samewhere.game.world.gallery.outside)).toBe(false);
  await page.keyboard.press('KeyR');
  expect(await page.evaluate(() => window.__samewhere.game.snapshot())).toEqual(initial);
  await page.keyboard.press('Digit9'); await page.keyboard.press('KeyZ');
  expect(await page.evaluate(() => window.__samewhere.game.snapshot())).toEqual(initial);
  expect(errors).toEqual([]);
});
