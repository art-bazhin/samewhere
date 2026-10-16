import { DataUtils } from 'three';
import type { RoomId } from './world';

export interface PreparedTransfer { room: RoomId; key: string; runs: Uint32Array; values: Float32Array }

/** Retain exact float32 samples but omit black surface texels. */
export function compressTransfer(room: RoomId, key: string, data: Float32Array): PreparedTransfer {
  const runs: number[] = [];
  let length = 0;
  for (let i = 0; i < data.length;) {
    if (!data[i]) { i++; continue; }
    const start = i;
    while (i < data.length && data[i]) i++;
    runs.push(start, i - start); length += i - start;
  }
  const values = new Float32Array(length); let cursor = 0;
  for (let run = 0; run < runs.length; run += 2) {
    values.set(data.subarray(runs[run], runs[run] + runs[run + 1]), cursor); cursor += runs[run + 1];
  }
  return { room, key, runs: new Uint32Array(runs), values };
}

/** No allocation or ray tracing during an interaction; touch only lit samples. */
export function combineTransfers(fields: PreparedTransfer[], scratch: Float32Array, output: Uint16Array) {
  scratch.fill(0); output.fill(0);
  for (const field of fields) {
    let cursor = 0;
    for (let run = 0; run < field.runs.length; run += 2) {
      const end = field.runs[run] + field.runs[run + 1];
      for (let i = field.runs[run]; i < end; i++) {
        scratch[i] += field.values[cursor++]; output[i] = DataUtils.toHalfFloat(scratch[i]);
      }
    }
  }
}
