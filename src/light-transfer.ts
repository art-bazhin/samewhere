import * as THREE from 'three';
import { CEILING_LIGHT, NORMAL_RESPONSE_CURVE } from './lighting';
import { PASSAGE_LIGHT_DEPTH, PASSAGE_LIGHT_WIDTH, prepareSurfaceLayout } from './lightmap-layout';
import { combineTransfers, type PreparedTransfer } from './light-transfer-cache';
import { connections, portalPosition, ROOM_IDS, wallNormal, type RoomId, type WorldState } from './world';
import lightingUrl, { revision as lightingRevision } from 'virtual:samewhere-lighting';
import { decodeLighting } from './lighting-data';
import { SURFACE_LIGHTMAP_FILTER } from './lightmap-filter';
import { DirectLight } from './direct-light';
import { DIRECTIONAL_LIGHTMAP_SHADER, LIGHTMAP_CHANNELS, PANEL_LIGHTMAP_CHANNELS } from './directional-lightmap';
import { fetchLoadingBuffer, type LoadingProgress } from './loading-progress';

interface FieldBuffer { texture: THREE.DataTexture; key: string }
interface RoomField extends FieldBuffer {
  scratch: Float32Array; expected: string; buffers: FieldBuffer[]; panel: THREE.DataTexture;
  passages: { frame: THREE.Vector4; atlas: THREE.Vector4 }[]; active: number[];
}

