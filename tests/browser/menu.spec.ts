import { test, expect } from '@playwright/test';

test('the English menu offers controls, resumes progress and starts a fresh game without dev mode', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const overlay = page.locator('#overlay'), dialog = page.getByRole('dialog', { name: 'CONTROLS' });
  await expect(page.locator('#play-button')).toBeEnabled();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('.menu-brand')).toHaveText('samewhere.');
  await expect(page.locator('.menu-actions button:visible')).toHaveText(['NEW GAME', 'CONTROLS']);
  await expect(page.locator('.menu-card, .overlay-caption, .menu-note, .menu-meta, .connection-sketch')).toHaveCount(0);
  const initial = await page.evaluate(async () => {
    const path = '/src/world.ts', { ROOMS, canStand } = await import(path);
    const { game } = window.__samewhere, pedestal = ROOMS.A.pedestals.find((p: any) => p.controls === 'A');
    if (game.player.x !== pedestal.x || game.player.z <= pedestal.z || game.player.yaw !== Math.PI || game.player.pitch !== 0 || !canStand('A', game.player)) {
      throw new Error('The player must stand beyond the square pedestal, facing the wall straight ahead');
    }
    const brand = getComputedStyle(document.querySelector('.menu-brand')!), item = getComputedStyle(document.querySelector('#play-button')!);
    if (brand.font !== item.font || brand.color !== item.color) throw new Error('Menu typography must match the wordmark');
    return game.snapshot();
  });
  expect(await page.locator('#game').evaluate(canvas => getComputedStyle(canvas).filter)).toBe('blur(3px)');
  await page.screenshot({ path: info.outputPath('start-menu.png') });
  await page.locator('#controls-button').click(); await expect(dialog).toBeVisible();
  await expect(dialog.locator('dd')).toHaveText(['Move', 'Look around', 'Take or place a ball', 'Select red / blue', 'Switch ball color', 'Undo last action', 'Pause', 'Toggle fullscreen', 'Toggle sound']);
  expect(await page.evaluate(() => /[А-Яа-яЁё]/.test(document.body.innerText + [...document.querySelectorAll('[aria-label]')].map(element => element.getAttribute('aria-label')).join('')))).toBe(false);
  await page.screenshot({ path: info.outputPath('controls.png') });
  await page.locator('#controls-close').click(); await expect(dialog).not.toBeVisible();
  await page.locator('#controls-button').click(); await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
  await expect(overlay).toBeVisible(); await expect(page.locator('#resume-button')).toBeHidden();

  await page.locator('#play-button').click(); await expect(overlay).toBeHidden();
  expect(await page.locator('#game').evaluate(canvas => getComputedStyle(canvas).filter)).toBe('none');
  expect(await page.evaluate(() => window.__samewhere.game.snapshot())).toEqual(initial);
  const changed = await page.evaluate(() => {
    const { game, sync } = window.__samewhere;
    game.interact({ room: 'B', side: 0 }); game.player.room = 'B'; sync();
    return game.snapshot();
  });
  await page.keyboard.press('Escape'); await expect(overlay).toBeVisible();
  await expect(page.locator('.menu-actions button:visible')).toHaveText(['RESUME GAME', 'NEW GAME', 'CONTROLS']);
  await page.screenshot({ path: info.outputPath('pause-menu.png') });
  await page.locator('#controls-button').click(); await page.locator('#controls-close').click();
  await page.locator('#resume-button').click(); await expect(overlay).toBeHidden();
  expect(await page.evaluate(() => window.__samewhere.game.snapshot())).toEqual(changed);
  expect(await page.evaluate(() => [...window.__samewhere.sound.music.active])).toEqual([0, 1]);
  await page.keyboard.press('Escape'); await expect(overlay).toBeVisible();
  await page.locator('#play-button').click(); await expect(overlay).toBeHidden();
  expect(await page.evaluate(() => window.__samewhere.game.snapshot())).toEqual(initial);
  expect(await page.evaluate(() => window.__samewhere.game.history.length)).toBe(0);
  expect(await page.evaluate(() => [...window.__samewhere.sound.music.active])).toEqual([0]);

  await page.keyboard.press('Escape'); await expect(overlay).toBeVisible();
  await page.setViewportSize({ width: 640, height: 600 });
  await page.locator('#controls-button').click(); await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(640); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(600);
  await page.screenshot({ path: info.outputPath('controls-small.png') });
  expect(errors).toEqual([]);
});
