import type { SurfaceSamples } from './lightmap-layout';
import type { SocketRef } from './world';
import { createBounceTransferSampler } from './bounce-light-transfer';
import type { LightingBakeQuality } from './panel-light-bake';

/** RGB diffuse bounce only; detailed direct light uses separate GPU maps. */
export function bakeSurfaceTransfer(receiver: SocketRef, source: SocketRef, samples: SurfaceSamples, texelCount: number, quality: LightingBakeQuality = 'full') {
  const values = new Float32Array(texelCount * 4), point = { x: 0, y: 0, z: 0 }, normal = { ...point };
  const sampleBounce = createBounceTransferSampler(receiver, source, undefined, true, quality);
  for (const texel of samples.texels) {
    const passage = samples.passages[texel];
    if (passage >= 0 && passage !== receiver.side) continue;
    const i = texel * 3;
    point.x = samples.positions[i]; point.y = samples.positions[i + 1]; point.z = samples.positions[i + 2];
    normal.x = samples.normals[i]; normal.y = samples.normals[i + 1]; normal.z = samples.normals[i + 2];
    sampleBounce(point, normal, values, texel * 4 + 1);
    // Sub-pixel contributions otherwise dominate the sparse cache's size.
    for (let channel = 0; channel < 4; channel++) if (values[texel * 4 + channel] < .0005) values[texel * 4 + channel] = 0;
  }
  return values;
}
