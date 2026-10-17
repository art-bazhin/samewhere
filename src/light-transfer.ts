import * as THREE from 'three';
import { CEILING_LIGHT } from './lighting';
import { PASSAGE_LIGHT_DEPTH, PASSAGE_LIGHT_WIDTH, prepareSurfaceLayout } from './lightmap-layout';
import { combineTransfers, type PreparedTransfer } from './light-transfer-cache';
import { connections, portalPosition, ROOM_IDS, wallNormal, type RoomId, type WorldState } from './world';
import type { TransferResult } from './light-transfer-worker';

interface FieldBuffer { texture: THREE.DataTexture; key: string }
interface RoomField extends FieldBuffer {
  scratch: Float32Array; expected: string; buffers: FieldBuffer[]; panel: THREE.DataTexture;
  passages: { frame: THREE.Vector4; atlas: THREE.Vector4 }[]; active: number[];
}

/** Startup-baked one-hop diffuse lighting; no additional lights or render passes. */
export class LightTransfer {
  enabled = true;
  readonly ready: Promise<void>;
  readonly fields: Record<RoomId, RoomField>;
  readonly uniforms = {
    transferredLight: { value: null as THREE.DataTexture | null },
    transferColor: { value: new THREE.Color(CEILING_LIGHT.color) }, transferGain: { value: 0 },
    panelLight: { value: null as THREE.DataTexture | null },
    passageCount: { value: 0 },
    passageFrames: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) },
    passageAtlases: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) },
  };
  revision = 0;
  readonly jobs = 1; // One startup job; interactions never submit another bake.
  lastBakeMs = 0;
  cacheSize = 0;
  preparedBytes = 0;
  private readonly prepared = new Map<string, PreparedTransfer>();
  private readonly worker = new Worker(new URL('./light-transfer-worker.ts', import.meta.url), { type: 'module' });
  private state = '';
  private initialized = false;

  constructor(rooms: Record<RoomId, { scene: THREE.Scene }>) {
    this.fields = Object.fromEntries(ROOM_IDS.map(room => {
      const layout = prepareSurfaceLayout(rooms[room].scene, room), { width, height } = layout;
      const buffers = Array.from({ length: 2 }, () => {
        const texture = new THREE.DataTexture(new Uint16Array(width * height * 4), width, height, THREE.RGBAFormat, THREE.HalfFloatType);
        texture.minFilter = texture.magFilter = THREE.LinearFilter; texture.needsUpdate = true;
        return { texture, key: '' };
      });
      const panel = new THREE.DataTexture(new Uint16Array(width * height * 4), width, height, THREE.RGBAFormat, THREE.HalfFloatType);
      panel.minFilter = panel.magFilter = THREE.LinearFilter; panel.needsUpdate = true;
      const passages: RoomField['passages'] = [];
      for (const chart of layout.charts) if (chart.passage !== undefined) {
        const p = portalPosition(room, chart.passage), n = wallNormal(room, chart.passage);
        passages[chart.passage] = { frame: new THREE.Vector4(n.x, n.z, p.x * n.x + p.z * n.z, -n.z * p.x + n.x * p.z),
          atlas: new THREE.Vector4((chart.x + 1.5 - chart.min.x / chart.step.x) / width, (chart.y + 1.5 - chart.min.y / chart.step.y) / height,
            1 / (chart.step.x * width), 1 / (chart.step.y * height)) };
      }
      const field: RoomField = { ...buffers[0], buffers, scratch: new Float32Array(width * height * 4), expected: '', panel, passages, active: [] };
      return [room, field];
    })) as Record<RoomId, RoomField>;
    this.uniforms.transferredLight.value = this.fields.A.texture;
    this.uniforms.panelLight.value = this.fields.A.panel;
    this.ready = new Promise<void>((resolve, reject) => {
      this.worker.onerror = event => { this.worker.terminate(); reject(new Error(event.message)); };
      this.worker.onmessage = ({ data }: MessageEvent<TransferResult>) => {
        this.worker.terminate();
        if ('error' in data) { reject(new Error(data.error)); return; }
        for (const room of ROOM_IDS) {
          const image = this.fields[room].texture.image;
          if (image.width !== data.atlases[room][0] || image.height !== data.atlases[room][1]) {
            reject(new Error(`Lighting layout mismatch in room ${room}`)); return;
          }
          this.fields[room].panel.image.data = data.panels[room]; this.fields[room].panel.needsUpdate = true;
        }
        this.lastBakeMs = data.elapsedMs; this.cacheSize = data.fields.length;
        for (const field of data.fields) {
          this.prepared.set(field.key, field); this.preparedBytes += field.values.byteLength + field.runs.byteLength;
        }
        this.initialized = true; this.apply(); resolve();
      };
      this.worker.postMessage(null);
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
    for (const room of ROOM_IDS) {
      this.fields[room].expected = keys[room];
      this.fields[room].active = links.filter(link => link.receiver.room === room).map(link => link.receiver.side);
    }
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
    this.uniforms.panelLight.value = field.panel;
    this.uniforms.transferGain.value = preparing || this.enabled && !!field.key ? 1 : 0;
    this.uniforms.passageCount.value = this.enabled && field.key ? field.active.length : 0;
    field.active.forEach((side, index) => {
      this.uniforms.passageFrames.value[index].copy(field.passages[side].frame);
      this.uniforms.passageAtlases.value[index].copy(field.passages[side].atlas);
    });
  }
  install(material: THREE.MeshStandardMaterial) {
    const before = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey();
    material.onBeforeCompile = (shader, renderer) => {
      before(shader, renderer); Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = 'attribute vec2 transferUv; varying vec2 vTransferUv;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vTransferUv = transferUv;
        #ifdef PORTAL_SURFACE_PADDING
          vTransferUv += portalLightUvOffset;
        #endif`);
      shader.fragmentShader = `varying vec2 vTransferUv;
        uniform sampler2D transferredLight; uniform vec3 transferColor; uniform float transferGain;
        uniform sampler2D panelLight;
        uniform int passageCount; uniform vec4 passageFrames[4]; uniform vec4 passageAtlases[4];\n` + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <aomap_fragment>', `
        vec4 roomLight = texture2D(panelLight, vTransferUv);
        #ifdef SOCKET_BALL_SHADOW
          roomLight.r *= socketVisibility.x;
          roomLight.gba *= socketVisibility.y;
        #endif
        reflectedLight.directDiffuse += (roomLight.r * transferColor + roomLight.gba) * BRDF_Lambert(material.diffuseColor);
        if (transferGain > 0.) {
          vec4 transported = texture2D(transferredLight, vTransferUv);
          reflectedLight.directDiffuse += transferGain * (transported.r * transferColor + transported.gba) * BRDF_Lambert(material.diffuseColor);
        }
        #ifdef FLOOR_PASSAGE_LIGHTING
          for (int passage = 0; passage < 4; passage++) {
            if (passage >= passageCount) break;
            vec4 frame = passageFrames[passage], atlas = passageAtlases[passage];
            float depth = frame.z - dot(contactPosition, frame.xy);
            float lateral = dot(contactPosition, vec2(-frame.y, frame.x)) - frame.w;
            if (depth < -.0001 || depth >= ${PASSAGE_LIGHT_DEPTH.toFixed(4)} || abs(lateral) >= ${PASSAGE_LIGHT_WIDTH.toFixed(4)}) continue;
            float blend = (1. - smoothstep(.15, ${PASSAGE_LIGHT_DEPTH.toFixed(4)}, depth)) * (1. - smoothstep(.9, ${PASSAGE_LIGHT_WIDTH.toFixed(4)}, abs(lateral)));
            vec2 uv = atlas.xy + vec2(lateral, max(0., depth)) * atlas.zw;
            vec4 joined = texture2D(panelLight, uv) + texture2D(transferredLight, uv);
            vec3 diffuse = (joined.r * transferColor + joined.gba) * BRDF_Lambert(material.diffuseColor);
            reflectedLight.directDiffuse = mix(reflectedLight.directDiffuse, diffuse, blend);
          }
        #endif
        #include <aomap_fragment>`);
    };
    material.customProgramCacheKey = () => `${key}:neighbor-surface-lightmap`;
  }
  dispose() {
    this.worker.terminate(); this.prepared.clear();
    for (const field of Object.values(this.fields)) { field.panel.dispose(); for (const buffer of field.buffers) buffer.texture.dispose(); }
  }
}
