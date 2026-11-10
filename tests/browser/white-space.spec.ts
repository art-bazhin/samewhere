import { writeFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

test('the white EXIT fades in over the normal visibility range through successive gallery rooms', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/?dev=1'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  await page.locator('#play-button').click(); await expect(page.locator('#overlay')).toBeHidden();
  await page.keyboard.press('Digit9');
  const result = await page.evaluate(async () => {
    const path = '/src/world.ts', visibilityPath = '/src/visibility.ts';
    const { portalPosition, portalDistance, wallNormal } = await import(path), { VISIBILITY_START, VISIBILITY_END } = await import(visibilityPath);
    const { game, space } = window.__samewhere, gallery = game.world.gallery, last = gallery.signs.at(-1);
    const p = portalPosition('A', last.side), n = wallNormal('A', last.side), period = portalDistance('A') * 2;
    const middle = VISIBILITY_END - 8, seam = Math.ceil(VISIBILITY_START / period) * period;
    const canvas = document.createElement('canvas'), source = space.renderer.domElement;
    canvas.width = source.width; canvas.height = source.height;
    const context = canvas.getContext('2d')!, samples: { distance: number; rgb: number[] }[] = [], images: { name: string; data: string }[] = [];
    for (const distance of [VISIBILITY_END + 1, VISIBILITY_END + .05, VISIBILITY_END - .05, VISIBILITY_END - 2,
      VISIBILITY_END - 4, middle, VISIBILITY_END - 12, seam + .001, seam - .001, VISIBILITY_START, VISIBILITY_START - 4]) {
      const rooms = Math.floor(distance / period), local = distance - rooms * period;
      gallery.cell = { x: Math.round(last.x - n.x * rooms), z: Math.round(last.z - n.z * rooms) };
      Object.assign(game.player, { x: p.x - n.x * local, z: p.z - n.z * local });
      space.render(); context.drawImage(source, 0, 0);
      const rgb = Array.from(context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data.slice(0, 3));
      samples.push({ distance, rgb });
      if ([VISIBILITY_END + 1, middle, VISIBILITY_START].includes(distance)) images.push({ name: `exit-distance-${distance}.png`, data: canvas.toDataURL() });
    }
    return { samples, images };
  });
  for (const image of result.images) await writeFile(info.outputPath(image.name), Buffer.from(image.data.split(',')[1], 'base64'));
  console.log('White EXIT distance fade:', result.samples);
  expect(Math.max(...result.samples[0].rgb)).toBeLessThan(3);
  expect(Math.max(...result.samples[2].rgb)).toBeLessThan(3);
  for (let i = 1; i < result.samples.length; i++) expect(result.samples[i].rgb[0]).toBeGreaterThanOrEqual(result.samples[i - 1].rgb[0] - 2);
  const middle = result.samples[5].rgb;
  expect(Math.min(...middle)).toBeGreaterThan(80); expect(Math.max(...middle)).toBeLessThan(220);
  expect(Math.abs(result.samples[7].rgb[0] - result.samples[8].rgb[0])).toBeLessThan(3);
  expect(result.samples.at(-1)!.rgb).toEqual([255, 255, 255]); expect(errors).toEqual([]);
});

