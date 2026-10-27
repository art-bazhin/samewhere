import { DataTexture, Material, Mesh, Scene, ShaderMaterial, Texture, Vector2 } from 'three';

/** Toggle surface artwork while retaining baked lighting, reflections and portals. */
export class SurfaceTextures {
  enabled = true;
  private readonly originals = new Map<Material, { maps: [string, Texture, Texture][]; scales: [Vector2, Vector2][] }>();
  constructor(scenes: Scene[], textures: Set<Texture>) {
    const materials = new Set<Material>();
    for (const scene of scenes) scene.traverse(object => {
      if (object instanceof Mesh) for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
    });
    const flatMaps = new Map<Texture, Texture>();
    for (const material of materials) {
      if (material instanceof ShaderMaterial || material.userData.keepTexture) continue;
      const maps = Object.entries(material).filter((entry): entry is [string, Texture] =>
        entry[1] instanceof Texture && entry[0] !== 'envMap' && entry[0] !== 'lightMap');
      if (!maps.length) continue;
      const scales = ['normalScale', 'clearcoatNormalScale'].map(key => Reflect.get(material, key))
        .filter((scale): scale is Vector2 => scale instanceof Vector2).map(scale => [scale, scale.clone()] as [Vector2, Vector2]);
      this.originals.set(material, { scales, maps: maps.map(([key, map]) => {
        let flat = flatMaps.get(map);
        if (!flat) {
          // Keep map presence, UV channel and encoding so T reuses the same
          // shaders. Flat normals come from the zeroed normal scales below.
          flat = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
          flat.colorSpace = map.colorSpace; flat.channel = map.channel; flat.needsUpdate = true;
          flatMaps.set(map, flat); textures.add(flat);
        }
        return [key, map, flat];
      }) });
    }
  }
  toggle() {
    this.enabled = !this.enabled;
    for (const [material, { maps, scales }] of this.originals) {
      for (const [key, map, flat] of maps) Reflect.set(material, key, this.enabled ? map : flat);
      for (const [scale, original] of scales) if (this.enabled) scale.copy(original); else scale.setScalar(0);
      material.needsUpdate = true;
    }
    return this.enabled;
  }
}
