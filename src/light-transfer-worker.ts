import { DataUtils } from 'three';
import { bakeTransfer, TRANSFER_AXES, TRANSFER_GRIDS, TRANSFER_SPACING } from './light-transfer-field';
import { DOOR_HEIGHT, ROOM_IDS, type RoomId, type SocketRef } from './world';

export interface TransferLink { receiver: SocketRef; source: SocketRef; key: string }
export interface TransferRequest { revision: number; links: TransferLink[]; keys: Record<RoomId, string>; known: string[] }
export interface TransferResult { revision: number; elapsedMs: number; cacheSize: number; fields: { room: RoomId; key: string; data: Uint16Array; min: number[]; max: number[] }[] }
const cache = new Map<string, Float32Array>();
const scope = self as unknown as { onmessage: (event: MessageEvent<TransferRequest>) => void; postMessage: (data: TransferResult, transfer: Transferable[]) => void };
scope.onmessage = ({ data: request }) => {
  const start = performance.now(), fields: TransferResult['fields'] = [];
  const known = new Set(request.known);
  for (const room of ROOM_IDS) {
    const links = request.links.filter(link => link.receiver.room === room);
    if (!links.length) continue;
    const grid = TRANSFER_GRIDS[room];
    const contributions = links.map(link => {
      let values = cache.get(link.key);
      if (!values) values = bakeTransfer(link.receiver, link.source);
      cache.delete(link.key); cache.set(link.key, values);
      while (cache.size > 24) cache.delete(cache.keys().next().value!);
      return values;
    });
    // At most four live endpoints. Cache every nonempty subset so taking a ball
    // can remove its light immediately without blanking the surviving portals.
    for (let mask = 1; mask < 1 << links.length; mask++) {
      const selected = links.filter((_, index) => mask & 1 << index), key = selected.map(link => link.key).join('|');
      if (known.has(key)) continue;
      const total = new Float32Array(grid.size.x * grid.size.y * grid.size.z * TRANSFER_AXES);
      for (let index = 0; index < links.length; index++) if (mask & 1 << index) {
        const values = contributions[index];
        for (let i = 0; i < total.length; i++) total[i] += values[i];
      }
      const values = new Uint16Array(total.length);
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], count = total.length / TRANSFER_AXES;
      for (let i = 0; i < total.length; i++) {
        values[i] = DataUtils.toHalfFloat(total[i]);
        if (total[i] <= 0) continue;
        const index = i % count, coordinates = [index % grid.size.x, Math.floor(index / grid.size.x) % grid.size.y, Math.floor(index / (grid.size.x * grid.size.y))];
        for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis], coordinates[axis]); max[axis] = Math.max(max[axis], coordinates[axis]); }
      }
      const origin = [grid.origin.x, grid.origin.y, grid.origin.z], hasLight = Number.isFinite(min[0]);
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = hasLight ? origin[axis] + (min[axis] - 1) * TRANSFER_SPACING : 0;
        max[axis] = hasLight ? origin[axis] + (max[axis] + 1) * TRANSFER_SPACING : -1;
      }
      max[1] = Math.min(max[1], DOOR_HEIGHT);
      fields.push({ room, key, data: values, min, max });
    }
  }
  scope.postMessage({ revision: request.revision, elapsedMs: performance.now() - start, cacheSize: cache.size, fields }, fields.map(field => field.data.buffer as ArrayBuffer));
};
