import { writeFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

test('the hub drawing is present from the start and survives opening its own doorway and resetting', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const result = await page.evaluate(() => {
    const app = window.__samewhere, { game, space } = app;
    const wall = space.rooms.G.walls[3], marking = space.rooms.G.markings[0];
    function capture() {
      Object.assign(game.player, { room: 'G', x: -3.5, z: 4.8, yaw: Math.PI, pitch: 0 });
      app.sync(); space.render();
      const source = space.renderer.domElement, canvas = document.createElement('canvas');
      canvas.width = source.width; canvas.height = source.height;
      const context = canvas.getContext('2d')!; context.drawImage(source, 0, 0);
      const corners = [-.3, .3].flatMap(x => [-.3, .3].map(y => {
        const p = wall.solid.parent.localToWorld(space.camera.position.clone().set(-1.3 + x, 1.65 + y, 0)).project(space.camera);
        return { x: (p.x + 1) * canvas.width / 2, y: (1 - p.y) * canvas.height / 2 };
      }));
      const left = Math.floor(Math.min(...corners.map(p => p.x))), top = Math.floor(Math.min(...corners.map(p => p.y)));
      const width = Math.ceil(Math.max(...corners.map(p => p.x))) - left, height = Math.ceil(Math.max(...corners.map(p => p.y))) - top;
      const pixels = context.getImageData(left, top, width, height).data;
      let red = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 40 && pixels[i] > pixels[i + 1] * 1.6 && pixels[i] > pixels[i + 2] * 1.6) red++;
      return { red, image: canvas.toDataURL() };
    }
    const initial = capture();
    game.interact({ room: 'B', side: 2 }); game.interact({ room: 'G', side: 0 });
    const closed = capture();
    game.interact({ room: 'G', side: 0 }); game.interact({ room: 'G', side: 3 });
    const open = capture(), completed = game.world.passageProgress;
    const sameMaterial = wall.solid.getObjectByName('room-wall').material === wall.open.getObjectByName('room-wall').material;
    game.interact({ room: 'G', side: 3 }); const persistent = capture();
    game.reset(); const reset = capture();
    return { initial: initial.red, closed: closed.red, open: open.red, persistent: persistent.red, reset: reset.red,
      completed, sameMaterial, shownAfterReset: marking.shown.value, image: open.image };
  });
  await writeFile(info.outputPath('hub-passage-marking.png'), Buffer.from(result.image.split(',')[1], 'base64'));
  expect(result.initial).toBeGreaterThan(100); expect(result.closed).toBeGreaterThan(100);
  expect(result.open).toBeGreaterThan(100); expect(result.persistent).toBeGreaterThan(100);
  expect(result.reset).toBeGreaterThan(100); expect(result.shownAfterReset).toBe(1);
  expect(result.completed).toBe(1); expect(result.sameMaterial).toBe(true);
  expect(errors).toEqual([]);
});
