import * as THREE from 'three';
import { CEILING_TILE_SIZE, pedestalOutline, PEDESTAL_APOTHEM, ROOM_HEIGHT, ROOMS, wallNormal, type PedestalDefinition } from './world';
import { withDistanceFade } from './visibility';
import { materialDetail, mirroredNormals } from './material-detail';
import { createRoomEnvironment } from './room-environment';

/** Local material artwork; generation prompts are in public/materials/sources.json. */
export function createMaterials(renderer: THREE.WebGLRenderer) {
  const optimizations = { value: true };
  const loader = new THREE.TextureLoader(), textures = new Set<THREE.Texture>(), pending: Promise<unknown>[] = [];
  const anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
  function texture(file: string, metersPerTile: number, relief: number, roughness: [number, number], prepare?: (image: HTMLImageElement) => HTMLCanvasElement) {
    const detail = materialDetail(metersPerTile, relief, roughness, anisotropy);
    textures.add(detail.normal); textures.add(detail.roughness);
    let result!: THREE.Texture;
    pending.push(new Promise((resolve, reject) => {
      result = loader.load(`/materials/${file}`, loaded => {
        const image = prepare ? prepare(loaded.image as HTMLImageElement) : loaded.image as HTMLImageElement;
        loaded.image = image; loaded.needsUpdate = true;
        detail.update(image); resolve(loaded);
      }, undefined, reject);
    }));
    result.wrapS = result.wrapT = THREE.MirroredRepeatWrapping; result.anisotropy = anisotropy;
    result.repeat.setScalar(2 / metersPerTile); result.colorSpace = THREE.SRGBColorSpace;
    textures.add(result); return { color: result, ...detail };
  }
  const wallpaper = texture('backrooms-wallpaper-color.png', 1.2, .00065, [.74, .96]), carpet = texture('backrooms-carpet-color.png', 1, .003, [.9, 1]);
  const concrete = texture('pedestal-concrete-color.jpg', .8, .0007, [.78, .97]);
  // Normalize the JPG's measured mean linear RGB to the original beige albedo.
  // Keep its pore/color variation without darkening the original plinth color.
  const concreteTint = new THREE.Color(0xcdbb86);
  concreteTint.r /= .504106; concreteTint.g /= .443913; concreteTint.b /= .362871;
  const ceiling = texture('office-ceiling-panel-color.jpg', CEILING_TILE_SIZE, .0012, [.94, 1], ceilingTile);
  // surfaceUV projects x/-z in meters. Put each panel center on the shared grid.
  for (const map of [ceiling.color, ceiling.normal, ceiling.roughness]) map.offset.set(.5, .5);
  const diffuser = lampDiffuser(); textures.add(diffuser);
  const environment = createRoomEnvironment(renderer, diffuser);
  const materials = {
    wall: new THREE.MeshStandardMaterial({ map: wallpaper.color, normalMap: wallpaper.normal, roughnessMap: wallpaper.roughness, roughness: 1 }),
    floor: new THREE.MeshPhysicalMaterial({ map: carpet.color, normalMap: carpet.normal, roughnessMap: carpet.roughness, roughness: 1,
      sheen: .25, sheenColor: 0xd8c69f, sheenRoughness: .95 }),
    ceiling: new THREE.MeshStandardMaterial({ map: ceiling.color, normalMap: ceiling.normal, roughnessMap: ceiling.roughness,
      emissive: 0x3f3b28, emissiveMap: ceiling.color, roughness: 1, side: THREE.BackSide }),
    pedestal: new THREE.MeshStandardMaterial({ color: concreteTint, map: concrete.color, normalMap: concrete.normal, roughnessMap: concrete.roughness, roughness: 1, vertexColors: true }),
    socket: new THREE.MeshStandardMaterial({ color: concreteTint, map: concrete.color, normalMap: concrete.normal, roughnessMap: concrete.roughness, roughness: 1, vertexColors: true }),
    hit: new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }),
    red: new THREE.MeshStandardMaterial({ color: 0xc92530, roughness: 0.4, metalness: 0.02 }),
    blue: new THREE.MeshStandardMaterial({ color: 0x2466c9, roughness: 0.4, metalness: 0.02 }),
    lamp: new THREE.MeshBasicMaterial({ color: 0xfffbd6, map: diffuser }),
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
      reflectedLight.indirectSpecular *= 1. - .3 * contact;
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
      reflectedLight.indirectDiffuse *= baseContact; reflectedLight.directDiffuse *= baseContact;
      reflectedLight.indirectSpecular *= baseContact;`);
  };
  materials.pedestal.customProgramCacheKey = () => 'pedestal-contact';
  for (const material of [materials.wall, materials.floor, materials.ceiling, materials.pedestal, materials.socket]) mirroredNormals(material);
  for (const material of Object.values(materials)) withDistanceFade(material);
  return { materials, textures, environment, optimizations, ready: Promise.all(pending).then(() => {}) };
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
      reflectedLight.indirectDiffuse *= shade; reflectedLight.directDiffuse *= shade;
      reflectedLight.indirectSpecular *= shade;
      #ifdef USE_SHEEN
        sheenSpecularIndirect *= shade; sheenSpecularDirect *= shade;
      #endif`);
  };
  material.customProgramCacheKey = () => `floor-contacts:${contacts}`;
  return withDistanceFade(mirroredNormals(material));
}

/** Subtle tubes behind an opal diffuser, entirely inside the existing light tile. */
function lampDiffuser() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
  const context = canvas.getContext('2d')!, pixels = context.createImageData(512, 512);
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
    const u = (x + .5) / 512, v = (y + .5) / 512;
    const tubes = Math.exp(-(((u - .27) / .16) ** 2)) + Math.exp(-(((u - .73) / .16) ** 2));
    const end = Math.min(1, Math.min(v, 1 - v) / .08), prism = (x % 4 === 0 || y % 4 === 0) ? -.8 : .2;
    const value = 230 + 19 * tubes * end + prism, i = (y * 512 + x) * 4;
    pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = value; pixels.data[i + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
  const map = new THREE.CanvasTexture(canvas); map.colorSpace = THREE.SRGBColorSpace; return map;
}

/** Mineral-fiber artwork with a 24 mm painted T-grid, without extra geometry. */
function ceilingTile(image: HTMLImageElement) {
  const canvas = document.createElement('canvas'), size = image.naturalWidth;
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0, size, size);
  const border = (width: number, color: string) => {
    context.fillStyle = color;
    context.fillRect(0, 0, size, width); context.fillRect(0, size - width, size, width);
    context.fillRect(0, 0, width, size); context.fillRect(size - width, 0, width, size);
  };
  const rail = Math.max(1, Math.round(.012 / CEILING_TILE_SIZE * size));
  border(rail + 1, '#aaa38b'); border(rail, '#d9d3b9');
  border(Math.max(1, Math.round(.001 / CEILING_TILE_SIZE * size)), '#8c866f');
  return canvas;
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