/** Build-baked diffuse bounce and separately cached, detailed direct light. */
export class LightTransfer {
  enabled = true;
  readonly ready: Promise<void>;
  readonly fields: Record<RoomId, RoomField>;
  readonly direct: DirectLight;
  readonly uniforms = {
    transferredLight: { value: null as THREE.DataTexture | null },
    transferColor: { value: new THREE.Color(CEILING_LIGHT.color) }, transferGain: { value: 0 },
    bounceGain: { value: 1 },
    normalResponseCurve: { value: NORMAL_RESPONSE_CURVE },
    panelLight: { value: null as THREE.DataTexture | null },
    lightmapSize: { value: new THREE.Vector2() },
    passageCount: { value: 0 },
    passageFrames: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) },
    passageAtlases: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) },
    passageDirectAtlases: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) },
    passageLocalAtlases: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) },
  };
  revision = 0;
  readonly jobs = 0; // All CPU lighting is prepared by the build.
  lastBakeMs = 0;
  loadMs = 0;
  cacheSize = 0;
  preparedBytes = 0;
  private readonly prepared = new Map<string, PreparedTransfer>();
  private readonly download = new AbortController();
  private state = '';
  private initialized = false;

  constructor(rooms: Record<RoomId, { scene: THREE.Scene }>, renderer: THREE.WebGLRenderer, loading?: LoadingProgress) {
    this.direct = new DirectLight(renderer, rooms);
    this.fields = Object.fromEntries(ROOM_IDS.map(room => {
      const layout = prepareSurfaceLayout(rooms[room].scene, room), { width, height } = layout;
      const storage = (channels = LIGHTMAP_CHANNELS) => {
        // Stack both planes in one texture: seven-light rooms already approach
        // WebGL's fragment sampler limit, so directions must not add samplers.
        const texture = new THREE.DataTexture(new Uint16Array(width * height * channels), width, height * channels / 4, THREE.RGBAFormat, THREE.HalfFloatType);
        texture.minFilter = texture.magFilter = THREE.LinearFilter; texture.needsUpdate = true;
        return { texture, key: '' };
      };
      const buffers = Array.from({ length: 2 }, () => storage()), panel = storage(PANEL_LIGHTMAP_CHANNELS);
      const passages: RoomField['passages'] = [];
      for (const chart of layout.charts) if (chart.passage !== undefined) {
        const p = portalPosition(room, chart.passage), n = wallNormal(room, chart.passage);
        passages[chart.passage] = { frame: new THREE.Vector4(n.x, n.z, p.x * n.x + p.z * n.z, -n.z * p.x + n.x * p.z),
          atlas: new THREE.Vector4((chart.x + 1.5 - chart.min.x / chart.step.x) / width, (chart.y + 1.5 - chart.min.y / chart.step.y) / height,
            1 / (chart.step.x * width), 1 / (chart.step.y * height)) };
      }
      const field: RoomField = { ...buffers[0], buffers, scratch: new Float32Array(width * height * LIGHTMAP_CHANNELS), expected: '',
        panel: panel.texture, passages, active: [] };
      return [room, field];
    })) as Record<RoomId, RoomField>;
    this.uniforms.transferredLight.value = this.fields.A.texture;
    this.uniforms.panelLight.value = this.fields.A.panel;
    this.uniforms.lightmapSize.value.set(this.fields.A.texture.image.width, this.fields.A.texture.image.height / 2);
    this.ready = this.load(loading);
  }
  private async load(loading?: LoadingProgress) {
    const downloaded = loading?.task(), prepared = loading?.task(), start = performance.now();
    const data = decodeLighting(await fetchLoadingBuffer(lightingUrl, this.download.signal, downloaded), lightingRevision);
    for (const room of ROOM_IDS) {
      const image = this.fields[room].texture.image;
      if (image.width !== data.atlases[room][0] || image.height !== data.atlases[room][1] * 2) throw new Error(`Lighting layout mismatch in room ${room}`);
      this.fields[room].panel.image.data = data.panels[room]; this.fields[room].panel.needsUpdate = true;
    }
    this.lastBakeMs = data.elapsedMs; this.cacheSize = data.fields.length;
    for (const field of data.fields) {
      this.prepared.set(field.key, field); this.preparedBytes += field.values.byteLength + field.runs.byteLength;
    }
    this.initialized = true; this.apply(); this.loadMs = performance.now() - start;
    prepared?.();
  }
  sync(world: WorldState) {
    this.direct.sync(world);
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
    this.direct.bind(room, this.enabled);
    this.uniforms.transferredLight.value = field.texture;
    this.uniforms.panelLight.value = field.panel;
    this.uniforms.lightmapSize.value.set(field.texture.image.width, field.texture.image.height / 2);
    this.uniforms.transferGain.value = preparing || this.enabled && !!field.key ? 1 : 0;
    this.uniforms.passageCount.value = this.enabled && field.key ? field.active.length : 0;
    field.active.forEach((side, index) => {
      this.uniforms.passageFrames.value[index].copy(field.passages[side].frame);
      this.uniforms.passageAtlases.value[index].copy(field.passages[side].atlas);
      this.uniforms.passageDirectAtlases.value[index].copy(this.direct.surfaces.fields[room].passages[side]);
      this.uniforms.passageLocalAtlases.value[index].copy(this.direct.surfaces.fields[room].localPassages[side]);
    });
  }
  install(material: THREE.MeshStandardMaterial) {
    const before = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey();
    material.onBeforeCompile = (shader, renderer) => {
      before(shader, renderer); Object.assign(shader.uniforms, this.uniforms, { directSurfaceLight: this.direct.surfaces.uniform });
      shader.vertexShader = 'attribute vec2 transferUv; varying vec2 vTransferUv; attribute vec4 directUv; varying vec2 vDirectUv; varying vec2 vDirectLocalUv;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vDirectUv = directUv.xy; vDirectLocalUv = directUv.zw;
        vTransferUv = transferUv;
        #ifdef PORTAL_SURFACE_PADDING
          vTransferUv += portalLightUvOffset;
          vDirectUv += portalDirectUvOffset.xy; vDirectLocalUv += portalDirectUvOffset.zw;
        #endif`);
      shader.fragmentShader = `${SURFACE_LIGHTMAP_FILTER.replaceAll('sampleSurfaceLightmap', 'sampleLightmapPlane')}
        uniform vec2 lightmapSize;
        vec4 sampleSurfaceLightmap(sampler2D lightmap, vec2 uv) { return sampleLightmapPlane(lightmap, uv * lightmapSize / vec2(textureSize(lightmap, 0))); }
        vec4 sampleSurfaceDirection(sampler2D lightmap, vec2 uv) { return sampleSurfaceLightmap(lightmap, uv + vec2(0., 1.)); }
        ${DIRECTIONAL_LIGHTMAP_SHADER}
        varying vec2 vTransferUv;
        varying vec2 vDirectUv; varying vec2 vDirectLocalUv; uniform sampler2D directSurfaceLight;
        uniform sampler2D transferredLight; uniform vec3 transferColor; uniform float transferGain; uniform float bounceGain;
        uniform sampler2D panelLight;
        uniform int passageCount; uniform vec4 passageFrames[4]; uniform vec4 passageAtlases[4]; uniform vec4 passageDirectAtlases[4]; uniform vec4 passageLocalAtlases[4];\n` + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <aomap_fragment>', `
        vec4 roomLight = sampleSurfaceLightmap(panelLight, vTransferUv);
        #ifdef SOCKET_BALL_SHADOW
          roomLight.r *= socketVisibility.x;
        #endif
        vec3 roomBounce = directionalBounce(roomLight.gba, sampleSurfaceDirection(panelLight, vTransferUv), normal, nonPerturbedNormal);
        vec3 roomDirect = directionalDirect(roomLight.r * transferColor, sampleSurfaceLightmap(panelLight, vTransferUv + vec2(0., 2.)), normal, nonPerturbedNormal);
        reflectedLight.directDiffuse += roomDirect * BRDF_Lambert(material.diffuseColor);
        vec3 bakedBounce = roomBounce;
        if (transferGain > 0.) {
          vec4 directField = texture2D(directSurfaceLight, vDirectUv);
          vec3 neighborDirect = directionalDirect(directField.r * transferColor, vec4(directField.gba, directField.r), normal, nonPerturbedNormal);
          reflectedLight.directDiffuse += neighborDirect * BRDF_Lambert(material.diffuseColor);
          if (vDirectLocalUv.x > 0.) {
            vec4 localField = texture2D(directSurfaceLight, vDirectLocalUv);
            vec3 localDirect = directionalDirect(localField.r * transferColor, vec4(localField.gba, localField.r), normal, nonPerturbedNormal);
            reflectedLight.directDiffuse = (localDirect + neighborDirect) * BRDF_Lambert(material.diffuseColor);
          }
        }
        if (transferGain > 0.) {
          vec4 transported = sampleSurfaceLightmap(transferredLight, vTransferUv);
          vec3 transportedBounce = directionalBounce(transported.gba, sampleSurfaceDirection(transferredLight, vTransferUv), normal, nonPerturbedNormal);
          bakedBounce += transferGain * transportedBounce;
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
            vec4 directAtlas = passageDirectAtlases[passage];
            vec4 joinedField = texture2D(directSurfaceLight, directAtlas.xy + vec2(lateral, max(0., depth)) * directAtlas.zw);
            vec3 joinedDirect = directionalDirect(joinedField.r * transferColor, vec4(joinedField.gba, joinedField.r), normal, nonPerturbedNormal);
            vec4 localAtlas = passageLocalAtlases[passage];
            vec4 localField = texture2D(directSurfaceLight, localAtlas.xy + vec2(lateral, max(0., depth)) * localAtlas.zw);
            // Clamp and curve each side's response before adding opposing light.
            vec3 localDirect = directionalDirect(localField.r * transferColor, vec4(localField.gba, localField.r), normal, nonPerturbedNormal);
            vec3 localBounce = directionalBounce(sampleSurfaceLightmap(panelLight, uv).gba, sampleSurfaceDirection(panelLight, uv), normal, nonPerturbedNormal);
            vec3 neighborBounce = directionalBounce(sampleSurfaceLightmap(transferredLight, uv).gba, sampleSurfaceDirection(transferredLight, uv), normal, nonPerturbedNormal);
            vec3 diffuse = (joinedDirect + localDirect) * BRDF_Lambert(material.diffuseColor);
            reflectedLight.directDiffuse = mix(reflectedLight.directDiffuse, diffuse, blend);
            bakedBounce = mix(bakedBounce, localBounce + neighborBounce, blend);
          }
        #endif
        // Keep baked reflections in the indirect channel for AO and contacts.
        // Socket visibility is applied to this channel once by its material.
        reflectedLight.indirectDiffuse += bounceGain * bakedBounce * BRDF_Lambert(material.diffuseColor);
        #include <aomap_fragment>`);
    };
    material.customProgramCacheKey = () => `${key}:neighbor-geometric-direct`;
  }
  dispose() {
    this.download.abort(); this.prepared.clear();
    this.direct.dispose();
    for (const field of Object.values(this.fields)) {
      field.panel.dispose();
      for (const buffer of field.buffers) buffer.texture.dispose();
    }
  }
}
