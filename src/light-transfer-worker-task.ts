import { bakeLightingRooms, type BakedRoomLighting } from './light-transfer-bake';
import type { RoomId } from './world';

export type RoomTaskResult = BakedRoomLighting | { error: string };
export function lightingTransferables(data: BakedRoomLighting): Transferable[] {
  return [...data.fields.flatMap(field => [field.runs.buffer as ArrayBuffer, field.values.buffer as ArrayBuffer]),
    ...Object.values(data.panels).map(values => values.buffer as ArrayBuffer)];
}
const scope = self as unknown as { onmessage: (event: MessageEvent<RoomId[]>) => void; postMessage: (data: RoomTaskResult, transfer?: Transferable[]) => void };
scope.onmessage = ({ data: rooms }) => {
  try {
    const result = bakeLightingRooms(rooms); scope.postMessage(result, lightingTransferables(result));
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
