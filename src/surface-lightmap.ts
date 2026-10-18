import type { SurfaceSamples } from './lightmap-layout';
import type { SocketRef } from './world';
import { createBounceTransferSampler } from './bounce-light-transfer';
import type { LightingBakeQuality } from './panel-light-bake';
import { LIGHTMAP_CHANNELS, luminance } from './directional-lightmap';

/** RGB diffuse bounce only; detailed direct light uses separate GPU maps. */
export function bakeSurfaceTransfer(receiver: SocketRef, source: SocketRef, samples: SurfaceSamples, texelCount: number, quality: LightingBakeQuality = 'full') {
  const values = new Float32Array(texelCount * LIGHTMAP_CHANNELS), point = { x: 0, y: 0, z: 0 }, normal = { ...point }, moment = new Float32Array(4);
  const sampleBounce = createBounceTransferSampler(receiver, source, undefined, true, quality);
  for (const texel of samples.texels) {
    const passage = samples.passages[texel];
    if (passage >= 0 && passage !== receiver.side) continue;
    const i = texel * 3;
    point.x = samples.positions[i]; point.y = samples.positions[i + 1]; point.z = samples.positions[i + 2];
    normal.x = samples.normals[i]; normal.y = samples.normals[i + 1]; normal.z = samples.normals[i + 2];
    sampleBounce(point, normal, values, texel * 4 + 1, moment);
    // Sub-pixel contributions otherwise dominate the sparse cache's size.
    for (let channel = 0; channel < 4; channel++) if (values[texel * 4 + channel] < .0005) values[texel * 4 + channel] = 0;
    // Match the retained RGB energy; tiny discarded samples must not leave a direction behind.
    const energy = luminance(values[texel * 4 + 1], values[texel * 4 + 2], values[texel * 4 + 3]);
    const gain = moment[3] > 0 ? energy / moment[3] : 0;
    for (let channel = 0; channel < 4; channel++) values[texelCount * 4 + texel * 4 + channel] = moment[channel] * gain || 0;
  }
  return values;
}
