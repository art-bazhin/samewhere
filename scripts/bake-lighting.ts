import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';
import { bakeLightingParallel } from './lighting-workers';
import { encodeLighting } from '../src/lighting-data';

const [target, revision, quality = 'full'] = process.argv.slice(2);
if (!target || !revision) throw new Error('Expected lighting output path and source revision');
if (quality !== 'draft' && quality !== 'full') throw new Error(`Unknown lighting quality: ${quality}`);
const data = await bakeLightingParallel(quality), binary = encodeLighting(data, revision);
const [br, gz] = await Promise.all([
  promisify(brotliCompress)(binary, { params: { [constants.BROTLI_PARAM_QUALITY]: quality === 'full' ? 11 : 4 } }),
  promisify(gzip)(binary, { level: quality === 'full' ? 9 : 1 }),
]);
await mkdir(dirname(target), { recursive: true });
for (const [suffix, bytes] of [['', binary], ['.br', br], ['.gz', gz]] as const) {
  const path = target + suffix, temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, bytes); await rename(temporary, path);
}
console.log(`[lighting] ${quality}; ${data.fields.length} connections; bake ${(data.elapsedMs / 1000).toFixed(1)}s; binary ${binary.byteLength} B; Brotli ${br.byteLength} B`);
