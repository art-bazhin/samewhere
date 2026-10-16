import { chromium } from '@playwright/test';

// A repeatable hub view, alternating take/place, followed by walking/turning in
// all rooms. The reference uses the original separate casters and global shadow
// invalidation. GPU queries are asynchronous; JS intervals are not presentation FPS.
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-webgl'] });
try {
  for (const mode of ['reference', 'optimized']) {
    const page = await browser.newPage({ viewport: { width: 1710, height: 1107 }, deviceScaleFactor: 2 });
    await page.goto('http://127.0.0.1:5173/');
    await page.waitForFunction(() => !!window.__samewhere?.space);
    await page.evaluate(() => window.__samewhere.space.ready);
    const result = await page.evaluate(async mode => {
      const path = '/src/world.ts', { ROOM_IDS, ROOMS } = await import(path);
      const app = window.__samewhere, space = app.space, gl = space.renderer.getContext();
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      const original = space.render.bind(space), begin = space.gpuTiming.begin, end = space.gpuTiming.end;
      space.gpuTiming.begin = space.gpuTiming.end = () => {};
      if (mode === 'reference') {
        for (const room of Object.values(space.rooms)) room.shadows.scene.children = room.scene.children;
        space.portalOccluded = () => false;
        space.preparePendingShadow = () => {};
      }
      const sync = () => {
        app.sync();
        if (mode === 'reference') for (const room of Object.values(space.rooms)) for (const light of room.shadowLights) light.shadow.needsUpdate = true;
      };
      app.game.world.balls[0].socket = { room: 'A', side: 0 }; app.game.world.balls[1].socket = { room: 'G', side: 0 }; sync();
      Object.assign(app.game.player, { room: 'G', x: -3.6, z: 5.5, yaw: 0, pitch: -.3 });
      const samples = [], gpu = [], pending = []; let frame = 0, previous = 0;
      const initial = { allocations: space.targetAllocations, programs: space.renderer.info.programs.length };
      const stats = values => {
        if (!values.length) return null;
        const sorted = values.slice().sort((a, b) => a - b);
        return { mean: +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(2),
          p95: +sorted[Math.ceil(sorted.length * .95) - 1].toFixed(2), max: +sorted.at(-1).toFixed(2) };
      };
      return new Promise(resolve => {
        space.render = () => {
          const start = performance.now(), measured = frame >= 60, walking = frame >= 300;
          const action = !walking && measured && (frame - 60) % 20 === 0;
          while (pending.length && gl.getQueryParameter(pending[0].query, gl.QUERY_RESULT_AVAILABLE)) {
            const item = pending.shift();
            if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) gpu.push({ ms: gl.getQueryParameter(item.query, gl.QUERY_RESULT) / 1e6, action: item.action, walking: item.walking });
            gl.deleteQuery(item.query);
          }
          const actionStart = performance.now();
          if (action) { app.game.interact({ room: 'C', side: 3 }); sync(); }
          const actionCpu = performance.now() - actionStart;
          if (walking) {
            const segment = Math.floor((frame - 300) / 30), room = ROOM_IDS[Math.min(segment, ROOM_IDS.length - 1)];
            if ((frame - 300) % 30 === 0) {
              const p = ROOMS[room].pedestals[0]; Object.assign(app.game.player, { room, x: p.x, z: p.z + 1.8, yaw: 0, pitch: -.2 });
            }
            app.game.player.yaw += .07;
            app.game.move({ x: Math.sin(frame * .05) * .03, z: Math.cos(frame * .05) * .03 });
          }
          const query = measured && ext && pending.length < 16 ? gl.createQuery() : null;
          if (query) gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
          const renderStart = performance.now(); original(); const cpu = performance.now() - renderStart;
          if (query) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push({ query, action, walking }); }
          if (measured) samples.push({ interval: start - previous, cpu, actionCpu, action, walking, draws: space.drawCalls });
          previous = start;
          if (++frame >= 540) {
            space.render = original; space.gpuTiming.begin = begin; space.gpuTiming.end = end;
            for (const item of pending) gl.deleteQuery(item.query);
            resolve({ canvas: [gl.drawingBufferWidth, gl.drawingBufferHeight],
              intervals: stats(samples.map(s => s.interval)), actionCpu: stats(samples.filter(s => s.action).map(s => s.actionCpu)),
              renderAction: stats(samples.filter(s => s.action).map(s => s.cpu)), renderWalking: stats(samples.filter(s => s.walking).map(s => s.cpu)),
              drawsSteady: stats(samples.filter(s => !s.action && !s.walking).map(s => s.draws)), drawsAction: stats(samples.filter(s => s.action).map(s => s.draws)),
              gpuSteady: stats(gpu.filter(s => !s.action && !s.walking).map(s => s.ms)), gpuAction: stats(gpu.filter(s => s.action).map(s => s.ms)), gpuWalking: stats(gpu.filter(s => s.walking).map(s => s.ms)),
              newPrograms: space.renderer.info.programs.length - initial.programs, newTargets: space.targetAllocations - initial.allocations, error: gl.getError() });
          }
        };
      });
    }, mode);
    console.log(JSON.stringify({ mode, ...result })); await page.close();
  }
} finally { await browser.close(); }
