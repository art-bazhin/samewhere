import { test, expect, type Page } from '@playwright/test';

async function turn(page: Page, packets: number) {
  return page.evaluate(async packets => {
    const app = window.__samewhere;
    app.mouseLook.reset(); app.game.player.yaw = app.game.player.pitch = 0;
    for (let i = 0; i < packets; i++) {
      document.dispatchEvent(new PointerEvent(app.mouseEvent, { movementX: 40 / packets, movementY: -20 / packets }));
      if (packets > 1) await new Promise(resolve => setTimeout(resolve, 25));
    }
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return { yaw: app.game.player.yaw, pitch: app.game.player.pitch };
  }, packets);
}

test('look sensitivity scales both axes without acceleration and survives reload and NEW GAME', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const state = window as any; state.captureOptions = [];
    const request = Element.prototype.requestPointerLock;
    Element.prototype.requestPointerLock = function(options) {
      state.captureOptions.push(options?.unadjustedMovement ?? false);
      return request.call(this, options);
    };
  });
  await page.goto('/'); await expect(page.locator('#loading-screen')).toBeHidden();
  await page.locator('#controls-button').click();
  const slider = page.getByRole('slider', { name: 'LOOK SENSITIVITY', exact: true });
  const value = page.locator('#look-sensitivity-value');
  await expect(slider).toHaveValue('1'); await expect(value).toHaveText('1.0');
  const initial = await page.evaluate(() => window.__samewhere.game.snapshot());
  await slider.press('Tab'); await expect(page.locator('#controls-close')).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(slider).toBeFocused();
  await expect(slider).toHaveCSS('outline-style', 'solid');
  await slider.press('End'); await expect(value).toHaveText('4.0');
  await expect(slider).toHaveAttribute('aria-valuetext', '4.0');
  expect(await page.evaluate(() => window.__samewhere.game.snapshot())).toEqual(initial);
  expect(await page.evaluate(() => localStorage.getItem('samewhere.save'))).toBeNull();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('samewhere.settings')!))).toEqual({ lookSensitivity: 4 });
  await page.locator('#controls-close').click(); await page.locator('#play-button').click();
  await expect(page.locator('#overlay')).toBeHidden();
  expect(await page.evaluate(() => (window as any).captureOptions[0])).toBe(true);
  const fast = await turn(page, 1), slow = await turn(page, 4);
  expect(fast.yaw).toBeCloseTo(-40 * .002 * 4, 8); expect(fast.pitch).toBeCloseTo(20 * .002 * 4, 8);
  expect(slow.yaw).toBeCloseTo(fast.yaw, 8); expect(slow.pitch).toBeCloseTo(fast.pitch, 8);
  await page.keyboard.press('Escape'); await expect(page.locator('#overlay')).toBeVisible();
  await page.reload(); await expect(page.locator('#loading-screen')).toBeHidden();
  await page.locator('#controls-button').click();
  await expect(slider).toHaveValue('4'); await expect(value).toHaveText('4.0');
  await page.locator('#controls-close').click(); await page.locator('#play-button').click();
  await expect(page.locator('#new-game-dialog')).toBeVisible(); await page.locator('#new-game-confirm').click();
  await expect(page.locator('#overlay')).toBeHidden();
  expect(await page.evaluate(() => window.__samewhere.game.snapshot())).toEqual(initial);
  await page.keyboard.press('Escape'); await expect(page.locator('#overlay')).toBeVisible();
  await page.locator('#controls-button').click(); await expect(value).toHaveText('4.0');
  await slider.press('Home'); await expect(value).toHaveText('0.2');
  await slider.press('ArrowRight'); await expect(slider).toHaveValue('0.3'); await expect(value).toHaveText('0.3');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('samewhere.settings')!).lookSensitivity)).toBeCloseTo(.3, 8);
  expect(errors).toEqual([]);
});

test('blocked settings storage still allows changing sensitivity for the current session', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
    Storage.prototype.getItem = function(key) {
      if (key === 'samewhere.settings') throw new Error('Settings blocked');
      return get.call(this, key);
    };
    Storage.prototype.setItem = function(key, value) {
      if (key === 'samewhere.settings') throw new Error('Settings blocked');
      return set.call(this, key, value);
    };
  });
  await page.goto('/'); await expect(page.locator('#loading-screen')).toBeHidden();
  await page.locator('#controls-button').click();
  const slider = page.getByRole('slider', { name: 'LOOK SENSITIVITY', exact: true });
  await expect(page.locator('#look-sensitivity-value')).toHaveText('1.0');
  await slider.press('End'); await expect(page.locator('#look-sensitivity-value')).toHaveText('4.0');
  await page.locator('#controls-close').click(); await page.locator('#play-button').click();
  await expect(page.locator('#overlay')).toBeHidden();
  expect((await turn(page, 1)).yaw).toBeCloseTo(-40 * .002 * 4, 8);
  expect(errors).toEqual([]);
});
