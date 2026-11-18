import { test, expect } from '@playwright/test';
import { Game } from '../../src/world';
import { GAME_VERSION } from '../../src/version';

const savedGame = () => {
  const { game, sound } = window.__samewhere;
  return { state: game.snapshot(), transitions: game.transitions, music: [...sound.music.active], soundEnabled: sound.enabled };
};

test('loading a current-version save immediately removes obsolete history without losing progress', async ({ page }) => {
  const game = new Game(); game.interact({ room: 'B', side: 0 });
  Object.assign(game.player, { x: 1.25, z: 3, yaw: .3, pitch: -.2 });
  const current = { version: GAME_VERSION, state: game.snapshot(), transitions: 7, music: [0, 1], soundEnabled: false };
  const legacy = { ...current, history: Array(256).fill(current.state) };
  await page.addInitScript(save => localStorage.setItem('samewhere.save', JSON.stringify(save)), legacy);
  await page.goto('/'); await expect(page.locator('#loading-screen')).toBeHidden();
  await expect(page.locator('#resume-button')).toBeVisible();
  expect(await page.evaluate(savedGame)).toEqual({ state: current.state, transitions: 7, music: [0, 1], soundEnabled: false });
  const stored = await page.evaluate(() => localStorage.getItem('samewhere.save')!);
  expect(JSON.parse(stored)).toEqual(current);
  expect(stored.length).toBeLessThan(JSON.stringify(legacy).length / 100);
  expect(await page.evaluate(() => {
    const app = window.__samewhere;
    return ['history', 'remember', 'undo'].some(key => key in app.game) || 'undo' in app;
  })).toBe(false);
});

test('an old save resets world, music and analytics but preserves mouse sensitivity', async ({ page }) => {
  const initial = new Game().snapshot(), game = new Game();
  game.player.room = 'G'; game.world.passageProgress = 2;
  const old = { version: GAME_VERSION - 1, state: game.snapshot(), transitions: 30, music: [0, 1, 2], soundEnabled: false,
    analytics: { version: GAME_VERSION - 1, activeMs: 900_000, reached: ['run_started', 'room_H_visited', 'symbol_room_3_visited'] } };
  await page.addInitScript(save => {
    localStorage.setItem('samewhere.save', JSON.stringify(save));
    localStorage.setItem('samewhere.settings', JSON.stringify({ lookSensitivity: 2.3 }));
  }, old);
  await page.goto('/'); await expect(page.locator('#loading-screen')).toBeHidden();
  await expect(page.locator('#resume-button')).toBeHidden();
  expect(await page.evaluate(savedGame)).toEqual({ state: initial, transitions: 0, music: [0], soundEnabled: true });
  expect(await page.evaluate(() => localStorage.getItem('samewhere.save'))).toBeNull();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('samewhere.settings')!))).toEqual({ lookSensitivity: 2.3 });
  await page.evaluate(() => {
    const app = window.__samewhere; app.analyticsEvents = [];
    app.analytics.send = (event: string, value: number) => app.analyticsEvents.push({ event, value });
  });
  await page.locator('#play-button').click(); await expect(page.locator('#overlay')).toBeHidden();
  const result = await page.evaluate(() => ({ save: JSON.parse(localStorage.getItem('samewhere.save')!), events: window.__samewhere.analyticsEvents }));
  expect(result.save.version).toBe(GAME_VERSION); expect(result.save.analytics.version).toBe(GAME_VERSION);
  expect(result.save.analytics.reached).toEqual(['run_started', 'room_4_visited']);
  expect(result.events).toEqual([
    { event: `v${GAME_VERSION}:run_started`, value: 0 },
    { event: `v${GAME_VERSION}:room_4_visited`, value: 0 },
  ]);
});

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

test('reload resumes the full autosaved game; NEW GAME replaces it', async ({ page }) => {
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
  await page.keyboard.press('Escape'); await expect(page.locator('#overlay')).toBeVisible();
  await page.locator('#play-button').click(); await page.locator('#new-game-confirm').click();
  await expect(page.locator('#overlay')).toBeHidden();
  expect(await page.evaluate(() => window.__samewhere.game.snapshot())).toEqual(initial);
  await page.reload(); await expect(page.locator('#loading-screen')).toBeHidden();
  expect(await page.evaluate(savedGame)).toMatchObject({ state: initial, transitions: 0, music: [0] });
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
  expect(await page.evaluate(savedGame)).toMatchObject({ state: initial, transitions: 0, music: [0] });
  expect(errors).toEqual([]);
});
