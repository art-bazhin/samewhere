import { compressTransfer, type PreparedTransfer } from './light-transfer-cache';
import { bakingLayout, surfaceSamples } from './lightmap-layout';
import { bakeSurfaceTransfer } from './surface-lightmap';
import { bakePanelLight } from './panel-light-bake';
import { ROOM_IDS, ROOMS, type RoomId } from './world';

export interface BakedLighting { elapsedMs: number; fields: PreparedTransfer[]; atlases: Record<RoomId, [number, number]>; panels: Record<RoomId, Uint16Array> }
export interface BakedRoomLighting { elapsedMs: number; fields: PreparedTransfer[]; atlases: Partial<BakedLighting['atlases']>; panels: Partial<BakedLighting['panels']> }

/** Build-time calculation; independent of filesystem, assets, DOM and WebGL. */
export function bakeLightTransfer(): BakedLighting {
  return bakeLightingRooms(ROOM_IDS) as BakedLighting;
}

/** Receiving rooms can also be baked independently for verification. */
export function bakeLightingRooms(rooms: RoomId[]): BakedRoomLighting {
  const start = performance.now(), fields: PreparedTransfer[] = [];
  const layouts = Object.fromEntries(rooms.map(room => {
    const layout = bakingLayout(room);
    return [room, { width: layout.width, height: layout.height, samples: surfaceSamples(layout) }];
  })) as Record<RoomId, { width: number; height: number; samples: ReturnType<typeof surfaceSamples> }>;
  const sockets = ROOM_IDS.flatMap(room => Array.from({ length: ROOMS[room].sides }, (_, side) => ({ room, side })));
  for (const receiver of sockets) for (const source of sockets) {
    if (!rooms.includes(receiver.room)) continue;
    if (receiver.room === source.room && receiver.side === source.side) continue;
    const layout = layouts[receiver.room], key = `${receiver.room}${receiver.side}<${source.room}${source.side}`;
    fields.push(compressTransfer(receiver.room, key, bakeSurfaceTransfer(receiver, source, layout.samples, layout.width * layout.height), 4));
  }
  const atlases = Object.fromEntries(rooms.map(room => [room, [layouts[room].width, layouts[room].height]])) as BakedRoomLighting['atlases'];
  const panels = Object.fromEntries(rooms.map(room => {
    const layout = layouts[room]; return [room, bakePanelLight(room, layout.samples, layout.width * layout.height)];
  })) as BakedRoomLighting['panels'];
  return { elapsedMs: performance.now() - start, fields, atlases, panels };
}
