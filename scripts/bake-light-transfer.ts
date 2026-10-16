import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { encodeTransferAsset, type AtlasSizes } from '../src/light-transfer-asset';
import { compressTransfer, type PreparedTransfer } from '../src/light-transfer-cache';
import { bakingLayout, surfaceSamples } from '../src/lightmap-layout';
import { bakeSurfaceTransfer } from '../src/surface-lightmap';
import { ROOM_IDS, ROOMS } from '../src/world';

const root = new URL('../', import.meta.url), manifestURL = new URL('src/light-transfer-manifest.json', root);
const inputs = ['src/geometry.ts', 'src/world.ts', 'src/lighting.ts', 'src/room-visual.ts', 'src/materials.ts',
  'src/lightmap-layout.ts', 'src/light-transfer-sampling.ts', 'src/surface-lightmap.ts',
  'src/light-transfer-cache.ts', 'src/light-transfer-asset.ts', 'scripts/bake-light-transfer.ts'];

export async function lightingSourceHash() {
  const hash = createHash('sha256');
  for (const path of inputs) { hash.update(path); hash.update('\0'); hash.update(await readFile(new URL(path, root))); hash.update('\0'); }
  return hash.digest('hex');
}

async function prepare() {
  const sourceHash = await lightingSourceHash(), force = process.argv.includes('--force'), check = process.argv.includes('--check');
  try {
    const manifest = JSON.parse(await readFile(manifestURL, 'utf8'));
    if (!force && manifest.sourceHash === sourceHash &&
      (await stat(new URL(`public/${manifest.url}`, root))).size === manifest.compressedBytes) {
      console.log(`Prepared lighting is current (${manifest.fields} connections).`); return;
    }
  } catch { /* Missing/stale data is generated below. */ }
  if (check) throw new Error('Prepared lighting is missing or outdated. Run npm run bake:lighting.');
  const start = performance.now(), fields: PreparedTransfer[] = [];
  const layouts = Object.fromEntries(ROOM_IDS.map(room => { const layout = bakingLayout(room); return [room, { ...layout, samples: surfaceSamples(layout) }]; })) as Record<typeof ROOM_IDS[number], ReturnType<typeof bakingLayout> & { samples: ReturnType<typeof surfaceSamples> }>;
  const atlases = Object.fromEntries(ROOM_IDS.map(room => [room, [layouts[room].width, layouts[room].height]])) as AtlasSizes;
  const sockets = ROOM_IDS.flatMap(room => Array.from({ length: ROOMS[room].sides }, (_, side) => ({ room, side })));
  for (const receiver of sockets) for (const source of sockets) {
    if (receiver.room === source.room && receiver.side === source.side) continue;
    const layout = layouts[receiver.room];
    fields.push(compressTransfer(receiver.room, `${receiver.room}${receiver.side}<${source.room}${source.side}`,
      bakeSurfaceTransfer(receiver, source, layout.samples, layout.width * layout.height)));
  }
  const binary = encodeTransferAsset(fields, sourceHash, atlases), compressed = gzipSync(binary, { level: 9 });
  const directory = new URL('public/lighting/', root), filename = `transfer-${sourceHash.slice(0, 16)}.bin.gz`;
  await mkdir(directory, { recursive: true });
  await writeFile(new URL(`${filename}.tmp`, directory), compressed);
  await rename(new URL(`${filename}.tmp`, directory), new URL(filename, directory));
  const manifest = { sourceHash, url: `lighting/${filename}`, fields: fields.length, atlases, compressedBytes: compressed.byteLength, uncompressedBytes: binary.byteLength };
  await writeFile(new URL(`${manifestURL.href}.tmp`), JSON.stringify(manifest, null, 2) + '\n');
  await rename(new URL(`${manifestURL.href}.tmp`), manifestURL);
  for (const old of await readdir(directory)) if (/^transfer-[0-9a-f]{16}\.bin\.gz$/.test(old) && old !== filename) await unlink(new URL(old, directory));
  console.log(`Saved ${fields.length} connections: ${(compressed.byteLength / 1048576).toFixed(2)} MiB compressed, ${(binary.byteLength / 1048576).toFixed(2)} MiB decoded, ${((performance.now() - start) / 1000).toFixed(2)} s.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await prepare();
