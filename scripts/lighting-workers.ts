import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { ROOM_IDS } from '../src/world';
import type { LightingBakeQuality } from '../src/panel-light-bake';
import type { BakedLighting, BakedRoomLighting } from '../src/light-transfer-bake';
export { bakeLightingRooms } from '../src/light-transfer-bake';

/** Keep the browser responsive while independent receiving rooms bake. */
export async function bakeLightingParallel(quality: LightingBakeQuality): Promise<BakedLighting> {
  const start = performance.now(), count = Math.min(ROOM_IDS.length, Math.max(1, availableParallelism() - 2));
  const batches = Array.from({ length: count }, () => [] as typeof ROOM_IDS);
  ROOM_IDS.forEach((room, i) => batches[i % count].push(room));
  const workers: Worker[] = [];
  try {
    const results = await Promise.all(batches.map(rooms => new Promise<BakedRoomLighting>((resolve, reject) => {
      const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        import('tsx/esm/api').then(({ tsImport }) => tsImport(workerData.module, workerData.module))
          .then(({ bakeLightingRooms }) => parentPort.postMessage(bakeLightingRooms(workerData.rooms, workerData.quality)));
      `, { eval: true, execArgv: [], workerData: { module: import.meta.url, rooms, quality } });
      workers.push(worker);
      worker.once('message', resolve); worker.once('error', reject);
      worker.once('exit', code => { if (code !== 0) reject(new Error(`Lighting worker exited with code ${code}`)); });
    })));
    return { elapsedMs: performance.now() - start, fields: results.flatMap(result => result.fields), joined: results.find(result => result.joined)?.joined,
      atlases: Object.assign({}, ...results.map(result => result.atlases)), panels: Object.assign({}, ...results.map(result => result.panels)) };
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
}
