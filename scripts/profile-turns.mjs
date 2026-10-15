import { chromium } from '@playwright/test';

// Run against `npm run dev`. Native input is covered by the browser acceptance
// tests; this repeatable sweep measures rendering without automation IPC per frame.
const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const viewport of [{ width: 1440, height: 960 }, { width: 2560, height: 1440 }]) for (const scenario of ['start', 'near-portal']) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
    await page.goto('http://127.0.0.1:5173/');
    await page.waitForFunction(() => !!window.__samewhere?.space?.passes);
    await page.locator('#play-button').click();
    await page.waitForFunction(() => document.querySelector('#overlay').hidden);
    if (scenario === 'near-portal') await page.evaluate(() => Object.assign(window.__samewhere.game.player, { x: 0, z: -4.6, yaw: Math.PI, pitch: 0 }));
    const result = await page.evaluate(async () => {
      const app = window.__samewhere, samples = [];
      const original = app.space.render.bind(app.space);
      let previous = 0, count = 0;
      return new Promise(resolve => {
        app.space.render = () => {
          const start = performance.now();
          original();
          samples.push({ interval: previous ? start - previous : 0, cpu: performance.now() - start, passes: app.space.passes, targets: app.space.targets.length, pixels: app.space.portalPixels, fullPixels: (app.space.passes - 1) * app.space.targetWidth * app.space.targetHeight,
            allocations: app.space.targetAllocations, storagePixels: app.space.targets.reduce((sum, target) => sum + target.width * target.height, 0) });
          previous = start;
          // The next frame sees input from this turn; one full revolution / second.
          document.dispatchEvent(new PointerEvent(app.mouseEvent, { movementX: 52, movementY: Math.sin(count * 0.08) * 4 }));
          if (++count >= 240) {
            app.space.render = original;
            const summarize = list => {
              const intervals = list.map(s => s.interval).filter(Boolean).sort((a, b) => a - b), cpu = list.map(s => s.cpu).sort((a, b) => a - b);
              const quantile = (array, percentile) => Number(array[Math.floor((array.length - 1) * percentile)].toFixed(2));
              const pixels = list.reduce((sum, s) => sum + (s.pixels ?? s.fullPixels), 0), fullPixels = list.reduce((sum, s) => sum + s.fullPixels, 0);
              return { frames: list.length, frameP50: quantile(intervals, 0.5), frameP95: quantile(intervals, 0.95), frameMax: quantile(intervals, 1), cpuP95: quantile(cpu, 0.95), cpuMax: quantile(cpu, 1), over25ms: intervals.filter(x => x > 25).length, maxPasses: Math.max(...list.map(s => s.passes)), maxTargets: Math.max(...list.map(s => s.targets)), meanPortalPixels: Math.round(pixels / list.length), portalFillReduction: `${(100 * (1 - pixels / fullPixels)).toFixed(1)}%`, allocations: list.at(-1).allocations - list[0].allocations, storageMpix: +(Math.max(...list.map(s => s.storagePixels)) / 1e6).toFixed(2) };
            };
            resolve({ cold: summarize(samples.slice(0, 120)), warm: summarize(samples.slice(120)), gpu: app.space.gpuTiming.summary() });
          }
        };
      });
    });
    console.log(JSON.stringify({ viewport, scenario, ...result }));
    await page.close();
  }
} finally { await browser.close(); }