test('9 prepares the final EXIT into unlit white space, with a continuous crossing and return', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/?dev=1'); await page.waitForFunction(() => !!window.__samewhere?.space);
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
  expect(result.forward).toBe(1); expect(result.back).toBe(1);
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

test('approaching the final EXIT washes the entire view into white over seven metres without changing lights', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/?dev=1'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  await page.locator('#play-button').click(); await expect(page.locator('#overlay')).toBeHidden();
  await page.keyboard.press('Digit9');
  const result = await page.evaluate(async () => {
    const path = '/src/world.ts', { portalPosition, wallNormal } = await import(path);
    const { game, space } = window.__samewhere, gallery = game.world.gallery, last = gallery.signs.at(-1);
    const p = portalPosition('A', last.side), n = wallNormal('A', last.side), yaw = game.player.yaw, renderGlow = space.renderExitGlow.bind(space);
    const range = 7;
    const canvas = document.createElement('canvas'), source = space.renderer.domElement;
    canvas.width = source.width; canvas.height = source.height;
    const context = canvas.getContext('2d')!, samples: { distance: number; gain: number; coverage: number }[] = [], images: { name: string; data: string }[] = [];
    const lights = () => JSON.stringify(Object.values(space.rooms).flatMap((room: any) => room.scene.children.filter((object: any) => object.isLight).map((light: any) => light.intensity)));
    const lighting = lights(), revision = space.lightTransfer.revision;
    function capture(glow: boolean) {
      space.renderExitGlow = glow ? renderGlow : () => {};
      try {
        space.render(); context.drawImage(source, 0, 0);
        return context.getImageData(0, 0, canvas.width, canvas.height).data;
      } finally { space.renderExitGlow = renderGlow; }
    }
    for (const distance of [range + .1, range, range - .01, range * .75, range / 2, range * .25, .01, range / 2, range]) {
      Object.assign(game.player, { x: p.x - n.x * distance, z: p.z - n.z * distance, yaw: distance === .01 ? yaw + Math.PI : yaw });
      const before = capture(false), after = capture(true);
      let changed = 0, eligible = 0, increase = 0, available = 0;
      for (let i = 0; i < before.length; i += 4) {
        if (Math.max(before[i], before[i + 1], before[i + 2]) < 240) {
          eligible++; if (Math.min(after[i] - before[i], after[i + 1] - before[i + 1], after[i + 2] - before[i + 2]) > 2) changed++;
        }
        for (let c = 0; c < 3; c++) { increase += after[i + c] - before[i + c]; available += 255 - before[i + c]; }
      }
      samples.push({ distance, gain: increase / available, coverage: changed / eligible });
      if ([range * .75, range / 2, range * .25].includes(distance) && images.length < 3) images.push({ name: `exit-glow-${distance.toFixed(2)}.png`, data: canvas.toDataURL() });
    }
    Object.assign(game.player, { x: p.x - n.x * range / 2, z: p.z - n.z * range / 2, yaw: game.player.yaw + Math.PI });
    capture(true); const reversedGlow = space.whiteSpace.glow.material.uniforms.amount.value;
    gallery.cell = { x: 0, z: 0 }; capture(true);
    const elsewhere = space.whiteSpace.glow.material.uniforms.amount.value;
    return { samples, reversedGlow, elsewhere, unchangedLighting: lighting === lights() && revision === space.lightTransfer.revision, images };
  });
  for (const image of result.images) await writeFile(info.outputPath(image.name), Buffer.from(image.data.split(',')[1], 'base64'));
  console.log('EXIT screen glow:', result.samples);
  expect(Math.abs(result.samples[0].gain)).toBeLessThan(.001); expect(Math.abs(result.samples[1].gain)).toBeLessThan(.001);
  for (let i = 2; i <= 6; i++) expect(result.samples[i].gain).toBeGreaterThanOrEqual(result.samples[i - 1].gain);
  expect(result.samples[3].gain).toBeGreaterThan(.05); expect(result.samples[3].gain).toBeLessThan(.3);
  expect(result.samples[4].gain).toBeGreaterThan(.4); expect(result.samples[4].gain).toBeLessThan(.6);
  expect(result.samples[4].coverage).toBeGreaterThan(.99); expect(result.samples[6].gain).toBeGreaterThan(.999);
  expect(result.samples[7].gain).toBeCloseTo(result.samples[4].gain, 3); expect(Math.abs(result.samples[8].gain)).toBeLessThan(.001);
  expect(result.reversedGlow).toBeCloseTo(.5); expect(result.elsewhere).toBe(0); expect(result.unchangedLighting).toBe(true); expect(errors).toEqual([]);
});
