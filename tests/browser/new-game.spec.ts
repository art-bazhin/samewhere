import { test, expect } from '@playwright/test';

const progress = () => {
  const { game, sound } = window.__samewhere;
  return { state: game.snapshot(), history: game.history, music: [...sound.music.active], save: localStorage.getItem('samewhere.save') };
};

test('NEW GAME preserves active and saved progress until CONTINUE is confirmed', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const dialog = page.getByRole('dialog', { name: 'NEW GAME', exact: true });
  await page.goto('/'); await page.locator('#play-button').click(); await expect(page.locator('#overlay')).toBeHidden();
  await expect(dialog).toBeHidden();
  const initial = await page.evaluate(() => window.__samewhere.game.snapshot());
  await page.evaluate(() => {
    const { game, sound, sync } = window.__samewhere;
    game.interact({ room: 'B', side: 0 }); sound.music.update('B', 0); sync();
  });
  await page.keyboard.press('Escape'); await expect(page.locator('#overlay')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__samewhere.sound.context.state)).toBe('suspended');
  const current = await page.evaluate(progress);
  for (const dismiss of ['cancel', 'escape', 'backdrop']) {
    await page.locator('#play-button').click(); await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Starting a new game will erase your current progress.');
    await expect(dialog.locator('button')).toHaveText(['CANCEL', 'CONTINUE']);
    await expect(page.locator('#new-game-cancel')).toBeFocused();
    expect(await page.evaluate(progress)).toEqual(current);
    if (dismiss === 'cancel') {
      await page.screenshot({ path: info.outputPath('new-game-confirmation.png') });
      await page.locator('#new-game-cancel').click();
    } else if (dismiss === 'escape') await page.keyboard.press('Escape');
    else {
      await page.setViewportSize({ width: 640, height: 600 });
      await page.screenshot({ path: info.outputPath('new-game-confirmation-small.png') });
      await page.mouse.click(5, 5);
    }
    await expect(dialog).toBeHidden(); await expect(page.locator('#overlay')).toBeVisible();
    expect(await page.evaluate(progress)).toEqual(current);
    expect(await page.evaluate(() => window.__samewhere.sound.context.state)).toBe('suspended');
  }
  await page.reload(); await expect(page.locator('#loading-screen')).toBeHidden();
  await page.locator('#play-button').click(); await expect(dialog).toBeVisible();
  expect(await page.evaluate(progress)).toEqual(current);
  expect(await page.evaluate(() => window.__samewhere.sound.context)).toBeNull();
  await page.locator('#new-game-confirm').click(); await expect(dialog).toBeHidden();
  await expect(page.locator('#overlay')).toBeHidden();
  const fresh = await page.evaluate(progress);
  expect(fresh.state).toEqual(initial); expect(fresh.history).toEqual([]); expect(fresh.music).toEqual([0]);
  expect(JSON.parse(fresh.save!)).toMatchObject({ state: initial, history: [], music: [0] });
  expect(errors).toEqual([]);
});

test('Escape cancels confirmation in fullscreen without resuming; CONTINUE starts a new game', async ({ page }) => {
  await page.goto('/'); await page.locator('#play-button').click(); await expect(page.locator('#overlay')).toBeHidden();
  const initial = await page.evaluate(() => window.__samewhere.game.snapshot());
  await page.evaluate(() => { const { game, sync } = window.__samewhere; game.interact({ room: 'B', side: 0 }); sync(); });
  await page.keyboard.press('KeyF'); await page.waitForFunction(() => !!document.fullscreenElement);
  await page.keyboard.press('Escape'); await expect(page.locator('#overlay')).toBeVisible();
  const current = await page.evaluate(progress);
  await page.locator('#play-button').click(); await expect(page.locator('#new-game-dialog')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.locator('#new-game-dialog')).toBeHidden();
  await expect(page.locator('#overlay')).toBeVisible();
  expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  expect(await page.evaluate(() => document.pointerLockElement)).toBeNull();
  expect(await page.evaluate(progress)).toEqual(current);
  await page.locator('#play-button').click(); await page.locator('#new-game-confirm').click();
  await expect(page.locator('#overlay')).toBeHidden();
  expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  expect(await page.evaluate(() => window.__samewhere.game.snapshot())).toEqual(initial);
});
