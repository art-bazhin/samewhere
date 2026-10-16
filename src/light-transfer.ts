import * as THREE from 'three';
import { CEILING_LIGHT } from './lighting';
import { TRANSFER_AXES, TRANSFER_GRIDS, TRANSFER_SPACING } from './light-transfer-field';
import { combineTransfers, type PreparedTransfer } from './light-transfer-cache';
import { connections, ROOM_IDS, type RoomId, type WorldState } from './world';
import type { TransferResult } from './light-transfer-worker';

interface FieldBuffer { texture: THREE.Data3DTexture; key: string; min: THREE.Vector3; max: THREE.Vector3 }
interface RoomField extends FieldBuffer { scratch: Float32Array; expected: string; buffers: FieldBuffer[] }

/** Worker-baked one-hop diffuse lighting; no additional lights or render passes. */
export class LightTransfer {
  enabled = true;
  readonly ready: Promise<void>;
  readonly fields = Object.fromEntries(ROOM_IDS.map(room => {
    const grid = TRANSFER_GRIDS[room], { x, y, z } = grid.size;
    const buffers = Array.from({ length: 2 }, () => {
      const texture = new THREE.Data3DTexture(new Uint16Array(x * y * z * TRANSFER_AXES), x, y, z * TRANSFER_AXES);
      texture.format = THREE.RedFormat; texture.type = THREE.HalfFloatType;
      texture.minFilter = texture.magFilter = THREE.LinearFilter; texture.needsUpdate = true;
      return { texture, key: '', min: new THREE.Vector3(), max: new THREE.Vector3(-1, -1, -1) };
    });
    return [room, { ...buffers[0], min: buffers[0].min.clone(), max: buffers[0].max.clone(), buffers,
      scratch: new Float32Array(x * y * z * TRANSFER_AXES), expected: '' }];
  })) as Record<RoomId, RoomField>;
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
  preparedBytes = 0;
  private readonly prepared = new Map<string, PreparedTransfer>();
  private readonly worker = new Worker(new URL('./light-transfer-worker.ts', import.meta.url), { type: 'module' });
  private state = '';
  private initialized = false;

  constructor() {
    this.ready = new Promise<void>((resolve, reject) => {
      this.worker.onerror = event => { console.error('Light transfer worker:', event.message); reject(new Error(event.message)); };
      this.worker.onmessage = ({ data }: MessageEvent<TransferResult>) => {
        this.lastBakeMs = data.elapsedMs; this.cacheSize = data.fields.length;
        for (const field of data.fields) {
          this.prepared.set(field.key, field); this.preparedBytes += field.values.byteLength + field.runs.byteLength;
        }
        this.initialized = true; this.apply(); this.worker.terminate(); resolve();
      };
      this.jobs++; this.worker.postMessage(null);
    });
  }
  sync(world: WorldState) {
    const links = connections(world).flatMap(({ ends }) => [
      { receiver: ends[0], source: ends[1], key: `${ends[0].room}${ends[0].side}<${ends[1].room}${ends[1].side}` },
      { receiver: ends[1], source: ends[0], key: `${ends[1].room}${ends[1].side}<${ends[0].room}${ends[0].side}` },
    ]).sort((a, b) => a.key.localeCompare(b.key));
    const state = links.map(link => link.key).join('|');
    if (state === this.state) return;
    this.state = state;
    const keys = Object.fromEntries(ROOM_IDS.map(room => [room, links.filter(link => link.receiver.room === room).map(link => link.key).join('|')])) as Record<RoomId, string>;
    for (const room of ROOM_IDS) this.fields[room].expected = keys[room];
    this.revision++; if (this.initialized) this.apply();
  }
  private apply() {
    for (const room of ROOM_IDS) {
      const field = this.fields[room];
      if (field.key === field.expected) continue;
      if (!field.expected) { field.key = ''; continue; }
      let buffer = field.buffers.find(buffer => buffer.key === field.expected);
      if (!buffer) {
        // Do not overwrite the texture the GPU sampled in the previous frame.
        // Both storage buffers are allocated and uploaded before play.
        buffer = field.buffers.find(buffer => buffer.texture !== field.texture)!;
        const sources = field.expected.split('|').map(key => this.prepared.get(key)!);
        combineTransfers(sources, field.scratch, buffer.texture.image.data as Uint16Array);
        buffer.min.set(Infinity, Infinity, Infinity); buffer.max.set(-Infinity, -Infinity, -Infinity);
        for (const source of sources) if (source.values.length) for (let axis = 0; axis < 3; axis++) {
          buffer.min.setComponent(axis, Math.min(buffer.min.getComponent(axis), source.min[axis]));
          buffer.max.setComponent(axis, Math.max(buffer.max.getComponent(axis), source.max[axis]));
        }
        if (!Number.isFinite(buffer.min.x)) { buffer.min.set(0, 0, 0); buffer.max.set(-1, -1, -1); }
        buffer.key = field.expected; buffer.texture.needsUpdate = true;
      }
      field.texture = buffer.texture; field.key = field.expected; field.min.copy(buffer.min); field.max.copy(buffer.max);
    }
  }
  whenSettled() { return this.ready; }
  bind(room: RoomId, preparing = false) {
    const grid = TRANSFER_GRIDS[room], field = this.fields[room];
    this.uniforms.transferredLight.value = field.texture;
    this.uniforms.transferOrigin.value.set(grid.origin.x, grid.origin.y, grid.origin.z);
    this.uniforms.transferSize.value.set(grid.size.x, grid.size.y, grid.size.z);
    if (preparing) {
      this.uniforms.transferMin.value.copy(this.uniforms.transferOrigin.value);
      this.uniforms.transferMax.value.set(grid.origin.x + grid.size.x * TRANSFER_SPACING, grid.origin.y + grid.size.y * TRANSFER_SPACING, grid.origin.z + grid.size.z * TRANSFER_SPACING);
    } else { this.uniforms.transferMin.value.copy(field.min); this.uniforms.transferMax.value.copy(field.max); }
    this.uniforms.transferGain.value = preparing || this.enabled && !!field.key ? 1 : 0;
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
  dispose() { this.worker.terminate(); this.prepared.clear(); for (const field of Object.values(this.fields)) for (const buffer of field.buffers) buffer.texture.dispose(); }
}
