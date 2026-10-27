import { writeFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

test('the final EXIT opens a continuous 100 m tunnel that brightens into white space', async ({ page }, info) => {
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
    Object.assign(game.player, { x: p.x - n.x * .00001, z: p.z - n.z * .00001, yaw: -Math.atan2(n.x, -n.z), pitch: 0 });
    app.sync(); space.render(); const before = capture();
    game.move({ x: n.x * .00002, z: n.z * .00002 }); app.sync(); space.render();
    check(game.world.gallery.inTunnel, 'The final marked passage did not enter the tunnel');
    const after = capture(); let difference = 0;
    for (let i = 0; i < before.pixels.length; i += 4) for (let channel = 0; channel < 3; channel++) {
      difference += Math.abs(before.pixels[i + channel] - after.pixels[i + channel]);
    }
    const seamMean = difference / (before.pixels.length / 4 * 3);
    const images = [{ name: 'tunnel-seam-before.png', data: before.image }, { name: 'tunnel-seam-after.png', data: after.image }];
    const samples: { z: number; mean: number; wall: number; white: number; center: number[] }[] = [];
    for (const z of [1, 25, 50, 75, 95, EXIT_TUNNEL_LENGTH + 2]) {
      game.move({ x: -game.player.x, z: z - game.player.z });
      Object.assign(game.player, { yaw: Math.PI, pitch: 0 }); app.sync(); space.render();
      const image = capture(); samples.push({ z, mean: image.mean, wall: image.wall, white: image.white, center: image.center });
      images.push({ name: `tunnel-${z}.png`, data: image.image });
    }
    check(space.pick() === null, 'A phantom square-room pedestal can be selected inside the tunnel');
    game.move({ x: 0, z: 1 - game.player.z }); game.player.yaw = 0; app.sync(); space.render();
    images.push({ name: 'tunnel-return.png', data: capture().image });
    game.move({ x: 0, z: -1.2 }); app.sync(); space.render();
    check(!game.world.gallery.inTunnel && game.world.gallery.cell.x === last.x && game.world.gallery.cell.z === last.z, 'Returning lost the last gallery room');
    game.undo(); app.sync(); space.render(); check(game.world.gallery.inTunnel, 'Undo did not restore the tunnel');
    const lamps = space.exitTunnel.scene.children.filter((object: any) => object.name === 'tunnel-ceiling-lamp').length;
    app.reset(); space.render();
    return { seamMean, samples, lamps, length: EXIT_TUNNEL_LENGTH, images };
  });
  for (const image of result.images) await writeFile(info.outputPath(image.name), Buffer.from(image.data.split(',')[1], 'base64'));
  console.log('Exit tunnel:', { seamMean: result.seamMean, samples: result.samples });
  expect(result.length).toBe(100); expect(result.lamps).toBe(1); expect(result.seamMean).toBeLessThan(.3);
  expect(Math.min(...result.samples[0].center)).toBeGreaterThan(240);
  for (let i = 1; i < 5; i++) expect(result.samples[i].wall).toBeGreaterThan(result.samples[i - 1].wall);
  expect(result.samples[4].wall - result.samples[0].wall).toBeGreaterThan(60);
  expect(result.samples.at(-1)!.mean).toBeGreaterThan(253); expect(errors).toEqual([]);
});
