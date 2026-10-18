import { test, expect } from '@playwright/test';

for (const deviceScaleFactor of [1, 2]) test.describe(`direct lighting at display scale ${deviceScaleFactor}`, () => {
test.use({ deviceScaleFactor });

test('neighbor shadows follow straight jamb edges at centimeter scale and stay cached while walking', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const result = await page.evaluate(async () => {
    const threePath = '/node_modules/three/build/three.module.js', worldPath = '/src/world.ts', shaderPath = '/src/direct-light.ts';
    const samplerPath = '/src/light-transfer-sampling.ts', lightingPath = '/src/lighting.ts';
    const THREE = await import(threePath), W = await import(worldPath);
    const { DIRECT_LIGHT_SHADER, DIRECT_SHADOW_SHADER } = await import(shaderPath);
    const { transferPathBlocked } = await import(samplerPath), { CEILING_LIGHT } = await import(lightingPath);
    const app = window.__samewhere, space = app.space, light = space.lightTransfer, renderer = space.renderer;
    const from = { room: 'C', side: 1 }, to = { room: 'B', side: 0 };
    app.game.world.balls.forEach((ball: any) => { ball.socket = null; });
    app.game.world.balls[0].socket = from; app.game.world.balls[1].socket = to; app.sync(); space.render();
    const before = { ...renderer.info.memory, programs: renderer.info.programs.length }, updates = light.direct.updates;
    for (let i = 0; i < 15; i++) { app.game.player.yaw += .02; space.render(); }
    const cached = light.direct.updates === updates, after = { ...renderer.info.memory, programs: renderer.info.programs.length };
    space.render = () => {}; renderer.clippingPlanes = []; light.bind('C');
    // Isolate the first real lamp while retaining its prepared depth tile.
    light.direct.uniforms.directNeighborCount.value = 1;
    const p = W.portalPosition('C', 1), n = W.wallNormal('C', 1), row = light.direct.uniforms.directRow.value;
    const lamp = { x: light.direct.data[row * 1024 * 4], y: light.direct.data[row * 1024 * 4 + 1] };
    const normalDistance = (lamp.x - p.x) * n.x + (lamp.y - p.z) * n.z;
    const lateralLamp = -(lamp.x - p.x) * n.z + (lamp.y - p.z) * n.x;
    const probes: { point: any; expected: number; inside: boolean; depth: number; side: number; offset: number }[] = [];
    for (const depth of [.8, 1.15, 1.5, 1.85, 2.2, 2.55, 2.9, 3.25]) for (const side of [-1, 1]) {
      const bounds = [-.15, .15].map(face => (side * .9 * (normalDistance + depth) - lateralLamp * (depth + face)) / (normalDistance - face));
      const edge = side < 0 ? Math.max(...bounds) : Math.min(...bounds);
      for (const offset of [-.025, -.01, .01, .025]) {
        const lateral = edge + offset;
        const point = { x: p.x - n.x * depth - n.z * lateral, y: .002, z: p.z - n.z * depth + n.x * lateral };
        const t = depth / (depth + normalDistance), aperture = { x: point.x + (lamp.x - point.x) * t,
          y: point.y + (CEILING_LIGHT.height - point.y) * t, z: point.z + (lamp.y - point.z) * t };
        const q = W.transformPoint(aperture, from, to), source = W.transformPoint({ x: lamp.x, z: lamp.y }, from, to);
        const blocked = transferPathBlocked('C', point, aperture, 1) || transferPathBlocked('B', { ...q, y: aperture.y }, { ...source, y: CEILING_LIGHT.height }, 0);
        probes.push({ point, expected: blocked ? 0 : 1, inside: offset * side < 0, depth, side, offset });
      }
    }
    // Re-render the final irradiance texture with that one fixture too, so the
    // regression covers the shipped cache as well as the depth projection.
    light.direct.surfaces.render(renderer, 'C', () => {}, light.direct.uniforms.directLocalStarts.value, light.direct.uniforms.directLocalCounts.value);
    const floor = space.rooms.C.scene.children.find((mesh: any) => mesh.name === 'floor'), floorPosition = floor.geometry.getAttribute('position');
    const floorUv = floor.geometry.getAttribute('directUv'), floorIndex = floor.geometry.index;
    const data = new Float32Array(probes.length * 4 * 2);
    probes.forEach((probe, i) => data.set([probe.point.x, probe.point.y, probe.point.z, 1], i * 4));
    probes.forEach((probe, i) => {
      for (let vertex = 0; vertex < floorIndex.count; vertex += 3) {
        const ids = [0, 1, 2].map(k => floorIndex.getX(vertex + k));
        const points = ids.map(k => new THREE.Vector3().fromBufferAttribute(floorPosition, k));
        const weights = new THREE.Triangle(...points).getBarycoord(new THREE.Vector3(probe.point.x, 0, probe.point.z), new THREE.Vector3());
        if (!weights || Math.min(weights.x, weights.y, weights.z) < -.000001) continue;
        const uv = new THREE.Vector2(); ids.forEach((id, k) => uv.addScaledVector(new THREE.Vector2().fromBufferAttribute(floorUv, id), weights.getComponent(k)));
        data.set([uv.x, uv.y, 0, 0], (probes.length + i) * 4); break;
      }
    });
    const texture = new THREE.DataTexture(data, probes.length, 2, THREE.RGBAFormat, THREE.FloatType); texture.needsUpdate = true;
    const material = new THREE.ShaderMaterial({
      uniforms: { ...light.direct.uniforms, probes: { value: texture }, surfaceLight: { value: light.direct.surfaces.fields.C.target.texture } },
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0., 1.); }',
      fragmentShader: `${DIRECT_LIGHT_SHADER}\n#include <packing>\n${DIRECT_SHADOW_SHADER}
        uniform sampler2D probes, surfaceLight;
        void main() {
          vec3 p = texelFetch(probes, ivec2(int(gl_FragCoord.x), 0), 0).xyz;
          gl_FragColor = vec4(directNeighborLight(p, vec3(0., 1., 0.), vec3(0., 1., 0.)),
            directEnergy(p, vec3(0., 1., 0.), directRecord(0, 0).xy),
            texture2D(surfaceLight, texelFetch(probes, ivec2(int(gl_FragCoord.x), 1), 0).xy).r, directVisibility(0, p, vec3(0., 1., 0.)));
        }`,
    });
    const scene = new THREE.Scene(), geometry = new THREE.PlaneGeometry(2, 2); scene.add(new THREE.Mesh(geometry, material));
    const target = new THREE.WebGLRenderTarget(probes.length, 1, { type: THREE.FloatType }), pixels = new Float32Array(probes.length * 4);
    try {
      renderer.setRenderTarget(target); renderer.render(scene, new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1));
      renderer.readRenderTargetPixels(target, 0, 0, probes.length, 1, pixels);
      return { probes: probes.map((probe, i) => ({ ...probe, actual: pixels[i * 4], energy: pixels[i * 4 + 1], mapped: pixels[i * 4 + 2], visibility: pixels[i * 4 + 3] })), cached, before, after, error: renderer.getContext().getError() };
    } finally { renderer.setRenderTarget(null); geometry.dispose(); material.dispose(); texture.dispose(); target.dispose(); }
  });
  const lit = result.probes.filter(probe => probe.inside && probe.expected > 0 && probe.energy > .001);
  const blocked = result.probes.filter(probe => !probe.inside);
  console.log('Centimeter-scale doorway shadows:', { lit: lit.length, blocked: blocked.length, cached: result.cached,
    maxLitError: Math.max(...lit.map(probe => Math.abs(probe.actual / probe.energy - 1))) });
  expect(lit.length).toBeGreaterThan(12);
  // The four-tap depth filter may soften the edge. Its 50% contour must still
  // lie within one centimeter, rather than following the former 25 cm grid.
  for (const probe of lit) expect(probe.actual, JSON.stringify(probe)).toBeGreaterThan(probe.energy * .5);
  for (const probe of blocked) expect(probe.actual, JSON.stringify(probe)).toBeLessThan(.000001);
  for (const probe of lit.filter(probe => Math.abs(probe.offset) > .02)) expect(probe.mapped, JSON.stringify(probe)).toBeGreaterThan(probe.energy * .5);
  for (const probe of blocked.filter(probe => Math.abs(probe.offset) > .02)) expect(probe.mapped, JSON.stringify(probe)).toBeLessThan(probe.energy * .5);
  expect(result.cached).toBe(true); expect(result.after).toEqual(result.before);
  expect(result.error).toBe(0); expect(errors).toEqual([]);
});
});

