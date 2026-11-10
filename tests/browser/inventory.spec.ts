import { test, expect } from '@playwright/test';

test('the minimal inventory shows held balls, switches available colors and follows real take/place/undo actions', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/?dev=1'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  await page.locator('#play-button').click(); await expect(page.locator('#overlay')).toBeHidden();
  const held = page.locator('#inventory .held');
  const selected = page.locator('#inventory .held.selected');
  await expect(held).toHaveCount(0);
  await expect(page.locator('#room-name, #room-shape, #red-count, #blue-count, #interaction, #toast, #hud button, #hud kbd, .topbar, .bottom-bar')).toHaveCount(0);
  await expect(page.locator('#fps-counter')).toHaveText(/^\d+ FPS$/);
  await page.screenshot({ path: info.outputPath('empty-hands.png') });
  await page.keyboard.press('F3'); await expect(page.locator('#debug')).toBeVisible();
  await page.keyboard.press('F3'); await expect(page.locator('#debug')).toBeHidden();
  await page.keyboard.press('Escape'); await expect(page.locator('#overlay')).toBeVisible();
  await expect(page.locator('#controls-button')).toBeVisible();
  await page.locator('#resume-button').click(); await expect(page.locator('#overlay')).toBeHidden();
  await page.keyboard.press('Digit0'); await expect(held).toHaveCount(4);
  await expect(page.locator('#inventory .held[data-color=red]')).toHaveCount(2);
  await expect(page.locator('#inventory .held[data-color=blue]')).toHaveCount(2);
  await expect(selected).toHaveCount(2); await expect(selected.first()).toHaveAttribute('data-color', 'red');
  await page.mouse.wheel(0, 100); await expect(selected.first()).toHaveAttribute('data-color', 'blue');
  await page.mouse.wheel(0, -100); await expect(selected.first()).toHaveAttribute('data-color', 'red');
  await page.keyboard.press('Digit2'); await expect(selected.first()).toHaveAttribute('data-color', 'blue');
  await page.keyboard.press('Escape'); await expect(page.locator('#overlay')).toBeVisible();
  await page.mouse.wheel(0, 100); await expect(selected.first()).toHaveAttribute('data-color', 'blue');
  await page.locator('#resume-button').click(); await expect(page.locator('#overlay')).toBeHidden();
  await expect.poll(() => page.evaluate(() => {
    const selected = document.querySelector('#inventory .held.selected')!.getBoundingClientRect();
    const other = document.querySelector('#inventory .held:not(.selected)')!.getBoundingClientRect();
    return Math.abs(selected.y + selected.height / 2 - other.y - other.height / 2) < .1 && selected.width > other.width + 2;
  })).toBe(true);
  await page.screenshot({ path: info.outputPath('four-balls-blue-selected.png') });

  async function clickSocket(side: number) {
    expect(await page.evaluate(side => {
      const { game, space, mouseLook } = window.__samewhere;
      const target = space.rooms.A.sockets.find((socket: any) => socket.ref.room === 'A' && socket.ref.side === side);
      const pedestal = target.hit.parent.parent.position;
      Object.assign(game.player, { room: 'A', x: pedestal.x, z: pedestal.z + 1.25 }); mouseLook.reset();
      const point = (target.ball.visible ? target.ball : target.hit).getWorldPosition(space.camera.position.clone());
      if (!target.ball.visible) { point.x += .004; point.z += .002; }
      const dx = point.x - game.player.x, dz = point.z - game.player.z;
      game.player.yaw = Math.atan2(-dx, -dz); game.player.pitch = Math.atan2(point.y - 1.65, Math.hypot(dx, dz));
      return space.pick();
    }, side)).toEqual({ room: 'A', side });
    await page.mouse.down(); await page.mouse.up();
  }
  await clickSocket(0); await expect(page.locator('#inventory .held[data-color=blue]')).toHaveCount(1);
  await expect(selected.first()).toHaveAttribute('data-color', 'blue');
  await clickSocket(1); await expect(page.locator('#inventory .held[data-color=blue]')).toHaveCount(0);
  await expect(selected).toHaveCount(2); await expect(selected.first()).toHaveAttribute('data-color', 'red');
  await page.keyboard.press('Digit2'); await expect(selected.first()).toHaveAttribute('data-color', 'red');
  await page.mouse.wheel(0, 100); await expect(selected.first()).toHaveAttribute('data-color', 'red');
  await clickSocket(0); await expect(page.locator('#inventory .held[data-color=blue]')).toHaveCount(1);
  await expect(selected).toHaveCount(1); await expect(selected.first()).toHaveAttribute('data-color', 'blue');
  await page.keyboard.press('KeyZ'); await expect(page.locator('#inventory .held[data-color=blue]')).toHaveCount(0);
  await expect(selected.first()).toHaveAttribute('data-color', 'red');
  await page.keyboard.press('KeyZ'); await expect(page.locator('#inventory .held[data-color=blue]')).toHaveCount(1);
  await expect(selected.first()).toHaveAttribute('data-color', 'blue');
  await page.keyboard.press('KeyR'); await expect(held).toHaveCount(0);
  await expect.poll(() => page.locator('#inventory .inventory-ball').evaluateAll(elements => elements.every(element => Number(getComputedStyle(element).opacity) === 0))).toBe(true);
  expect(errors).toEqual([]);
});
