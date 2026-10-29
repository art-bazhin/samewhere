import { writeFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

test('0 shortcuts prepare the square gallery with four balls in hand and can be undone', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  await page.locator('#play-button').click(); await expect(page.locator('#overlay')).toBeHidden();
  const initial = await page.evaluate(() => window.__samewhere.game.snapshot());
  await page.keyboard.press('Digit0');
  await expect(page.locator('#red-count')).toHaveText('2'); await expect(page.locator('#blue-count')).toHaveText('2');
  const ready = await page.evaluate(() => {
    const { game, space } = window.__samewhere;
    return { room: game.player.room, balls: game.world.balls.every((ball: any) => ball.socket === null),
      markings: space.rooms.A.markings.filter((marking: any) => marking.shown.value === 1).length, gallery: game.world.gallery };
  });
  expect(ready).toEqual({ room: 'A', balls: true, markings: 4, gallery: null });
  await page.keyboard.press('KeyZ');
  expect(await page.evaluate(() => window.__samewhere.game.snapshot())).toEqual(initial);
  await page.keyboard.press('Numpad0');
  await page.evaluate(async () => {
    const path = '/src/world.ts', { FINAL_PASSAGE_GOALS } = await import(path);
    const { game, sync, space } = window.__samewhere;
    for (const goal of FINAL_PASSAGE_GOALS) { game.world.selected = goal.color; game.interact(goal.from); }
    sync(); space.render();
  });
  expect(await page.evaluate(() => window.__samewhere.game.world.gallery.signs.length)).toBe(42);
  await page.keyboard.press('Digit0');
  expect(await page.evaluate(() => {
    const { game, space } = window.__samewhere; space.render();
    return { balls: game.world.balls.every((ball: any) => ball.socket === null), gallery: game.world.gallery,
      exit: space.exitSigns.signs.some((sign: any) => sign.visible) };
  })).toEqual({ balls: true, gallery: null, exit: false });
  await page.keyboard.press('KeyR');
  expect(await page.evaluate(() => window.__samewhere.game.snapshot())).toEqual(initial);
});

