import { chromium } from '@playwright/test';

// First open of a hub passage, followed by a real collision/portal crossing.
// Asynchronous GPU queries distinguish GPU cost from requestAnimationFrame pacing.
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-webgl'] });
const reference = process.argv.includes('--reference');
const fullShadows = process.argv.includes('--full-shadows'), reconnect = process.argv.includes('--reconnect');
const noTransfer = process.argv.includes('--no-transfer');
const noShadowUpdates = process.argv.includes('--no-shadow-updates');
try {
  for (const width of process.argv.includes('--quick') ? [1710] : [1710, 2560]) {
    const page = await browser.newPage({ viewport: { width, height: width === 1710 ? 1107 : 1440 }, deviceScaleFactor: 2 });
    await page.goto('http://127.0.0.1:5173/');
    await page.waitForFunction(() => !!window.__samewhere?.space);
    await page.evaluate(() => window.__samewhere.space.ready);
    const result = await page.evaluate(async ({ reference, fullShadows, reconnect, noTransfer, noShadowUpdates }) => {
      const app = window.__samewhere, space = app.space, gl = space.renderer.getContext();
      space.assets.optimizations.value = !reference;
      for (const room of Object.values(space.rooms)) room.shadows.partialUpdates = !fullShadows;
      if (noTransfer) { space.lightTransfer.enabled = false; space.lightTransfer.sync = () => {}; }
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      const render = space.render.bind(space), begin = space.gpuTiming.begin, end = space.gpuTiming.end;
      space.gpuTiming.begin = space.gpuTiming.end = () => {};
      const samples = [], pending = []; let frame = 0, previous = 0, crossing = -100, opening = -100;
      let uploads = 0;
      const upload = gl.texSubImage2D.bind(gl);
      gl.texSubImage2D = (...args) => { uploads++; return upload(...args); };
      const programs = space.renderer.info.programs.length, targets = space.targetAllocations;
      const jobs = space.lightTransfer.jobs; let immediateLight = true;
      app.game.world.balls.forEach(ball => { ball.socket = null; });
      app.game.world.balls[1].socket = { room: 'G', side: 0 }; app.sync();
      Object.assign(app.game.player, { room: 'A', x: 0, z: -4.6, yaw: 0, pitch: -.18 });
      const stats = values => {
        if (!values.length) return null;
        const sorted = values.slice().sort((a, b) => a - b);
        return { n: values.length, mean: +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(3), p95: +sorted[Math.ceil(sorted.length * .95) - 1].toFixed(3), max: +sorted.at(-1).toFixed(3) };
      };
      return new Promise(resolve => {
        space.render = () => {
          const start = performance.now();
          while (pending.length && gl.getQueryParameter(pending[0].query, gl.QUERY_RESULT_AVAILABLE)) {
            const { query, sample } = pending.shift();
            if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) sample.gpu = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
            gl.deleteQuery(query);
          }
          const phase = frame < 60 ? 'warmup' : frame < 180 ? 'open' : frame < 340 ? 'enter' : 'hub';
          const query = ext && pending.length < 16 ? gl.createQuery() : null;
          if (query) gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
          const actionStart = performance.now();
          let event = '';
          if (frame === 60 || reconnect && frame >= 80 && frame <= 180 && frame % 20 === 0) {
            opening = frame;
            const closed = frame < 180 && (frame - 60) % 40 === 20;
            app.game.world.balls[0].socket = closed ? null : { room: 'A', side: 0 };
            app.game.world.balls[1].socket = { room: 'G', side: frame === 180 ? 0 : Math.floor((frame - 60) / 40) % 4 };
            app.sync(); event = closed ? 'close' : 'open';
            if (noShadowUpdates) for (const room of Object.values(space.rooms)) for (const light of room.shadowLights) light.shadow.needsUpdate = false;
            immediateLight &&= Object.values(space.lightTransfer.fields).every(field => field.key === field.expected);
          }
          if (phase === 'enter') {
            const before = app.game.player.room;
            app.game.move({ x: -Math.sin(app.game.player.yaw) * .025, z: -Math.cos(app.game.player.yaw) * .025 });
            if (app.game.player.room !== before) crossing = frame;
          }
          if (phase === 'hub') app.game.player.yaw += .014;
          const actionCpu = performance.now() - actionStart, beforeUploads = uploads;
          const renderStart = performance.now(); render();
          const sample = { frame, phase, cpu: performance.now() - renderStart, actionCpu, event, interval: start - previous, draws: space.drawCalls, triangles: space.renderer.info.render.triangles, passes: space.passes, shadowPixels: space.shadowPixels, uploads: uploads - beforeUploads,
            opening: frame - opening < 8, crossing: Math.abs(frame - crossing) < 4 };
          samples.push(sample);
          if (query) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push({ query, sample }); }
          previous = start;
          if (++frame === 460) {
            space.render = render; space.gpuTiming.begin = begin; space.gpuTiming.end = end; gl.texSubImage2D = upload;
            for (const { query } of pending) gl.deleteQuery(query);
            const report = list => ({ cpu: stats(list.map(s => s.cpu)), gpu: stats(list.flatMap(s => s.gpu === undefined ? [] : [s.gpu])), intervals: stats(list.map(s => s.interval)), draws: stats(list.map(s => s.draws)) });
            resolve({ reference, fullShadows, reconnect, noTransfer, noShadowUpdates, immediateLight, newLightJobs: space.lightTransfer.jobs - jobs,
              loadMs: space.lightTransfer.lastLoadMs, preparedBytes: space.lightTransfer.preparedBytes,
              canvas: [gl.drawingBufferWidth, gl.drawingBufferHeight], opening: report(samples.filter(s => s.opening)), events: samples.filter(s => s.event), openSteady: report(samples.filter(s => s.phase === 'open' && s.frame >= 80)), crossing: report(samples.filter(s => s.frame >= crossing - 3 && s.frame <= crossing + 3)),
              hub: report(samples.filter(s => s.phase === 'hub')), spikes: samples.filter(s => s.phase !== 'warmup' && (s.cpu > 4 || s.gpu > 17 || s.uploads || s.opening || s.crossing)),
              newPrograms: space.renderer.info.programs.length - programs, newTargets: space.targetAllocations - targets, error: gl.getError() });
          }
        };
      });
    }, { reference, fullShadows, reconnect, noTransfer, noShadowUpdates });
    console.log(JSON.stringify(result)); await page.close();
  }
} finally { await browser.close(); }
