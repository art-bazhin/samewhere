import { test, expect } from '@playwright/test';

for (const url of ['/', '/?dev=0', '/?dev=1']) {
  test(`fast travel, restart and the FPS counter require dev=1: ${url}`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await expect(page.locator('.menu-intro, #help')).toHaveCount(0);
    await expect(page.getByText('Семь комнат. Четыре шара.')).toHaveCount(0);
    await expect(page.getByText('Как устроены связи')).toHaveCount(0);
    await expect(page.locator('#play-button')).toBeEnabled();
    await page.screenshot({ path: info.outputPath('menu.png') });
    await page.locator('#play-button').click();
    await expect(page.locator('#overlay')).toBeHidden();
    const initial = await page.evaluate(() => window.__samewhere.game.snapshot());
    if (url === '/?dev=1') {
      await expect(page.locator('#fps-counter')).toBeVisible();
      await expect(page.locator('#fps-counter')).toHaveText(/^\d+ FPS$/);
      const bounds = await page.locator('#fps-counter').boundingBox();
      expect(bounds!.x).toBeGreaterThan(page.viewportSize()!.width / 2);
      expect(bounds!.y).toBeLessThan(50);
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => window.__samewhere.game.player.room)).toBe('G');
      await page.keyboard.press('Digit0');
      await expect(page.locator('#inventory .held')).toHaveCount(4);
      expect(await page.evaluate(() => window.__samewhere.game.player.room)).toBe('A');
      await page.keyboard.press('Digit9');
      expect(await page.evaluate(() => window.__samewhere.game.world.gallery.signs.length)).toBe(42);
      await page.keyboard.press('KeyR');
      expect(await page.evaluate(() => window.__samewhere.game.snapshot())).toEqual(initial);
    } else {
      await expect(page.locator('#fps-counter')).toBeHidden();
      for (const key of ['Tab', 'Digit0', 'Numpad0', 'Digit9', 'Numpad9']) {
        await page.keyboard.press(key);
        expect(await page.evaluate(() => window.__samewhere.game.snapshot())).toEqual(initial);
      }
      const changed = await page.evaluate(() => {
        const { game, sync } = window.__samewhere;
        game.interact({ room: 'B', side: 0 }); sync();
        return game.snapshot();
      });
      expect(changed).not.toEqual(initial);
      await page.keyboard.press('KeyR');
      expect(await page.evaluate(() => window.__samewhere.game.snapshot())).toEqual(changed);
      expect((await page.locator('#hud').innerText()).trim()).toBe('');
    }
    await page.screenshot({ path: info.outputPath('game.png') });
    expect(errors).toEqual([]);
  });
}
