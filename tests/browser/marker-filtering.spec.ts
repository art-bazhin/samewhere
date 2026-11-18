import { test, expect } from '@playwright/test';

test('distant marker strokes retain coverage through reduction, oblique views and subpixel movement', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.setViewportSize({ width: 720, height: 480 });
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const results = await page.evaluate(() => {
    const { space } = window.__samewhere, { renderer, camera } = space;
    const width = 720, height = 480;
    const results: { kind: string; distance: number; angle: number; ratios: number[]; error: number }[] = [];
    renderer.clippingPlanes = [];
    for (const [kind, room, side, centerX, ink] of [['text', 'A', 2, 1.95, 'messageInk'], ['pentagon', 'G', 3, -1.3, 'ink'],
      ['Y', 'B', 2, -1.3, 'ink'], ['square', 'E', 1, -1.3, 'ink']] as const) {
      const scene = space.rooms[room].scene, wall = space.rooms[room].walls[side], frame = wall.solid.parent;
      const material = wall.solid.children[0].material, before = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey();
      space.rooms[room].markings.forEach((marking: any) => { marking.shown.value = 1; });
      // Isolate actual ink coverage from wallpaper and lighting, keeping its normal shader path.
      material.onBeforeCompile = (shader: any, renderer: any) => {
        before(shader, renderer);
        shader.fragmentShader = shader.fragmentShader.replace('#include <dithering_fragment>', `#include <dithering_fragment>\n gl_FragColor = vec4(vec3(${ink}), 1.);`);
      };
      material.customProgramCacheKey = () => `${key}:coverage-test`; material.needsUpdate = true;
      scene.traverse((object: any) => { if (object.isMesh) object.visible = object.material === material; });
      wall.solid.visible = true; wall.open.visible = false;
      for (const distance of [8, 24]) for (const angle of [0, .65]) {
        const ratios: number[] = []; let totalError = 0;
        for (const phase of [0, .5]) {
          const target = frame.localToWorld(camera.position.clone().set(centerX, 1.65, 0));
          camera.position.copy(frame.localToWorld(camera.position.clone().set(centerX + Math.sin(angle) * distance, 1.65, Math.cos(angle) * distance)));
          camera.lookAt(target);
          const pixel = 2 * distance * Math.tan(camera.fov * Math.PI / 360) / height;
          camera.position.copy(frame.localToWorld(camera.position.clone().set(centerX + Math.sin(angle) * distance + pixel * phase,
            1.65 + pixel * phase * .63, Math.cos(angle) * distance)));
          camera.updateMatrixWorld(true);
          const images: Float32Array[] = [];
          for (const scale of [1, 4]) {
            renderer.setPixelRatio(scale); renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix();
            renderer.render(scene, camera);
            const gl = renderer.getContext(), pixels = new Uint8Array(width * height * scale * scale * 4);
            gl.readPixels(0, 0, width * scale, height * scale, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            const coverage = new Float32Array(width * height);
            for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
              let sum = 0;
              for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) sum += pixels[((y * scale + sy) * width * scale + x * scale + sx) * 4];
              coverage[y * width + x] = sum / (255 * scale * scale);
            }
            images.push(coverage);
          }
          let actual = 0, reference = 0, difference = 0;
          for (let i = 0; i < images[0].length; i++) {
            actual += images[0][i]; reference += images[1][i]; difference += Math.abs(images[0][i] - images[1][i]);
          }
          if (reference < .5) throw new Error(`Missing reference ink for ${kind} at ${distance} m`);
          ratios.push(actual / reference); totalError += difference / reference;
        }
        results.push({ kind, distance, angle, ratios, error: totalError / ratios.length });
      }
    }
    return results;
  });
  for (const result of results) {
    const description = `${result.kind} at ${result.distance} m, angle ${result.angle}: ${JSON.stringify(result)}`;
    for (const ratio of result.ratios) { expect(ratio, description).toBeGreaterThan(.85); expect(ratio, description).toBeLessThan(1.15); }
    expect(Math.max(...result.ratios) - Math.min(...result.ratios), description).toBeLessThan(.15);
    expect(result.error, description).toBeLessThan(.6);
  }
  expect(errors).toEqual([]);
});
