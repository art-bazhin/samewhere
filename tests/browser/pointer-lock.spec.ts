import { test, expect } from '@playwright/test';

test('NEW GAME retries an Esc cooldown once and ignores repeated clicks while capture is pending', async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as any; state.captureCalls = [];
    const request = Element.prototype.requestPointerLock;
    Element.prototype.requestPointerLock = function(options) {
      state.captureCalls.push(performance.now());
      if (state.captureCalls.length === 1) return Promise.reject(new DOMException(
        'Pointer lock cannot be acquired immediately after the user has exited the lock.', 'SecurityError'));
      return request.call(this, options);
    };
  });
  await page.goto('/'); await expect(page.locator('#loading-screen')).toBeHidden();
  await page.evaluate(() => {
    const state = window as any, game = window.__samewhere.game, reset = game.reset.bind(game); state.resets = 0;
    game.reset = () => { state.resets++; reset(); };
  });
  await page.locator('#play-button').dblclick(); await expect(page.locator('#overlay')).toBeHidden();
  const calls = await page.evaluate(() => (window as any).captureCalls as number[]);
  expect(calls).toHaveLength(2); expect(calls[1] - calls[0]).toBeGreaterThanOrEqual(1250);
  expect(await page.evaluate(() => (window as any).resets)).toBe(1);
  expect(await page.evaluate(() => document.pointerLockElement?.id)).toBe('game');
  await expect(page.locator('#error')).toBeHidden();
});

test('Escape cancels a pending retry instead of capturing the mouse later', async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as any; state.captureCalls = 0;
    Element.prototype.requestPointerLock = () => {
      state.captureCalls++;
      return Promise.reject(new DOMException('Pointer lock cannot be acquired immediately after the user has exited the lock.', 'SecurityError'));
    };
  });
  await page.goto('/'); await expect(page.locator('#loading-screen')).toBeHidden();
  await page.locator('#play-button').click(); await page.keyboard.press('Escape');
  await page.waitForTimeout(1450);
  expect(await page.evaluate(() => (window as any).captureCalls)).toBe(1);
  expect(await page.evaluate(() => document.pointerLockElement)).toBeNull();
  await expect(page.locator('#overlay')).toBeVisible(); await expect(page.locator('#error')).toBeHidden();
});

test('capture errors leave the logo and menu in place at both viewport sizes', async ({ page }, info) => {
  await page.addInitScript(() => {
    Element.prototype.requestPointerLock = () => Promise.reject(new DOMException('Pointer lock is blocked by the frame sandbox.', 'SecurityError'));
  });
  await page.goto('/'); await expect(page.locator('#loading-screen')).toBeHidden();
  for (const width of [1440, 640]) {
    await page.setViewportSize({ width, height: 720 });
    await page.locator('#error').evaluate(error => error.setAttribute('hidden', ''));
    const menu = await page.locator('.menu-actions').boundingBox(), brand = await page.locator('.menu-brand').boundingBox();
    await page.locator('#play-button').click(); await expect(page.locator('#error')).toBeVisible();
    expect(await page.locator('.menu-actions').boundingBox()).toEqual(menu);
    expect(await page.locator('.menu-brand').boundingBox()).toEqual(brand);
    const error = await page.locator('#error').boundingBox();
    expect(error!.y).toBeGreaterThan(menu!.y + menu!.height);
    expect(error!.x).toBeCloseTo(menu!.x, 1); expect(error!.x + error!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: info.outputPath(`capture-error-${width}.png`) });
  }
});
