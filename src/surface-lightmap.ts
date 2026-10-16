import { createTransferSampler } from './light-transfer-sampling';
import type { SurfaceSamples } from './lightmap-layout';
import type { SocketRef } from './world';

/** Bake one scalar per surface texel; normals are already known at bake time. */
export function bakeSurfaceTransfer(receiver: SocketRef, source: SocketRef, samples: SurfaceSamples, texelCount: number) {
  const values = new Float32Array(texelCount), sample = new Float32Array(6), point = { x: 0, y: 0, z: 0 };
  const sampleTransfer = createTransferSampler(receiver, source);
  for (const texel of samples.texels) {
    const i = texel * 3;
    point.x = samples.positions[i]; point.y = samples.positions[i + 1]; point.z = samples.positions[i + 2];
    sampleTransfer(point, sample);
    const nx = samples.normals[i], ny = samples.normals[i + 1], nz = samples.normals[i + 2];
    values[texel] = Math.abs(nx) * sample[nx >= 0 ? 0 : 1] + Math.abs(ny) * sample[ny >= 0 ? 2 : 3] + Math.abs(nz) * sample[nz >= 0 ? 4 : 5];
  }
  return values;
}
