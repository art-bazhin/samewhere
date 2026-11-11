import { test, expect } from '@playwright/test';

test('windowed mode resumes through the button while Escape only pauses or closes controls', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await expect(page.locator('#loading-screen')).toBeHidden();
  const menu = page.locator('#overlay'), controls = page.locator('#controls-dialog');
  await page.keyboard.press('Escape'); await expect(menu).toBeVisible();
  expect(await page.evaluate(() => document.pointerLockElement)).toBeNull();
  await page.locator('#play-button').click(); await expect(menu).toBeHidden();
  const state = await page.evaluate(() => {
    const { game, sync } = window.__samewhere; game.interact({ room: 'B', side: 0 }); sync(); return game.snapshot();
  });
  await page.keyboard.down('Escape'); await expect(menu).toBeVisible();
  await page.keyboard.down('Escape'); await expect(menu).toBeVisible(); await page.keyboard.up('Escape');
  await page.locator('#controls-button').click();
  await page.keyboard.press('Escape'); await expect(controls).toBeHidden(); await expect(menu).toBeVisible();
  await page.keyboard.press('Escape'); await expect(menu).toBeVisible();
  expect(await page.evaluate(() => document.pointerLockElement)).toBeNull();
  await page.locator('#resume-button').click(); await expect(menu).toBeHidden();
  expect(await page.evaluate(() => document.pointerLockElement?.id)).toBe('game');
  expect(await page.evaluate(() => window.__samewhere.game.snapshot())).toEqual(state);
  await page.keyboard.press('Escape'); await expect(menu).toBeVisible();
  await page.keyboard.press('Escape'); await expect(menu).toBeVisible();
  await page.locator('#resume-button').click(); await expect(menu).toBeHidden();
  expect(errors).toEqual([]);
});

test('fullscreen captures only Escape, keeps short presses in fullscreen and releases the keyboard on exit', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const state = window as any, keyboard = (navigator as any).keyboard;
    state.keyboardLocks = []; state.keyboardUnlocks = 0;
    const lock = keyboard.lock.bind(keyboard), unlock = keyboard.unlock.bind(keyboard);
    keyboard.lock = async (keys: string[]) => { await lock(keys); state.keyboardLocks.push(keys); };
    keyboard.unlock = () => { state.keyboardUnlocks++; unlock(); };
  });
  await page.goto('/'); await page.locator('#play-button').click(); await expect(page.locator('#overlay')).toBeHidden();
  const state = await page.evaluate(() => window.__samewhere.game.snapshot());
  await page.keyboard.press('KeyF');
  await expect.poll(() => page.evaluate(() => (window as any).keyboardLocks)).toEqual([['Escape']]);
  await page.keyboard.press('Escape'); await expect(page.locator('#overlay')).toBeVisible();
  expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  await page.keyboard.press('Escape'); await expect(page.locator('#overlay')).toBeHidden();
  expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  expect(await page.evaluate(() => window.__samewhere.game.snapshot())).toEqual(state);
  await page.keyboard.press('KeyF'); await page.waitForFunction(() => !document.fullscreenElement);
  await expect.poll(() => page.evaluate(() => (window as any).keyboardUnlocks)).toBe(1);
  expect(errors).toEqual([]);
});

for (const mode of ['unavailable', 'rejected']) {
  test(`fullscreen still works when Keyboard Lock is ${mode}`, async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(mode => {
      Object.defineProperty(navigator, 'keyboard', { value: mode === 'unavailable' ? undefined : {
        lock: () => Promise.reject(new DOMException('Keyboard lock is not allowed.', 'NotAllowedError')), unlock() {},
      } });
    }, mode);
    await page.goto('/'); await expect(page.locator('#loading-screen')).toBeHidden();
    await page.keyboard.press('KeyF'); await page.waitForFunction(() => !!document.fullscreenElement);
    await page.keyboard.press('KeyF'); await page.waitForFunction(() => !document.fullscreenElement);
    await expect(page.locator('#error')).toBeHidden(); expect(errors).toEqual([]);
  });
}