test('square-room loop writes identical shadow and irradiance texels at standard and Retina scales', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const result = await page.evaluate(async () => {
    const path = '/node_modules/three/build/three.module.js', THREE = await import(path);
    const app = window.__samewhere, space = app.space, renderer = space.renderer, direct = space.lightTransfer.direct;
    app.game.world.balls.forEach((ball: any) => { ball.socket = null; });
    app.game.world.balls[0].socket = { room: 'A', side: 0 };
    app.game.world.balls[1].socket = { room: 'A', side: 1 }; app.sync();
    space.render = () => {};
    const geometry = new THREE.PlaneGeometry(2, 2), scene = new THREE.Scene();
    const material = new THREE.ShaderMaterial({
      uniforms: { irradiance: { value: direct.surfaces.fields.A.target.texture } },
      vertexShader: 'varying vec2 sampleUv; void main() { sampleUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
      fragmentShader: 'varying vec2 sampleUv; uniform sampler2D irradiance; void main() { gl_FragColor = vec4(texture2D(irradiance, sampleUv).rrr, 1.); }',
    });
    scene.add(new THREE.Mesh(geometry, material));
    const target = new THREE.WebGLRenderTarget(128, 128, { type: THREE.FloatType, depthBuffer: false });
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), previousRatio = renderer.getPixelRatio();
    const capture = (ratio: number) => {
      renderer.setPixelRatio(ratio);
      direct.slots.forEach((slot: any) => { if (slot.link) slot.dirty = true; }); direct.update();
      const depth: Uint8Array[] = [];
      direct.slots.forEach((slot: any, index: number) => {
        if (!slot.link) return;
        slot.lamps.forEach((_: any, lamp: number) => {
          const tile = index * 7 + lamp, pixels = new Uint8Array(256 * 512 * 4);
          renderer.readRenderTargetPixels(direct.target, tile % 8 * 256, Math.floor(tile / 8) * 512, 256, 512, pixels);
          depth.push(pixels);
        });
      });
      renderer.setRenderTarget(target); renderer.render(scene, camera);
      const irradiance = new Float32Array(128 * 128 * 4);
      renderer.readRenderTargetPixels(target, 0, 0, 128, 128, irradiance); renderer.setRenderTarget(null);
      return { depth, irradiance };
    };
    try {
      const standard = capture(1), retina = capture(1.5);
      let changedDepth = 0, maxIrradianceError = 0, litSamples = 0;
      standard.depth.forEach((tile, i) => tile.forEach((value, j) => { if (value !== retina.depth[i][j]) changedDepth++; }));
      for (let i = 0; i < standard.irradiance.length; i += 4) {
        maxIrradianceError = Math.max(maxIrradianceError, Math.abs(standard.irradiance[i] - retina.irradiance[i]));
        if (standard.irradiance[i] > .001) litSamples++;
      }
      return { changedDepth, maxIrradianceError, litSamples, error: renderer.getContext().getError() };
    } finally {
      renderer.setRenderTarget(null); renderer.setPixelRatio(previousRatio);
      target.dispose(); geometry.dispose(); material.dispose();
    }
  });
  expect(result.litSamples).toBeGreaterThan(100);
  expect(result.changedDepth).toBe(0);
  expect(result.maxIrradianceError).toBeLessThan(.000001);
  expect(result.error).toBe(0);
});
