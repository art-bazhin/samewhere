import { test, expect } from '@playwright/test';

test('ball reflections include the shaded saucer and retain bright ceiling highlights', async ({ page }) => {
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
    const probe = { value: false }, material = socket.ball.material;
    const before = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey();
    material.onBeforeCompile = (shader: any, context: any) => {
      before(shader, context); shader.uniforms.reflectionProbe = probe;
      shader.fragmentShader = 'uniform bool reflectionProbe;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
        if (reflectionProbe) outgoingLight = reflectedLight.indirectSpecular + material.clearcoat * clearcoatSpecularIndirect;
        #include <opaque_fragment>`);
    };
    material.customProgramCacheKey = () => `${key}:ball-reflection-regression`; material.needsUpdate = true;
    const gl = renderer.getContext(), pixels = new Uint8Array(600 * 600 * 4);
    const draw = (isolated: boolean) => {
      probe.value = isolated; renderer.setRenderTarget(null); renderer.render(room.scene, camera);
      gl.readPixels(0, 0, 600, 600, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    };
    draw(false);
    const ray = new THREE.Raycaster(), lower: number[] = [];
    let brightestWhite = 0;
    for (let y = 0; y < 600; y += 4) for (let x = 0; x < 600; x += 4) {
      ray.setFromCamera(new THREE.Vector2((x + .5) / 600 * 2 - 1, (y + .5) / 600 * 2 - 1), camera);
      const hit = ray.intersectObject(socket.ball, false)[0]; if (!hit) continue;
      const index = (y * 600 + x) * 4;
      brightestWhite = Math.max(brightestWhite, Math.min(pixels[index], pixels[index + 1], pixels[index + 2]));
      const normal = hit.point.clone().sub(center).normalize(), view = camera.position.clone().sub(hit.point).normalize();
      if (normal.y < -.25 && normal.dot(view) < .4) lower.push(index);
    }
    const lowerReflection = () => {
      draw(true);
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
    return { samples: lower.length, correct, overPedestal, brightestWhite, error: gl.getError() };
  });
  console.log('Lower ball reflection:', result);
  expect(result.samples).toBeGreaterThan(20);
  expect(result.correct).toBeLessThan(result.overPedestal * .6);
  expect(result.brightestWhite).toBeGreaterThan(210);
  expect(result.error).toBe(0); expect(errors).toEqual([]);
});
