import { bakeLightingRooms, type BakedLighting, type BakedRoomLighting } from './light-transfer-bake';
import { ROOM_IDS, ROOMS, roomWalls, type RoomId } from './world';
import type { RoomTaskResult } from './light-transfer-worker-task';

export type TransferResult = BakedLighting | { error: string };
const scope = self as unknown as { onmessage: () => void; postMessage: (data: TransferResult, transfer?: Transferable[]) => void };
scope.onmessage = async () => {
  const start = performance.now(), workers: Worker[] = [];
  try {
    // Reserve CPU capacity for the UI; never keep workers after the startup job.
    const count = Math.min(4, Math.max(1, Math.floor((navigator.hardwareConcurrency || 2) / 2)));
    const groups = Array.from({ length: count }, () => ({ rooms: [] as RoomId[], cost: 0 }));
    const cost = (room: RoomId) => ROOMS[room].sides * roomWalls(room).length * (ROOMS[room].outline ? 1.6 : 1);
    for (const room of [...ROOM_IDS].sort((a, b) => cost(b) - cost(a))) {
      const group = groups.reduce((a, b) => a.cost <= b.cost ? a : b); group.rooms.push(room); group.cost += cost(room);
    }
    const pending = groups.slice(1).filter(group => group.rooms.length).map(group => new Promise<BakedRoomLighting>((resolve, reject) => {
      const worker = new Worker(new URL('./light-transfer-worker-task.ts', import.meta.url), { type: 'module' }); workers.push(worker);
      worker.onerror = event => reject(new Error(event.message));
      worker.onmessage = ({ data }: MessageEvent<RoomTaskResult>) => {
        if ('error' in data) reject(new Error(data.error)); else resolve(data);
      };
      worker.postMessage(group.rooms);
    }));
    // Attach rejection handlers before the coordinator performs its own batch.
    const batches = Promise.all(pending);
    const own = bakeLightingRooms(groups[0].rooms), parts = [own, ...await batches];
    const result: BakedLighting = {
      elapsedMs: performance.now() - start,
      fields: parts.flatMap(part => part.fields).sort((a, b) => a.key.localeCompare(b.key)),
      atlases: Object.assign({}, ...parts.map(part => part.atlases)), panels: Object.assign({}, ...parts.map(part => part.panels)),
    };
    scope.postMessage(result, [...result.fields.flatMap(field => [field.runs.buffer as ArrayBuffer, field.values.buffer as ArrayBuffer]),
      ...Object.values(result.panels).map(values => values.buffer as ArrayBuffer)]);
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    for (const worker of workers) worker.terminate();
  }
};
