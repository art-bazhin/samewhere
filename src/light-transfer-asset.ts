import type { PreparedTransfer } from './light-transfer-cache';
import { ROOM_IDS, ROOMS, type RoomId } from './world';

const MAGIC = 0x544c5753; // SWLT, little endian.
const VERSION = 2;
const HEADER_BYTES = 16;
export type AtlasSizes = Record<RoomId, [number, number]>;
interface StoredField { room: RoomId; key: string; runs: number; values: number }
interface AssetMetadata { sourceHash: string; atlases: AtlasSizes; fields: StoredField[] }
const aligned = (bytes: number) => Math.ceil(bytes / 4) * 4;

/** Lossless float32 payloads, with aligned arrays so loading needs no copies. */
export function encodeTransferAsset(fields: PreparedTransfer[], sourceHash: string, atlases: AtlasSizes) {
  const metadata: AssetMetadata = { sourceHash, atlases, fields: fields.map(field => ({ room: field.room, key: field.key,
    runs: field.runs.length, values: field.values.length })) };
  const json = new TextEncoder().encode(JSON.stringify(metadata));
  const payloadOffset = HEADER_BYTES + aligned(json.byteLength);
  const payloadBytes = fields.reduce((sum, field) => sum + field.runs.byteLength + field.values.byteLength, 0);
  const bytes = new Uint8Array(payloadOffset + payloadBytes), header = new DataView(bytes.buffer);
  header.setUint32(0, MAGIC, true); header.setUint32(4, VERSION, true);
  header.setUint32(8, json.byteLength, true); header.setUint32(12, payloadBytes, true);
  bytes.set(json, HEADER_BYTES);
  let offset = payloadOffset;
  for (const field of fields) for (const array of [field.runs, field.values]) {
    bytes.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), offset); offset += array.byteLength;
  }
  return bytes;
}

/** Validate the scene/version and keep views into one transferable buffer. */
export function decodeTransferAsset(buffer: ArrayBuffer, sourceHash: string): PreparedTransfer[] {
  const invalid = () => new Error('Invalid or outdated prepared lighting. Run npm run bake:lighting.');
  if (buffer.byteLength < HEADER_BYTES) throw invalid();
  const header = new DataView(buffer), jsonBytes = header.getUint32(8, true);
  let offset = HEADER_BYTES + aligned(jsonBytes);
  if (header.getUint32(0, true) !== MAGIC || header.getUint32(4, true) !== VERSION ||
    offset > buffer.byteLength || offset + header.getUint32(12, true) !== buffer.byteLength) throw invalid();
  const metadata = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, HEADER_BYTES, jsonBytes))) as AssetMetadata;
  if (metadata.sourceHash !== sourceHash || !Array.isArray(metadata.fields)) throw invalid();
  for (const room of ROOM_IDS) if (!Array.isArray(metadata.atlases?.[room]) || metadata.atlases[room].length !== 2 ||
    !metadata.atlases[room].every(value => Number.isSafeInteger(value) && value > 0 && value <= 16384)) throw invalid();
  const sockets = ROOM_IDS.flatMap(room => Array.from({ length: ROOMS[room].sides }, (_, side) => ({ room, key: `${room}${side}` })));
  const expected = new Map<string, RoomId>(sockets.flatMap(receiver => sockets.filter(source => source.key !== receiver.key)
    .map(source => [`${receiver.key}<${source.key}`, receiver.room] as const)));
  if (metadata.fields.length !== expected.size) throw invalid();
  const fields: PreparedTransfer[] = [];
  for (const stored of metadata.fields) {
    if (expected.get(stored.key) !== stored.room || !Number.isSafeInteger(stored.runs) || stored.runs < 0 || stored.runs % 2 ||
      !Number.isSafeInteger(stored.values) || stored.values < 0 ||
      offset + (stored.runs + stored.values) * 4 > buffer.byteLength) throw invalid();
    expected.delete(stored.key);
    const runs = new Uint32Array(buffer, offset, stored.runs); offset += runs.byteLength;
    const values = new Float32Array(buffer, offset, stored.values); offset += values.byteLength;
    const [width, height] = metadata.atlases[stored.room], count = width * height;
    let end = 0, samples = 0;
    for (let i = 0; i < runs.length; i += 2) {
      if (!runs[i + 1] || runs[i] < end || runs[i] + runs[i + 1] > count) throw invalid();
      end = runs[i] + runs[i + 1]; samples += runs[i + 1];
    }
    if (samples !== values.length) throw invalid();
    fields.push({ room: stored.room, key: stored.key, runs, values });
  }
  if (offset !== buffer.byteLength) throw invalid();
  return fields;
}
