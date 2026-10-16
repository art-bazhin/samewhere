import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

// Uses a visible, fullscreen Chrome window and asynchronous GPU timer queries.
// A deterministic camera/walking path avoids dependence on desktop focus. Native
// pointer delivery is checked separately by the browser acceptance tests.
const browser = await chromium.launch({ channel: 'chrome', headless: false });
try {
  const page = await browser.newPage({ viewport: { width: 1710, height: 1107 }, deviceScaleFactor: 2 });
  const focusSession = await page.context().newCDPSession(page);
  await focusSession.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.goto('http://127.0.0.1:5173/');
  await page.waitForFunction(() => !!window.__samewhere?.space?.passes);
  await page.locator('.fullscreen-menu-button').click();
  await page.waitForFunction(() => !!document.fullscreenElement);
  await page.bringToFront(); await page.waitForTimeout(1500);
  await page.locator('#play-button').click();
  await page.waitForFunction(() => document.querySelector('#overlay').hidden);
  const system = await browser.newBrowserCDPSession();
  const { gpu } = await system.send('SystemInfo.getInfo');
  console.log(JSON.stringify({ renderer: gpu.auxAttributes.glRenderer }));
  for (const mode of ['portals', 'no-portals', 'no-hud', 'no-blur', 'ratio-1', 'walk-no-portals']) {
    await page.evaluate(mode => {
      const app = window.__samewhere;
      app.reset(); Object.assign(app.game.player, { x: 0, z: 0, yaw: 0, pitch: 0 });
      if (mode.includes('no-portals')) { for (const ball of app.game.world.balls) ball.socket = null; app.sync(); }
      document.querySelector('#hud').style.display = mode === 'no-hud' ? 'none' : '';
      document.querySelector('#overlay').hidden = true; document.body.classList.remove('paused');
      for (const element of document.querySelectorAll('.inventory,.location')) element.style.backdropFilter = mode === 'no-blur' ? 'none' : '';
      app.space.renderer.setPixelRatio(mode === 'ratio-1' ? 1 : 1.5); app.space.resize();
    }, mode);
    await page.waitForTimeout(500);
    await page.evaluate(mode => {
      const app = window.__samewhere, gl = app.space.renderer.getContext(), ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      const original = app.space.render.bind(app.space), pending = [], samples = [], gpu = [];
      const timerBegin = app.space.gpuTiming.begin, timerEnd = app.space.gpuTiming.end;
      app.space.gpuTiming.begin = () => {}; app.space.gpuTiming.end = () => {};
      let previous = 0, frame = 0;
      const motionStart = performance.now();
      app.space.render = () => {
        const start = performance.now();
        const elapsed = start - motionStart;
        if (mode.startsWith('walk')) {
          const direction = Math.floor(elapsed / 1000) % 2 ? -1 : 1;
          app.game.move({ x: 0, z: direction * 5 * Math.min((start - (previous || start)) / 1000, 0.1) });
        } else {
          const angle = elapsed / 3000 * Math.PI * 2;
          app.game.player.yaw = 0.6 * Math.sin(angle); app.game.player.pitch = 0.3 * (Math.cos(angle) - 1);
        }
        while (pending.length && gl.getQueryParameter(pending[0].query, gl.QUERY_RESULT_AVAILABLE)) {
          const item = pending.shift();
          if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) gpu.push({ ms: gl.getQueryParameter(item.query, gl.QUERY_RESULT) / 1e6, latency: frame - item.frame });
          gl.deleteQuery(item.query);
        }
        const query = ext && pending.length < 16 ? gl.createQuery() : null;
        if (query) gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
        original();
        if (query) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push({ query, frame }); }
        if (previous) samples.push({ interval: start - previous, cpu: performance.now() - start, passes: app.space.passes, yaw: app.game.player.yaw, pitch: app.game.player.pitch, x: app.game.player.x, z: app.game.player.z });
        previous = start; frame++;
      };
      window.__pacing = { finish() {
        app.space.render = original;
        app.space.gpuTiming.begin = timerBegin; app.space.gpuTiming.end = timerEnd;
        for (const item of pending) gl.deleteQuery(item.query);
        const summary = (values) => {
          const sorted = values.slice().sort((a,b) => a-b);
          const at = q => +(sorted[Math.floor((sorted.length - 1) * q)] ?? 0).toFixed(2);
          return { p50: at(0.5), p95: at(0.95), max: at(1) };
        };
        return { frames: samples.length, intervals: summary(samples.map(s => s.interval)), cpu: summary(samples.map(s => s.cpu)), gpu: summary(gpu.map(s => s.ms)), gpuLatency: summary(gpu.map(s => s.latency)), over25ms: samples.filter(s => s.interval > 25).length, canvas: [gl.drawingBufferWidth, gl.drawingBufferHeight], uniquePoses: new Set(samples.map(s => [s.yaw,s.pitch,s.x,s.z].join(','))).size };
      } };
    }, mode);
    const session = await page.context().newCDPSession(page);
    const trace = mode === 'portals';
    let traceComplete;
    if (trace) {
      traceComplete = new Promise(resolve => session.once('Tracing.tracingComplete', resolve));
      await session.send('Tracing.start', { categories: 'cc,benchmark,viz,gpu,devtools.timeline,disabled-by-default-devtools.timeline.frame', transferMode: 'ReturnAsStream' });
    }
    await page.waitForTimeout(4000);
    const result = await page.evaluate(() => window.__pacing.finish());
    if (result.uniquePoses < 30) throw new Error('Camera did not move during the pacing profile');
    console.log(JSON.stringify({ mode, ...result }));
    if (trace) {
      await session.send('Tracing.end'); const { stream } = await traceComplete;
      let contents = '';
      while (true) { const chunk = await session.send('IO.read', { handle: stream }); contents += chunk.data; if (chunk.eof) break; }
      await session.send('IO.close', { handle: stream });
      await mkdir('test-results/profiling', { recursive: true });
      await writeFile('test-results/profiling/chrome-pacing.json', contents);
      const events = JSON.parse(contents).traceEvents;
      const reporters = events.filter(e => e.name === 'PipelineReporter' || e.name === 'CompositorFrameReporter');
      const states = {};
      for (const event of reporters) {
        const report = event.args?.frame_reporter; if (!report) continue;
        const key = `${report.state}/${report.frame_type ?? 'main'}`; states[key] = (states[key] ?? 0) + 1;
      }
      console.log(JSON.stringify({ traceReporters: states }));
    }
    await session.detach();
  }
} finally { await browser.close(); }
