import { DataUtils } from 'three';
import { bakingLayout, surfaceSamples } from './lightmap-layout';
import { bakePanelLight, type LightingBakeQuality } from './panel-light-bake';
import { createTransferSampler } from './light-transfer-sampling';
import { createBounceTransferSampler } from './bounce-light-transfer';
import { TUNNEL_LIGHT_LINKS } from './lighting';

export interface JoinedField { size: [number, number]; panel: Uint16Array }
export type JoinedLighting = Record<'A' | 'T', JoinedField>;

/** Fixed A↔T bounce and shared threshold samples. Sharp direct light uses the
 * same detailed GPU maps and live fixture shadows as ordinary rooms. */
export function bakeJoinedLighting(quality: LightingBakeQuality): JoinedLighting {
  return Object.fromEntries((['A', 'T'] as const).map(room => {
    const layout = bakingLayout(room, true), samples = surfaceSamples(layout), count = layout.width * layout.height;
    const panel = bakePanelLight(room, samples, count, quality);
    const links = TUNNEL_LIGHT_LINKS.filter(link => link.receiver.room === room);
    for (const { receiver, source } of links) {
      const direct = createTransferSampler(receiver, source, true, quality === 'full' ? 9 : 3);
      const bounce = createBounceTransferSampler(receiver, source, undefined, true, quality);
      const energy = new Float32Array(6), rgb = new Float32Array(3), moment = new Float32Array(4), gradient = new Float64Array(4);
      for (const texel of samples.texels) {
        if (samples.passages[texel] >= 0 && samples.passages[texel] !== receiver.side) continue;
        const i = texel * 3, out = texel * 4;
        const point = { x: samples.positions[i], y: samples.positions[i + 1], z: samples.positions[i + 2] };
        const normal = { x: samples.normals[i], y: samples.normals[i + 1], z: samples.normals[i + 2] };
        // Only the shared threshold needs the full direct sum in this atlas.
        // Other surfaces use the ordinary fine GPU direct maps and live spots.
        energy.fill(0); gradient.fill(0);
        if (samples.passages[texel] >= 0) direct(point, energy, normal, gradient);
        rgb.fill(0); bounce(point, normal, rgb, 0, moment);
        const add = (offset: number, value: number) => { panel[offset] = DataUtils.toHalfFloat(DataUtils.fromHalfFloat(panel[offset]) + value); };
        add(out, energy[0]);
        for (let c = 0; c < 3; c++) add(out + 1 + c, rgb[c]);
        for (let c = 0; c < 4; c++) {
          add(count * 4 + out + c, moment[c]); add(count * 8 + out + c, c === 3 ? energy[0] : gradient[c]);
        }
      }
    }
    return [room, { size: [layout.width, layout.height], panel }];
  })) as JoinedLighting;
}
