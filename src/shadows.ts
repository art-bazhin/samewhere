import * as THREE from 'three';

interface ChangingCaster { source: THREE.Mesh; proxy: THREE.Mesh; bounds: THREE.Sphere; box: THREE.Box3 }

function visibleInScene(object: THREE.Object3D) {
  for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) if (!parent.visible) return false;
  return true;
}

/** Exact shadow geometry, batched once at load time; visible/pickable meshes stay separate. */
export class RoomShadows {
  readonly scene = new THREE.Scene();
  partialUpdates = true;
  private readonly material = new THREE.MeshBasicMaterial();
  private readonly changing: ChangingCaster[] = [];
  private readonly geometry: THREE.BufferGeometry;
  private readonly cones: { light: THREE.SpotLight; position: THREE.Vector3; direction: THREE.Vector3; sin: number; cos: number }[];
  private readonly offset = new THREE.Vector3();
  private readonly projected = Array.from({ length: 8 }, () => new THREE.Vector4());
  private readonly dirty = new Map<THREE.SpotLight['shadow'], THREE.Vector4 | null>();

  constructor(source: THREE.Scene, lights: THREE.SpotLight[], moving: Set<THREE.Object3D>) {
    const fixed: THREE.Mesh[] = [];
    source.traverse(object => {
      if (!(object instanceof THREE.Mesh) || !object.castShadow) return;
      let changes = false;
      for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) if (moving.has(parent)) { changes = true; break; }
      if (!changes) { fixed.push(object); return; }
      const proxy = new THREE.Mesh(object.geometry, this.material);
      proxy.matrix.copy(object.matrixWorld); proxy.matrixAutoUpdate = false;
      proxy.castShadow = true; proxy.visible = visibleInScene(object); this.scene.add(proxy);
      object.geometry.computeBoundingSphere();
      const bounds = object.geometry.boundingSphere!.clone().applyMatrix4(object.matrixWorld);
      bounds.radius += .01; // Conservative margin for shadow bias and rasterization.
      object.geometry.computeBoundingBox();
      const box = object.geometry.boundingBox!.clone().applyMatrix4(object.matrixWorld).expandByScalar(.01);
      this.changing.push({ source: object, proxy, bounds, box });
    });
    // Depth rendering needs positions only. Bake the original transforms and
    // triangles (including the saucers), rather than approximating silhouettes.
    const count = fixed.reduce((sum, mesh) => sum + (mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position').count), 0);
    const positions = new Float32Array(count * 3), point = new THREE.Vector3(); let cursor = 0;
    for (const mesh of fixed) {
      const position = mesh.geometry.getAttribute('position'), index = mesh.geometry.index;
      for (let i = 0; i < (index?.count ?? position.count); i++) {
        point.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(mesh.matrixWorld);
        point.toArray(positions, cursor); cursor += 3;
      }
    }
    this.geometry = new THREE.BufferGeometry(); this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const batch = new THREE.Mesh(this.geometry, this.material); batch.castShadow = true; this.scene.add(batch);
    this.scene.updateMatrixWorld(true); this.scene.matrixWorldAutoUpdate = false;
    this.cones = lights.map(light => {
      light.shadow.updateMatrices(light);
      const position = light.getWorldPosition(new THREE.Vector3());
      const direction = light.target.getWorldPosition(new THREE.Vector3()).sub(position).normalize();
      return { light, position, direction, sin: Math.sin(light.angle), cos: Math.cos(light.angle) };
    });
  }

  sync() {
    for (const caster of this.changing) {
      const visible = visibleInScene(caster.source);
      if (visible === caster.proxy.visible) continue;
      caster.proxy.visible = visible;
      for (const { light, position, direction, sin, cos } of this.cones) {
        if (!light.shadow.getFrustum().intersectsSphere(caster.bounds)) continue;
        this.offset.subVectors(caster.bounds.center, position);
        const axial = this.offset.dot(direction), radial = Math.sqrt(Math.max(0, this.offset.lengthSq() - axial * axial));
        // The shadow camera has a square frustum; the actual spotlight is round.
        if (radial * cos - axial * sin <= caster.bounds.radius) {
          const shadow = light.shadow;
          if ((shadow.needsUpdate && !this.dirty.has(shadow)) || !shadow.map) this.dirty.set(shadow, null);
          else if (this.dirty.get(shadow) !== null) {
            const rectangle = this.projectBounds(caster.box, light), previous = this.dirty.get(shadow);
            if (previous) {
              const right = Math.max(previous.x + previous.z, rectangle.x + rectangle.z), top = Math.max(previous.y + previous.w, rectangle.y + rectangle.w);
              previous.x = Math.min(previous.x, rectangle.x); previous.y = Math.min(previous.y, rectangle.y);
              previous.z = right - previous.x; previous.w = top - previous.y;
            } else this.dirty.set(shadow, rectangle);
          }
          shadow.needsUpdate = true;
        }
      }
    }
  }

  private projectBounds(bounds: THREE.Box3, light: THREE.SpotLight) {
    const { shadow } = light, near = shadow.camera.near;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const include = (x: number, y: number, w: number) => {
      minX = Math.min(minX, x / w); minY = Math.min(minY, y / w);
      maxX = Math.max(maxX, x / w); maxY = Math.max(maxY, y / w);
    };
    for (let i = 0; i < 8; i++) {
      const p = this.projected[i].set(i & 1 ? bounds.max.x : bounds.min.x, i & 2 ? bounds.max.y : bounds.min.y, i & 4 ? bounds.max.z : bounds.min.z, 1).applyMatrix4(shadow.matrix);
      if (p.w >= near) include(p.x, p.y, p.w);
    }
    // Walls extend above the lamp. Clip their box edges to the shadow camera's
    // near plane before projecting, so they do not force a full-map update.
    for (let i = 0; i < 8; i++) for (let axis = 0; axis < 3; axis++) {
      const j = i ^ (1 << axis); if (j <= i) continue;
      const a = this.projected[i], b = this.projected[j];
      if ((a.w < near) === (b.w < near)) continue;
      const t = (near - a.w) / (b.w - a.w);
      include(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, near);
    }
    if (!Number.isFinite(minX)) return new THREE.Vector4();
    const width = shadow.mapSize.x, height = shadow.mapSize.y;
    const left = Math.min(width, Math.max(0, Math.floor(minX * width) - 3)), bottom = Math.min(height, Math.max(0, Math.floor(minY * height) - 3));
    const right = Math.max(0, Math.min(width, Math.ceil(maxX * width) + 3)), top = Math.max(0, Math.min(height, Math.ceil(maxY * height) + 3));
    return new THREE.Vector4(left, bottom, Math.max(0, right - left), Math.max(0, top - bottom));
  }

  beforeRender(lights: THREE.Light[]) {
    let pixels = 0;
    for (const light of lights) {
      const shadow = (light as THREE.SpotLight).shadow;
      if (!shadow || !shadow.needsUpdate) continue;
      const rectangle = this.partialUpdates && this.dirty.get(shadow);
      if (shadow.map) {
        shadow.map.scissorTest = !!rectangle;
        if (rectangle) shadow.map.scissor.copy(rectangle);
      }
      pixels += rectangle ? rectangle.z * rectangle.w : shadow.mapSize.x * shadow.mapSize.y;
    }
    return pixels;
  }
  afterRender(lights: THREE.Light[]) {
    for (const light of lights) {
      const shadow = (light as THREE.SpotLight).shadow;
      if (!shadow || shadow.needsUpdate) continue;
      this.dirty.delete(shadow); if (shadow.map) shadow.map.scissorTest = false;
    }
  }

  dispose() { this.geometry.dispose(); this.material.dispose(); }
}
