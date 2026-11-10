import { test, expect } from '@playwright/test';

test('six music stems share a seamless clock and unlock only at the specified milestones', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => {
    const state = window as any; state.musicStarts = []; state.musicRamps = [];
    const start = AudioBufferSourceNode.prototype.start, ramp = AudioParam.prototype.linearRampToValueAtTime;
    AudioBufferSourceNode.prototype.start = function(when = 0, offset = 0) {
      if (this.loop && this.buffer) state.musicStarts.push({ context: this.context, when, offset, end: this.loopEnd,
        length: this.buffer.length, rate: this.buffer.sampleRate, channels: this.buffer.numberOfChannels });
      start.call(this, when, offset);
    };
    AudioParam.prototype.linearRampToValueAtTime = function(value, endTime) {
      state.musicRamps.push({ parameter: this, value, endTime, now: state.__samewhere?.sound.context?.currentTime ?? 0 });
      return ramp.call(this, value, endTime);
    };
  });
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.sound);
  await page.evaluate(() => Promise.all([window.__samewhere.space.ready, window.__samewhere.sound.ready]));
  expect(await page.evaluate(() => window.__samewhere.sound.context)).toBeNull();
  await page.locator('#play-button').click(); await expect(page.locator('#overlay')).toBeHidden();
  const active = () => page.evaluate(() => [...window.__samewhere.sound.music.active].map((index: number) => index + 1));
  await expect.poll(active).toEqual([1]);
  const initial = await page.evaluate(() => {
    const { sound } = window.__samewhere;
    return { starts: (window as any).musicStarts.filter((event: any) => event.context === sound.context).map(({ context, ...event }: any) => event),
      gains: sound.music.layers.map((layer: any) => layer.gain.gain.value), output: sound.output.gain.value,
      edges: sound.music.layers.map(({ source }: any) => Array.from({ length: source.buffer.numberOfChannels }, (_, channel) => {
        const data = source.buffer.getChannelData(channel); return [data[0], data[data.length - 1]];
      })) };
  });
  expect(initial.starts).toHaveLength(6); expect(new Set(initial.starts.map((event: any) => event.when)).size).toBe(1);
  expect(new Set(initial.starts.map((event: any) => event.end)).size).toBe(1);
  expect(initial.starts.every((event: any) => event.offset === 0 && event.rate === 44100 && event.channels === 2)).toBe(true);
  expect(initial.starts[0].end).toBeCloseTo(219.428571, 4); expect(initial.gains).toEqual([expect.closeTo(10 ** (-5 / 20), 6), 0, 0, 0, 0, 0]);
  expect(initial.output).toBeCloseTo(10 ** (-5 / 20), 6);
  expect(initial.edges.flat(2).every((value: number) => value === 0)).toBe(true);

  async function enter(from: string, to: string, progress?: number) {
    await page.evaluate(async ({ from, to, progress }) => {
      const path = '/src/world.ts', { portalPosition, wallNormal } = await import(path);
      const { game, sync } = window.__samewhere;
      game.world.balls[0].socket = { room: from, side: 0 }; game.world.balls[1].socket = { room: to, side: 0 };
      if (progress !== undefined) game.world.passageProgress = progress;
      const p = portalPosition(from, 0), n = wallNormal(from, 0);
      Object.assign(game.player, { room: from, x: p.x - n.x * .2, z: p.z - n.z * .2, yaw: 0, pitch: 0 }); sync();
      game.move({ x: n.x * .4, z: n.z * .4 }); sync();
    }, { from, to, progress });
  }
  // Merely drawing a neighboring pentagon through a portal must not unlock it.
  await page.evaluate(() => {
    const { game, sync, space } = window.__samewhere;
    game.world.balls[0].socket = { room: 'A', side: 0 }; game.world.balls[1].socket = { room: 'B', side: 0 }; sync(); space.render();
  });
  expect(await active()).toEqual([1]);
  await enter('A', 'B'); await expect.poll(active).toEqual([1, 2]);
  await enter('B', 'D'); await expect.poll(active).toEqual([1, 2, 3]);
  await enter('D', 'G'); await expect.poll(active).toEqual([1, 2, 3, 4]);
  await enter('G', 'A', 2); expect(await active()).toEqual([1, 2, 3, 4]);
  await enter('A', 'D');
  await page.evaluate(() => { window.__samewhere.game.world.passageProgress = 3; window.__samewhere.sync(); });
  expect(await active()).toEqual([1, 2, 3, 4]);
  await enter('D', 'A'); await expect.poll(active).toEqual([1, 2, 3, 4, 5]);
  await page.evaluate(async () => {
    const path = '/src/world.ts', { FINAL_PASSAGE_GOALS } = await import(path), { game, sync } = window.__samewhere;
    game.world.balls.forEach((ball: any) => { ball.socket = null; });
    for (const goal of FINAL_PASSAGE_GOALS) { game.selectColor(goal.color); game.interact(goal.from); }
    sync();
  });
  await expect.poll(active).toEqual([1, 2, 3, 4, 5, 6]);
  const fades = await page.evaluate(() => window.__samewhere.sound.music.layers.slice(1).map(({ gain }: any) =>
    (window as any).musicRamps.filter((event: any) => event.parameter === gain.gain).map((event: any) => ({ value: event.value, seconds: event.endTime - event.now }))));
  for (const fade of fades) { expect(fade).toHaveLength(1); expect(fade[0].value).toBe(1); expect(fade[0].seconds).toBeCloseTo(15, 2); }
  await page.keyboard.press('KeyZ'); expect(await active()).toEqual([1, 2, 3, 4, 5, 6]);
  await page.keyboard.press('KeyM');
  await expect.poll(() => page.evaluate(() => window.__samewhere.sound.output.gain.value)).toBe(0);
  await page.keyboard.press('KeyM');
  await expect.poll(() => page.evaluate(() => window.__samewhere.sound.output.gain.value)).toBeCloseTo(10 ** (-5 / 20), 6);

  // Check rendered signal after a minute of silence, not just the ramp's end timestamp.
  const envelope = await page.evaluate(async () => {
    const path = '/src/music.ts', { fadeGain } = await import(path);
    const context = new OfflineAudioContext(1, 76 * 8000, 8000), source = context.createConstantSource(), gain = context.createGain();
    gain.gain.value = 0; source.connect(gain).connect(context.destination); source.start();
    const paused = context.suspend(60), rendering = context.startRendering(); await paused;
    fadeGain(gain.gain, 1, context.currentTime, 15);
    await context.resume(); const buffer = await rendering, samples = buffer.getChannelData(0);
    return [60, 60.1, 63.75, 67.5, 71.25, 75].map(time => samples[Math.round(time * 8000)]);
  });
  const expectedEnvelope = [0, .1 / 15, .25, .5, .75, 1];
  envelope.forEach((gain, index) => expect(gain).toBeCloseTo(expectedEnvelope[index], 4));

  // Render only 20 ms around an actual MP3 loop seam, using the prepared buffer.
  const seam = await page.evaluate(async () => {
    const buffer = window.__samewhere.sound.music.layers[0].source.buffer;
    const edge = 441, context = new OfflineAudioContext(2, edge * 2, 44100), source = context.createBufferSource();
    source.buffer = buffer; source.loop = true; source.loopEnd = buffer.duration;
    source.connect(context.destination); source.start(0, (buffer.length - edge) / buffer.sampleRate);
    const rendered = await context.startRendering(), data = rendered.getChannelData(0);
    return { left: data[edge - 1], right: data[edge], energy: data.reduce((sum, value) => sum + Math.abs(value), 0) };
  });
  expect(Math.abs(seam.left)).toBeLessThan(.00001); expect(Math.abs(seam.right)).toBeLessThan(.00001); expect(seam.energy).toBeGreaterThan(.01);
  await page.keyboard.press('KeyR'); await expect.poll(active).toEqual([1]);
  await expect.poll(() => page.evaluate(() => window.__samewhere.sound.music.layers.map((layer: any) => layer.gain.gain.value))).toEqual([expect.closeTo(10 ** (-5 / 20), 6), 0, 0, 0, 0, 0]);
  expect(await page.evaluate(() => (window as any).musicStarts.filter((event: any) => event.context === window.__samewhere.sound.context).length)).toBe(6);
  console.log('Music:', { stems: initial.starts.length, duration: initial.starts[0].end, seam, envelope, output: initial.output,
    fadeSeconds: fades.map((fade: any) => fade[0].seconds) });
  expect(errors).toEqual([]);
});
