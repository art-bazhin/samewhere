import { DataUtils } from 'three';
import { TRANSFER_AXES, TRANSFER_GRIDS, TRANSFER_SPACING } from './light-transfer-field';
import { DOOR_HEIGHT, type RoomId } from './world';

export interface PreparedTransfer { room: RoomId; key: string; runs: Uint32Array; values: Float32Array; min: number[]; max: number[] }

/** Retain exact float32 samples but omit zero spans (most of each room volume). */
export function compressTransfer(room: RoomId, key: string, data: Float32Array): PreparedTransfer {
  const grid = TRANSFER_GRIDS[room], count = data.length / TRANSFER_AXES;
  const runs: number[] = [], min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let length = 0;
  for (let i = 0; i < data.length;) {
    if (!data[i]) { i++; continue; }
    const start = i;
    while (i < data.length && data[i]) {
      const index = i % count, coordinates = [index % grid.size.x, Math.floor(index / grid.size.x) % grid.size.y, Math.floor(index / (grid.size.x * grid.size.y))];
      for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis], coordinates[axis]); max[axis] = Math.max(max[axis], coordinates[axis]); }
      i++;
    }
    runs.push(start, i - start); length += i - start;
  }
  const values = new Float32Array(length); let cursor = 0;
  for (let run = 0; run < runs.length; run += 2) {
    values.set(data.subarray(runs[run], runs[run] + runs[run + 1]), cursor); cursor += runs[run + 1];
  }
  const origin = [grid.origin.x, grid.origin.y, grid.origin.z], hasLight = Number.isFinite(min[0]);
  for (let axis = 0; axis < 3; axis++) {
    min[axis] = hasLight ? origin[axis] + (min[axis] - 1) * TRANSFER_SPACING : 0;
    max[axis] = hasLight ? origin[axis] + (max[axis] + 1) * TRANSFER_SPACING : -1;
  }
  max[1] = Math.min(max[1], DOOR_HEIGHT);
  return { room, key, runs: new Uint32Array(runs), values, min, max };
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
