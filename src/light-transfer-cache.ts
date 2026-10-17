import { DataUtils } from 'three';
import type { RoomId } from './world';

export interface PreparedTransfer { room: RoomId; key: string; channels: number; runs: Uint32Array; values: Float32Array }

/** Retain exact float32 samples but omit black surface texels. */
export function compressTransfer(room: RoomId, key: string, data: Float32Array, channels = 1): PreparedTransfer {
  // Pack one channel at a time: sparse RGB bounce must not split every run of
  // the much denser direct-light channel into individual four-byte samples.
  const count = data.length / channels;
  const at = (i: number) => data[i % count * channels + Math.floor(i / count)];
  const runs: number[] = [];
  let length = 0;
  for (let i = 0; i < data.length;) {
    if (!at(i)) { i++; continue; }
    const start = i;
    while (i < data.length && at(i)) i++;
    runs.push(start, i - start); length += i - start;
  }
  const values = new Float32Array(length); let cursor = 0;
  for (let run = 0; run < runs.length; run += 2) {
    const end = runs[run] + runs[run + 1];
    for (let i = runs[run]; i < end; i++) values[cursor++] = at(i);
  }
  return { room, key, channels, runs: new Uint32Array(runs), values };
}

/** No allocation or ray tracing during an interaction; touch only lit samples. */
export function combineTransfers(fields: PreparedTransfer[], scratch: Float32Array, output: Uint16Array) {
  scratch.fill(0); output.fill(0);
  for (const field of fields) {
    const count = scratch.length / field.channels;
    let cursor = 0;
    for (let run = 0; run < field.runs.length; run += 2) {
      const end = field.runs[run] + field.runs[run + 1];
      for (let i = field.runs[run]; i < end; i++) {
        const target = i % count * field.channels + Math.floor(i / count);
        scratch[target] += field.values[cursor++]; output[target] = DataUtils.toHalfFloat(scratch[target]);
      }
    }
  }
}
