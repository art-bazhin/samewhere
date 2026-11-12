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
  await page.goto('/?dev=1'); await page.waitForFunction(() => !!window.__samewhere?.sound);
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
        const data = source.buffer.getChannelData(channel), end = Math.round(source.loopEnd * source.buffer.sampleRate);
        return [data[0], data[end]];
      })) };
  });
  expect(initial.starts).toHaveLength(6); expect(new Set(initial.starts.map((event: any) => event.when)).size).toBe(1);
  expect(new Set(initial.starts.map((event: any) => event.end)).size).toBe(1);
  expect(initial.starts.every((event: any) => event.offset === 0 && event.rate === 44100 && event.channels === 2)).toBe(true);
  expect(initial.starts[0].end).toBeCloseTo(54.857143, 4);
  expect(initial.starts.every((event: any) => event.end === 2419200 / event.rate)).toBe(true);
  for (const event of initial.starts) expect(event.length / event.rate - event.end).toBeCloseTo(2, 1);
  expect(initial.gains).toEqual([expect.closeTo(10 ** (-10 / 20), 6), 0, 0, 0, 0, 0]);
  expect(initial.output).toBeCloseTo(10 ** (-5 / 20), 6);
  for (const stem of initial.edges) for (const [start, continuation] of stem) expect(start).toBe(continuation);
  expect(initial.edges.flat(2).some((value: number) => value !== 0)).toBe(true);

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
  await page.keyboard.press('Escape'); await expect(page.locator('#overlay')).toBeVisible();
  const pauseRamp = await page.evaluate(() => (window as any).musicRamps.filter((event: any) => event.parameter === window.__samewhere.sound.pauseGain.gain).at(-1));
  expect(pauseRamp.value).toBe(0); expect(pauseRamp.endTime - pauseRamp.now).toBeCloseTo(.5, 2);
  await expect.poll(() => page.evaluate(() => window.__samewhere.sound.context.state)).toBe('suspended');
  expect(await page.evaluate(() => window.__samewhere.sound.pauseGain.gain.value)).toBe(0);
  await page.keyboard.press('Digit8');
  expect(await page.evaluate(() => (window as any).musicStarts.filter((event: any) => event.context === window.__samewhere.sound.context).length)).toBe(6);
  const paused = await page.evaluate(() => ({ time: window.__samewhere.sound.context.currentTime,
    gains: window.__samewhere.sound.music.layers.map(({ gain }: any) => gain.gain.value) }));
  await page.locator('#controls-button').click(); await page.waitForTimeout(250);
  expect(await page.evaluate(() => ({ time: window.__samewhere.sound.context.currentTime,
    gains: window.__samewhere.sound.music.layers.map(({ gain }: any) => gain.gain.value) }))).toEqual(paused);
  await page.keyboard.press('Escape'); await expect(page.locator('#overlay')).toBeVisible();
  await page.locator('#resume-button').click(); await expect(page.locator('#overlay')).toBeHidden();
  const resumeRamp = await page.evaluate(() => (window as any).musicRamps.filter((event: any) => event.parameter === window.__samewhere.sound.pauseGain.gain).at(-1));
  expect(resumeRamp.value).toBe(1); expect(resumeRamp.endTime - resumeRamp.now).toBeCloseTo(.5, 2);
  await expect.poll(() => page.evaluate(() => window.__samewhere.sound.context.state)).toBe('running');
  await expect.poll(() => page.evaluate(() => window.__samewhere.sound.pauseGain.gain.value)).toBe(1);
  expect(await page.evaluate(() => window.__samewhere.sound.context.currentTime)).toBeGreaterThan(paused.time);
  expect(await page.evaluate(() => window.__samewhere.sound.music.layers[1].gain.gain.value)).toBeGreaterThan(paused.gains[1]);
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

  for (const key of ['Digit8', 'Numpad8']) {
    await page.evaluate(() => {
      const state = window as any; state.musicEnded = 0;
      state.musicBeforeSeek = window.__samewhere.sound.music.layers.map(({ source, gain }: any) => {
        source.addEventListener('ended', () => state.musicEnded++, { once: true });
        return { source, gain, buffer: source.buffer };
      });
    });
    await page.keyboard.press(key);
    await expect.poll(() => page.evaluate(() => (window as any).musicEnded)).toBe(6);
    const seek = await page.evaluate(() => {
      const state = window as any, { sound } = window.__samewhere;
      return { starts: state.musicStarts.filter((event: any) => event.context === sound.context).slice(-6)
        .map(({ context, ...event }: any) => event),
        retained: sound.music.layers.every(({ source, gain }: any, i: number) =>
          source !== state.musicBeforeSeek[i].source && source.buffer === state.musicBeforeSeek[i].buffer && gain === state.musicBeforeSeek[i].gain) };
    });
    expect(seek.retained).toBe(true); expect(new Set(seek.starts.map((event: any) => event.when)).size).toBe(1);
    expect(seek.starts.every((event: any) => event.offset === event.end - 10)).toBe(true);
    expect(await active()).toEqual([1, 2, 3, 4, 5, 6]);
  }

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

  // Compare every MP3 seam with its natural, uninterrupted continuation.
  const seams = await page.evaluate(async () => {
    const result = [];
    for (const { source: live } of window.__samewhere.sound.music.layers) {
      const buffer = live.buffer, end = Math.round(live.loopEnd * buffer.sampleRate), edge = 441;
      const context = new OfflineAudioContext(2, edge * 2, buffer.sampleRate), source = context.createBufferSource();
      source.buffer = buffer; source.loop = true; source.loopEnd = live.loopEnd;
      source.connect(context.destination); source.start(0, (end - edge) / buffer.sampleRate);
      const rendered = await context.startRendering();
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const data = rendered.getChannelData(channel), original = buffer.getChannelData(channel);
        const difference = data.reduce((max, value, i) => Math.max(max, Math.abs(value - original[end - edge + i])), 0);
        const head = buffer.sampleRate;
        result.push({ step: data[edge] - data[edge - 1], naturalStep: original[end] - original[end - 1],
          blendStep: original[head] - original[head - 1], naturalBlendStep: original[end + head] - original[end + head - 1],
          difference, energy: data.reduce((sum, value) => sum + Math.abs(value), 0) });
      }
    }
    return result;
  });
  for (const seam of seams) {
    expect(seam.step).toBeCloseTo(seam.naturalStep, 6); expect(seam.difference).toBeLessThan(.000001);
    expect(seam.blendStep).toBeCloseTo(seam.naturalBlendStep, 6);
    expect(seam.energy).toBeGreaterThan(.01);
  }

  // Keep the copied second exact, blend for 200 ms, and preserve the remaining audio.
  const loop = await page.evaluate(async () => {
    const path = '/src/music.ts', { prepareMusicLoop } = await import(path);
    const rate = 8000, end = rate * 6, blendEnd = Math.round(rate * 1.2), context = new OfflineAudioContext(2, end * 3, rate);
    const buffer = context.createBuffer(2, rate * 8, rate);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel), sign = channel ? -1 : 1;
      for (let i = 0; i < data.length; i++) data[i] = sign * (.25 + .5 * i / data.length);
    }
    const original = buffer.getChannelData(0), unchanged = original.slice(blendEnd), continuation = original.slice(end, end + rate);
    prepareMusicLoop(buffer, end / rate);
    const preserved = unchanged.every((value, i) => value === original[blendEnd + i]);
    const copied = continuation.every((value, i) => value === original[i]);
    // Independent channel contributions retain their combined power during the fade.
    const power = context.createBuffer(2, rate * 8, rate), a = power.getChannelData(0), b = power.getChannelData(1);
    a.fill(.25, 0, end); b.fill(.25, end); prepareMusicLoop(power, end / rate);
    let powerError = 0;
    for (let i = rate; i < blendEnd; i++) powerError = Math.max(powerError, Math.abs(a[i] * a[i] + b[i] * b[i] - .25 ** 2));
    const source = context.createBufferSource(); source.buffer = buffer; source.loop = true; source.loopEnd = end / rate;
    source.connect(context.destination); source.start();
    const rendered = await context.startRendering(), left = rendered.getChannelData(0), right = rendered.getChannelData(1);
    let stereoError = 0, jump = 0;
    for (let i = 0; i < left.length; i++) {
      stereoError = Math.max(stereoError, Math.abs(left[i] + right[i]));
      if (i) jump = Math.max(jump, Math.abs(left[i] - left[i - 1]));
    }
    return { preserved, copied, jump, stereoError, powerError, first: left[0], headEnd: left[rate - 1], fadeEnd: left[blendEnd - 1],
      repeated: left[end] === left[0] && left[end * 2] === left[0] };
  });
  expect(loop.preserved).toBe(true); expect(loop.copied).toBe(true); expect(loop.repeated).toBe(true);
  expect(loop.first).toBe(.625); expect(loop.headEnd).toBeCloseTo(.25 + .5 * (48000 + 8000 - 1) / 64000, 6);
  expect(loop.fadeEnd).toBeCloseTo(.25 + .5 * (9600 - 1) / 64000, 6);
  expect(loop.jump).toBeLessThan(.001); expect(loop.stereoError).toBe(0); expect(loop.powerError).toBeLessThan(.0000001);
  await page.keyboard.press('KeyR'); await expect.poll(active).toEqual([1]);
  await expect.poll(() => page.evaluate(() => window.__samewhere.sound.music.layers.map((layer: any) => layer.gain.gain.value))).toEqual([expect.closeTo(10 ** (-10 / 20), 6), 0, 0, 0, 0, 0]);
  expect(await page.evaluate(() => (window as any).musicStarts.filter((event: any) => event.context === window.__samewhere.sound.context).length)).toBe(18);
  console.log('Music:', { stems: initial.starts.length, duration: initial.starts[0].end, seams, loop, envelope, output: initial.output,
    fadeSeconds: fades.map((fade: any) => fade[0].seconds) });
  expect(errors).toEqual([]);
});

test('music seeking stays dev-only and resuming during the menu fade cancels the pending audio pause', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await page.locator('#play-button').click(); await expect(page.locator('#overlay')).toBeHidden();
  await page.evaluate(() => { (window as any).musicBeforeSeek = window.__samewhere.sound.music.layers.map(({ source }: any) => source); });
  for (const key of ['Digit8', 'Numpad8']) await page.keyboard.press(key);
  expect(await page.evaluate(() => window.__samewhere.sound.music.layers.every(({ source }: any, i: number) => source === (window as any).musicBeforeSeek[i]))).toBe(true);
  await page.keyboard.press('Escape'); await expect(page.locator('#overlay')).toBeVisible();
  await page.locator('#resume-button').click(); await expect(page.locator('#overlay')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__samewhere.sound.pauseGain.gain.value)).toBe(1);
  const time = await page.evaluate(() => window.__samewhere.sound.context.currentTime);
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => window.__samewhere.sound.context.state)).toBe('running');
  expect(await page.evaluate(() => window.__samewhere.sound.context.currentTime)).toBeGreaterThan(time);
  expect(errors).toEqual([]);
});
