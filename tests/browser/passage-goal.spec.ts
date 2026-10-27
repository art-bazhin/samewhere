import { writeFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

test('the complete drawing chain reveals in order and ends with four simultaneous square markings', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const result = await page.evaluate(async () => {
    const path = '/src/world.ts', { PASSAGE_GOALS, FINAL_PASSAGE_GOALS } = await import(path);
    const app = window.__samewhere, { game, space } = app;
    const images: { name: string; data: string }[] = [];
    function check(condition: boolean, message: string) { if (!condition) throw new Error(message); }
    function sync() {
      app.sync();
      for (const room of Object.values(space.rooms) as any[]) for (const marking of room.markings) {
        check(marking.shown.value === Number(game.world.passageProgress >= marking.goal), `Wrong marking visibility at stage ${game.world.passageProgress}`);
      }
    }
    function clear() {
      game.player.room = 'G';
      for (const ball of game.world.balls) if (ball.socket) check(game.interact(ball.socket) === 'take', 'Cannot collect ball from hub');
      sync();
    }
    function place(color: string, ref: any) {
      game.world.selected = color; check(game.interact(ref) === 'place', `Cannot place ${color} at ${ref.room}${ref.side}`);
    }
    function capture(goal: any) {
      const room = goal.from.room, side = goal.from.side, wall = space.rooms[room].walls[side], frame = wall.solid.parent;
      const eye = frame.localToWorld(space.camera.position.clone().set(0, 0, 2.2));
      Object.assign(game.player, { room, x: eye.x, z: eye.z, yaw: frame.rotation.y, pitch: 0 });
      sync(); space.render();
      const source = space.renderer.domElement, canvas = document.createElement('canvas');
      canvas.width = source.width; canvas.height = source.height;
      const context = canvas.getContext('2d')!; context.drawImage(source, 0, 0);
      const corners = [-.3, .3].flatMap(x => [-.3, .3].map(y => {
        const p = frame.localToWorld(space.camera.position.clone().set(-1.3 + x, 1.65 + y, 0)).project(space.camera);
        return { x: (p.x + 1) * canvas.width / 2, y: (1 - p.y) * canvas.height / 2 };
      }));
      const left = Math.floor(Math.min(...corners.map(p => p.x))), top = Math.floor(Math.min(...corners.map(p => p.y)));
      const width = Math.ceil(Math.max(...corners.map(p => p.x))) - left, height = Math.ceil(Math.max(...corners.map(p => p.y))) - top;
      const pixels = context.getImageData(left, top, width, height).data;
      let colored = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
        if (goal.color === 'red' ? r > 40 && r > g * 1.6 && r > b * 1.6 : b > 20 && b > r * 1.3 && g > r * 1.2) colored++;
      }
      return { colored, data: canvas.toDataURL() };
    }
    const initial = capture(PASSAGE_GOALS[0]);
    check(initial.colored > 100, 'The hub drawing must be present from the start');
    images.push({ name: 'marker-G3.png', data: initial.data });
    for (const room of ['C', 'E', 'F']) check(space.rooms[room].markings.length === 0, `An obsolete drawing remains in ${room}`);
    check(space.rooms.A.markings.length === 4 && space.rooms.A.markings.every((m: any) => m.shown.value === 0), 'Final drawings leaked into the starting room');
    for (const [stage, goal] of PASSAGE_GOALS.entries()) {
      clear();
      const wrong = goal.color === 'red' ? 'blue' : 'red';
      place(wrong, goal.from); place(wrong, { room: goal.to, side: 0 }); sync();
      check(game.world.passageProgress === stage, 'Wrong color advanced the chain');
      clear(); place(goal.color, goal.from); place(goal.color, { room: goal.to, side: 0 }); sync();
      check(game.world.passageProgress === stage + 1, 'Correct connection did not advance');
      game.undo(); sync(); check(game.world.passageProgress === stage, 'Undo did not hide the next drawing');
      place(goal.color, { room: goal.to, side: 0 }); sync();
      const next = stage + 1 < PASSAGE_GOALS.length ? [PASSAGE_GOALS[stage + 1]] : FINAL_PASSAGE_GOALS;
      for (const marking of next) {
        const image = capture(marking);
        check(image.colored > 100, `Missing ${marking.color} ink at ${marking.from.room}${marking.from.side}`);
        images.push({ name: `marker-${marking.from.room}${marking.from.side}.png`, data: image.data });
      }
    }
    clear();
    for (const goal of FINAL_PASSAGE_GOALS) place(goal.color, goal.from);
    sync(); check(game.world.passageProgress === PASSAGE_GOALS.length, 'Remote assembly incorrectly completed the finale');
    game.player.room = 'A';
    game.interact({ room: 'A', side: 3 }); place('blue', { room: 'A', side: 3 }); sync();
    check(game.world.passageProgress === PASSAGE_GOALS.length + 1, 'The simultaneous pattern did not complete inside A');
    game.undo(); sync(); check(game.world.passageProgress === PASSAGE_GOALS.length, 'Final completion was not undoable');
    game.reset(); sync();
    for (const goal of FINAL_PASSAGE_GOALS) check(capture(goal).colored === 0, 'A final drawing survived reset');
    check(space.rooms.G.markings[0].shown.value === 1, 'Reset removed the hub drawing');
    return { images, progress: game.world.passageProgress };
  });
  for (const image of result.images) await writeFile(info.outputPath(image.name), Buffer.from(image.data.split(',')[1], 'base64'));
  expect(result.images).toHaveLength(7); expect(result.progress).toBe(0); expect(errors).toEqual([]);
});
