import { chromium } from '@playwright/test';

// Compare the same prepared scene with transport disabled/enabled in ABBA order.
// Only lighting sampling changes; geometry, portal resolution and shadows match.
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-webgl'] });
const compareShadows = process.argv.includes('--shadow-updates');
try {
  for (const scenario of [
    { room: 'A', width: 1710, height: 1107 },
    { room: 'G', width: 1710, height: 1107 },
    { room: 'G', width: 2560, height: 1440 },
  ]) {
    const page = await browser.newPage({ viewport: { width: scenario.width, height: scenario.height }, deviceScaleFactor: 2 });
    await page.goto('http://127.0.0.1:5173/'); await page.waitForFunction(() => !!window.__samewhere?.space);
    await page.evaluate(() => window.__samewhere.space.ready);
    const result = await page.evaluate(async ({ room, compareShadows }) => {
      const app = window.__samewhere, space = app.space, light = space.lightTransfer, gl = space.renderer.getContext();
      app.game.world.balls[0].socket = { room: 'A', side: 0 }; app.game.world.balls[1].socket = { room: 'G', side: 0 };
      app.game.world.balls[2].socket = app.game.world.balls[3].socket = null; app.sync(); await light.whenSettled();
      app.game.world.selected = 'blue';
      Object.assign(app.game.player, room === 'A' ? { room, x: 1.6, z: -3, yaw: .6, pitch: -.85 } : { room, x: -3.6, z: 5.5, yaw: 0, pitch: -.3 });
      const original = space.render.bind(space), begin = space.gpuTiming.begin, end = space.gpuTiming.end;
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2'), pending = [], gpu = [], samples = [];
      space.gpuTiming.begin = space.gpuTiming.end = () => {};
      const order = [false, true, true, false]; let frame = 0;
      const stats = values => {
        if (!values.length) return null; const sorted = values.slice().sort((a, b) => a - b);
        return { n: values.length, mean: +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(3),
          p95: +sorted[Math.ceil(values.length * .95) - 1].toFixed(3), max: +sorted.at(-1).toFixed(3) };
      };
      const jobs = light.jobs, programs = space.renderer.info.programs.length;
      return new Promise(resolve => {
        space.render = () => {
          while (pending.length && gl.getQueryParameter(pending[0].query, gl.QUERY_RESULT_AVAILABLE)) {
            const item = pending.shift();
            if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) gpu.push({ enabled: item.enabled, action: item.action, ms: gl.getQueryParameter(item.query, gl.QUERY_RESULT) / 1e6 });
            gl.deleteQuery(item.query);
          }
          const phase = Math.floor((frame - 60) / 120), enabled = phase >= 0 && phase < order.length ? order[phase] : true;
          light.enabled = compareShadows || enabled;
          if (compareShadows) for (const room of Object.values(space.rooms)) room.shadows.partialUpdates = enabled;
          const action = compareShadows && phase >= 0 && frame % 20 === 0;
          const measured = phase >= 0 && phase < order.length && (frame - 60) % 120 >= 8;
          const query = measured && ext && pending.length < 16 ? gl.createQuery() : null;
          if (query) gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
          if (action) { app.game.interact({ room: 'C', side: 3 }); app.sync(); }
          const start = performance.now(); original(); const cpu = performance.now() - start;
          if (query) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push({ query, enabled, action }); }
          if (measured) samples.push({ enabled, action, cpu, draws: space.drawCalls, passes: space.passes });
          if (++frame >= 570) {
            space.render = original; light.enabled = true; space.gpuTiming.begin = begin; space.gpuTiming.end = end;
            for (const item of pending) gl.deleteQuery(item.query);
            resolve({ compareShadows, canvas: [gl.drawingBufferWidth, gl.drawingBufferHeight], off: {
              gpu: stats(gpu.filter(s => !s.enabled).map(s => s.ms)), cpu: stats(samples.filter(s => !s.enabled).map(s => s.cpu)),
              gpuAction: stats(gpu.filter(s => !s.enabled && s.action).map(s => s.ms)),
              draws: stats(samples.filter(s => !s.enabled).map(s => s.draws)), passes: stats(samples.filter(s => !s.enabled).map(s => s.passes)),
            }, on: {
              gpu: stats(gpu.filter(s => s.enabled).map(s => s.ms)), cpu: stats(samples.filter(s => s.enabled).map(s => s.cpu)),
              gpuAction: stats(gpu.filter(s => s.enabled && s.action).map(s => s.ms)),
              draws: stats(samples.filter(s => s.enabled).map(s => s.draws)), passes: stats(samples.filter(s => s.enabled).map(s => s.passes)),
            }, newJobs: light.jobs - jobs, newPrograms: space.renderer.info.programs.length - programs, bakeMs: light.lastBakeMs,
              volumeBytes: Object.values(light.fields).reduce((sum, field) => sum + field.buffers.reduce((sum, buffer) => sum + buffer.texture.image.data.byteLength, 0), 0), error: gl.getError() });
          }
        };
      });
    }, { room: scenario.room, compareShadows });
    console.log(JSON.stringify({ room: scenario.room, ...result })); await page.close();
  }
} finally { await browser.close(); }
