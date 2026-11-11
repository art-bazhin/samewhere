import { test, expect } from '@playwright/test';

test('opening and closing the menu fades its opacity and background blur over half a second', async ({ page }) => {
  await page.goto('/'); await page.locator('#play-button').click(); await expect(page.locator('#overlay')).toBeHidden();
  const state = await page.evaluate(() => window.__samewhere.game.snapshot());
  for (const opening of [true, false]) {
    if (opening) await page.keyboard.press('Escape'); else await page.locator('#resume-button').click();
    await page.waitForFunction(() => {
      const elements = [document.getElementById('overlay')!, document.getElementById('game')!];
      if (!elements[0].getAnimations().some(animation => animation instanceof CSSTransition && animation.transitionProperty === 'opacity')) return false;
      elements.forEach(element => element.getAnimations().forEach(animation => animation.pause()));
      return true;
    });
    const fade = await page.evaluate(() => {
      const overlay = document.getElementById('overlay')!, game = document.getElementById('game')!;
      const animations = [...overlay.getAnimations(), ...game.getAnimations()];
      const durations = animations.filter(animation => animation instanceof CSSTransition && ['opacity', 'filter'].includes(animation.transitionProperty))
        .map(animation => animation.effect!.getTiming().duration);
      const samples = [0, 250, 500].map(time => {
        animations.forEach(animation => { animation.currentTime = time; });
        return { opacity: Number(getComputedStyle(overlay).opacity), blur: Number(getComputedStyle(game).filter.match(/[\d.]+/)?.[0] ?? 0) };
      });
      animations.forEach(animation => animation.finish());
      return { durations, samples, inert: document.getElementById('menu-content')!.inert };
    });
    expect(fade.durations).toEqual([500, 500]);
    expect(fade.samples[0]).toEqual({ opacity: opening ? 0 : 1, blur: opening ? 0 : 3 });
    expect(fade.samples[1].opacity).toBeGreaterThan(0); expect(fade.samples[1].opacity).toBeLessThan(1);
    expect(fade.samples[1].blur).toBeGreaterThan(0); expect(fade.samples[1].blur).toBeLessThan(3);
    expect(fade.samples[2]).toEqual({ opacity: opening ? 1 : 0, blur: opening ? 3 : 0 });
    expect(fade.inert).toBe(!opening);
    expect(await page.evaluate(() => window.__samewhere.game.snapshot())).toEqual(state);
  }
  await expect(page.locator('#overlay')).toBeHidden();
});

test('initial loading hides preparation behind black and fades into the menu after graphics and music are ready', async ({ page }, info) => {
  let releaseMain!: () => void, releaseMusic!: () => void;
  const mainGate = new Promise<void>(resolve => { releaseMain = resolve; });
  const musicGate = new Promise<void>(resolve => { releaseMusic = resolve; });
  await page.route('**/src/main.ts', async route => { await mainGate; await route.continue(); });
  await page.route('**/music/SAMEWHERE-006.mp3', async route => { await musicGate; await route.continue(); });
  try {
    await page.goto('/?dev=1', { waitUntil: 'commit' });
    const loading = page.getByRole('status', { name: 'Loading' });
    await expect(loading).toBeVisible();
    for (const selector of ['#menu-content', '.menu-brand', '#hud']) await expect(page.locator(selector)).toBeHidden();
    expect(await loading.evaluate(screen => ({ background: getComputedStyle(screen).backgroundColor, opacity: getComputedStyle(screen).opacity })))
      .toEqual({ background: 'rgb(0, 0, 0)', opacity: '1' });
    expect(await page.locator('#game').evaluate(canvas => getComputedStyle(canvas).filter)).toBe('blur(3px)');
    const cover = await loading.boundingBox(), bounds = await page.locator('.loading-label').boundingBox(), viewport = page.viewportSize()!;
    expect(cover).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height });
    expect(bounds!.x + bounds!.width / 2).toBeCloseTo(viewport.width / 2, 0);
    expect(bounds!.y + bounds!.height / 2).toBeCloseTo(viewport.height / 2, 0);
    const animation = await page.locator('.loading-dots').evaluate(dots => {
      const animation = dots.getAnimations()[0]; animation.pause();
      const duration = animation.effect!.getTiming().duration;
      const hidden = [1, 1001, 2001, 3001, 4001].map(time => {
        animation.currentTime = time;
        return Number(getComputedStyle(dots).clipPath.match(/([\d.]+)%/)?.[1] ?? 0);
      });
      animation.play(); return { duration, hidden };
    });
    expect(animation.duration).toBe(4000);
    [100, 200 / 3, 100 / 3, 0, 100].forEach((value, index) => expect(animation.hidden[index]).toBeCloseTo(value, 3));
    releaseMain();
    await page.waitForFunction(() => !!window.__samewhere?.space);
    await page.evaluate(() => window.__samewhere.space.ready);
    await expect(loading).toBeVisible(); await expect(page.locator('#menu-content')).toBeHidden();
    expect(await loading.evaluate(screen => getComputedStyle(screen).opacity)).toBe('1');
    await page.screenshot({ path: info.outputPath('loading.png') });
    const fading = page.waitForFunction(() => {
      const screen = document.getElementById('loading-screen')!, animation = screen.getAnimations()[0];
      if (!animation) return false;
      animation.pause(); return true;
    });
    releaseMusic();
    await fading;
    await expect(page.locator('#play-button')).toBeEnabled();
    await expect(page.locator('#menu-content')).toHaveJSProperty('inert', true);
    const fade = await loading.evaluate(screen => {
      const animation = screen.getAnimations()[0];
      animation.currentTime = 0; const start = Number(getComputedStyle(screen).opacity);
      animation.currentTime = 300;
      return { duration: animation.effect!.getTiming().duration, start, middle: Number(getComputedStyle(screen).opacity) };
    });
    expect(fade.duration).toBe(600); expect(fade.start).toBe(1);
    expect(fade.middle).toBeGreaterThan(0); expect(fade.middle).toBeLessThan(1);
    await page.screenshot({ path: info.outputPath('loading-fade.png') });
    await loading.evaluate(screen => screen.getAnimations()[0].play());
    await expect(loading).toBeHidden(); await expect(page.locator('.menu-brand')).toBeVisible();
    await expect(page.locator('#menu-content')).toHaveJSProperty('inert', false);
    await expect(page.locator('#fps-counter')).toBeVisible();
    await page.locator('#play-button').click(); await expect(page.locator('#overlay')).toBeHidden();
    await page.keyboard.press('Escape'); await expect(page.locator('#overlay')).toBeVisible();
    await expect(loading).toBeHidden(); await expect(page.locator('#resume-button')).toBeVisible();
  } finally { releaseMain(); releaseMusic(); }
});

test('the English menu offers controls, resumes progress and starts a fresh game without dev mode', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const overlay = page.locator('#overlay'), dialog = page.getByRole('dialog', { name: 'CONTROLS' });
  await expect(page.locator('#play-button')).toBeEnabled();
  await expect(page.locator('#loading-screen')).toBeHidden();
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
  await expect(dialog.locator('dd')).toHaveText(['Move', 'Look around', 'Take or place a ball', 'Select red / blue', 'Switch ball color', 'Undo last action', 'Pause; resume in fullscreen', 'Toggle fullscreen', 'Toggle sound']);
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
  await expect(overlay).toHaveCSS('opacity', '1');
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
