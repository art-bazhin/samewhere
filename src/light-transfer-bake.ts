import { compressTransfer, type PreparedTransfer } from './light-transfer-cache';
import { bakingLayout, surfaceSamples } from './lightmap-layout';
import { bakeSurfaceTransfer } from './surface-lightmap';
import { ROOM_IDS, ROOMS, type RoomId } from './world';

export interface BakedLighting { elapsedMs: number; fields: PreparedTransfer[]; atlases: Record<RoomId, [number, number]> }

/** One startup job. No filesystem, assets, or DOM; runs in a Web Worker. */
export function bakeLightTransfer(): BakedLighting {
  const start = performance.now(), fields: PreparedTransfer[] = [];
  const layouts = Object.fromEntries(ROOM_IDS.map(room => {
    const layout = bakingLayout(room);
    return [room, { width: layout.width, height: layout.height, samples: surfaceSamples(layout) }];
  })) as Record<RoomId, { width: number; height: number; samples: ReturnType<typeof surfaceSamples> }>;
  const sockets = ROOM_IDS.flatMap(room => Array.from({ length: ROOMS[room].sides }, (_, side) => ({ room, side })));
  for (const receiver of sockets) for (const source of sockets) {
    if (receiver.room === source.room && receiver.side === source.side) continue;
    const layout = layouts[receiver.room], key = `${receiver.room}${receiver.side}<${source.room}${source.side}`;
    fields.push(compressTransfer(receiver.room, key, bakeSurfaceTransfer(receiver, source, layout.samples, layout.width * layout.height)));
  }
  const atlases = Object.fromEntries(ROOM_IDS.map(room => [room, [layouts[room].width, layouts[room].height]])) as BakedLighting['atlases'];
  return { elapsedMs: performance.now() - start, fields, atlases };
}