test('EXIT signs follow a fixed route regardless of the camera and stay continuous through portals', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const result = await page.evaluate(async () => {
    const worldPath = '/src/world.ts', galleryPath = '/src/gallery.ts';
    const { PASSAGE_GOALS, portalPosition, wallNormal, portalDistance } = await import(worldPath);
    const { galleryExitAt, galleryNeighbor, galleryRoute } = await import(galleryPath);
    const app = window.__samewhere, { game, space } = app;
    function check(condition: boolean, message: string) { if (!condition) throw new Error(message); }
    function capture() {
      const source = space.renderer.domElement, canvas = document.createElement('canvas');
      canvas.width = source.width; canvas.height = source.height;
      const context = canvas.getContext('2d')!; context.drawImage(source, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let green = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 1] > 65 && pixels[i + 1] > pixels[i] * 1.7 && pixels[i + 1] > pixels[i + 2] * 1.3) green++;
      return { green, image: canvas.toDataURL() };
    }
    function pose(side: number, distance: number, pitch = 0) {
      const p = portalPosition('A', side), n = wallNormal('A', side);
      Object.assign(game.player, { x: p.x - n.x * distance, z: p.z - n.z * distance, yaw: -Math.atan2(n.x, -n.z), pitch });
    }
    const plannedRoute = JSON.stringify(galleryRoute()), firstNormal = wallNormal('A', galleryRoute()[0].side);
    const firstYaw = -Math.atan2(firstNormal.x, -firstNormal.z);
    for (const [x, z, yaw, pitch] of [[-3, 3, -Math.PI / 4, -.3], [4.6, 0, Math.PI / 2, 0], [0, 0, firstYaw, 0]]) {
      app.reset(); game.world.passageProgress = PASSAGE_GOALS.length;
      game.world.balls.forEach((ball: any, index: number) => { ball.socket = index === 3 ? null : { room: 'A', side: [0, 2, 1][index] }; });
      Object.assign(game.player, { room: 'A', x, z, yaw, pitch });
      game.world.selected = 'blue'; game.interact({ room: 'A', side: 3 });
      check(JSON.stringify(game.world.gallery?.signs) === plannedRoute, 'The EXIT route depends on the camera or waits for rendering');
      app.sync(); space.render();
    }
    const initial = capture(), gallery = game.world.gallery;
    check(gallery?.signs.length === 42, 'The completed pattern did not start the EXIT route');
    check(initial.green > 100, 'The first EXIT did not appear while the player was looking at it');
    const route = structuredClone(gallery.signs), routeJSON = JSON.stringify(route);
    pose(route[0].side, portalDistance('A'), .12); app.sync(); space.render();
    const visible = capture(); check(visible.green > 100, 'The first EXIT cannot be seen after turning towards it');

    // Every recursive view must select the sign at its own unwrapped coordinates.
    const render = space.renderer.render.bind(space.renderer), views = new Set<string>(), period = portalDistance('A') * 2;
    space.renderer.render = (scene: any, camera: any) => {
      if (scene === space.rooms.A.scene && game.world.gallery) {
        const current = game.world.gallery;
        const base = current.outside ? current.signs.at(-1) : current.cell;
        const cell = { x: base.x + Math.round((game.player.x - camera.position.x) / period),
          z: base.z + Math.round((game.player.z - camera.position.z) / period) };
        const expected = galleryExitAt(current, cell);
        const shown = space.exitSigns.signs.flatMap((sign: any, side: number) => sign.visible ? [side] : []);
        check(JSON.stringify(shown) === JSON.stringify(expected === null ? [] : [expected]), `Wrong sign in gallery room ${cell.x},${cell.z}`);
        views.add(`${cell.x},${cell.z}`);
      }
      render(scene, camera);
    };
    let before = { green: 0, image: '' }, after = before;
    try {
      for (const [index, sign] of route.entries()) {
        check(game.world.gallery.cell.x === sign.x && game.world.gallery.cell.z === sign.z, `Route coordinate mismatch at ${index}`);
        check(galleryExitAt(game.world.gallery, sign) === sign.side, `Missing sign at ${index}`);
        if (index) check(sign.side !== (route[index - 1].side + 2) % 4, `EXIT requires reversing through the entrance at ${index}`);
        const n = wallNormal('A', sign.side);
        if (!index) {
          pose(sign.side, .00001); app.sync(); space.render(); before = capture();
          game.move({ x: n.x * .00002, z: n.z * .00002 });
          app.sync(); space.render(); after = capture();
          check(before.green > 20, 'Seam comparison did not contain a distant EXIT');
        } else {
          pose(sign.side, .45); game.move({ x: n.x * .6, z: n.z * .6 }); app.sync(); space.render();
        }
        const expected = galleryNeighbor(sign, sign.side);
        check(game.world.gallery.cell.x === expected.x && game.world.gallery.cell.z === expected.z, 'Crossing lost the gallery coordinates');
      }
      check(game.world.gallery.outside, 'The last EXIT did not enter white space');
      check(JSON.stringify(game.world.gallery.signs) === routeJSON, 'Crossing portals moved old EXIT signs');
      const side = route.at(-1)!.side, n = wallNormal('A', side);
      pose(side, -.45); game.move({ x: -n.x * .6, z: -n.z * .6 }); app.sync(); space.render();
      check(!game.world.gallery.outside, 'Returning did not restore the last gallery room');
      check(galleryExitAt(game.world.gallery, game.world.gallery.cell) === route.at(-1)!.side, 'Returning backwards lost the old EXIT');
      game.undo(); app.sync(); space.render();
      check(galleryExitAt(game.world.gallery, game.world.gallery.cell) === null, 'Undo did not restore the gallery position');
    } finally { space.renderer.render = render; }
    check(views.size > route.length, 'Recursive views did not exercise different gallery rooms');
    app.reset(); space.render();
    check(game.world.gallery === null && space.exitSigns.signs.every((sign: any) => !sign.visible), 'Reset retained EXIT signs');
    return { initial: initial.green, shown: visible.green, before: before.green, after: after.green, views: views.size,
      images: [{ name: 'gallery-exit.png', data: visible.image }, { name: 'gallery-seam-before.png', data: before.image }, { name: 'gallery-seam-after.png', data: after.image }] };
  });
  for (const image of result.images) await writeFile(info.outputPath(image.name), Buffer.from(image.data.split(',')[1], 'base64'));
  expect(Math.abs(result.before - result.after), `EXIT pixels before/after crossing: ${result.before}/${result.after}`).toBeLessThan(Math.max(10, result.before * .02));
  expect(result.initial).toBeGreaterThan(100); expect(result.shown).toBeGreaterThan(100); expect(errors).toEqual([]);
});
