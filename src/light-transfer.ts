import * as THREE from 'three';
import { CEILING_LIGHT } from './lighting';
import { TRANSFER_AXES, TRANSFER_GRIDS, TRANSFER_SPACING } from './light-transfer-field';
import { connections, ROOM_IDS, type RoomId, type WorldState } from './world';
import type { TransferRequest, TransferResult } from './light-transfer-worker';

type CachedField = TransferResult['fields'][number] & { links: string[] };
const MAX_SNAPSHOTS = 32;
const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024;

/** Worker-baked one-hop diffuse lighting; no additional lights or render passes. */
export class LightTransfer {
  enabled = true;
  readonly ready: Promise<void>;
  readonly fields = Object.fromEntries(ROOM_IDS.map(room => {
    const grid = TRANSFER_GRIDS[room], { x, y, z } = grid.size;
    const texture = new THREE.Data3DTexture(new Uint16Array(x * y * z * TRANSFER_AXES), x, y, z * TRANSFER_AXES);
    texture.format = THREE.RedFormat; texture.type = THREE.HalfFloatType;
    texture.minFilter = texture.magFilter = THREE.LinearFilter; texture.needsUpdate = true;
    return [room, { texture, key: '', expected: '', min: new THREE.Vector3(), max: new THREE.Vector3(-1, -1, -1) }];
  })) as Record<RoomId, { texture: THREE.Data3DTexture; key: string; expected: string; min: THREE.Vector3; max: THREE.Vector3 }>;
  readonly uniforms = {
    transferredLight: { value: this.fields.A.texture },
    transferOrigin: { value: new THREE.Vector3() }, transferSize: { value: new THREE.Vector3(1, 1, 1) },
    transferColor: { value: new THREE.Color(CEILING_LIGHT.color) }, transferGain: { value: 0 },
    transferMin: { value: new THREE.Vector3() }, transferMax: { value: new THREE.Vector3(-1, -1, -1) },
  };
  revision = 0;
  jobs = 0;
  lastBakeMs = 0;
  cacheSize = 0;
  snapshotBytes = 0;
  private readonly snapshots = new Map<string, CachedField>();
  private readonly worker = new Worker(new URL('./light-transfer-worker.ts', import.meta.url), { type: 'module' });
  private request: Omit<TransferRequest, 'known'> | null = null;
  private busy = false;
  private state = '';
  private waiters: (() => void)[] = [];
  private resolveReady!: () => void;

