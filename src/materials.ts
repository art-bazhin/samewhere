import * as THREE from 'three';
import { CEILING_TILE_SIZE, pedestalOutline, PEDESTAL_APOTHEM, ROOM_HEIGHT, ROOMS, wallNormal, type PedestalDefinition } from './world';
import { withDistanceFade } from './visibility';

/** Local material artwork; generation prompts are in public/materials/sources.json. */
export function createMaterials(renderer: THREE.WebGLRenderer) {
  const optimizations = { value: true };
  const loader = new THREE.TextureLoader(), textures = new Set<THREE.Texture>(), pending: Promise<unknown>[] = [];
  const anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
  function texture(name: string, metersPerTile: number) {
    let result!: THREE.Texture;
    pending.push(new Promise((resolve, reject) => {
      result = loader.load(`/materials/${name}.png`, resolve, undefined, reject);
    }));
    result.wrapS = result.wrapT = THREE.MirroredRepeatWrapping; result.anisotropy = anisotropy;
    result.repeat.setScalar(2 / metersPerTile); result.colorSpace = THREE.SRGBColorSpace;
    textures.add(result); return result;
  }
  const wallpaper = texture('backrooms-wallpaper-color', 1.2), carpet = texture('backrooms-carpet-color', 1);
  const ceiling = ceilingTile(); ceiling.anisotropy = anisotropy; textures.add(ceiling);
  const materials = {
    wall: new THREE.MeshStandardMaterial({ map: wallpaper, bumpMap: wallpaper, bumpScale: 0.0015, roughness: 0.94 }),
    floor: new THREE.MeshStandardMaterial({ map: carpet, bumpMap: carpet, bumpScale: 0.008, roughness: 1 }),
    ceiling: new THREE.MeshStandardMaterial({ map: ceiling, bumpMap: ceiling, bumpScale: 0.002, emissive: 0x3f3b28, roughness: 1, side: THREE.BackSide }),
    pedestal: new THREE.MeshStandardMaterial({ color: 0xcdbb86, roughness: 0.87 }),
    socket: new THREE.MeshStandardMaterial({ color: 0xcdbb86, roughness: 0.87, vertexColors: true }),
    hit: new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }),
    red: new THREE.MeshStandardMaterial({ color: 0xc92530, roughness: 0.4, metalness: 0.02 }),
    blue: new THREE.MeshStandardMaterial({ color: 0x2466c9, roughness: 0.4, metalness: 0.02 }),
    lamp: new THREE.MeshBasicMaterial({ color: 0xfffbd6 }),
    lampFrame: new THREE.MeshStandardMaterial({ color: 0xd6cda6, roughness: 0.8 }),
  };
  // A small baked-contact approximation at wall/floor and wall/ceiling joins.
  // It works in room coordinates, including when the scene is seen recursively.
  materials.wall.onBeforeCompile = shader => {
    shader.vertexShader = 'varying float surfaceHeight;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
      surfaceHeight = (modelMatrix * vec4(transformed, 1.)).y;`);
    shader.fragmentShader = 'varying float surfaceHeight;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <aomap_fragment>', `#include <aomap_fragment>
      float contact = exp(-max(surfaceHeight, 0.) * 7.) + exp(-max(${ROOM_HEIGHT.toFixed(4)} - surfaceHeight, 0.) * 6.);
      reflectedLight.indirectDiffuse *= 1. - .24 * contact;
      reflectedLight.directDiffuse *= 1. - .12 * contact;`);
  };
  materials.wall.customProgramCacheKey = () => 'wall-contact';
  materials.pedestal.onBeforeCompile = shader => {
    shader.vertexShader = 'varying float baseHeight;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
      baseHeight = (modelMatrix * vec4(transformed, 1.)).y;`);
    shader.fragmentShader = 'varying float baseHeight;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <aomap_fragment>', `#include <aomap_fragment>
      float baseContact = 1. - .3 * exp(-max(baseHeight, 0.) * 35.);
      reflectedLight.indirectDiffuse *= baseContact; reflectedLight.directDiffuse *= baseContact;`);
  };
  materials.pedestal.customProgramCacheKey = () => 'pedestal-contact';
  for (const material of Object.values(materials)) withDistanceFade(material);
  return { materials, textures, optimizations, ready: Promise.all(pending).then(() => {}) };
}
export type MaterialSet = ReturnType<typeof createMaterials>['materials'];

/** Skip work whose direct-light contribution is exactly zero on these opaque PBR surfaces. */
export function optimizeLighting(material: THREE.MeshStandardMaterial, enabled: THREE.IUniform<boolean>) {
  const before = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey();
  const lighting = THREE.ShaderChunk.lights_fragment_begin.replace(
    /(getSpotLightInfo\( spotLight, geometryPosition, directLight \);)([\s\S]*?RE_Direct\( directLight,[^;]+;)/,
    '$1\n if (!surfaceOptimizations || (directLight.visible && dot(geometryNormal, directLight.direction) > 0.)) { $2\n }',
  );
  material.onBeforeCompile = (shader, renderer) => {
    before(shader, renderer); shader.uniforms.surfaceOptimizations = enabled;
    shader.fragmentShader = 'uniform bool surfaceOptimizations;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>', lighting);
  };
  material.customProgramCacheKey = () => `${key}:unlit-surfaces`;
}

