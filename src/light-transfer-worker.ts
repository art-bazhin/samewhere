import { bakeTransfer } from './light-transfer-field';
import { compressTransfer, type PreparedTransfer } from './light-transfer-cache';
import { ROOM_IDS, ROOMS } from './world';

export interface TransferResult { elapsedMs: number; fields: PreparedTransfer[] }
const scope = self as unknown as { onmessage: () => void; postMessage: (data: TransferResult, transfer: Transferable[]) => void };
scope.onmessage = () => {
  const start = performance.now(), fields: PreparedTransfer[] = [];
  const sockets = ROOM_IDS.flatMap(room => Array.from({ length: ROOMS[room].sides }, (_, side) => ({ room, side })));
  // Geometry and lamps are static. Prepare every directed connection once,
  // before play, instead of racing the door opening with an on-demand bake.
  for (const receiver of sockets) for (const source of sockets) {
    if (receiver.room === source.room && receiver.side === source.side) continue;
    const key = `${receiver.room}${receiver.side}<${source.room}${source.side}`;
    fields.push(compressTransfer(receiver.room, key, bakeTransfer(receiver, source)));
  }
  scope.postMessage({ elapsedMs: performance.now() - start, fields }, fields.flatMap(field => [field.runs.buffer as ArrayBuffer, field.values.buffer as ArrayBuffer]));
};
