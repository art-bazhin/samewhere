import { test, expect } from '@playwright/test';

test('ball reflections include the shaded saucer and ceiling panels without duplicate spot highlights', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.setViewportSize({ width: 600, height: 600 });
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const result = await page.evaluate(async () => {
    const path = '/node_modules/three/build/three.module.js', THREE = await import(path);
    const app = window.__samewhere, space = app.space, renderer = space.renderer, room = space.rooms.A;
    space.render = () => {}; space.lightTransfer.bind('A'); renderer.clippingPlanes = [];
    renderer.setPixelRatio(1); renderer.setSize(600, 600);
    const socket = room.sockets.find((s: any) => s.ref.room === 'B' && s.ref.side === 2);
    const center = socket.ball.getWorldPosition(new THREE.Vector3());
    const camera = new THREE.PerspectiveCamera(35, 1, .001, 30);
    camera.position.copy(center).add(new THREE.Vector3(.12, .22625, .2)); camera.lookAt(center); camera.updateMatrixWorld(true);
    const probe = { value: 0 }, originalMaterial = socket.ball.material;
    for (const material of [space.assets.materials.red, space.assets.materials.blue]) {
      const before = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey();
      material.onBeforeCompile = (shader: any, context: any) => {
        before(shader, context); shader.uniforms.reflectionProbe = probe;
        shader.fragmentShader = 'uniform int reflectionProbe;\n' + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
          if (reflectionProbe == 1) outgoingLight = reflectedLight.indirectSpecular + material.clearcoat * clearcoatSpecularIndirect;
          if (reflectionProbe == 2) outgoingLight = reflectedLight.directSpecular + material.clearcoat * clearcoatSpecularDirect;
          if (reflectionProbe == 3) outgoingLight = reflectedLight.directDiffuse;
          #include <opaque_fragment>`);
      };
      material.customProgramCacheKey = () => `${key}:ball-reflection-regression`; material.needsUpdate = true;
    }
    const gl = renderer.getContext(), pixels = new Uint8Array(600 * 600 * 4);
    const draw = (mode: number) => {
      probe.value = mode; renderer.setRenderTarget(null); renderer.render(room.scene, camera);
      gl.readPixels(0, 0, 600, 600, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    };
    const ray = new THREE.Raycaster(), lower: number[] = [], ballPixels: number[] = [];
    for (let y = 0; y < 600; y += 4) for (let x = 0; x < 600; x += 4) {
      ray.setFromCamera(new THREE.Vector2((x + .5) / 600 * 2 - 1, (y + .5) / 600 * 2 - 1), camera);
      const hit = ray.intersectObject(socket.ball, false)[0]; if (!hit) continue;
      const index = (y * 600 + x) * 4;
      const normal = hit.point.clone().sub(center).normalize(), view = camera.position.clone().sub(hit.point).normalize();
      // Check ceiling highlights away from the MSAA silhouette and saucer lip.
      if (normal.y > .05 && normal.dot(view) > .3) ballPixels.push(index);
      if (normal.y < -.25 && normal.dot(view) < .4) lower.push(index);
    }
    const peak = (white: boolean) => ballPixels.reduce((max, index) => Math.max(max,
      (white ? Math.min : Math.max)(pixels[index], pixels[index + 1], pixels[index + 2])), 0);
    const highlights = [space.assets.materials.red, space.assets.materials.blue].map(material => {
      socket.ball.material = material;
      draw(1); const panel = peak(true);
      draw(2); const spot = peak(false);
      draw(3); const diffuse = peak(false);
      return { panel, spot, diffuse };
    });
    socket.ball.material = originalMaterial;
    const lowerReflection = () => {
      draw(1);
      return lower.reduce((sum, index) => sum + .2126 * pixels[index] + .7152 * pixels[index + 1] + .0722 * pixels[index + 2], 0) / lower.length;
    };
    const correct = lowerReflection();
    // Recreate a probe taken over the bright center of the pedestal. The
    // comparison isolates reflection position from direct light and cup shadows.
    const source = room.sockets.find((s: any) => s.ball.visible), original = source.ball.getWorldPosition;
    const misplaced = source.ball.parent.parent.getWorldPosition(new THREE.Vector3());
    misplaced.y = source.ball.getWorldPosition(new THREE.Vector3()).y;
    source.ball.getWorldPosition = (target: any) => target.copy(misplaced);
    try { space.prepareBallReflections(); }
    finally { source.ball.getWorldPosition = original; }
    const overPedestal = lowerReflection();
    return { samples: lower.length, correct, overPedestal, highlights, error: gl.getError() };
  });
  console.log('Lower ball reflection:', result);
  expect(result.samples).toBeGreaterThan(20);
  expect(result.correct).toBeLessThan(result.overPedestal * .6);
  for (const highlight of result.highlights) {
    // Measure panels alone; the former >210 full-image peak came from a spot.
    expect(highlight.panel).toBeGreaterThan(180);
    expect(highlight.spot).toBe(0);
    expect(highlight.diffuse).toBeGreaterThan(100);
  }
  expect(result.error).toBe(0); expect(errors).toEqual([]);
});
