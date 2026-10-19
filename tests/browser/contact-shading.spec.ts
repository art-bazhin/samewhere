import { test, expect } from '@playwright/test';

test('contacts darken only indirect light, including baked bounce and doorway blends', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/'); await page.waitForFunction(() => !!window.__samewhere?.space);
  await page.evaluate(() => window.__samewhere.space.ready);
  const result = await page.evaluate(async () => {
    const threePath = '/node_modules/three/build/three.module.js', contactPath = '/src/contact-shading.ts';
    const THREE = await import(threePath), { withContactShading } = await import(contactPath);
    const space = window.__samewhere.space, renderer = space.renderer;
    space.render = () => {}; renderer.clippingPlanes = [];
    // Constant atlas planes isolate each light source while exercising the
    // shipped transport, passage blending and contact shaders together.
    const texture = (planes: number[][]) => {
      const data = new Float32Array(4 * 4 * planes.length * 4);
      planes.forEach((rgba, plane) => { for (let i = 0; i < 16; i++) data.set(rgba, (plane * 16 + i) * 4); });
      const map = new THREE.DataTexture(data, 4, 4 * planes.length, THREE.RGBAFormat, THREE.FloatType);
      map.minFilter = map.magFilter = THREE.LinearFilter; map.needsUpdate = true; return map;
    };
    const panel = texture([[2, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]]);
    const neighbor = texture([[0, 2, 2, 2], [0, 0, 0, 0]]), direct = texture([[1, 0, 0, 0]]);
    const distance = { value: 0 }, contacts = { value: 1 }, passages = { value: 0 };
    const material = new THREE.MeshPhysicalMaterial({ color: 0xffffff, sheen: .25, clearcoat: .3 });
    material.defines = { ...material.defines, FLOOR_PASSAGE_LIGHTING: '' };
    withContactShading(material, 'contactDistance = probeDistance;', undefined, { probeDistance: distance, probeContacts: contacts },
      'uniform float probeDistance, probeContacts;');
    space.lightTransfer.install(material);
    const before = material.onBeforeCompile.bind(material);
    material.onBeforeCompile = (shader: any, context: any) => {
      before(shader, context);
      Object.assign(shader.uniforms, {
        panelLight: { value: panel }, transferredLight: { value: neighbor }, directSurfaceLight: { value: direct },
        lightmapSize: { value: new THREE.Vector2(4, 4) }, transferColor: { value: new THREE.Color(0xffffff) },
        transferGain: { value: 1 }, bounceGain: { value: 1 }, passageCount: passages,
        passageFrames: { value: [new THREE.Vector4(0, 1, 0, 0), ...Array.from({ length: 3 }, () => new THREE.Vector4())] },
        ...Object.fromEntries(['passageAtlases', 'passageDirectAtlases', 'passageLocalAtlases'].map(key =>
          [key, { value: Array.from({ length: 4 }, () => new THREE.Vector4(.5, .5, 0, 0)) }])),
      });
      shader.fragmentShader = shader.fragmentShader.replace('vec4 roomLight =', `
        reflectedLight.directDiffuse = reflectedLight.directSpecular = vec3(1.);
        reflectedLight.indirectDiffuse = reflectedLight.indirectSpecular = vec3(1.);
        sheenSpecularDirect = sheenSpecularIndirect = vec3(1.);
        clearcoatSpecularDirect = clearcoatSpecularIndirect = vec3(1.);
        totalEmissiveRadiance = vec3(1.);
        vec4 roomLight =`);
      shader.fragmentShader = shader.fragmentShader.replace('float shade = 1. -', 'float shade = 1. - probeContacts *');
      shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
        outgoingLight = vec3(reflectedLight.directDiffuse.r + reflectedLight.directSpecular.r + sheenSpecularDirect.r + clearcoatSpecularDirect.r,
          reflectedLight.indirectDiffuse.r + reflectedLight.indirectSpecular.r + sheenSpecularIndirect.r + clearcoatSpecularIndirect.r,
          totalEmissiveRadiance.r);
        #include <opaque_fragment>`);
    };
    const scene = new THREE.Scene(), geometry = new THREE.PlaneGeometry(2, 2);
    for (const name of ['transferUv', 'directUv']) geometry.setAttribute(name, new THREE.Float32BufferAttribute(new Float32Array(8).fill(.5), 2));
    scene.add(new THREE.Mesh(geometry, material));
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .01, 2); camera.position.z = 1;
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType }), pixel = new Float32Array(4), samples = [];
    try {
      renderer.setRenderTarget(target);
      for (const passage of [0, 1]) for (const gap of [0, .01, .02, .05, .1]) for (const enabled of [0, 1]) {
        passages.value = passage; distance.value = gap; contacts.value = enabled;
        renderer.render(scene, camera); renderer.readRenderTargetPixels(target, 0, 0, 1, 1, pixel);
        samples.push({ passage, gap, enabled, direct: pixel[0], indirect: pixel[1], emission: pixel[2] });
      }
      return { samples, error: renderer.getContext().getError() };
    } finally {
      renderer.setRenderTarget(null); target.dispose(); material.dispose(); geometry.dispose();
      panel.dispose(); neighbor.dispose(); direct.dispose();
    }
  });
  for (const sample of result.samples) {
    const shade = 1 - sample.enabled * .1 * Math.exp(-sample.gap * 50);
    expect(sample.direct, JSON.stringify(sample)).toBeCloseTo(4 - sample.passage + (2 + (1 - sample.passage)) / Math.PI, 5);
    expect(sample.indirect, JSON.stringify(sample)).toBeCloseTo((4 + 3 / Math.PI) * shade, 5);
    expect(sample.emission, JSON.stringify(sample)).toBeCloseTo(1, 5);
  }
  expect(result.error).toBe(0); expect(errors).toEqual([]);
});
