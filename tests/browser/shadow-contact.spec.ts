import { test, expect } from '@playwright/test';

test('balls block direct light at their saucer contacts without a bright inner rim', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const result = await page.evaluate(async () => {
    const path = '/node_modules/three/build/three.module.js', THREE = await import(path);
    const app = window.__samewhere, space = app.space, room = space.rooms.A, renderer = space.renderer;
    space.render = () => {}; renderer.clippingPlanes = []; space.lightTransfer.bind('A');
    const material = space.assets.materials.socket, before = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey();
    material.map = material.normalMap = material.roughnessMap = null; material.color.set(0xffffff);
    material.onBeforeCompile = (shader: any, context: any) => {
      before(shader, context);
      shader.fragmentShader = shader.fragmentShader.replace('vec4 roomLight =', 'vec3 liveDiffuse = reflectedLight.directDiffuse;\nvec4 roomLight =');
      shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', 'outgoingLight = liveDiffuse;\n#include <opaque_fragment>');
    };
    material.customProgramCacheKey = () => `${key}:ball-contact-probe`; material.needsUpdate = true;
    const camera = new THREE.OrthographicCamera(-.0001, .0001, .0001, -.0001, .001, 10);
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType }), pixel = new Float32Array(4);
    const samples: any[] = [], lit: number[] = [];
    const read = (x: number, z: number) => {
      camera.position.set(x, 2, z); camera.lookAt(x, 0, z); camera.updateMatrixWorld(true);
      renderer.render(room.scene, camera); renderer.readRenderTargetPixels(target, 0, 0, 1, 1, pixel);
      return Math.max(pixel[0], pixel[1], pixel[2]);
    };
    renderer.setRenderTarget(target);
    try {
      for (const [index, color] of ['red', 'blue'].entries()) {
        app.game.world.balls.forEach((ball: any) => { ball.socket = null; });
        app.game.world.balls.find((ball: any) => ball.color === color).socket = { room: 'B', side: index * 2 }; app.sync();
        const socket = room.sockets.find((s: any) => s.ref.room === 'B' && s.ref.side === index * 2);
        const center = socket.ball.getWorldPosition(new THREE.Vector3()), pedestal = socket.ball.parent.parent.position;
        const lamp = room.shadowLights.find((light: any) => Math.hypot(light.position.x - pedestal.x, light.position.z - pedestal.z) < .001);
        for (const light of room.shadowLights) { light.intensity = light === lamp ? 9 : 0; light.shadow.needsUpdate = true; }
        // Hide only the visible mesh. Its cached shadow proxy remains present,
        // exposing the actual direct illumination on the concrete below it.
        socket.ball.visible = false;
        for (const radius of [.008, .016, .024]) for (let angle = 0; angle < 8; angle++) {
          const x = center.x + Math.cos(angle * Math.PI / 4) * radius, z = center.z + Math.sin(angle * Math.PI / 4) * radius;
          samples.push({ color, radius, angle, light: read(x, z) });
        }
        lit.push(read(center.x + .048, center.z));
      }
      return { samples, lit, error: renderer.getContext().getError() };
    } finally { renderer.setRenderTarget(null); target.dispose(); }
  });
  console.log('Ball contact light leaks:', { samples: result.samples.length, max: Math.max(...result.samples.map(s => s.light)), lit: result.lit });
  expect(result.samples).toHaveLength(48);
  for (const sample of result.samples) expect(sample.light, JSON.stringify(sample)).toBeLessThan(.0001);
  for (const light of result.lit) expect(light).toBeGreaterThan(.01);
  expect(result.error).toBe(0); expect(errors).toEqual([]);
});

