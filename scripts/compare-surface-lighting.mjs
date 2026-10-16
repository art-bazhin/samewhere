import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';

// Capture the previous implementation before replacing it, then compare the
// same receiving surfaces and recursive views. Reference images live outside git.
const directory = process.argv.find(arg => arg.startsWith('--directory='))?.slice(12) ?? '/tmp/samewhere-lighting-reference';
const capture = process.argv.includes('--capture');
const imageIndex = Number(process.argv.find(arg => arg.startsWith('--image='))?.slice(8) ?? -1);
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-webgl'] });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.goto('http://127.0.0.1:5173/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const scenarios = await page.evaluate(async () => {
    const { ROOM_IDS, ROOMS, portalPosition, wallNormal } = await import('/src/world.ts');
    const scenarios = [];
    for (const room of ROOM_IDS) for (const side of [0, ROOMS[room].sides - 1]) {
      const p = portalPosition(room, side), n = wallNormal(room, side), source = room === 'G' ? 'A' : 'G';
      const sockets = [{ room, side }, { room: source, side: side % ROOMS[source].sides }, null, null];
      const yaw = Math.atan2(-n.x, -n.z);
      for (const pitch of [-.8, -.15]) scenarios.push({ sockets, player: { room, x: p.x - n.x * 2 + n.z * .6, z: p.z - n.z * 2 - n.x * .6, yaw, pitch } });
      // Look back from inside the doorway toward the receiving floor/pedestals.
      scenarios.push({ sockets, player: { room, x: p.x - n.x * .4, z: p.z - n.z * .4, yaw: yaw + Math.PI, pitch: -.45 } });
    }
    // Both contributions in one receiving room, including an open threshold.
    scenarios.push({ sockets: [{ room: 'A', side: 0 }, { room: 'G', side: 0 }, { room: 'A', side: 1 }, { room: 'C', side: 2 }], player: { room: 'A', x: 0, z: -3.2, yaw: 0, pitch: -.7 } });
    return scenarios;
  });
  const report = [];
  for (const [index, scenario] of scenarios.entries()) {
    const pixels = Buffer.from(await page.evaluate(scenario => {
      const app = window.__samewhere, space = app.space;
      app.game.world.balls.forEach((ball, i) => { ball.socket = scenario.sockets[i]; }); app.sync();
      Object.assign(app.game.player, scenario.player);
      for (let i = 0; i < 8; i++) space.render();
      const gl = space.renderer.getContext(), data = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
      gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, data);
      let raw = ''; for (let i = 0; i < data.length; i += 32768) raw += String.fromCharCode(...data.subarray(i, i + 32768)); return btoa(raw);
    }, scenario), 'base64');
    const filename = `${directory}/${index}.rgba.gz`;
    if (capture) await writeFile(filename, gzipSync(pixels));
    else {
      const reference = gunzipSync(await readFile(filename));
      let total = 0, max = 0, changed = 0, visible = 0;
      for (let i = 0; i < pixels.length; i++) {
        if (i % 4 === 3) continue;
        const delta = Math.abs(pixels[i] - reference[i]); total += delta; max = Math.max(max, delta);
        if (delta > 2) changed++; if (delta > 8) visible++;
      }
      report.push({ index, room: scenario.player.room, mean: +(total / (pixels.length * .75)).toFixed(5), max, changedPercent: +(changed / (pixels.length * .75) * 100).toFixed(4), above8Percent: +(visible / (pixels.length * .75) * 100).toFixed(4) });
      if (index === imageIndex) {
        const png = await page.evaluate(({ before, after }) => {
          const width = 1000, height = 700, canvas = document.createElement('canvas'); canvas.width = width * 2; canvas.height = height + 24;
          const context = canvas.getContext('2d'); context.fillStyle = '#111'; context.fillRect(0, 0, canvas.width, canvas.height);
          context.fillStyle = '#fff'; context.font = '16px sans-serif'; context.fillText('Reference volume', 12, 18); context.fillText('Surface lightmaps', width + 12, 18);
          for (const [side, source] of [before, after].entries()) {
            const bytes = Uint8Array.from(atob(source), c => c.charCodeAt(0)), image = context.createImageData(width, height);
            for (let y = 0; y < height; y++) image.data.set(bytes.subarray(y * width * 4, (y + 1) * width * 4), (height - y - 1) * width * 4);
            context.putImageData(image, side * width, 24);
          }
          return canvas.toDataURL('image/png').split(',')[1];
        }, { before: reference.toString('base64'), after: pixels.toString('base64') });
        await writeFile(`${directory}/${index}.comparison.png`, Buffer.from(png, 'base64'));
      }
    }
  }
  await writeFile(`${directory}/scenarios.json`, JSON.stringify(scenarios));
  console.log(JSON.stringify(capture ? { captured: scenarios.length, directory } : report));
} finally { await browser.close(); }
