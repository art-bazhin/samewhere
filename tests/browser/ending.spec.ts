import { test, expect } from '@playwright/test';

test('crossing the white EXIT freezes play, reveals the ending and leaves only stem 005 before replay', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const state = window as any; state.endingRamps = [];
    const ramp = AudioParam.prototype.linearRampToValueAtTime;
    AudioParam.prototype.linearRampToValueAtTime = function(value, endTime) {
      state.endingRamps.push({ parameter: this, value, endTime, now: state.__samewhere?.sound.context?.currentTime ?? 0 });
      return ramp.call(this, value, endTime);
    };
  });
  await page.goto('/?dev=1');
  await page.locator('#play-button').click(); await expect(page.locator('#overlay')).toBeHidden();
  const initial = await page.evaluate(() => window.__samewhere.game.snapshot());
  await page.keyboard.press('Digit9');
  await page.evaluate(async () => {
    const path = '/src/world.ts', { portalPosition, wallNormal } = await import(path);
    const { game, sound, sync, mouseLook } = window.__samewhere, music = sound.music;
    music.update('B', 0); music.update('D', 0); music.update('G', 0);
    // Model the fully developed mix reached after walking the gallery.
    for (const [index, { gain }] of music.layers.entries()) {
      gain.gain.cancelScheduledValues(sound.context.currentTime);
      gain.gain.setValueAtTime(index === 0 ? 10 ** (-5 / 20) : 1, sound.context.currentTime);
    }
    const last = game.world.gallery.signs.at(-1), p = portalPosition('A', last.side), n = wallNormal('A', last.side);
    Object.assign(game.player, { x: p.x - n.x * .08, z: p.z - n.z * .08 }); mouseLook.reset(); sync();
    (window as any).endingRamps = [];
  });
  await expect.poll(() => page.evaluate(() => window.__samewhere.sound.music.layers.map(({ gain }: any) => gain.gain.value)))
    .toEqual([expect.closeTo(10 ** (-5 / 20), 6), 1, 1, 1, 1, 1]);
  await expect(page.locator('#ending-screen')).toBeHidden();
  await page.keyboard.down('KeyW');
  await expect(page.locator('#ending-screen')).toBeVisible(); await page.keyboard.up('KeyW');
  expect(await page.evaluate(() => document.pointerLockElement?.id)).toBe('game');
  expect(await page.locator('#ending-screen').evaluate(screen => getComputedStyle(screen).cursor)).toBe('none');
  const finished = await page.evaluate(() => window.__samewhere.game.snapshot());
  expect(finished.world.gallery.outside).toBe(true);
  await expect(page.locator('#crosshair')).toBeHidden(); await expect(page.locator('#overlay')).toBeHidden();
  const appearance = await page.evaluate(() => {
    const title = document.getElementById('ending-title')!, button = document.getElementById('play-again')!;
    const animation = title.getAnimations()[0], current = animation.currentTime;
    animation.pause();
    const samples = [0, 7500, 15000].map(time => {
      animation.currentTime = time;
      const style = getComputedStyle(title), bounds = title.getBoundingClientRect();
      return { opacity: Number(style.opacity), scale: new DOMMatrix(style.transform).a,
        center: [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2] };
    });
    animation.currentTime = current; animation.play();
    return { samples, titleDuration: animation.effect!.getTiming().duration,
      buttonDelay: button.getAnimations()[0].effect!.getTiming().delay,
      buttonDuration: button.getAnimations()[0].effect!.getTiming().duration,
      color: getComputedStyle(title).color, background: getComputedStyle(document.getElementById('ending-screen')!).backgroundColor,
      fontSize: getComputedStyle(button).fontSize, menuFontSize: getComputedStyle(document.getElementById('play-button')!).fontSize,
      pointerEvents: getComputedStyle(title).pointerEvents, userSelect: getComputedStyle(title).userSelect,
      viewport: [innerWidth / 2, innerHeight / 2] };
  });
  expect(appearance.samples[0].opacity).toBe(0); expect(appearance.samples[0].scale).toBe(1);
  expect(appearance.samples[1].opacity).toBeGreaterThan(0); expect(appearance.samples[1].opacity).toBeLessThan(1);
  expect(appearance.samples[1].scale).toBeGreaterThan(1); expect(appearance.samples[1].scale).toBeLessThan(3);
  expect(appearance.samples[2].opacity).toBe(1); expect(appearance.samples[2].scale).toBe(3);
  expect(appearance.titleDuration).toBe(15000); expect(appearance.buttonDelay).toBe(15000); expect(appearance.buttonDuration).toBe(1000);
  expect(appearance.color).toBe('rgb(0, 0, 0)'); expect(appearance.background).toBe('rgb(255, 255, 255)');
  expect(appearance.fontSize).toBe(appearance.menuFontSize);
  expect(appearance.pointerEvents).toBe('none'); expect(appearance.userSelect).toBe('none');
  for (const sample of appearance.samples) sample.center.forEach((value, index) => expect(value).toBeCloseTo(appearance.viewport[index], 1));
  await page.waitForTimeout(1100);
  const earlyOpacity = Number(await page.locator('#ending-title').evaluate(title => getComputedStyle(title).opacity));
  expect(earlyOpacity).toBeGreaterThan(0); expect(earlyOpacity).toBeLessThan(1);
  await expect(page.locator('#play-again')).toBeHidden(); await expect(page.locator('#play-again')).toBeDisabled();
  for (const key of ['Escape', 'KeyZ', 'KeyR', 'Digit0', 'Digit9']) await page.keyboard.press(key);
  await page.mouse.move(200, 200); await page.mouse.wheel(0, 100);
  await page.keyboard.down('KeyW'); await page.waitForTimeout(150); await page.keyboard.up('KeyW');
  expect(await page.evaluate(() => window.__samewhere.game.snapshot())).toEqual(finished);
  await expect(page.locator('#overlay')).toBeHidden();
  expect(await page.locator('#ending-screen').evaluate(screen => getComputedStyle(screen).cursor)).toBe('none');
  const ramps = await page.evaluate(() => window.__samewhere.sound.music.layers.map(({ gain }: any) =>
    (window as any).endingRamps.filter((event: any) => event.parameter === gain.gain).map((event: any) => ({ value: event.value, seconds: event.endTime - event.now }))));
  ramps.forEach((events: any[], index: number) => {
    if (index === 4) expect(events).toEqual([]);
    else { expect(events).toHaveLength(1); expect(events[0].value).toBe(0); expect(events[0].seconds).toBeCloseTo(15, 2); }
  });
  const middle = await page.evaluate(() => window.__samewhere.sound.music.layers.map(({ gain }: any) => gain.gain.value));
  middle.forEach((gain: number, index: number) => { if (index === 4) expect(gain).toBe(1); else { expect(gain, `Stem ${index + 1}`).toBeGreaterThan(0); expect(gain).toBeLessThan(1); } });
  await expect(page.locator('#ending-screen')).toHaveClass(/interactive/, { timeout: 20_000 });
  await page.waitForFunction(() => document.pointerLockElement === null);
  expect(await page.locator('#ending-screen').evaluate(screen => getComputedStyle(screen).cursor)).toBe('auto');
  await expect(page.locator('#play-again')).toBeVisible();
  await expect(page.locator('#play-again')).toBeEnabled({ timeout: 20_000 });
  await page.screenshot({ path: info.outputPath('ending.png') });
  await expect.poll(() => page.evaluate(() => window.__samewhere.sound.music.layers.map(({ gain }: any) => gain.gain.value)),
    { timeout: 12_000, intervals: [250, 500] }).toEqual([0, 0, 0, 0, 1, 0]);
  await page.locator('#play-again').click();
  await expect(page.locator('#ending-screen')).toBeHidden(); await expect(page.locator('#overlay')).toBeHidden();
  expect(await page.evaluate(() => window.__samewhere.game.snapshot())).toEqual(initial);
  expect(await page.evaluate(() => [...window.__samewhere.sound.music.active])).toEqual([0]);
  await expect.poll(() => page.evaluate(() => window.__samewhere.sound.music.layers.map(({ gain }: any) => gain.gain.value)))
    .toEqual([expect.closeTo(10 ** (-5 / 20), 6), 0, 0, 0, 0, 0]);
  await expect(page.locator('#crosshair')).toBeVisible();
  await page.keyboard.down('KeyW'); await page.waitForTimeout(150); await page.keyboard.up('KeyW');
  expect(await page.evaluate(() => window.__samewhere.game.player.z)).toBeGreaterThan(initial.player.z + .1);
  await page.keyboard.press('Escape'); await expect(page.locator('#overlay')).toBeVisible();
  expect(errors).toEqual([]);
});