test('pedestal shadows do not leak direct light onto the floor at their bases', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const result = await page.evaluate(async () => {
    const threePath = '/node_modules/three/build/three.module.js', worldPath = '/src/world.ts';
    const THREE = await import(threePath), { ROOMS, pedestalOutline } = await import(worldPath);
    const app = window.__samewhere, space = app.space, room = space.rooms.G, renderer = space.renderer;
    app.game.world.balls.forEach((ball: any) => { ball.socket = null; }); app.sync();
    space.render = () => {}; space.clipPlane.setComponents(0, 1, 0, 1); space.lightTransfer.bind('G');
    // Read only live direct diffuse light, independently of textures, fill,
    // contact-darkening strength and the coarse baked diffuse lightmap.
    const floor = room.scene.getObjectByName('floor').material;
    floor.map = floor.normalMap = floor.roughnessMap = null; floor.color.set(0xffffff);
    const before = floor.onBeforeCompile.bind(floor), key = floor.customProgramCacheKey();
    floor.onBeforeCompile = (shader: any, context: any) => {
      before(shader, context);
      shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>',
        'outgoingLight = reflectedLight.directDiffuse;\n#include <opaque_fragment>');
    };
    floor.customProgramCacheKey = () => `${key}:direct-shadow-probe`; floor.needsUpdate = true;
    const panel = space.lightTransfer.fields.G.panel;
    panel.image.data.fill(0); panel.needsUpdate = true;
    const camera = new THREE.OrthographicCamera(-.0001, .0001, .0001, -.0001, .001, 10);
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType });
    const pixel = new Float32Array(4), ray = new THREE.Raycaster(), samples: any[] = [], lit: number[] = [];
    const bodies: any[] = []; room.scene.traverse((mesh: any) => { if (mesh.name === 'pedestal-body') bodies.push(mesh); });
    renderer.setRenderTarget(target);
    const read = (point: any) => {
      camera.position.set(point.x, 2, point.z); camera.lookAt(point.x, 0, point.z); camera.updateMatrixWorld(true);
      renderer.render(room.scene, camera); renderer.readRenderTargetPixels(target, 0, 0, 1, 1, pixel);
      return Math.max(pixel[0], pixel[1], pixel[2]);
    };
    try {
      for (const pedestal of ROOMS.G.pedestals) {
        const lamp = room.shadowLights.find((light: any) => Math.hypot(light.position.x - pedestal.x, light.position.z - pedestal.z) < .001);
        for (const light of room.shadowLights) light.intensity = light === lamp ? 9 : 0;
        const outline = pedestalOutline(pedestal.controls);
        for (let edge = 0; edge < outline.length; edge++) {
          const a = outline[edge], b = outline[(edge + 1) % outline.length], length = Math.hypot(b.x - a.x, b.z - a.z);
          const n = { x: (b.z - a.z) / length, z: -(b.x - a.x) / length };
          for (const gap of [.002, .01, .02]) {
            const point = new THREE.Vector3(pedestal.x + (a.x + b.x) / 2 + n.x * gap, .002, pedestal.z + (a.z + b.z) / 2 + n.z * gap);
            ray.set(point, lamp.position.clone().sub(point).normalize());
            if (!ray.intersectObjects(bodies, false).length) continue;
            samples.push({ shape: pedestal.controls, edge, gap, light: read(point) });
          }
        }
        lit.push(read({ x: pedestal.x, z: pedestal.z + 1 }));
      }
      return { samples, lit, error: renderer.getContext().getError() };
    } finally { renderer.setRenderTarget(null); target.dispose(); }
  });
  console.log('Pedestal base shadow probes:', { samples: result.samples.length, maxAtBase: Math.max(...result.samples.filter(s => s.gap === .002).map(s => s.light)), lit: result.lit });
  expect(new Set(result.samples.map(sample => sample.shape)).size).toBe(7);
  for (const sample of result.samples) {
    if (sample.gap === .002) expect(sample.light, JSON.stringify(sample)).toBeLessThan(.0001);
    // The narrow Y arms can have a legitimate penumbra farther from the base.
    const previous = result.samples.filter(s => s.shape === sample.shape && s.edge === sample.edge && s.gap < sample.gap);
    for (const neighbor of previous) expect(sample.light + .0001, JSON.stringify({ sample, neighbor })).toBeGreaterThanOrEqual(neighbor.light);
  }
  for (const light of result.lit) expect(light).toBeGreaterThan(.01);
  expect(result.error).toBe(0); expect(errors).toEqual([]);
});
