import * as THREE from 'three';
import { CEILING_LIGHT } from './lighting';
import { prepareSurfaceLayout } from './lightmap-layout';
import { combineTransfers, type PreparedTransfer } from './light-transfer-cache';
import { connections, ROOM_IDS, type RoomId, type WorldState } from './world';
import type { TransferRequest, TransferResult } from './light-transfer-worker';
import manifest from './light-transfer-manifest.json';

interface FieldBuffer { texture: THREE.DataTexture; key: string }
interface RoomField extends FieldBuffer { scratch: Float32Array; expected: string; buffers: FieldBuffer[] }

/** Precomputed one-hop diffuse lighting; no additional lights or render passes. */
export class LightTransfer {
  enabled = true;
  readonly ready: Promise<void>;
  readonly fields: Record<RoomId, RoomField>;
  readonly uniforms = {
    transferredLight: { value: null as THREE.DataTexture | null },
    transferColor: { value: new THREE.Color(CEILING_LIGHT.color) }, transferGain: { value: 0 },
  };
  revision = 0;
  readonly jobs = 0; // Runtime ray-tracing jobs: all connections ship with the game.
  lastLoadMs = 0;
  cacheSize = 0;
  preparedBytes = 0;
  private readonly prepared = new Map<string, PreparedTransfer>();
  private readonly worker = new Worker(new URL('./light-transfer-worker.ts', import.meta.url), { type: 'module' });
  private state = '';
  private initialized = false;

  constructor(rooms: Record<RoomId, { scene: THREE.Scene }>) {
    this.fields = Object.fromEntries(ROOM_IDS.map(room => {
      const layout = prepareSurfaceLayout(rooms[room].scene), { width, height } = layout;
      if (width !== manifest.atlases[room][0] || height !== manifest.atlases[room][1]) throw new Error('Outdated surface lighting layout. Run npm run bake:lighting.');
      const buffers = Array.from({ length: 2 }, () => {
        const texture = new THREE.DataTexture(new Uint16Array(width * height), width, height, THREE.RedFormat, THREE.HalfFloatType);
        texture.minFilter = texture.magFilter = THREE.LinearFilter; texture.needsUpdate = true;
        return { texture, key: '' };
      });
      return [room, { ...buffers[0], buffers, scratch: new Float32Array(width * height), expected: '' }];
    })) as Record<RoomId, RoomField>;
    this.uniforms.transferredLight.value = this.fields.A.texture;
    this.ready = new Promise<void>((resolve, reject) => {
      this.worker.onerror = event => { this.worker.terminate(); reject(new Error(event.message)); };
      this.worker.onmessage = ({ data }: MessageEvent<TransferResult>) => {
        this.worker.terminate();
        if ('error' in data) { reject(new Error(data.error)); return; }
        this.lastLoadMs = data.elapsedMs; this.cacheSize = data.fields.length;
        for (const field of data.fields) {
          this.prepared.set(field.key, field); this.preparedBytes += field.values.byteLength + field.runs.byteLength;
        }
        this.initialized = true; this.apply(); resolve();
      };
      const request: TransferRequest = { url: new URL(import.meta.env.BASE_URL + manifest.url, document.baseURI).href, sourceHash: manifest.sourceHash };
      this.worker.postMessage(request);
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
        buffer.key = field.expected; buffer.texture.needsUpdate = true;
      }
      field.texture = buffer.texture; field.key = field.expected;
    }
  }
  whenSettled() { return this.ready; }
  bind(room: RoomId, preparing = false) {
    const field = this.fields[room];
    this.uniforms.transferredLight.value = field.texture;
    this.uniforms.transferGain.value = preparing || this.enabled && !!field.key ? 1 : 0;
  }
  install(material: THREE.MeshStandardMaterial) {
    const before = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey();
    material.onBeforeCompile = (shader, renderer) => {
      before(shader, renderer); Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = 'attribute vec2 transferUv; varying vec2 vTransferUv;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vTransferUv = transferUv;`);
      shader.fragmentShader = `varying vec2 vTransferUv;
        uniform sampler2D transferredLight; uniform vec3 transferColor; uniform float transferGain;\n` + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <aomap_fragment>', `
        if (transferGain > 0.) {
          float transported = texture2D(transferredLight, vTransferUv).r;
          reflectedLight.directDiffuse += transferGain * transported * transferColor * BRDF_Lambert(material.diffuseColor);
        }
        #include <aomap_fragment>`);
    };
    material.customProgramCacheKey = () => `${key}:neighbor-surface-lightmap`;
  }
  dispose() { this.worker.terminate(); this.prepared.clear(); for (const field of Object.values(this.fields)) for (const buffer of field.buffers) buffer.texture.dispose(); }
}
