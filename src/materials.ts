import * as THREE from 'three';
import { BALL_RADIUS, CEILING_TILE_SIZE, pedestalOutline, PEDESTAL_APOTHEM, PEDESTAL_HEIGHT, ROOMS, SOCKET_DEPTH, SOCKET_RECESS, wallNormal, type PedestalDefinition, type RoomId } from './world';
import { withDistanceFade } from './visibility';
import { materialDetail } from './material-detail';
import { createRoomEnvironment } from './room-environment';
import { CEILING_GRID_WIDTH, CEILING_LIGHT, CEILING_PANEL_SIZE } from './lighting';
import { withPortalSurfacePadding } from './portal-surfaces';
import { boundaryContactDistance, PEDESTAL_CONTACT_STRENGTH, withWallContacts, withPedestalContacts, withContactShading } from './contact-shading';

export const PEDESTAL_TEXTURE_SIZE = .8;

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
    result.wrapS = result.wrapT = THREE.RepeatWrapping; result.anisotropy = anisotropy;
    result.repeat.setScalar(2 / metersPerTile); result.colorSpace = THREE.SRGBColorSpace;
    textures.add(result); return { color: result, ...detail };
  }
  const wallpaper = texture('backrooms-wallpaper-color.png', 1.2, .00065, [.74, .96]), carpet = texture('backrooms-carpet-color.png', 1, .003, [.9, 1]);
  const concrete = texture('pedestal-concrete-color.jpg', PEDESTAL_TEXTURE_SIZE, .0007, [.78, .97]);
  // Apply half of the original beige tint, retaining some of the neutral concrete.
  // A linear multiplier retains the concrete's pores and color variation.
  const concreteTint = new THREE.Color(0xcdbb86);
  concreteTint.r /= .504106; concreteTint.g /= .443913; concreteTint.b /= .362871;
  concreteTint.lerp(new THREE.Color(0xffffff), .5);
  const ceiling = texture('office-ceiling-panel-color.jpg', CEILING_TILE_SIZE, .0012, [.94, 1], ceilingTile);
  // surfaceUV projects x/-z in meters. Put each panel center on the shared grid.
  for (const map of [ceiling.color, ceiling.normal, ceiling.roughness]) map.offset.set(.5, .5);
  const diffuser = lampDiffuser(); textures.add(diffuser);
  const environment = createRoomEnvironment(renderer, diffuser);
  const polish = ballPolish(anisotropy); textures.add(polish);
  const ballSurface = { metalness: 0, ior: 1.57, roughness: 1, roughnessMap: polish,
    clearcoat: .45, clearcoatRoughness: .33, clearcoatRoughnessMap: polish,
    envMap: environment.texture, envMapIntensity: 1 };
  const materials = {
    wall: new THREE.MeshStandardMaterial({ map: wallpaper.color, normalMap: wallpaper.normal, roughnessMap: wallpaper.roughness, roughness: 1 }),
    floor: new THREE.MeshPhysicalMaterial({ map: carpet.color, normalMap: carpet.normal, roughnessMap: carpet.roughness, roughness: 1,
      sheen: .25, sheenColor: 0xd8c69f, sheenRoughness: .95 }),
    ceiling: new THREE.MeshStandardMaterial({ map: ceiling.color, normalMap: ceiling.normal, roughnessMap: ceiling.roughness,
      emissive: 0x3f3b28, emissiveMap: ceiling.color, roughness: 1, side: THREE.BackSide }),
    pedestal: new THREE.MeshStandardMaterial({ color: concreteTint, map: concrete.color, normalMap: concrete.normal, roughnessMap: concrete.roughness, roughness: 1, vertexColors: true }),
    socket: new THREE.MeshStandardMaterial({ color: concreteTint, map: concrete.color, normalMap: concrete.normal, roughnessMap: concrete.roughness, roughness: 1, vertexColors: true }),
    hit: new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }),
    red: new THREE.MeshPhysicalMaterial({ ...ballSurface, color: 0xc92530 }),
    blue: new THREE.MeshPhysicalMaterial({ ...ballSurface, color: 0x2466c9 }),
    lamp: new THREE.MeshBasicMaterial({ color: 0xfffbd6, map: diffuser }),
  };
  // Front-face depth keeps a solid pedestal's interior occluded at the floor.
  materials.pedestal.shadowSide = THREE.FrontSide;
  // The saucers close its top cutouts and have no downward-facing back shell.
  materials.socket.shadowSide = THREE.FrontSide;
  withWallContacts(materials.wall);
  withPedestalContacts(materials.pedestal);
  // Panel reflections already supply the resin and clearcoat highlights.
  for (const material of [materials.red, materials.blue]) withEnvironmentSpecular(material);
  materials.socket.onBeforeCompile = shader => {
    shader.vertexShader = 'attribute float socketOccupied; varying float vSocketOccupied; varying vec3 bowlPosition; varying vec2 socketOffset;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      vSocketOccupied = socketOccupied; bowlPosition = position;
      socketOffset = vec2(uv.x * 2. - position.x, -uv.y * 2. - position.z);`);
    shader.fragmentShader = `#define SOCKET_BALL_SHADOW
      varying float vSocketOccupied; varying vec3 bowlPosition; varying vec2 socketOffset;
      vec3 socketToBall() {
        return vec3(0., ${(BALL_RADIUS - SOCKET_DEPTH).toFixed(6)}, 0.) - bowlPosition;
      }
      vec2 socketBallVisibility() {
        if (vSocketOccupied < .5) return vec2(1.);
        vec3 toBall = socketToBall();
        vec3 toLamp = vec3(-socketOffset.x, ${(CEILING_LIGHT.height - PEDESTAL_HEIGHT + SOCKET_RECESS).toFixed(6)}, -socketOffset.y) - bowlPosition;
        float lampDistance = length(toLamp); vec3 direction = toLamp / lampDistance;
        float along = dot(toBall, direction);
        float clearance = length(toBall - direction * along) - ${BALL_RADIUS.toFixed(6)};
        float penumbra = max(.0007, ${(.5 * CEILING_PANEL_SIZE).toFixed(6)} * max(along, 0.) / lampDistance);
        float direct = along > 0. && along < lampDistance ? smoothstep(-penumbra, penumbra, clearance) : 1.;
        float gap = max(length(toBall) - ${BALL_RADIUS.toFixed(6)}, 0.);
        float ambient = 1. - .72 * exp(-gap * 170.);
        return vec2(direct, ambient);
      }\n` + shader.fragmentShader;
    // An 8 cm ball spans only a few shadow texels. Its back-surface depth and
    // filtering can leak light at contact; front-surface depth self-shadows the
    // ball. Resolve its exact silhouette locally, retaining the room shadow map
    // for all other blockers. Pedestal/socket transforms contain translation only.
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_pars_fragment>', `#include <lights_physical_pars_fragment>
      void RE_Direct_Socket(const in IncidentLight directLight, const in vec3 geometryPosition,
        const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal,
        const in PhysicalMaterial material, inout ReflectedLight reflectedLight) {
        if (vSocketOccupied > .5) {
          vec3 toBall = socketToBall();
          vec3 direction = inverseTransformDirection(directLight.direction, viewMatrix);
          float along = dot(toBall, direction);
          // All direct sources are ceiling lamps, beyond the sphere.
          if (along > 0. && dot(toBall, toBall) - along * along < ${(BALL_RADIUS * BALL_RADIUS).toFixed(8)}) return;
        }
        RE_Direct_Physical(directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
      }
      #undef RE_Direct
      #define RE_Direct RE_Direct_Socket`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>', `vec2 socketVisibility = socketBallVisibility();
      #include <lights_fragment_begin>`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <aomap_fragment>', `#include <aomap_fragment>
      reflectedLight.indirectDiffuse *= socketVisibility.y;
      reflectedLight.indirectSpecular *= socketVisibility.y;`);
  };
  materials.socket.customProgramCacheKey = () => 'socket-ball-shadow:exact-direct';
  withPortalSurfacePadding(materials.wall);
  for (const material of [materials.wall, materials.ceiling]) preservePortalCoverage(material);
  for (const material of Object.values(materials)) withDistanceFade(material);
  return { materials, textures, environment, optimizations, ready: Promise.all(pending).then(() => {}) };
}
export type MaterialSet = ReturnType<typeof createMaterials>['materials'];

/** Keep diffuse light/shadows from spots, and source highlights from the environment. */
function withEnvironmentSpecular(material: THREE.MeshStandardMaterial) {
  const before = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    before(shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_pars_fragment>', `#include <lights_physical_pars_fragment>
      void RE_Direct_SurfaceDiffuse(const in IncidentLight directLight, const in vec3 geometryPosition,
        const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal,
        const in PhysicalMaterial material, inout ReflectedLight reflectedLight) {
        vec3 irradiance = saturate(dot(geometryNormal, directLight.direction)) * directLight.color;
        reflectedLight.directDiffuse += irradiance * BRDF_Lambert(material.diffuseColor);
      }
      #undef RE_Direct
      #define RE_Direct RE_Direct_SurfaceDiffuse`);
  };
  material.customProgramCacheKey = () => `${key}:environment-specular`;
}