  constructor() {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.worker.onerror = event => { console.error('Light transfer worker:', event.message); reject(new Error(event.message)); };
    });
    this.worker.onmessage = ({ data }: MessageEvent<TransferResult>) => {
      this.busy = false; this.lastBakeMs = data.elapsedMs; this.cacheSize = data.cacheSize;
      for (const result of data.fields) {
        const previous = this.snapshots.get(result.key);
        if (previous) this.snapshotBytes -= previous.data.byteLength;
        this.snapshots.delete(result.key);
        this.snapshots.set(result.key, { ...result, links: result.key.split('|') }); this.snapshotBytes += result.data.byteLength;
      }
      // Old replies still contain reusable static contributions, but only fields
      // made entirely of currently open passages can become visible.
      this.applyCached(); this.trimCache();
      if (data.revision !== this.revision) { this.dispatch(); return; }
      this.resolveReady(); this.waiters.splice(0).forEach(resolve => resolve());
    };
  }
  sync(world: WorldState) {
    const links = connections(world).flatMap(({ ends }) => [
      { receiver: ends[0], source: ends[1], key: `${ends[0].room}${ends[0].side}<${ends[1].room}${ends[1].side}` },
      { receiver: ends[1], source: ends[0], key: `${ends[1].room}${ends[1].side}<${ends[0].room}${ends[0].side}` },
    ]).sort((a, b) => a.key.localeCompare(b.key));
    const state = links.map(link => link.key).join('|');
    if (this.request && state === this.state) return;
    this.state = state;
    const keys = Object.fromEntries(ROOM_IDS.map(room => [room, links.filter(link => link.receiver.room === room).map(link => link.key).join('|')])) as Record<RoomId, string>;
    for (const room of ROOM_IDS) this.fields[room].expected = keys[room];
    this.applyCached();
    this.request = { revision: ++this.revision, links, keys }; this.dispatch();
  }
  private dispatch() {
    if (this.busy || !this.request) return;
    this.busy = true; this.jobs++; this.worker.postMessage({ ...this.request, known: [...this.snapshots.keys()] } satisfies TransferRequest);
  }
  private applyCached() {
    for (const room of ROOM_IDS) {
      const field = this.fields[room];
      if (field.key === field.expected) continue;
      const expected = field.expected.split('|');
      const surviving = field.key.split('|').filter(link => link && expected.includes(link));
      let best = this.snapshots.get(field.expected);
      if (!best && field.expected) for (const snapshot of this.snapshots.values()) {
        if (snapshot.room === room && (!best || snapshot.links.length > best.links.length)
          && snapshot.links.every(link => expected.includes(link)) && surviving.every(link => snapshot.links.includes(link))) best = snapshot;
      }
      if (!best) { field.key = ''; continue; }
      // Missing new lights do not switch off already prepared, surviving lights.
      // A closed passage is never kept in the selected subset.
      if (field.key !== best.key) {
        if (field.texture.image.data !== best.data) { field.texture.image.data = best.data; field.texture.needsUpdate = true; }
        field.key = best.key;
        field.min.fromArray(best.min); field.max.fromArray(best.max);
      }
      this.snapshots.delete(best.key); this.snapshots.set(best.key, best);
    }
  }
  private trimCache() {
    const active = new Set(Object.values(this.fields).flatMap(field => field.expected.split('|').filter(Boolean)));
    while (this.snapshots.size > MAX_SNAPSHOTS || this.snapshotBytes > MAX_SNAPSHOT_BYTES) {
      // Keep all subsets of the live connections, not just their full sum. They
      // must remain available even after a long sequence of other ball moves.
      const oldest = [...this.snapshots.values()].find(snapshot => !snapshot.links.every(link => active.has(link)));
      if (!oldest) break;
      this.snapshotBytes -= oldest.data.byteLength; this.snapshots.delete(oldest.key);
    }
  }
  whenSettled() { return this.busy ? new Promise<void>(resolve => this.waiters.push(resolve)) : Promise.resolve(); }
  bind(room: RoomId) {
    const grid = TRANSFER_GRIDS[room], field = this.fields[room];
    this.uniforms.transferredLight.value = field.texture;
    this.uniforms.transferOrigin.value.set(grid.origin.x, grid.origin.y, grid.origin.z);
    this.uniforms.transferSize.value.set(grid.size.x, grid.size.y, grid.size.z);
    this.uniforms.transferMin.value.copy(field.min); this.uniforms.transferMax.value.copy(field.max);
    this.uniforms.transferGain.value = this.enabled && !!field.key ? 1 : 0;
  }
  install(material: THREE.MeshStandardMaterial) {
    const before = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey();
    material.onBeforeCompile = (shader, renderer) => {
      before(shader, renderer); Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = 'varying vec3 transferPosition, transferSurfaceNormal;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        transferPosition = (modelMatrix * vec4(transformed, 1.)).xyz;
        transferSurfaceNormal = inverseTransformDirection(transformedNormal, viewMatrix);`);
      shader.fragmentShader = `varying vec3 transferPosition, transferSurfaceNormal;
        uniform highp sampler3D transferredLight;
        uniform vec3 transferOrigin, transferSize, transferColor, transferMin, transferMax; uniform float transferGain;
        float transferSample(vec3 grid, float axis) {
          vec3 uv = (clamp(grid, vec3(0.), transferSize - 1.) + .5) / transferSize;
          uv.z = (uv.z + axis) / ${TRANSFER_AXES.toFixed(1)};
          return texture(transferredLight, uv).r;
        }\n` + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <aomap_fragment>', `
        if (transferGain > 0. && all(greaterThanEqual(transferPosition, transferMin)) && all(lessThanEqual(transferPosition, transferMax))) {
          vec3 transferNormal = normalize(transferSurfaceNormal);
          vec3 grid = (transferPosition - transferOrigin) / ${TRANSFER_SPACING.toFixed(4)};
          float transported = 0.;
          if (abs(transferNormal.x) > .001) transported += abs(transferNormal.x) * transferSample(grid, transferNormal.x >= 0. ? 0. : 1.);
          if (abs(transferNormal.y) > .001) transported += abs(transferNormal.y) * transferSample(grid, transferNormal.y >= 0. ? 2. : 3.);
          if (abs(transferNormal.z) > .001) transported += abs(transferNormal.z) * transferSample(grid, transferNormal.z >= 0. ? 4. : 5.);
          reflectedLight.directDiffuse += transferGain * transported * transferColor * BRDF_Lambert(material.diffuseColor);
        }
        #include <aomap_fragment>`);
    };
    material.customProgramCacheKey = () => `${key}:neighbor-diffuse`;
  }
  dispose() { this.worker.terminate(); for (const field of Object.values(this.fields)) field.texture.dispose(); }
}