/** Shade contacts in linear light, so the main view and portal buffers agree. */
export function floorWithContacts(base: THREE.MeshStandardMaterial, pedestals: PedestalDefinition[], enabled: THREE.IUniform<boolean>) {
  const material = base.clone();
  const contacts = pedestals.map((p, index) => {
    if (ROOMS[p.controls].outline) {
      const outline = pedestalOutline(p.controls), v = (point: { x: number; z: number }) => `vec2(${point.x.toFixed(6)}, ${point.z.toFixed(6)})`;
      const segments = outline.map((a, edge) => {
        const b = outline[(edge + 1) % outline.length], dx = b.x - a.x, dz = b.z - a.z;
        return `{
          vec2 a = ${v(a)}, b = ${v(b)}, segment = b - a;
          float t = clamp(dot(local${index} - a, segment) / dot(segment, segment), 0., 1.);
          edge${index} = min(edge${index}, length(local${index} - a - t * segment));
          ${Math.abs(dz) > 1e-8 ? `if ((a.y > local${index}.y) != (b.y > local${index}.y) && local${index}.x < ${dx.toFixed(6)} * (local${index}.y - a.y) / ${dz.toFixed(6)} + a.x) inside${index} = !inside${index};` : ''}
        }`;
      }).join('\n');
      return `vec2 local${index} = contactPosition - vec2(${p.x.toFixed(4)}, ${p.z.toFixed(4)});
        float edge${index} = 100.; bool inside${index} = false; ${segments}
        shade *= 1. - .55 * exp(-(inside${index} ? 0. : edge${index}) * 18.);`;
    }
    const edges = Array.from({ length: ROOMS[p.controls].sides }, (_, side) => {
      const n = wallNormal(p.controls, side);
      return `edge${index} = max(edge${index}, dot(local${index}, vec2(${n.x.toFixed(5)}, ${n.z.toFixed(5)})) - ${PEDESTAL_APOTHEM.toFixed(4)});`;
    }).join('\n');
    return `vec2 local${index} = contactPosition - vec2(${p.x.toFixed(4)}, ${p.z.toFixed(4)});
      float edge${index} = -100.; ${edges}
      shade *= 1. - .55 * exp(-max(edge${index}, 0.) * 18.);`;
  }).map((contact, index) => {
    const outline = pedestalOutline(pedestals[index].controls), padding = ROOMS[pedestals[index].controls].outline ? 1 : 2;
    const xs = outline.map(p => p.x), zs = outline.map(p => p.z), p = pedestals[index];
    // Beyond this box the discarded factor is below float32 color precision.
    // Concave silhouettes use Euclidean edge distance; convex ones use planes.
    const min = [p.x + Math.min(...xs) - padding, p.z + Math.min(...zs) - padding];
    const max = [p.x + Math.max(...xs) + padding, p.z + Math.max(...zs) + padding];
    return `if (!boundedContacts || (all(greaterThan(contactPosition, vec2(${min.map(v => v.toFixed(6)).join(',')}))) && all(lessThan(contactPosition, vec2(${max.map(v => v.toFixed(6)).join(',')}))))) { ${contact} }`;
  }).join('\n');
  material.onBeforeCompile = shader => {
    shader.uniforms.boundedContacts = enabled;
    // The floor and passage halves already end at each terminal portal plane.
    // Clipping again discards MSAA edge pixels whose centers lie outside the
    // plane even though some covered samples are inside, leaving a dotted seam.
    shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>', '');
    shader.vertexShader = 'varying vec2 contactPosition;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
      contactPosition = (modelMatrix * vec4(transformed, 1.)).xz;`);
    shader.fragmentShader = 'varying vec2 contactPosition; uniform bool boundedContacts;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <aomap_fragment>', `#include <aomap_fragment>
      float shade = 1.; ${contacts}
      reflectedLight.indirectDiffuse *= shade; reflectedLight.directDiffuse *= shade;`);
  };
  material.customProgramCacheKey = () => `floor-contacts:${contacts}`;
  return withDistanceFade(material);
}

/** A 60 cm acoustic tile with a flat T-grid; no extra wall or ceiling geometry. */
function ceilingTile() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1024;
  const context = canvas.getContext('2d')!, pixels = context.createImageData(1024, 1024);
  let seed = 72841;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let y = 0; y < 1024; y++) for (let x = 0; x < 1024; x++) {
    const i = (y * 1024 + x) * 4, edge = Math.min(x, y, 1023 - x, 1023 - y);
    const pore = random() < 0.065 ? -18 : 0, grain = (random() - 0.5) * 9 + pore;
    const base = edge < 3 ? [118, 110, 74] : edge < 16 ? [217, 211, 180] : [222, 216, 188];
    for (let c = 0; c < 3; c++) pixels.data[i + c] = base[c] + grain;
    pixels.data[i + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.repeat.setScalar(2 / CEILING_TILE_SIZE);
  // surfaceUV projects x/-z in meters. Put the tile center at each grid point.
  texture.offset.set(.5, .5);
  return texture;
}

/** Meter-based box projection, so textures keep their scale on walls and prisms. */
export function surfaceUV(geometry: THREE.BufferGeometry, metersPerTile = 2) {
  const position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal');
  const uv = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
    const nx = Math.abs(normal.getX(i)), ny = Math.abs(normal.getY(i)), nz = Math.abs(normal.getZ(i));
    uv[i * 2] = (ny > nx && ny > nz ? x : nx > nz ? -z : x) / metersPerTile;
    uv[i * 2 + 1] = (ny > nx && ny > nz ? -z : y) / metersPerTile;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); return geometry;
}
