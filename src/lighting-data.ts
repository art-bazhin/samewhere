import type { BakedLighting } from './light-transfer-bake';
import { ROOM_IDS, ROOMS, type RoomId } from './world';
import { LIGHTMAP_CHANNELS, PANEL_LIGHTMAP_CHANNELS } from './directional-lightmap';

interface Section { offset: number; length: number }
interface Header {
  revision: string; elapsedMs: number; atlases: BakedLighting['atlases']; panels: Record<RoomId, Section>;
  fields: { room: RoomId; key: string; channels: number; runs: Section; values: Section }[];
}
const MAGIC = 'SWLIGHT3', PREFIX = 12;

/** Lossless binary storage: half-float panels, float32 transfers and uint32 runs. */
export function encodeLighting(data: BakedLighting, revision: string): Uint8Array {
  let offset = 0;
  const chunks: Uint8Array[] = [];
  const append = (array: Uint16Array | Uint32Array | Float32Array): Section => {
    const section = { offset, length: array.length };
    chunks.push(new Uint8Array(array.buffer, array.byteOffset, array.byteLength)); offset += array.byteLength;
    return section;
  };
  const panels = Object.fromEntries(ROOM_IDS.map(room => [room, append(data.panels[room])])) as Header['panels'];
  const fields = [...data.fields].sort((a, b) => a.key.localeCompare(b.key)).map(field => ({
    room: field.room, key: field.key, channels: field.channels, runs: append(field.runs), values: append(field.values),
  }));
  const header = new TextEncoder().encode(JSON.stringify({ revision, elapsedMs: data.elapsedMs, atlases: data.atlases, panels, fields } satisfies Header));
  const start = PREFIX + Math.ceil(header.length / 4) * 4, result = new Uint8Array(start + offset);
  result.set(new TextEncoder().encode(MAGIC)); new DataView(result.buffer).setUint32(8, header.length, true);
  result.set(header, PREFIX); offset = start;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

/** Arrays share the downloaded buffer; loading never recomputes illumination. */
export function decodeLighting(buffer: ArrayBuffer, revision: string): BakedLighting {
  if (buffer.byteLength < PREFIX || new TextDecoder().decode(new Uint8Array(buffer, 0, 8)) !== MAGIC) throw new Error('Invalid lighting file');
  const length = new DataView(buffer).getUint32(8, true), start = PREFIX + Math.ceil(length / 4) * 4;
  if (length > 1024 * 1024 || start > buffer.byteLength) throw new Error('Invalid lighting header');
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, PREFIX, length))) as Header;
  if (header.revision !== revision) throw new Error('Lighting revision mismatch');
  const view = <T extends Uint16Array | Uint32Array | Float32Array>(section: Section,
    Type: { new(buffer: ArrayBuffer, offset: number, length: number): T; BYTES_PER_ELEMENT: number }): T => {
    if (!section || !Number.isSafeInteger(section.offset) || !Number.isSafeInteger(section.length) || section.offset < 0 || section.length < 0 ||
      section.offset % Type.BYTES_PER_ELEMENT || start + section.offset + section.length * Type.BYTES_PER_ELEMENT > buffer.byteLength) throw new Error('Invalid lighting section');
    return new Type(buffer, start + section.offset, section.length);
  };
  const panels = Object.fromEntries(ROOM_IDS.map(room => {
    const size = header.atlases?.[room], panel = view(header.panels?.[room], Uint16Array);
    if (!size || !size.every(value => Number.isInteger(value) && value > 0) || size.length !== 2 || panel.length !== size[0] * size[1] * PANEL_LIGHTMAP_CHANNELS) throw new Error(`Invalid lighting atlas: ${room}`);
    return [room, panel];
  })) as BakedLighting['panels'];
  const sockets = ROOM_IDS.flatMap(room => Array.from({ length: ROOMS[room].sides }, (_, side) => `${room}${side}`));
  const expected = new Set(sockets.flatMap(receiver => sockets.filter(source => source !== receiver).map(source => `${receiver}<${source}`)));
  const fields = header.fields.map(field => {
    if (!expected.delete(field.key) || !field.key.startsWith(field.room) || !ROOM_IDS.includes(field.room) || field.channels !== 4) throw new Error('Invalid lighting connection');
    const runs = view(field.runs, Uint32Array), values = view(field.values, Float32Array);
    let count = 0, end = 0;
    for (let i = 0; i < runs.length; i += 2) {
      if (runs[i] < end || !runs[i + 1]) throw new Error('Invalid lighting runs');
      count += runs[i + 1]; end = runs[i] + runs[i + 1];
    }
    const [width, height] = header.atlases[field.room];
    if (runs.length % 2 || count !== values.length || end > width * height * LIGHTMAP_CHANNELS) throw new Error('Invalid lighting samples');
    return { room: field.room, key: field.key, channels: field.channels, runs, values };
  });
  if (expected.size) throw new Error('Missing lighting connections');
  return { elapsedMs: header.elapsedMs, atlases: header.atlases, panels, fields };
}
