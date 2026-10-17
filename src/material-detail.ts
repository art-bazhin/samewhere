import * as THREE from 'three';

/** Separate linear material data; never use the sRGB color map as a height map. */
export function materialDetail(meters: number, relief: number, range: [number, number], anisotropy: number) {
  const size = 1024, normalData = new Uint8Array(size * size * 4), roughData = new Uint8Array(512 * 512 * 4).fill(255);
  for (let i = 0; i < normalData.length; i += 4) normalData.set([128, 128, 255, 255], i);
  const normal = new THREE.DataTexture(normalData, size, size), roughness = new THREE.DataTexture(roughData, 512, 512);
  for (const map of [normal, roughness]) {
    map.wrapS = map.wrapT = THREE.MirroredRepeatWrapping; map.repeat.setScalar(2 / meters);
    map.minFilter = THREE.LinearMipmapLinearFilter; map.magFilter = THREE.LinearFilter; map.generateMipmaps = true;
    map.anisotropy = anisotropy; map.flipY = true; map.needsUpdate = true;
  }
  return { normal, roughness, update(image: HTMLImageElement | HTMLCanvasElement) {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0, size, size);
    const pixels = context.getImageData(0, 0, size, size).data, height = new Float32Array(size * size);
    for (let i = 0; i < height.length; i++) height[i] = (.2126 * pixels[i * 4] + .7152 * pixels[i * 4 + 1] + .0722 * pixels[i * 4 + 2]) / 255;
    const at = (x: number, y: number) => height[Math.max(0, Math.min(size - 1, y)) * size + Math.max(0, Math.min(size - 1, x))];
    const scale = relief * size / meters;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      // Sobel gradients retain fine emboss/pile while rejecting broad discoloration.
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)) * scale / 8;
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)) * scale / 8;
      const length = Math.hypot(dx, dy, 1), i = (y * size + x) * 4;
      normalData[i] = Math.round(127.5 * (1 - dx / length)); normalData[i + 1] = Math.round(127.5 * (1 + dy / length));
      normalData[i + 2] = Math.round(127.5 * (1 + 1 / length));
    }
    context.drawImage(image, 0, 0, 512, 512);
    const roughPixels = context.getImageData(0, 0, 512, 512).data;
    for (let i = 0; i < roughData.length; i += 4) {
      const luma = (.2126 * roughPixels[i] + .7152 * roughPixels[i + 1] + .0722 * roughPixels[i + 2]) / 255;
      roughData[i] = roughData[i + 1] = roughData[i + 2] = Math.round(255 * (range[0] + (1 - luma) * (range[1] - range[0])));
    }
    normal.needsUpdate = roughness.needsUpdate = true;
  } };
}

/** Mirrored image tiles need their normal's tangent axes mirrored as well. */
export function mirroredNormals<T extends THREE.MeshStandardMaterial>(material: T): T {
  const before = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    before(shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>',
      THREE.ShaderChunk.normal_fragment_maps.replace('mapN.xy *= normalScale;', 'mapN.xy *= normalScale * (1. - 2. * mod(floor(vNormalMapUv), 2.));'));
  };
  material.customProgramCacheKey = () => `${key}:mirrored-normals`; return material;
}
