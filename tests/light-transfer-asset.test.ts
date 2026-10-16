import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { lightingSourceHash } from '../scripts/bake-light-transfer';
import { decodeTransferAsset, encodeTransferAsset } from '../src/light-transfer-asset';
import { compressTransfer } from '../src/light-transfer-cache';
import { bakingLayout, surfaceSamples } from '../src/lightmap-layout';
import { bakeSurfaceTransfer } from '../src/surface-lightmap';
import type { AtlasSizes } from '../src/light-transfer-asset';
import manifest from '../src/light-transfer-manifest.json';

const compressed = await readFile(new URL(`../public/${manifest.url}`, import.meta.url));
const binary = Uint8Array.from(gunzipSync(compressed));
const fields = decodeTransferAsset(binary.buffer, manifest.sourceHash);

test('the saved lighting matches the current geometry, lamps and bake algorithm', async () => {
  assert.equal(manifest.sourceHash, await lightingSourceHash());
  assert.equal(compressed.byteLength, manifest.compressedBytes); assert.equal(binary.byteLength, manifest.uncompressedBytes);
  assert.ok(manifest.compressedBytes < 2 * 1024 * 1024); assert.ok(binary.byteLength < 4 * 1024 * 1024);
  assert.equal(fields.length, 812); assert.equal(fields.length, manifest.fields);
  assert.equal(new Set(fields.map(field => field.key)).size, fields.length);
  for (const field of fields) { assert.equal(field.runs.buffer, binary.buffer); assert.equal(field.values.buffer, binary.buffer); }
});

test('saved surface texels match fresh ray tracing bit for bit, including concave rooms', () => {
  for (const [receiver, source] of [
    [{ room: 'A', side: 0 }, { room: 'G', side: 0 }],
    [{ room: 'G', side: 3 }, { room: 'A', side: 1 }],
    [{ room: 'E', side: 2 }, { room: 'F', side: 3 }],
  ] as const) {
    const key = `${receiver.room}${receiver.side}<${source.room}${source.side}`;
    const layout = bakingLayout(receiver.room);
    assert.deepEqual([layout.width, layout.height], manifest.atlases[receiver.room]);
    assert.deepEqual(fields.find(field => field.key === key), compressTransfer(receiver.room, key, bakeSurfaceTransfer(receiver, source, surfaceSamples(layout), layout.width * layout.height)));
  }
});

test('all saved arrays survive a binary round trip without loss', () => {
  assert.deepEqual(encodeTransferAsset(fields, manifest.sourceHash, manifest.atlases as AtlasSizes), binary);
});

test('invalid versions, stale data, truncation and out-of-bounds spans are rejected', () => {
  assert.throws(() => decodeTransferAsset(binary.buffer, 'different-scene'), /outdated/);
  assert.throws(() => decodeTransferAsset(binary.buffer.slice(0, -4), manifest.sourceHash), /Invalid/);
  assert.throws(() => decodeTransferAsset(new ArrayBuffer(4), manifest.sourceHash), /Invalid/);
  const badVersion = binary.slice(); new DataView(badVersion.buffer).setUint32(4, 99, true);
  assert.throws(() => decodeTransferAsset(badVersion.buffer, manifest.sourceHash), /Invalid/);
  const badSpan = binary.slice(), firstNonempty = fields.find(field => field.runs.length)!;
  new DataView(badSpan.buffer).setUint32(firstNonempty.runs.byteOffset, 0xffffffff, true);
  assert.throws(() => decodeTransferAsset(badSpan.buffer, manifest.sourceHash), /Invalid/);
});