/** Keep MSAA-covered boundary fragments and the solid caps at the portal plane. */
function preservePortalCoverage(material: THREE.MeshStandardMaterial) {
  const before = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey();
  const clipping = THREE.ShaderChunk.clipping_planes_fragment.replaceAll(
    'dot( vClipPosition, plane.xyz ) > plane.w', 'outsidePortalClip( vClipPosition, plane )',
  );
  material.onBeforeCompile = (shader, renderer) => {
    before(shader, renderer);
    // A center-only discard can remove the whole fragment although some MSAA
    // samples lie inside the room. The receiving image then leaks through the
    // shared reveal edge. Retain that half-pixel footprint, plus float tolerance.
    shader.fragmentShader = `bool outsidePortalClip(vec3 position, vec4 plane) {
      float distance = dot(position, plane.xyz) - plane.w;
      return distance > max(.00002, .5 * fwidth(distance));
    }\n` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>', clipping);
  };
  material.customProgramCacheKey = () => `${key}:portal-coverage`;
}

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
export function floorWithContacts(base: THREE.MeshStandardMaterial, pedestals: PedestalDefinition[], enabled: THREE.IUniform<boolean>,
  room: RoomId, openings: THREE.IUniform<Int32Array>) {
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
        contactDistance = min(contactDistance, inside${index} ? 0. : edge${index});`;
    }
    const edges = Array.from({ length: ROOMS[p.controls].sides }, (_, side) => {
      const n = wallNormal(p.controls, side);
      return `edge${index} = max(edge${index}, dot(local${index}, vec2(${n.x.toFixed(5)}, ${n.z.toFixed(5)})) - ${PEDESTAL_APOTHEM.toFixed(4)});`;
    }).join('\n');
    return `vec2 local${index} = contactPosition - vec2(${p.x.toFixed(4)}, ${p.z.toFixed(4)});
      float edge${index} = -100.; ${edges}
      contactDistance = min(contactDistance, max(edge${index}, 0.));`;
  }).map((contact, index) => {
    const outline = pedestalOutline(pedestals[index].controls), padding = ROOMS[pedestals[index].controls].outline ? 1 : 2;
    const xs = outline.map(p => p.x), zs = outline.map(p => p.z), p = pedestals[index];
    // Beyond this box the discarded tail is visually negligible.
    // Concave silhouettes use Euclidean edge distance; convex ones use planes.
    const min = [p.x + Math.min(...xs) - padding, p.z + Math.min(...zs) - padding];
    const max = [p.x + Math.max(...xs) + padding, p.z + Math.max(...zs) + padding];
    return `if (!boundedContacts || (all(greaterThan(contactPosition, vec2(${min.map(v => v.toFixed(6)).join(',')}))) && all(lessThan(contactPosition, vec2(${max.map(v => v.toFixed(6)).join(',')}))))) { ${contact} }`;
  }).join('\n');
  material.onBeforeCompile = shader => {
    shader.defines = { ...shader.defines, FLOOR_PASSAGE_LIGHTING: '' };
    // The floor and passage halves already end at each terminal portal plane.
    // Clipping again discards MSAA edge pixels whose centers lie outside the
    // plane even though some covered samples are inside, leaving a dotted seam.
    shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>', '');
  };
  withContactShading(material, `${contacts}\n${boundaryContactDistance(room, true, PEDESTAL_CONTACT_STRENGTH)}`, PEDESTAL_CONTACT_STRENGTH,
    { boundedContacts: enabled, contactOpenings: openings },
    `uniform bool boundedContacts; uniform int contactOpenings[${ROOMS[room].sides}];`);
  // The carpet's broad reflections use the shared environment on both sides of
  // a portal. Local-only spot highlights would stop at the transition plane.
  withEnvironmentSpecular(material);
  return withDistanceFade(material);
}

/** Submillimeter polish variation in linear roughness, without visible color grain. */
function ballPolish(anisotropy: number) {
  const size = 256, pixels = new Uint8Array(size * size * 4); let seed = 49571;
  for (let i = 0; i < pixels.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const roughness = 35 + Math.round(seed / 4294967296 * 8);
    pixels[i] = pixels[i + 1] = pixels[i + 2] = roughness; pixels[i + 3] = 255;
  }
  const map = new THREE.DataTexture(pixels, size, size);
  map.wrapS = map.wrapT = THREE.RepeatWrapping; map.repeat.set(2, 1);
  map.minFilter = THREE.LinearMipmapLinearFilter; map.magFilter = THREE.LinearFilter;
  map.anisotropy = anisotropy; map.generateMipmaps = true; map.needsUpdate = true; return map;
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
  // Round into the opening so no subtexel strip of fiber remains by a diffuser.
  const rail = Math.max(1, Math.ceil(CEILING_GRID_WIDTH / 2 / CEILING_TILE_SIZE * size));
  // A warm greige just below the panel's mean sRGB (#d7cdbb), without a colored edge.
  border(rail, '#c9c0ae');
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

/** One oriented strip around the prism, rather than mirrored box projections.
 * A whole number of texture tiles closes the strip at its first corner. */
export function pedestalUV(geometry: THREE.BufferGeometry, controls: RoomId) {
  surfaceUV(geometry);
  const outline = pedestalOutline(controls), position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal'), uv = geometry.getAttribute('uv');
  let perimeter = 0;
  const edges = outline.map((a, index) => {
    const b = outline[(index + 1) % outline.length], dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz), start = perimeter;
    perimeter += length; return { a, dx, dz, length, start };
  });
  // Keep the horizontal scale close to 0.8 m per tile while making the final
  // seam periodic. Height, the top projection and the socket lips keep their UVs.
  const scale = Math.max(1, Math.round(perimeter / PEDESTAL_TEXTURE_SIZE)) * PEDESTAL_TEXTURE_SIZE / perimeter;
  for (let i = 0; i < position.count; i++) {
    if (Math.abs(normal.getY(i)) > .1) continue;
    const x = position.getX(i), z = position.getZ(i);
    for (const { a, dx, dz, length, start } of edges) {
      if ((normal.getX(i) * dz - normal.getZ(i) * dx) / length < .9999 ||
        Math.abs((x - a.x) * dz - (z - a.z) * dx) / length > .00001) continue;
      const along = ((x - a.x) * dx + (z - a.z) * dz) / length;
      if (along < -.00001 || along > length + .00001) continue;
      // Negative perimeter direction with V pointing up gives an outward,
      // non-mirrored tangent basis for both the color and normal maps.
      uv.setXY(i, -(start + along) * scale / 2, position.getY(i) / 2); break;
    }
  }
  return geometry;
}
