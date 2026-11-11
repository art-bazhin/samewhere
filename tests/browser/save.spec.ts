import { test, expect } from '@playwright/test';

const savedGame = () => {
  const { game, sound } = window.__samewhere;
  return { state: game.snapshot(), history: game.history, transitions: game.transitions, music: [...sound.music.active], soundEnabled: sound.enabled };
};

for (const paused of [false, true]) {
  test(`leaving the page does not recreate a manually deleted save: ${paused ? 'paused' : 'playing'}`, async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('/'); await page.locator('#play-button').click(); await expect(page.locator('#overlay')).toBeHidden();
    const initial = await page.evaluate(() => window.__samewhere.game.snapshot());
    await page.evaluate(() => { const { game, sync } = window.__samewhere; game.interact({ room: 'B', side: 0 }); sync(); });
    expect(await page.evaluate(() => localStorage.getItem('samewhere.save'))).not.toBeNull();
    if (paused) { await page.keyboard.press('Escape'); await expect(page.locator('#overlay')).toBeVisible(); }
    await Promise.all([
      page.waitForEvent('domcontentloaded'),
      page.evaluate(() => { localStorage.removeItem('samewhere.save'); location.reload(); }),
    ]);
    await expect(page.locator('#loading-screen')).toBeHidden(); await expect(page.locator('#resume-button')).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('samewhere.save'))).toBeNull();
    expect(await page.evaluate(() => window.__samewhere.game.snapshot())).toEqual(initial);
    await page.locator('#play-button').click(); await expect(page.locator('#overlay')).toBeHidden();
    await expect(page.locator('#new-game-dialog')).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('samewhere.save'))).not.toBeNull();
    expect(errors).toEqual([]);
  });
}

test('leaving the page still updates an existing save with the latest position', async ({ page }) => {
  await page.goto('/'); await page.locator('#play-button').click(); await expect(page.locator('#overlay')).toBeHidden();
  const player = await page.evaluate(() => {
    const { game } = window.__samewhere; game.player.x += .125; return { ...game.player };
  });
  await page.reload(); await expect(page.locator('#loading-screen')).toBeHidden();
  await expect(page.locator('#resume-button')).toBeVisible();
  expect(await page.evaluate(() => window.__samewhere.game.player)).toEqual(player);
});

test('reload resumes the full autosaved game and undo history; NEW GAME replaces it', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await expect(page.locator('#loading-screen')).toBeHidden();
  await expect(page.locator('#resume-button')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('samewhere.save'))).toBeNull();
  await page.locator('#play-button').click(); await expect(page.locator('#overlay')).toBeHidden();
  const initial = await page.evaluate(() => window.__samewhere.game.snapshot());
  await page.evaluate(() => {
    const { game, sound, sync } = window.__samewhere;
    game.interact({ room: 'B', side: 0 }); game.interact({ room: 'C', side: 0 });
    game.world.passageProgress = 2; game.transitions = 7;
    Object.assign(game.player, { room: 'G', x: 0, z: 3, yaw: .3, pitch: -.2 });
    sound.music.update('B', 0); sound.music.update('D', 0); sync();
  });
  await page.keyboard.down('KeyW'); await page.waitForTimeout(200); await page.keyboard.up('KeyW');
  // Periodic saving must cover walking even without an interaction or pause.
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('samewhere.save')!).state.player.z)).toBeLessThan(2.9);
  await page.keyboard.press('Digit2'); await page.keyboard.press('KeyM');
  await page.keyboard.press('Escape'); await expect(page.locator('#overlay')).toBeVisible();
  const expected = await page.evaluate(savedGame);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('samewhere.save')!))).toMatchObject(expected);
  await page.reload(); await expect(page.locator('#loading-screen')).toBeHidden();
  await expect(page.locator('#resume-button')).toBeVisible();
  expect(await page.evaluate(savedGame)).toEqual(expected);
  expect(await page.evaluate(() => window.__samewhere.sound.context)).toBeNull();
  await page.locator('#resume-button').click(); await expect(page.locator('#overlay')).toBeHidden();
  expect(await page.evaluate(savedGame)).toEqual(expected);
  expect(await page.evaluate(() => window.__samewhere.sound.music.layers.map(({ gain }: any) => gain.gain.value)))
    .toEqual([expect.closeTo(10 ** (-10 / 20), 6), 1, 1, 1, 0, 0]);
  await page.evaluate(() => window.__samewhere.undo());
  expect(await page.evaluate(() => window.__samewhere.game.snapshot())).toEqual(expected.history.at(-1));
  await page.keyboard.press('Escape'); await expect(page.locator('#overlay')).toBeVisible();
  await page.locator('#play-button').click(); await page.locator('#new-game-confirm').click();
  await expect(page.locator('#overlay')).toBeHidden();
  expect(await page.evaluate(() => window.__samewhere.game.snapshot())).toEqual(initial);
  await page.reload(); await expect(page.locator('#loading-screen')).toBeHidden();
  expect(await page.evaluate(savedGame)).toMatchObject({ state: initial, history: [], transitions: 0, music: [0] });
  expect(errors).toEqual([]);
});

test('gallery coordinates, EXIT signs and the ending survive reload; PLAY AGAIN creates a fresh save', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?dev=1'); await page.locator('#play-button').click(); await expect(page.locator('#overlay')).toBeHidden();
  const initial = await page.evaluate(() => window.__samewhere.game.snapshot());
  await page.keyboard.press('Digit9');
  const gallery = await page.evaluate(savedGame);
  await page.reload(); await expect(page.locator('#loading-screen')).toBeHidden();
  expect(await page.evaluate(savedGame)).toEqual(gallery);
  await page.locator('#resume-button').click(); await expect(page.locator('#overlay')).toBeHidden();
  await page.evaluate(async () => {
    const path = '/src/world.ts', { portalPosition, wallNormal } = await import(path);
    const { game, sync, mouseLook } = window.__samewhere;
    const side = game.world.gallery.signs.at(-1).side, p = portalPosition('A', side), n = wallNormal('A', side);
    Object.assign(game.player, { x: p.x - n.x * .08, z: p.z - n.z * .08 }); mouseLook.reset(); sync();
  });
  await page.keyboard.down('KeyW'); await expect(page.locator('#ending-screen')).toBeVisible(); await page.keyboard.up('KeyW');
  const ending = await page.evaluate(savedGame);
  await page.reload(); await expect(page.locator('#loading-screen')).toBeHidden();
  await expect(page.locator('#ending-screen')).toBeHidden();
  expect(await page.evaluate(savedGame)).toEqual(ending);
  await page.locator('#resume-button').click(); await expect(page.locator('#ending-screen')).toBeVisible();
  await page.locator('#ending-screen').evaluate(screen => screen.getAnimations({ subtree: true }).forEach(animation => animation.finish()));
  await expect(page.locator('#play-again')).toBeEnabled();
  await page.locator('#play-again').click(); await expect(page.locator('#overlay')).toBeHidden();
  await page.reload(); await expect(page.locator('#loading-screen')).toBeHidden();
  expect(await page.evaluate(savedGame)).toMatchObject({ state: initial, history: [], transitions: 0, music: [0] });
  expect(errors).toEqual([]);
});
