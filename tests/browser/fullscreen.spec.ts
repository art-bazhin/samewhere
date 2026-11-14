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
  await expect(page.locator('#overlay')).toBeHidden();
  expect(await page.evaluate(() => document.pointerLockElement?.id)).toBe('game');
  expect(errors).toEqual([]);
});

for (const cancel of [null, 'escape', 'focus'] as const) {
  const name = cancel === 'escape' ? 'Escape during fullscreen exit cancels automatic pointer recapture'
    : cancel === 'focus' ? 'remaining unfocused during fullscreen exit keeps the game paused'
    : 'F restores focus and pointer lock lost during fullscreen exit without showing the menu';
  test(name, async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const state = window as any; state.captureCalls = 0;
      const capture = Element.prototype.requestPointerLock;
      Element.prototype.requestPointerLock = function(options) { state.captureCalls++; return capture.call(this, options); };
      const exit = Document.prototype.exitFullscreen;
      Document.prototype.exitFullscreen = async function() {
        await exit.call(this);
        const released = new Promise<void>(resolve => document.addEventListener('pointerlockchange', () => resolve(), { once: true }));
        document.exitPointerLock(); await released;
        const focused = document.hasFocus.bind(document); state.transitionFocused = false;
        Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => state.transitionFocused && focused() });
        window.dispatchEvent(new Event('blur'));
        state.fullscreenPointerDropped = true;
        await new Promise<void>(resolve => { state.finishFullscreenExit = resolve; });
      };
    });
    await page.goto('/'); await expect(page.locator('#loading-screen')).toBeHidden();
    await page.locator('#play-button').click(); await expect(page.locator('#overlay')).toBeHidden();
    const initial = await page.evaluate(() => window.__samewhere.game.snapshot());
    await page.keyboard.press('KeyF'); await page.waitForFunction(() => !!document.fullscreenElement);
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      const state = window as any, menu = document.getElementById('overlay')!; state.menuAppearances = 0;
      new MutationObserver(() => { if (!menu.hidden) state.menuAppearances++; })
        .observe(menu, { attributes: true, attributeFilter: ['hidden'] });
    });
    await page.keyboard.press('KeyF'); await page.waitForFunction(() => (window as any).fullscreenPointerDropped);
    if (cancel === 'escape') await page.keyboard.press('Escape');
    if (!cancel) await page.evaluate(() => setTimeout(() => { (window as any).transitionFocused = true; }, 200));
    await page.evaluate(() => (window as any).finishFullscreenExit());
    if (cancel) {
      await expect(page.locator('#overlay')).toBeVisible();
      await page.waitForTimeout(150);
      expect(await page.evaluate(() => document.pointerLockElement)).toBeNull();
      expect(await page.evaluate(() => (window as any).captureCalls)).toBe(1);
    } else {
      await page.waitForFunction(() => document.pointerLockElement?.id === 'game');
      await expect(page.locator('#overlay')).toBeHidden();
      expect(await page.evaluate(() => (window as any).captureCalls)).toBe(2);
      expect(await page.evaluate(() => (window as any).menuAppearances)).toBe(0);
      // Ordinary focus loss must still pause once the F transition has completed.
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      await expect(page.locator('#overlay')).toBeVisible();
      expect(await page.evaluate(() => document.pointerLockElement)).toBeNull();
    }
    expect(await page.evaluate(() => window.__samewhere.game.snapshot())).toEqual(initial);
    await page.evaluate(() => { delete (document as any).hasFocus; });
    expect(errors).toEqual([]);
  });
}

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
    await expect(page.locator('#overlay')).toBeVisible();
    expect(await page.evaluate(() => document.pointerLockElement)).toBeNull();
    await expect(page.locator('#error')).toBeHidden(); expect(errors).toEqual([]);
  });
}
